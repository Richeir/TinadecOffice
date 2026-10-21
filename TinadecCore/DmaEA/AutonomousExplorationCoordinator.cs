using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using TinadecCore.Abstractions;
using TinadecCore.Abstractions.Ports;
using TinadecCore.Contracts.Dtos;

namespace TinadecCore.DmaEA;

/// <summary>
/// What the autonomous coordinator needs to know about a run: the frozen policy (which decides
/// whether planning is event-driven at all, and its knobs) and the four ids every ledger/coverage
/// read is scoped by. Built by the engine from <c>RunState</c> and the frozen configuration.
/// </summary>
public sealed record AutonomousPlanningRun(
    Guid TenantId,
    Guid WorkspaceId,
    Guid SessionId,
    Guid RunId,
    ModeRuntimePolicyDto RuntimePolicy);

public enum AutonomousPlanningTick
{
    Idle,
    Woken,
    Closed,
    CoverageDigest
}

/// <summary>
/// B3: turns the noisy facts of a run (worker settlements, steering, budgets) into one debounced
/// planning tick, and closes the planning loop when the ledger is empty and coverage is sufficient.
///
/// The coordinator does not call a model. A tick is a <c>plan_tick</c> notification to the run's
/// standing subscribers, so the planner takes its own turn through the same organization path every
/// other standing member uses; whatever it decides it writes through <c>plan_ledger_update</c>. That
/// keeps the planner's identity, prompt and tools in the pack instead of in Core.
///
/// Two timers:
/// a trailing debounce (three events in a burst wake the planner once) and a heartbeat (open intents
/// with no events still get a planner turn). Close-out waits one heartbeat after the last wake, so a
/// planner still taking its turn is never closed out from under itself.
/// </summary>
public sealed class AutonomousExplorationCoordinator
{
    private static readonly TimeSpan IdleStateLifetime = TimeSpan.FromHours(2);
    private readonly IGovernanceTopicSink _topics;
    private readonly IPlanLedger? _ledger;
    private readonly IExplorationGraph? _graph;
    private readonly TimeProvider _time;
    private readonly ILogger<AutonomousExplorationCoordinator>? _logger;
    private readonly ConcurrentDictionary<Guid, PlanningState> _runs = new();

    public AutonomousExplorationCoordinator(
        IGovernanceTopicSink topics,
        IPlanLedger? ledger = null,
        IExplorationGraph? graph = null,
        TimeProvider? time = null,
        ILogger<AutonomousExplorationCoordinator>? logger = null)
    {
        _topics = topics;
        _ledger = ledger;
        _graph = graph;
        _time = time ?? TimeProvider.System;
        _logger = logger;
    }

