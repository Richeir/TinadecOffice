using System.Net;

using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;

using TinadecCore.Abstractions.Ports;
using TinadecCore.DmaEA;
using TinadecCore.Models;

namespace TinadecCore.AgentFramework.Tests;

/// <summary>
/// The model health breaker is the only thing standing between a route with one candidate and a
/// permanently failing run: <c>ModelInvocationChatFactory</c> exhausts a single-candidate chain after
/// the bounded retries, so without a breaker every subsequent invocation pays the full backoff again.
///
/// <para>
/// Two rules carry the weight and both are asserted here rather than described: cooling must never
/// substitute a model the frozen plan did not declare (it reports <c>model_pool_exhausted</c>
/// instead), and the set of categories that cool a provider must be the same set the classifier
/// considers retryable. The second can only be expressed behaviourally — <c>ModelInvocationFailure</c>
/// is DmaEA-internal, so <see cref="ModelHealthPolicy"/> cannot reference its list, and a test is what
/// keeps the two from drifting apart.
/// </para>
/// </summary>
public sealed class ModelHealthPolicyTests
{
    private static readonly Guid Provider = Guid.Parse("11111111-1111-1111-1111-111111111111");

    // ---- the classifier and the breaker agree about what is transient ------------------------

    public static TheoryData<Exception> RetryableProviderFailures() => new()
    {
        new TimeoutException("The provider did not answer in time."),
        new TaskCanceledException("The call was abandoned by the runtime."),
        new IOException("The connection was reset."),
        new HttpRequestException("Name resolution failed."),
        new HttpRequestException("Too many requests.", null, HttpStatusCode.TooManyRequests),
        new HttpRequestException("Upstream broke.", null, HttpStatusCode.BadGateway),
        // The classifier's only other fallback: an exception carrying a sub-400 status. It retries it,
        // so the breaker has to count it; otherwise the same shape is retryable on one side and free
        // on the other.
        new StatusBearingException(200),
    };

    [Theory]
    [MemberData(nameof(RetryableProviderFailures))]
    public void EveryRetryableFailureCategory_AlsoCountsAgainstTheProvider(Exception exception)
    {
        var failure = ModelInvocationFailure.Classify(exception, CancellationToken.None);

        Assert.True(
            failure.CanFallback,
            $"{exception.GetType().Name} was expected to be retryable, but Classify said '{failure.Category}'.");
        Assert.True(
            ModelHealthPolicy.CountsAsFailure(failure.Category),
            $"The invocation factory retries '{failure.Category}' but ModelHealthPolicy does not count it, "
            + "so a provider failing exactly this way would never cool down. Add it to RetryableCategories.");
    }

    public static TheoryData<Exception> DeterministicFailures() => new()
    {
        new HttpRequestException("Bad request.", null, HttpStatusCode.BadRequest),
        new HttpRequestException("Unauthorized.", null, HttpStatusCode.Unauthorized),
        new HttpRequestException("Forbidden.", null, HttpStatusCode.Forbidden),
        new InvalidOperationException("The frozen plan named a model that does not exist."),
    };

    [Theory]
    [MemberData(nameof(DeterministicFailures))]
    public void DeterministicFailures_NeverCoolAProvider(Exception exception)
    {
        var failure = ModelInvocationFailure.Classify(exception, CancellationToken.None);

        Assert.False(failure.CanFallback);
        Assert.False(ModelHealthPolicy.CountsAsFailure(failure.Category));
    }

    [Fact]
    public void Cancellation_IsNeitherRetriedNorCounted()
    {
        using var cancelled = new CancellationTokenSource();
        cancelled.Cancel();

        var failure = ModelInvocationFailure.Classify(new OperationCanceledException(), cancelled.Token);

        Assert.True(failure.Cancelled);
        Assert.False(failure.CanFallback);
        Assert.False(ModelHealthPolicy.CountsAsFailure(failure.Category));
    }

    // ---- the filter -----------------------------------------------------------------------

