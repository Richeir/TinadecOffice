using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using TinadecCore.Abstractions.Ports;

namespace TinadecCore.Models;

/// <summary>
/// Settings for the model health breaker (config section <c>TinadecModelHealth</c>).
/// </summary>
public sealed record ModelHealthOptions(bool Enabled, int FailureThreshold, TimeSpan Cooldown)
{
    public static ModelHealthOptions Default { get; } = new(
        true,
        ModelHealthPolicy.DefaultFailureThreshold,
        TimeSpan.FromSeconds(ModelHealthPolicy.DefaultCooldownSeconds));

    public static ModelHealthOptions From(IConfiguration? configuration)
    {
        if (configuration?.GetSection("TinadecModelHealth") is not { } section) return Default;

        var threshold = section.GetValue<int?>("FailureThreshold") ?? Default.FailureThreshold;
        var cooldown = section.GetValue<int?>("CooldownSeconds") ?? (int)Default.Cooldown.TotalSeconds;

        return Default with
        {
            Enabled = section.GetValue<bool?>("Enabled") ?? Default.Enabled,
            FailureThreshold = Math.Clamp(threshold, 1, ModelHealthPolicy.MaxFailureThreshold),
            Cooldown = TimeSpan.FromSeconds(Math.Clamp(
                cooldown, ModelHealthPolicy.MinCooldownSeconds, ModelHealthPolicy.MaxCooldownSeconds))
        };
    }
}

/// <summary>
/// Durable circuit-breaker state for one (provider instance, model) pair, keyed by the ambient
/// tenant/workspace so two storage scopes never share an outage.
///
/// <para>
/// Every member is <b>best effort by contract</b>: a health write that fails is logged and dropped, never
/// thrown. Health is a hint about the world; letting a database hiccup fail a run that the provider would
/// have answered is a strictly worse trade than losing one failure count. The caller
/// (<c>AgentModelResolver</c>) relies on that and does not wrap this in its own try/catch.
/// </para>
/// </summary>
public sealed class ModelHealthRegistry
{
    private readonly IDbContextFactory<ModelControlDbContext> _models;
    private readonly ITenantContextAccessor _tenant;
    private readonly ModelHealthOptions _options;
    private readonly ILogger<ModelHealthRegistry> _logger;

    public ModelHealthRegistry(
        IDbContextFactory<ModelControlDbContext> models,
        ITenantContextAccessor tenant,
        ModelHealthOptions options,
        ILogger<ModelHealthRegistry> logger)
    {
        _models = models;
        _tenant = tenant;
        _options = options;
        _logger = logger;
    }

    public ModelHealthOptions Options => _options;

    /// <summary>
    /// Which of <paramref name="candidates"/> are currently cooling down. Keys are
    /// <c>(ProviderInstanceId, Model)</c> as the resolution carries them.
    /// </summary>
    public async Task<IReadOnlySet<(Guid ProviderInstanceId, string Model)>> LoadCoolingAsync(
        IReadOnlyCollection<(Guid ProviderInstanceId, string Model)> candidates,
        CancellationToken cancellationToken = default)
    {
        var result = new HashSet<(Guid, string)>();
        if (!_options.Enabled || candidates.Count == 0) return result;

        try
        {
            var scope = _tenant.Current;
            var providers = candidates.Select(item => item.ProviderInstanceId).Distinct().ToArray();
            var now = DateTimeOffset.UtcNow;

            await using var db = await _models.CreateDbContextAsync(cancellationToken).ConfigureAwait(false);
            var rows = await db.Health.AsNoTracking()
                .Where(x => x.TenantId == scope.TenantId
                            && x.WorkspaceId == scope.WorkspaceId
                            && providers.Contains(x.ProviderInstanceId))
                .Select(x => new { x.ProviderInstanceId, x.Model, x.CoolingUntil })
                .ToListAsync(cancellationToken)
                .ConfigureAwait(false);

            // The comparison is deliberately in memory: SQLite cannot translate DateTimeOffset against a
            // parameter (the same limitation recorded three times elsewhere in this repo).
            foreach (var row in rows)
                if (ModelHealthPolicy.IsCooling(row.CoolingUntil, now))
                    result.Add((row.ProviderInstanceId, row.Model));

            return result;
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "Model health read failed; treating every candidate as healthy.");
            return result;
        }
    }

    /// <summary>Clears the streak: one successful answer is the evidence the outage ended.</summary>
    public Task RecordSuccessAsync(Guid providerInstanceId, string? model, CancellationToken cancellationToken = default) =>
        UpdateAsync(providerInstanceId, model, failure: null, cancellationToken);

    /// <summary>Counts one transient failure and starts the cooldown once the threshold is reached.</summary>
    public Task RecordFailureAsync(
        Guid providerInstanceId,
        string? model,
        string? category,
        CancellationToken cancellationToken = default) =>
        ModelHealthPolicy.CountsAsFailure(category)
            ? UpdateAsync(providerInstanceId, model, failure: category, cancellationToken)
            : Task.CompletedTask;

    private async Task UpdateAsync(
        Guid providerInstanceId,
        string? model,
        string? failure,
        CancellationToken cancellationToken)
    {
        // A harness can resolve without a model name (the binary chooses it). Those pairs have no stable
        // key, so they are simply not tracked — inventing a key like "" would merge unrelated harnesses.
        if (!_options.Enabled || string.IsNullOrWhiteSpace(model)) return;

        try
        {
            var scope = _tenant.Current;
            var now = DateTimeOffset.UtcNow;

            await using var db = await _models.CreateDbContextAsync(cancellationToken).ConfigureAwait(false);
            var row = await db.Health
                .FirstOrDefaultAsync(
                    x => x.TenantId == scope.TenantId
                         && x.WorkspaceId == scope.WorkspaceId
                         && x.ProviderInstanceId == providerInstanceId
                         && x.Model == model,
                    cancellationToken)
                .ConfigureAwait(false);

            if (failure is null)
            {
                // Nothing recorded yet means there is no streak to clear; skip the write so a healthy run
                // does not create one row per (provider, model) it ever touched.
                if (row is null) return;
                if (row.ConsecutiveFailures == 0 && row.CoolingUntil is null) return;

                row.ConsecutiveFailures = 0;
                row.CoolingUntil = null;
                row.LastCategory = null;
                row.UpdatedAt = now;
            }
            else
            {
                if (row is null)
                {
                    row = new ModelHealthRecord
                    {
                        Id = Guid.NewGuid(),
                        TenantId = scope.TenantId,
                        WorkspaceId = scope.WorkspaceId,
                        ProviderInstanceId = providerInstanceId,
                        Model = model,
                        ConsecutiveFailures = 0
                    };
                    db.Health.Add(row);
                }

                row.ConsecutiveFailures++;
                row.LastCategory = failure;
                row.UpdatedAt = now;

                if (row.ConsecutiveFailures >= _options.FailureThreshold)
                {
                    // The streak restarts from zero: after the cooldown one more failure should not
                    // immediately re-open the breaker without the provider having had a chance.
                    row.ConsecutiveFailures = 0;
                    row.CoolingUntil = now + _options.Cooldown;
                }
            }

            await db.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "Model health write failed for provider {Provider} / model {Model}.", providerInstanceId, model);
        }
    }
}