    /// <summary>
    /// Records one run fact. The raw topic is forwarded to whoever subscribed to that fact; the
    /// planning wake itself is coalesced and raised by <see cref="TickAsync"/>. Returns false when
    /// the run's policy does not enable event-driven planning.
    /// </summary>
    public async Task<bool> ObserveAsync(AutonomousPlanningRun run, string topic, string summary, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(run);
        if (!ModeRuntimePolicyRegistry.Has(run.RuntimePolicy, ModeRuntimePolicyRegistry.EventDrivenPlanningFeature))
            return false;
        if (!IsPlanningEvent(topic)) return false;

        var state = _runs.GetOrAdd(run.RunId, _ => new PlanningState(run));
        var now = _time.GetUtcNow();
        lock (state.Gate)
        {
            state.Run = run;
            if (state.Closed) return false;
            state.LastEventAt = now;
            state.PendingSince ??= now;
            state.PendingEvents++;
            state.LatestSummary = summary;
        }

        // Best-effort and out of the lock: a subscriber to the raw fact hears it immediately even
        // while the planning wake is still being debounced.
        try
        {
            await _topics.RaiseAsync(new GovernanceTopicSignal(run.SessionId, run.RunId, topic, Clip(summary, 400)), cancellationToken)
                .ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
        {
            _logger?.TryLogDebug(ex, "Could not forward planning event {Topic} of run {RunId}.", topic, run.RunId);
        }
        return true;
    }

    /// <summary>Drives one run's timers. Serialized by the hosted service, and safe to call from tests.</summary>
    public async Task<AutonomousPlanningTick> TickAsync(Guid runId, CancellationToken cancellationToken = default)
    {
        if (!_runs.TryGetValue(runId, out var state)) return AutonomousPlanningTick.Idle;
        AutonomousPlanningRun run;
        string? debouncedSummary = null;
        bool evaluate = false;
        AutonomousExplorationSettings settings;
        var now = _time.GetUtcNow();
        lock (state.Gate)
        {
            if (state.Closed) return AutonomousPlanningTick.Idle;
            run = state.Run;
            settings = AutonomousExplorationSettings.From(run.RuntimePolicy.Settings);
            if (state.PendingSince is not null
                && now - state.LastEventAt >= TimeSpan.FromMilliseconds(settings.PlannerDebounceMs))
            {
                debouncedSummary = $"{state.PendingEvents} planning event(s) since the last tick; latest: {Clip(state.LatestSummary, 240)}";
                state.PendingSince = null;
                state.PendingEvents = 0;
                state.LatestSummary = null;
                state.LastWakeAt = now;
                state.Wakes++;
            }
            else if (state.PendingSince is null && state.LastWakeAt is { } lastWake
                && now - lastWake >= TimeSpan.FromMilliseconds(settings.PlannerHeartbeatMs))
            {
                // Stamp the evaluation itself: a heartbeat that finds open intents (or a close-out
                // that still has uncovered assets) must wait another full heartbeat before
                // raising again, or the 500 ms timer would turn one slow plan into a wake storm.
                evaluate = true;
                state.LastWakeAt = now;
            }
        }

        if (debouncedSummary is not null)
        {
            await RaiseAsync(run, debouncedSummary, cancellationToken).ConfigureAwait(false);
            return AutonomousPlanningTick.Woken;
        }
        if (!evaluate) return AutonomousPlanningTick.Idle;

        bool openIntents;
        try
        {
            openIntents = await HasOpenIntentsAsync(run, cancellationToken).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
        {
            _logger?.TryLogDebug(ex, "Could not read the plan ledger of run {RunId}.", run.RunId);
            return AutonomousPlanningTick.Idle;
        }
        if (openIntents)
        {
            await RaiseAsync(run, $"heartbeat: the plan still has open intents after {settings.PlannerHeartbeatMs} ms without an event.",
                cancellationToken).ConfigureAwait(false);
            return AutonomousPlanningTick.Woken;
        }

        return await CloseOutAsync(state, run, settings, cancellationToken).ConfigureAwait(false);
    }

    /// <summary>One pass over the runs that reported an event. The hosted service calls this on a timer.</summary>
    public async Task<int> TickAllAsync(CancellationToken cancellationToken = default)
    {
        var acted = 0;
        var now = _time.GetUtcNow();
        foreach (var (runId, state) in _runs)
        {
            DateTimeOffset lastEvent;
            bool closed;
            lock (state.Gate) { lastEvent = state.LastEventAt; closed = state.Closed; }
            if (closed || now - lastEvent > IdleStateLifetime)
            {
                _runs.TryRemove(runId, out _);
                continue;
            }
            try
            {
                if (await TickAsync(runId, cancellationToken).ConfigureAwait(false) != AutonomousPlanningTick.Idle) acted++;
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                _logger?.TryLogWarning(ex, "Autonomous planning tick failed for run {RunId}.", runId);
            }
        }
        return acted;
    }

    /// <summary>Drops a finished run's timers. Called when a run reaches a terminal state.</summary>
    public void Forget(Guid runId) => _runs.TryRemove(runId, out _);

    private async Task<AutonomousPlanningTick> CloseOutAsync(
        PlanningState state,
        AutonomousPlanningRun run,
        AutonomousExplorationSettings settings,
        CancellationToken cancellationToken)
    {
        int wakes;
        lock (state.Gate) { wakes = state.Wakes; }
        // No planner has run yet: an empty ledger is silence, not consensus.
        if (wakes == 0) return AutonomousPlanningTick.Idle;
        if (_graph is null)
        {
            MarkClosed(state);
            return AutonomousPlanningTick.Closed;
        }

        var scope = new ExplorationScope(run.TenantId, run.WorkspaceId, run.SessionId, run.RunId);
        ExplorationCoverage coverage;
        try
        {
            coverage = await _graph.CoverageAsync(scope, cancellationToken).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
        {
            _logger?.TryLogDebug(ex, "Could not read coverage of run {RunId}.", run.RunId);
            return AutonomousPlanningTick.Idle;
        }
        if (coverage.Ratio >= settings.CoverageMinRatio)
        {
            MarkClosed(state);
            return AutonomousPlanningTick.Closed;
        }

        var uncovered = coverage.Uncovered;
        var text = $"Coverage {coverage.Covered}/{coverage.Total} (ratio {coverage.Ratio:0.###}) is below the required "
            + $"{settings.CoverageMinRatio:0.###}. Assets no fact or finding has looked at yet:\n"
            + string.Join("\n", uncovered.Select(asset => $"- {asset.Key} ({asset.Kind}){OptionalTitle(asset.Title)}"));
        try
        {
            await _graph.DigestAsync(scope, new ExplorationDigestDraft(
                "Uncovered assets at plan close-out",
                text,
                Summary: text,
                SourceKey: $"plan-closeout:{run.RunId:N}:{CoverageKey(uncovered)}"), cancellationToken).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
        {
            _logger?.TryLogDebug(ex, "Could not record the close-out digest of run {RunId}.", run.RunId);
        }
        await RaiseAsync(run,
            $"coverage {coverage.Covered}/{coverage.Total} is below {settings.CoverageMinRatio:0.###}; "
            + $"{uncovered.Count} asset(s) remain uncovered: {string.Join(", ", uncovered.Take(8).Select(asset => asset.Key))}",
            cancellationToken).ConfigureAwait(false);
        return AutonomousPlanningTick.CoverageDigest;
    }

    private async Task RaiseAsync(AutonomousPlanningRun run, string summary, CancellationToken cancellationToken)
    {
        try
        {
            await _topics.RaiseAsync(new GovernanceTopicSignal(run.SessionId, run.RunId, GovernanceTopics.PlanTick, summary), cancellationToken)
                .ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
        {
            _logger?.TryLogDebug(ex, "Could not raise a planning tick for run {RunId}.", run.RunId);
        }
    }

    private async Task<bool> HasOpenIntentsAsync(AutonomousPlanningRun run, CancellationToken cancellationToken)
    {
        if (_ledger is null) return false;
        var intents = await _ledger.ListAsync(
            new PlanLedgerScope(run.TenantId, run.WorkspaceId, run.SessionId, run.RunId),
            cancellationToken: cancellationToken).ConfigureAwait(false);
        return intents.Any(intent => intent.Status is PlanIntentStatuses.Pending or PlanIntentStatuses.Running);
    }

    private void MarkClosed(PlanningState state)
    {
        lock (state.Gate) { state.Closed = true; }
        _runs.TryRemove(state.Run.RunId, out _);
    }

    private static bool IsPlanningEvent(string? topic) =>
        topic is not null && topic.Trim() is var value
        && (string.Equals(value, GovernanceTopics.WorkerSettled, StringComparison.OrdinalIgnoreCase)
            || string.Equals(value, GovernanceTopics.UserSteer, StringComparison.OrdinalIgnoreCase)
            || string.Equals(value, GovernanceTopics.BudgetTick, StringComparison.OrdinalIgnoreCase)
            || string.Equals(value, "exploration_record", StringComparison.OrdinalIgnoreCase));

    private static string CoverageKey(IReadOnlyList<ExplorationAsset> uncovered)
    {
        var material = string.Join("\n", uncovered.Select(asset => asset.Key).OrderBy(key => key, StringComparer.Ordinal));
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(material)))[..16].ToLowerInvariant();
    }

    private static string OptionalTitle(string? title) => string.IsNullOrWhiteSpace(title) ? string.Empty : $" — {title}";

    private static string Clip(string? value, int max)
    {
        if (string.IsNullOrWhiteSpace(value)) return string.Empty;
        var text = value.Trim();
        return text.Length <= max ? text : text[..max] + "…";
    }

    private sealed class PlanningState(AutonomousPlanningRun run)
    {
        public object Gate { get; } = new();
        public AutonomousPlanningRun Run { get; set; } = run;
        public DateTimeOffset? PendingSince { get; set; }
        public DateTimeOffset LastEventAt { get; set; }
        public DateTimeOffset? LastWakeAt { get; set; }
        public int PendingEvents { get; set; }
        public string? LatestSummary { get; set; }
        public int Wakes { get; set; }
        public bool Closed { get; set; }
    }
}

/// <summary>Runs the coordinator's timers. One tick every 500 ms is enough for a millisecond-scale
/// debounce and cheap because it only iterates runs that reported an event in this process.</summary>
public sealed class AutonomousExplorationCoordinatorService : BackgroundService
{
    private static readonly TimeSpan Interval = TimeSpan.FromMilliseconds(500);
    private readonly AutonomousExplorationCoordinator _coordinator;

    public AutonomousExplorationCoordinatorService(AutonomousExplorationCoordinator coordinator) => _coordinator = coordinator;

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(Interval);
        try
        {
            while (await timer.WaitForNextTickAsync(stoppingToken).ConfigureAwait(false))
                await _coordinator.TickAllAsync(stoppingToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
        }
    }
}
