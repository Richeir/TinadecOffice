using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using TinadecCore.Abstractions.Ports;
using TinadecCore.Contracts.Dtos;
using TinadecCore.DmaEA;

namespace TinadecCore.Api.Tests;

/// <summary>
/// B4 worker settlement: a terminal result becomes an exploration finding only when it cites a tool
/// execution or the archived result, and the plan intents the finishing worker claimed move with it.
/// Everything is gated by the frozen policy, and ownership stays the ledger's decision.
/// </summary>
public sealed class WorkerSettlementTests : IAsyncLifetime
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "tinadec-worker-settlement-tests", Guid.NewGuid().ToString("N"));
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
    public async Task ACitedCompletionWritesAFinding_AndClosesTheWorkersClaim()
    {
        _factory = new Factory(_root);
        var (settlement, ledger, graph, tenant, workspace) = Services();
        var session = Guid.NewGuid();
        var runId = Guid.NewGuid();
        var worker = Guid.NewGuid();
        var task = Guid.NewGuid();
        var scope = new PlanLedgerScope(tenant, workspace, session, runId, AgentInstanceId: worker);
        var intent = Assert.Single(await ledger.AddAsync(scope, [new PlanIntentDraft("check the endpoint")]));
        await ledger.ClaimAsync(scope, intent.Id);

        var executionId = Guid.NewGuid();
        var evidenceId = Guid.NewGuid();
        var result = await settlement.SettleAsync(State(tenant, workspace, session, runId), Configuration(Policy()),
            new WorkerSettlementRequest(task, "Check the endpoint", "completed", "GET /orders returns 200",
                "worker#1", "artex_worker", worker, 3, [executionId.ToString()], evidenceId));

        Assert.True(result.Applied);
        Assert.Equal(ExplorationNodeKinds.Finding, result.NodeKind);
        Assert.Equal([$"evidence:{evidenceId:N}", $"execution:{executionId:D}"], result.EvidenceRefs);
        Assert.Equal(1, result.IntentsUpdated);

        var node = Assert.Single(await SettlementNodesAsync(graph, tenant, workspace, session, runId));
        Assert.Equal("Check the endpoint", node.Title);
        Assert.Equal(task, node.TaskId);
        Assert.Equal(worker, node.AgentInstanceId);
        Assert.Equal("worker#1", node.Author);
        Assert.Contains($"execution:{executionId:D}", node.EvidenceRefs);
        var done = Assert.Single(await ledger.ListAsync(scope, PlanIntentStatuses.Done));
        Assert.Equal(intent.Id, done.Id);
        Assert.Contains("GET /orders returns 200", done.Note, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ACompletionWithoutCitationsIsOnlyAHint()
    {
        _factory = new Factory(_root);
        var (settlement, _, graph, tenant, workspace) = Services();
        var session = Guid.NewGuid();
        var runId = Guid.NewGuid();

        var result = await settlement.SettleAsync(State(tenant, workspace, session, runId), Configuration(Policy()),
            new WorkerSettlementRequest(Guid.NewGuid(), "A guess", "completed", "It probably works.",
                null, "artex_worker", Guid.NewGuid(), 1, [], null));

        Assert.True(result.Applied);
        Assert.Equal(ExplorationNodeKinds.Hint, result.NodeKind);
        Assert.Empty(result.EvidenceRefs);
        Assert.Equal(ExplorationNodeKinds.Hint,
            Assert.Single(await SettlementNodesAsync(graph, tenant, workspace, session, runId)).Kind);
    }

    [Fact]
    public async Task WithoutTheFeatureNothingIsWritten()
    {
        _factory = new Factory(_root);
        var (settlement, ledger, graph, tenant, workspace) = Services();
        var session = Guid.NewGuid();
        var runId = Guid.NewGuid();
        var worker = Guid.NewGuid();
        var scope = new PlanLedgerScope(tenant, workspace, session, runId, AgentInstanceId: worker);
        var intent = Assert.Single(await ledger.AddAsync(scope, [new PlanIntentDraft("check the endpoint")]));
        await ledger.ClaimAsync(scope, intent.Id);

        var result = await settlement.SettleAsync(State(tenant, workspace, session, runId),
            Configuration(Policy(withSettlement: false)),
            new WorkerSettlementRequest(Guid.NewGuid(), "Check the endpoint", "completed", "It works.",
                "worker#1", "artex_worker", worker, 1, [Guid.NewGuid().ToString()], Guid.NewGuid()));

        Assert.False(result.Applied);
        Assert.Empty(await SettlementNodesAsync(graph, tenant, workspace, session, runId));
        Assert.Equal(PlanIntentStatuses.Running, Assert.Single(await ledger.ListAsync(scope, PlanIntentStatuses.Running)).Status);
    }

    [Fact]
    public async Task AFailedTaskBlocksItsOwnClaim_AndLeavesAnotherWorkersClaimRunning()
    {
        _factory = new Factory(_root);
        var (settlement, ledger, graph, tenant, workspace) = Services();
        var session = Guid.NewGuid();
        var runId = Guid.NewGuid();
        var workerA = Guid.NewGuid();
        var workerB = Guid.NewGuid();
        var scopeA = new PlanLedgerScope(tenant, workspace, session, runId, AgentInstanceId: workerA);
        var scopeB = new PlanLedgerScope(tenant, workspace, session, runId, AgentInstanceId: workerB);
        var first = Assert.Single(await ledger.AddAsync(scopeA, [new PlanIntentDraft("worker A's intent")]));
        var second = Assert.Single(await ledger.AddAsync(scopeB, [new PlanIntentDraft("worker B's intent")]));
        await ledger.ClaimAsync(scopeA, first.Id);
        await ledger.ClaimAsync(scopeB, second.Id);

        var result = await settlement.SettleAsync(State(tenant, workspace, session, runId), Configuration(Policy()),
            new WorkerSettlementRequest(Guid.NewGuid(), "A failed task", "failed", "The fixture is missing.",
                "worker#1", "artex_worker", workerA, 2, [], null));

        Assert.True(result.Applied);
        Assert.Null(result.NodeKind);
        Assert.Equal(1, result.IntentsUpdated);
        Assert.Empty(await SettlementNodesAsync(graph, tenant, workspace, session, runId));
        var blocked = Assert.Single(await ledger.ListAsync(scopeA, PlanIntentStatuses.Blocked));
        Assert.Equal(first.Id, blocked.Id);
        Assert.Contains("fixture is missing", blocked.Note, StringComparison.Ordinal);
        Assert.Equal(second.Id, Assert.Single(await ledger.ListAsync(scopeB, PlanIntentStatuses.Running)).Id);
    }

    private async Task<IReadOnlyList<ExplorationNode>> SettlementNodesAsync(
        IExplorationGraph graph, Guid tenant, Guid workspace, Guid session, Guid runId) =>
        (await graph.QueryAsync(new ExplorationScope(tenant, workspace, session, runId), new ExplorationQuery(RunId: runId)))
        .Where(node => node.Kind is ExplorationNodeKinds.Finding or ExplorationNodeKinds.Hint)
        .ToArray();

    private static RunState State(Guid tenant, Guid workspace, Guid session, Guid runId) => new()
    {
        RunId = runId.ToString(),
        SessionId = session.ToString(),
        TenantId = tenant.ToString(),
        WorkspaceId = workspace.ToString(),
        InitiatedByPrincipalId = Guid.NewGuid().ToString()
    };

    private static FrozenRunConfigurationV1 Configuration(ModeRuntimePolicyDto policy)
    {
        var conversational = new RuntimeAgentDefinition("artex_director", "operation", "director", "persistent", [], true, "workspace");
        var worker = new RuntimeAgentDefinition("artex_worker", "operation", "worker", "persistent", [], false, "workspace");
        return new FrozenRunConfigurationV1(
            FrozenRunConfigurationV1.CurrentSchemaVersion, "baseline", 1, Guid.NewGuid(), "artex", "ask",
            new(2, 16, 4), new(2, 2, true), new(true, 2), new(65536, 128, true),
            new(true, 8, [], []), new("test", true, true, 60, 0),
            [conversational], [worker], [])
        {
            RuntimePolicy = policy,
            ToolManifest = []
        };
    }

    private static ModeRuntimePolicyDto Policy(bool withSettlement = true) => new()
    {
        Kind = ModeRuntimePolicyRegistry.AutonomousExplorationKind,
        Version = ModeRuntimePolicyRegistry.AutonomousExplorationVersion,
        Features = withSettlement
            ? ModeRuntimePolicyRegistry.AutonomousExplorationFeatures.ToArray()
            : [ModeRuntimePolicyRegistry.ExplorationGraphFeature, ModeRuntimePolicyRegistry.PlanLedgerFeature]
    };

    private (WorkerSettlementService Settlement, IPlanLedger Ledger, IExplorationGraph Graph, Guid Tenant, Guid Workspace) Services()
    {
        _ = _factory!.CreateClient();
        var scope = _factory.Services.GetRequiredService<ITenantContextAccessor>().Current;
        return (_factory.Services.GetRequiredService<WorkerSettlementService>(),
            _factory.Services.GetRequiredService<IPlanLedger>(),
            _factory.Services.GetRequiredService<IExplorationGraph>(),
            scope.TenantId, scope.WorkspaceId);
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