    [Fact]
    public void CoolingKeys_OnlyAdmitsAvailableCandidatesWithAProviderAndAModel()
    {
        var chain = new List<ChatResolution>
        {
            Candidate(Provider, "model-a"),
            Candidate(Provider, "model-a"),                 // duplicate: one key, one record
            Candidate(Provider, null),                       // harness picks the model
            Candidate(null, "model-b"),                      // no provider instance
            new() { IsAvailable = false, Error = "no route" }
        };

        var keys = ModelHealthPolicy.CoolingKeys(chain);

        Assert.Equal(new[] { (Provider, "model-a") }, keys);
    }

    [Fact]
    public void CoolingKeys_EmptyChainYieldsNoKeys()
    {
        Assert.Empty(ModelHealthPolicy.CoolingKeys([]));
    }

    [Fact]
    public void ApplyCooling_WithNothingCooling_ReturnsTheSameChain()
    {
        IReadOnlyList<ChatResolution> chain = [Candidate(Provider, "model-a"), Candidate(Provider, "model-b")];

        var kept = ModelHealthPolicy.ApplyCooling(chain, new HashSet<(Guid, string)>());

        Assert.Same(chain, kept);
    }

    [Fact]
    public void ApplyCooling_RemovesOnlyTheCoolingCandidate_AndKeepsTheDeclaredOrder()
    {
        var other = Guid.NewGuid();
        IReadOnlyList<ChatResolution> chain =
        [
            Candidate(Provider, "model-a"),
            Candidate(other, "model-b"),
            Candidate(other, "model-c"),
        ];

        var kept = ModelHealthPolicy.ApplyCooling(chain, new HashSet<(Guid, string)> { (other, "model-b") });

        Assert.Equal(new[] { "model-a", "model-c" }, kept.Select(item => item.Model));
    }

    [Fact]
    public void ApplyCooling_LeavesAHarnessChosenModelAlone_EvenWhenEverythingElseIsCooling()
    {
        // A harness resolves without a model name because its binary chooses one. It has no stable key,
        // so cooling must not be able to remove it — that would silently disable every harness provider
        // the moment any keyed candidate on the same route went down.
        IReadOnlyList<ChatResolution> chain = [Candidate(Provider, "model-a"), Candidate(Provider, null)];

        var kept = ModelHealthPolicy.ApplyCooling(chain, new HashSet<(Guid, string)> { (Provider, "model-a") });

        Assert.Single(kept);
        Assert.Null(kept[0].Model);
        Assert.True(kept[0].IsAvailable);
    }

    [Fact]
    public void ApplyCooling_WhenEveryCandidateIsCooling_ReportsThePoolAndNeverSubstitutesAModel()
    {
        var second = Guid.NewGuid();
        IReadOnlyList<ChatResolution> chain = [Candidate(Provider, "model-a"), Candidate(second, "model-b")];

        var result = ModelHealthPolicy.ApplyCooling(
            chain,
            new HashSet<(Guid, string)> { (Provider, "model-a"), (second, "model-b") });

        var only = Assert.Single(result);
        Assert.False(only.IsAvailable);
        Assert.Equal(ModelHealthPolicy.PoolExhaustedCategory, only.UnavailableCategory);
        Assert.Contains("model-a", only.Error, StringComparison.Ordinal);
        Assert.Contains("model-b", only.Error, StringComparison.Ordinal);

        // Identity comes from the head of the chain so the caller can still attribute the failure to a
        // route; the model name is NOT swapped for a surviving one, because there is none.
        Assert.Equal(chain[0].Model, only.Model);
        Assert.Equal(Provider, only.ProviderInstanceId);
    }

    [Fact]
    public void ApplyCooling_EmptyChainStaysEmpty_NoFabricatedCandidate()
    {
        var result = ModelHealthPolicy.ApplyCooling([], new HashSet<(Guid, string)> { (Provider, "model-a") });

        Assert.Empty(result);
    }

    // ---- the durable registry --------------------------------------------------------------

