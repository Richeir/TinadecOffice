using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using TinadecCore.Abstractions.Ports;
using TinadecCore.Contracts.Dtos;
using TinadecCore.DmaEA;
using TinadecCore.Tools;

namespace TinadecCore.Api.Tests;

/// <summary>
/// B3: the event-driven planner wake. A burst of run facts wakes the planner once; a plan with open
/// intents keeps a heartbeat; a plan with nothing open closes the loop, or records the assets nobody
/// looked at and asks again. None of this runs unless the frozen policy enables it.
/// </summary>
public sealed class AutonomousExplorationCoordinatorTests : IAsyncLifetime
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "tinadec-autonomous-planning-tests", Guid.NewGuid().ToString("N"));
    private Factory? _factory;

    public Task InitializeAsync()
    {
        Directory.CreateDirectory(_root);
        return Task.CompletedTask;
    }

    public async Task DisposeAsync()
    {
        _factory?.Dispose();
        Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
        for (var attempt = 0; attempt < 5 && Directory.Exists(_root); attempt++)
        {
            try { Directory.Delete(_root, recursive: true); break; }
            catch (IOException) { await Task.Delay(300); }
        }
    }

    [Fact]
    public async Task ABurstOfEventsWakesThePlannerOnce_AndTheRawFactsStillArriveImmediately()
    {
        _factory = new Factory(_root);
        var (ledger, graph, tenant, workspace) = Services();
        var time = new ManualTime { Now = new DateTimeOffset(2026, 10, 21, 8, 0, 0, TimeSpan.Zero) };
        var topics = new RecordingTopics();
        var coordinator = new AutonomousExplorationCoordinator(topics, ledger, graph, time);
        var run = PlanningRun(tenant, workspace, Policy(debounceMs: 1500, heartbeatMs: 30000));

        Assert.True(await coordinator.ObserveAsync(run, GovernanceTopics.WorkerSettled, "worker A settled"));
        Assert.True(await coordinator.ObserveAsync(run, GovernanceTopics.UserSteer, "look at the retry path"));
        Assert.True(await coordinator.ObserveAsync(run, GovernanceTopics.BudgetTick, "half the budget is gone"));

        // The raw facts are forwarded as they happen; only the planning wake is coalesced.
        Assert.Equal(3, topics.Signals.Count);
        Assert.Equal([GovernanceTopics.WorkerSettled, GovernanceTopics.UserSteer, GovernanceTopics.BudgetTick],
            topics.Signals.Select(signal => signal.Topic));
        Assert.All(topics.Signals, signal => Assert.Equal(run.RunId, signal.RunId));

        time.Now += TimeSpan.FromMilliseconds(1499);
        Assert.Equal(AutonomousPlanningTick.Idle, await coordinator.TickAsync(run.RunId));
        Assert.DoesNotContain(topics.Signals, signal => signal.Topic == GovernanceTopics.PlanTick);

        time.Now += TimeSpan.FromMilliseconds(1);
        Assert.Equal(AutonomousPlanningTick.Woken, await coordinator.TickAsync(run.RunId));
        var wake = Assert.Single(topics.Signals, signal => signal.Topic == GovernanceTopics.PlanTick);
        Assert.Contains("3 planning event(s) since the last tick", wake.Summary, StringComparison.Ordinal);
        Assert.Contains("latest: half the budget is gone", wake.Summary, StringComparison.Ordinal);

        // The pending burst is consumed; the next wake is the heartbeat, not another debounce.
        Assert.Equal(AutonomousPlanningTick.Idle, await coordinator.TickAsync(run.RunId));
        Assert.Single(topics.Signals, signal => signal.Topic == GovernanceTopics.PlanTick);
    }

    [Fact]
    public async Task AnOpenPlanKeepsAWakeHeartbeat_AndAQuietEmptyPlanClosesTheLoop()
    {
        _factory = new Factory(_root);
        var (ledger, graph, tenant, workspace) = Services();
        var time = new ManualTime { Now = new DateTimeOffset(2026, 10, 21, 8, 0, 0, TimeSpan.Zero) };
        var topics = new RecordingTopics();
        var coordinator = new AutonomousExplorationCoordinator(topics, ledger, graph, time);
        var run = PlanningRun(tenant, workspace, Policy(debounceMs: 200, heartbeatMs: 1000));
        var scope = new PlanLedgerScope(tenant, workspace, run.SessionId, run.RunId, AgentInstanceId: Guid.NewGuid());
        var intent = Assert.Single(await ledger.AddAsync(scope, [new PlanIntentDraft("read the retry path")]));

        await coordinator.ObserveAsync(run, GovernanceTopics.WorkerSettled, "worker A settled");
        time.Now += TimeSpan.FromMilliseconds(200);
        Assert.Equal(AutonomousPlanningTick.Woken, await coordinator.TickAsync(run.RunId));

        // The planner claimed the intent; the heartbeat keeps the still-open plan from going silent.
        await ledger.ClaimAsync(scope, intent.Id);
        time.Now += TimeSpan.FromMilliseconds(1000);
        Assert.Equal(AutonomousPlanningTick.Woken, await coordinator.TickAsync(run.RunId));
        Assert.Contains(topics.Signals, signal => signal.Topic == GovernanceTopics.PlanTick
            && signal.Summary.Contains("heartbeat", StringComparison.Ordinal));
        // The heartbeat itself resets the clock: the next timer pass cannot wake twice in a row.
        Assert.Equal(AutonomousPlanningTick.Idle, await coordinator.TickAsync(run.RunId));

        await ledger.CompleteAsync(scope, intent.Id, "checked");
        time.Now += TimeSpan.FromMilliseconds(1000);
        Assert.Equal(AutonomousPlanningTick.Closed, await coordinator.TickAsync(run.RunId));
        Assert.Equal(AutonomousPlanningTick.Idle, await coordinator.TickAsync(run.RunId));
    }

    [Fact]
    public async Task AnEmptyPlanWithThinCoverageRecordsTheUncoveredAssets_AndAsksAgainNoSoonerThanAHeartbeat()
    {
        _factory = new Factory(_root);
        var (ledger, graph, tenant, workspace) = Services();
        var time = new ManualTime { Now = new DateTimeOffset(2026, 10, 21, 8, 0, 0, TimeSpan.Zero) };
        var topics = new RecordingTopics();
        var coordinator = new AutonomousExplorationCoordinator(topics, ledger, graph, time);
        var run = PlanningRun(tenant, workspace, Policy(debounceMs: 200, heartbeatMs: 1000, coverageMinRatio: 1.0));
        var scope = new ExplorationScope(tenant, workspace, run.SessionId, run.RunId);
        await graph.UpsertAssetAsync(scope, new ExplorationAssetDraft("src/Order.cs", ExplorationAssetKinds.File));

        await coordinator.ObserveAsync(run, "exploration_record", "recorded something");
        time.Now += TimeSpan.FromMilliseconds(200);
        Assert.Equal(AutonomousPlanningTick.Woken, await coordinator.TickAsync(run.RunId));

        time.Now += TimeSpan.FromMilliseconds(1000);
        Assert.Equal(AutonomousPlanningTick.CoverageDigest, await coordinator.TickAsync(run.RunId));
        var digest = Assert.Single(await graph.QueryAsync(scope, new ExplorationQuery(Kind: ExplorationNodeKinds.Digest)));
        Assert.Contains("src/Order.cs", digest.Content, StringComparison.Ordinal);
        Assert.Contains(topics.Signals, signal => signal.Topic == GovernanceTopics.PlanTick
            && signal.Summary.Contains("1 asset(s) remain uncovered", StringComparison.Ordinal));

        // Still short of coverage, but not a wake storm: the digest waits for the next heartbeat.
        Assert.Equal(AutonomousPlanningTick.Idle, await coordinator.TickAsync(run.RunId));
        time.Now += TimeSpan.FromMilliseconds(1000);
        Assert.Equal(AutonomousPlanningTick.CoverageDigest, await coordinator.TickAsync(run.RunId));
        // The close-out digest is idempotent: a second pass reuses its source key.
        Assert.Single(await graph.QueryAsync(scope, new ExplorationQuery(Kind: ExplorationNodeKinds.Digest)));
    }

    [Fact]
    public async Task OnlyPlanningFactsOfAnEventDrivenPolicyAreObserved()
    {
        _factory = new Factory(_root);
        var (ledger, graph, tenant, workspace) = Services();
        var time = new ManualTime { Now = new DateTimeOffset(2026, 10, 21, 8, 0, 0, TimeSpan.Zero) };
        var topics = new RecordingTopics();
        var coordinator = new AutonomousExplorationCoordinator(topics, ledger, graph, time);

        var withoutFeature = PlanningRun(tenant, workspace, new ModeRuntimePolicyDto
        {
            Kind = ModeRuntimePolicyRegistry.AutonomousExplorationKind,
            Version = ModeRuntimePolicyRegistry.AutonomousExplorationVersion,
            Features = [ModeRuntimePolicyRegistry.ExplorationGraphFeature]
        });
        Assert.False(await coordinator.ObserveAsync(withoutFeature, GovernanceTopics.WorkerSettled, "settled"));
        Assert.Empty(topics.Signals);

        var run = PlanningRun(tenant, workspace, Policy());
        Assert.False(await coordinator.ObserveAsync(run, GovernanceTopics.TaskCreated, "task created"));
        Assert.False(await coordinator.ObserveAsync(run, GovernanceTopics.TaskClosed, "task closed"));
        Assert.Empty(topics.Signals);
        Assert.Equal(AutonomousPlanningTick.Idle, await coordinator.TickAsync(run.RunId));
    }

    [Fact]
    public void TheBudgetAndSteeringFactsArePlanningEvents()
    {
        Assert.Equal(ModeRuntimePolicyRegistry.PlanLedgerFeature,
            ModeRuntimePolicyRegistry.Definition(ModeRuntimePolicyRegistry.AutonomousExplorationKind, 1)!
                .Dependencies.Single(dependency => dependency.Feature == ModeRuntimePolicyRegistry.EventDrivenPlanningFeature).Requires);
        Assert.True(ModeRuntimePolicyRegistry.Has(Policy(), ModeRuntimePolicyRegistry.EventDrivenPlanningFeature));
        Assert.Contains(GovernanceTopics.PlanTick, GovernanceTopics.All);
        Assert.Contains(GovernanceTopics.WorkerSettled, GovernanceTopics.All);
        Assert.Contains(GovernanceTopics.UserSteer, GovernanceTopics.All);
        Assert.Contains(GovernanceTopics.BudgetTick, GovernanceTopics.All);
    }

    private static AutonomousPlanningRun PlanningRun(Guid tenant, Guid workspace, ModeRuntimePolicyDto policy) =>
        new(tenant, workspace, Guid.NewGuid(), Guid.NewGuid(), policy);

    private static ModeRuntimePolicyDto Policy(int debounceMs = 1500, int heartbeatMs = 30000, double coverageMinRatio = 0.6) => new()
    {
        Kind = ModeRuntimePolicyRegistry.AutonomousExplorationKind,
        Version = ModeRuntimePolicyRegistry.AutonomousExplorationVersion,
        Features =
        [
            ModeRuntimePolicyRegistry.ExplorationGraphFeature,
            ModeRuntimePolicyRegistry.PlanLedgerFeature,
            ModeRuntimePolicyRegistry.EventDrivenPlanningFeature
        ],
        Settings = System.Text.Json.JsonSerializer.SerializeToElement(new
        {
            planner_debounce_ms = debounceMs,
            planner_heartbeat_ms = heartbeatMs,
            coverage_min_ratio = coverageMinRatio
        })
    };

    private (IPlanLedger Ledger, IExplorationGraph Graph, Guid Tenant, Guid Workspace) Services()
    {
        _ = _factory!.CreateClient();
        var scope = _factory.Services.GetRequiredService<ITenantContextAccessor>().Current;
        return (_factory.Services.GetRequiredService<IPlanLedger>(), _factory.Services.GetRequiredService<IExplorationGraph>(),
            scope.TenantId, scope.WorkspaceId);
    }

    private sealed class ManualTime : TimeProvider
    {
        public DateTimeOffset Now { get; set; }
        public override DateTimeOffset GetUtcNow() => Now;
    }

    private sealed class RecordingTopics : IGovernanceTopicSink
    {
        private readonly object _gate = new();
        private readonly List<GovernanceTopicSignal> _signals = [];
        public IReadOnlyList<GovernanceTopicSignal> Signals { get { lock (_gate) return _signals.ToArray(); } }
        public Task RaiseAsync(GovernanceTopicSignal signal, CancellationToken cancellationToken = default)
        {
            lock (_gate) _signals.Add(signal);
            return Task.CompletedTask;
        }
    }

    private sealed class NoEmbeddings : IEmbeddingProvider
    {
        public Task<EmbeddingResult> GenerateAsync(EmbeddingRequest request, CancellationToken cancellationToken = default) =>
            Task.FromResult(new EmbeddingResult { IsAvailable = false, Detail = "No embedding model is configured." });
    }

    private sealed class Factory(string root) : IsolatedApiFactory
    {
        protected override void ConfigureIsolatedWebHost(IWebHostBuilder builder) => builder
            .ConfigureAppConfiguration((_, config) => config.AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["TinadecPersistence:Sqlite:DatabasePath"] = Path.Combine(root, "tinadec.db"),
                ["TinadecPersistence:DataRoot"] = Path.Combine(root, "data"),
                ["TinadecEvidence:IndexEnabled"] = "false",
                ["Logging:LogLevel:Default"] = "Warning"
            }))
            .ConfigureServices(services =>
                services.Replace(ServiceDescriptor.Singleton<IEmbeddingProvider, NoEmbeddings>()));
    }
}