    [Fact]
    public async Task Registry_CoolsOnlyAfterTheThreshold_AndOneSuccessClearsTheStreak()
    {
        using var db = new HealthDatabase();
        await db.EnsureCreatedAsync();
        var registry = db.Registry(threshold: 3);

        await registry.RecordFailureAsync(db.ProviderId, "model-a", "rate_limited");
        await registry.RecordFailureAsync(db.ProviderId, "model-a", "rate_limited");
        Assert.Empty(await registry.LoadCoolingAsync(Keys((db.ProviderId, "model-a"))));

        await registry.RecordFailureAsync(db.ProviderId, "model-a", "provider_server_error");
        Assert.Equal(
            Keys((db.ProviderId, "model-a")),
            await registry.LoadCoolingAsync(Keys((db.ProviderId, "model-a"))));

        await registry.RecordSuccessAsync(db.ProviderId, "model-a");
        Assert.Empty(await registry.LoadCoolingAsync(Keys((db.ProviderId, "model-a"))));

        // A success with nothing recorded must not create a row: a healthy workspace would otherwise
        // accumulate one row per (provider, model) it ever called.
        await registry.RecordSuccessAsync(Guid.NewGuid(), "never-failed");
        Assert.Equal(1, await db.CountRowsAsync());
    }

    [Fact]
    public async Task Registry_IgnoresDeterministicCategoriesAndModelsWithoutAName()
    {
        using var db = new HealthDatabase();
        await db.EnsureCreatedAsync();
        var registry = db.Registry(threshold: 1);

        for (var i = 0; i < 5; i++)
        {
            await registry.RecordFailureAsync(db.ProviderId, "model-a", "request_error");
            await registry.RecordFailureAsync(db.ProviderId, "model-a", "authentication_or_authorization");
            await registry.RecordFailureAsync(db.ProviderId, null, "rate_limited");
            await registry.RecordFailureAsync(db.ProviderId, "  ", "rate_limited");
        }

        Assert.Equal(0, await db.CountRowsAsync());
        Assert.Empty(await registry.LoadCoolingAsync(
            Keys((db.ProviderId, "model-a"), (db.ProviderId, ""))));
    }

    [Fact]
    public async Task Registry_ACooldownThatAlreadyElapsed_LetsTheCandidateBackIn()
    {
        using var db = new HealthDatabase();
        await db.EnsureCreatedAsync();
        var registry = db.Registry(threshold: 1, cooldown: TimeSpan.FromMilliseconds(-1));

        await registry.RecordFailureAsync(db.ProviderId, "model-a", "timeout");

        // The row must exist and carry a cooldown timestamp — otherwise this test would pass on an
        // implementation that simply never wrote anything.
        await using (var ctx = db.CreateContext())
        {
            var row = await ctx.Health.AsNoTracking().SingleAsync();
            Assert.Equal("timeout", row.LastCategory);
            Assert.NotNull(row.CoolingUntil);
        }

        Assert.Empty(await registry.LoadCoolingAsync(Keys((db.ProviderId, "model-a"))));
    }

    [Fact]
    public async Task Registry_WhenDisabled_NeitherReadsNorWrites()
    {
        using var db = new HealthDatabase();
        await db.EnsureCreatedAsync();
        var registry = db.Registry(threshold: 1, enabled: false);

        for (var i = 0; i < 3; i++)
            await registry.RecordFailureAsync(db.ProviderId, "model-a", "rate_limited");

        Assert.Equal(0, await db.CountRowsAsync());
        Assert.Empty(await registry.LoadCoolingAsync(Keys((db.ProviderId, "model-a"))));
    }

    [Fact]
    public async Task Registry_TwoWorkspacesOnTheSameFile_NeverShareAnOutage()
    {
        using var db = new HealthDatabase();
        await db.EnsureCreatedAsync();
        var workspaceA = db.Registry(threshold: 1);
        var workspaceB = db.Registry(threshold: 1, workspace: Guid.NewGuid());

        await workspaceA.RecordFailureAsync(db.ProviderId, "model-a", "rate_limited");

        Assert.Single(await workspaceA.LoadCoolingAsync(Keys((db.ProviderId, "model-a"))));
        Assert.Empty(await workspaceB.LoadCoolingAsync(Keys((db.ProviderId, "model-a"))));
    }

    [Fact]
    public void Options_ClampWhatTheConfigurationAsksFor_AndDefaultToThePolicy()
    {
        var defaults = ModelHealthOptions.From(null);
        Assert.True(defaults.Enabled);
        Assert.Equal(ModelHealthPolicy.DefaultFailureThreshold, defaults.FailureThreshold);
        Assert.Equal(ModelHealthPolicy.DefaultCooldownSeconds, (int)defaults.Cooldown.TotalSeconds);

        var configured = ModelHealthOptions.From(new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["TinadecModelHealth:FailureThreshold"] = "9999",
                ["TinadecModelHealth:CooldownSeconds"] = "1",
                ["TinadecModelHealth:Enabled"] = "false"
            })
            .Build());

        Assert.False(configured.Enabled);
        Assert.Equal(ModelHealthPolicy.MaxFailureThreshold, configured.FailureThreshold);
        Assert.Equal(ModelHealthPolicy.MinCooldownSeconds, (int)configured.Cooldown.TotalSeconds);
    }

    // ---- fixtures -------------------------------------------------------------------------

    private static (Guid ProviderInstanceId, string Model)[] Keys(
        params (Guid ProviderInstanceId, string Model)[] pairs) => pairs;

    private static ChatResolution Candidate(Guid? provider, string? model) => new()
    {
        IsAvailable = true,
        ProviderInstanceId = provider,
        Model = model,
        ModelId = model is null ? null : $"openai/{model}",
        BaseUrl = "http://localhost",
        ApiKey = "test-key",
        Protocol = ChatProtocols.OpenAiChat,
        CandidatePosition = 0,
    };

    /// <summary>An exception the classifier reads a status from that did not come from HTTP.</summary>
    private sealed class StatusBearingException(int status) : Exception("A provider wrapper failed.")
    {
        public int Status { get; } = status;
    }

    private sealed class FixedTenant(Guid tenantId, Guid workspaceId) : ITenantContextAccessor
    {
        public TenantContext Current { get; } = new(tenantId, workspaceId, Guid.Empty, "owner", IsDevelopment: true);
    }

    private sealed class TestContextFactory(DbContextOptions<ModelControlDbContext> options)
        : IDbContextFactory<ModelControlDbContext>
    {
        public ModelControlDbContext CreateDbContext() => new(options);
    }

    /// <summary>One real SQLite file per test, so the breaker is exercised against durable state.</summary>
    private sealed class HealthDatabase : IDisposable
    {
        private readonly string _root = Path.Combine(
            Path.GetTempPath(), "tinadec-model-health", Guid.NewGuid().ToString("N"));

        private readonly DbContextOptions<ModelControlDbContext> _options;

        public HealthDatabase()
        {
            Directory.CreateDirectory(_root);
            _options = new DbContextOptionsBuilder<ModelControlDbContext>()
                .UseSqlite($"Data Source={DatabasePath}")
                .Options;
        }

        public Guid TenantId { get; } = Guid.NewGuid();
        public Guid WorkspaceId { get; } = Guid.NewGuid();
        public Guid ProviderId { get; } = Guid.NewGuid();

        private string DatabasePath => Path.Combine(_root, "models.db");

        public ModelControlDbContext CreateContext() => new(_options);

        public async Task EnsureCreatedAsync()
        {
            await using var context = CreateContext();
            await context.Database.EnsureCreatedAsync();
        }

        public async Task<int> CountRowsAsync()
        {
            await using var context = CreateContext();
            return await context.Health.CountAsync();
        }

        public ModelHealthRegistry Registry(
            int threshold = ModelHealthPolicy.DefaultFailureThreshold,
            TimeSpan? cooldown = null,
            bool enabled = true,
            Guid? workspace = null) =>
            new(
                new TestContextFactory(_options),
                new FixedTenant(TenantId, workspace ?? WorkspaceId),
                new ModelHealthOptions(
                    enabled, threshold, cooldown ?? TimeSpan.FromMinutes(1)),
                NullLogger<ModelHealthRegistry>.Instance);

        public void Dispose()
        {
            SqliteConnection.ClearAllPools();
            try
            {
                Directory.Delete(_root, recursive: true);
            }
            catch (IOException)
            {
                // A pooled handle may still hold the file; the directory lives under the temp root.
            }
        }
    }
}
