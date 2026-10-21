using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using System.Text.Json;
using TinadecCore.Abstractions.Ports;
using TinadecCore.Contracts.Dtos;
using TinadecCore.DmaEA;
using TinadecCore.Tools;

namespace TinadecCore.Api.Tests;

/// <summary>
/// B2: the run's shared plan ledger. Ownership is enforced by the ledger, not by the caller; a
/// replan replaces only the open part of the plan; and the ledger is keyed by the run's own source
/// prefix so a free-form <c>exploration_record</c> intent never becomes schedulable work.
/// </summary>
public sealed class PlanLedgerTests : IAsyncLifetime
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "tinadec-plan-ledger-tests", Guid.NewGuid().ToString("N"));
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
    public async Task AClaimBelongsToItsWorker_AndNobodyElseMayFinishOrTakeIt()
    {
        _factory = new Factory(_root);
        var (ledger, tenant, workspace) = Services();
        var session = Guid.NewGuid();
        var run = Guid.NewGuid();
        var workerA = Guid.NewGuid();
        var workerB = Guid.NewGuid();
        var scopeA = new PlanLedgerScope(tenant, workspace, session, run, AgentInstanceId: workerA);
        var scopeB = new PlanLedgerScope(tenant, workspace, session, run, AgentInstanceId: workerB);

        var added = await ledger.AddAsync(scopeA, [new PlanIntentDraft("read the endpoint"), new PlanIntentDraft("write a test")]);
        Assert.Equal([1, 2], added.Select(intent => intent.Ordinal));
        Assert.All(added, intent => Assert.Equal(PlanIntentStatuses.Pending, intent.Status));

        var claimed = await ledger.ClaimAsync(scopeA, added[0].Id);
        Assert.Equal(PlanIntentStatuses.Running, claimed.Status);
        Assert.Equal(workerA, claimed.ClaimedByAgentInstanceId);
        // A retried claim from the owner is not a conflict.
        Assert.Equal(claimed, await ledger.ClaimAsync(scopeA, added[0].Id));

        var stolen = await Assert.ThrowsAsync<PlanLedgerDeniedException>(() => ledger.ClaimAsync(scopeB, added[0].Id));
        Assert.StartsWith("policy_denied:", stolen.Message, StringComparison.Ordinal);
        Assert.Contains("claimed by another worker", stolen.Message, StringComparison.Ordinal);
        var foreignComplete = await Assert.ThrowsAsync<PlanLedgerDeniedException>(() =>
            ledger.CompleteAsync(scopeB, added[0].Id, "looks fine"));
        Assert.Contains("claimed by another worker", foreignComplete.Message, StringComparison.Ordinal);

        // Finishing an intent nobody claimed is refused too: work starts with a claim.
        var unclaimed = await Assert.ThrowsAsync<PlanLedgerDeniedException>(() => ledger.CompleteAsync(scopeB, added[1].Id));
        Assert.Contains("still pending", unclaimed.Message, StringComparison.Ordinal);

        var done = await ledger.CompleteAsync(scopeA, added[0].Id, "checked against src/Order.cs");
        Assert.Equal(PlanIntentStatuses.Done, done.Status);
        Assert.Equal("checked against src/Order.cs", done.Note);
        // The owner replaying a completion after a lost response is not a conflict.
        Assert.Equal(done, await ledger.CompleteAsync(scopeA, added[0].Id, "checked against src/Order.cs"));

        var afterDone = await Assert.ThrowsAsync<PlanLedgerDeniedException>(() => ledger.ClaimAsync(scopeA, added[0].Id));
        Assert.Contains("already done", afterDone.Message, StringComparison.Ordinal);
        var blockedAfterDone = await Assert.ThrowsAsync<PlanLedgerDeniedException>(() =>
            ledger.BlockAsync(scopeA, added[0].Id, "too late"));
        Assert.Contains("already done", blockedAfterDone.Message, StringComparison.Ordinal);

        var second = await ledger.ClaimAsync(scopeA, added[1].Id);
        Assert.Equal(PlanIntentStatuses.Running, second.Status);
        var blocked = await ledger.BlockAsync(scopeA, added[1].Id, "the endpoint needs a fixture that does not exist");
        Assert.Equal(PlanIntentStatuses.Blocked, blocked.Status);
        Assert.Equal("the endpoint needs a fixture that does not exist", blocked.Note);
    }

    [Fact]
    public async Task AReplanReplacesOnlyTheOpenPart_AndKeepsWhatFinished()
    {
        _factory = new Factory(_root);
        var (ledger, tenant, workspace) = Services();
        var scope = new PlanLedgerScope(tenant, workspace, Guid.NewGuid(), Guid.NewGuid(), AgentInstanceId: Guid.NewGuid());

        var added = await ledger.AddAsync(scope,
            [new PlanIntentDraft("map the module", EvidenceRefs: ["tool:1"]), new PlanIntentDraft("write the fix"), new PlanIntentDraft("run the tests")]);
        await ledger.ClaimAsync(scope, added[0].Id);
        await ledger.CompleteAsync(scope, added[0].Id, "mapped");
        await ledger.ClaimAsync(scope, added[1].Id);

        var replanned = await ledger.ReplanAsync(scope,
            [new PlanIntentDraft("write the fix, second attempt", EvidenceRefs: ["tool:1", "tool:2"]), new PlanIntentDraft("verify on the fixture")]);
        Assert.Equal([4, 5], replanned.Select(intent => intent.Ordinal));
        Assert.All(replanned, intent => Assert.Equal(PlanIntentStatuses.Pending, intent.Status));
        Assert.Equal(["tool:1", "tool:2"], replanned[0].EvidenceRefs);

        var all = await ledger.ListAsync(scope);
        Assert.Equal([1, 2, 3, 4, 5], all.Select(intent => intent.Ordinal));
        Assert.Equal(
            [PlanIntentStatuses.Done, PlanIntentStatuses.Abandoned, PlanIntentStatuses.Abandoned, PlanIntentStatuses.Pending, PlanIntentStatuses.Pending],
            all.Select(intent => intent.Status));
        Assert.Equal("mapped", all[0].Note);
        Assert.Equal(["tool:1"], all[0].EvidenceRefs);
        Assert.Equal("Replaced by a replan.", all[1].Note);
        Assert.Equal("Replaced by a replan.", all[2].Note);
    }

    [Fact]
    public async Task TheLedgerIsScopedToItsRun_AndOnlyRunKeyedIntentsAreSchedulable()
    {
        _factory = new Factory(_root);
        var (ledger, graph, tenant, workspace) = GraphServices();
        var session = Guid.NewGuid();
        var run = Guid.NewGuid();
        var actor = Guid.NewGuid();
        var scope = new PlanLedgerScope(tenant, workspace, session, run, AgentInstanceId: actor);
        var added = await ledger.AddAsync(scope, [new PlanIntentDraft("the only real intent")]);

        // Another run in the same session keeps its own plan.
        var otherRun = new PlanLedgerScope(tenant, workspace, session, Guid.NewGuid(), AgentInstanceId: actor);
        Assert.Empty(await ledger.ListAsync(otherRun));
        // A foreign tenant cannot even name the intent.
        var foreign = new PlanLedgerScope(Guid.NewGuid(), workspace, session, run, AgentInstanceId: actor);
        Assert.Empty(await ledger.ListAsync(foreign));
        await Assert.ThrowsAsync<KeyNotFoundException>(() => ledger.ClaimAsync(foreign, added[0].Id));

        // An intent the model recorded as free-form exploration material is not part of the plan:
        // it has no run-prefixed source key, so a planner never schedules it.
        var free = await graph.AppendNodeAsync(new ExplorationScope(tenant, workspace, session, run),
            new ExplorationNodeDraft(ExplorationNodeKinds.Intent, "something the model mused about", SourceKey: "intent:free-form"));
        Assert.DoesNotContain(await ledger.ListAsync(scope), intent => intent.Id == free.Id);
        Assert.Single(await ledger.ListAsync(scope));

        // Writes need an actor: a scope without an agent instance cannot claim.
        var anonymous = new PlanLedgerScope(tenant, workspace, session, run);
        await Assert.ThrowsAsync<ArgumentException>(() => ledger.ClaimAsync(anonymous, added[0].Id));
    }

    [Fact]
    public async Task StatusFiltersNarrowTheLedger_AndUnknownStatesAreRefused()
    {
        _factory = new Factory(_root);
        var (ledger, tenant, workspace) = Services();
        var scope = new PlanLedgerScope(tenant, workspace, Guid.NewGuid(), Guid.NewGuid(), AgentInstanceId: Guid.NewGuid());
        var added = await ledger.AddAsync(scope, [new PlanIntentDraft("first"), new PlanIntentDraft("second")]);
        await ledger.ClaimAsync(scope, added[0].Id);
        await ledger.CompleteAsync(scope, added[0].Id);
        await ledger.ClaimAsync(scope, added[1].Id);

        Assert.Equal(added[0].Id, Assert.Single(await ledger.ListAsync(scope, PlanIntentStatuses.Done)).Id);
        Assert.Equal(added[1].Id, Assert.Single(await ledger.ListAsync(scope, PlanIntentStatuses.Running)).Id);
        Assert.Empty(await ledger.ListAsync(scope, PlanIntentStatuses.Pending));
        await Assert.ThrowsAsync<ArgumentException>(() => ledger.ListAsync(scope, "in-progress"));

        Assert.True(PlanIntentStatuses.IsTerminal(PlanIntentStatuses.Blocked));
        Assert.False(PlanIntentStatuses.IsTerminal(PlanIntentStatuses.Running));
    }

    [Fact]
    public void TheLedgerPromptShowsWhatIsOpen_WhoOwnsIt_AndWhyItStopped()
    {
        Assert.Null(PlanLedgerPrompt.Format([]));

        var agent = Guid.NewGuid();
        var now = DateTimeOffset.UtcNow;
        var prompt = PlanLedgerPrompt.Format(
        [
            new PlanIntent(Guid.NewGuid(), "run:1:intent:1", 1, "map the module", null, PlanIntentStatuses.Done,
                null, agent, ["tool:1"], "mapped", now, now),
            new PlanIntent(Guid.NewGuid(), "run:1:intent:2", 2, "write the fix", null, PlanIntentStatuses.Running,
                null, agent, [], null, now, now),
            new PlanIntent(Guid.NewGuid(), "run:1:intent:3", 3, "run the tests", null, PlanIntentStatuses.Blocked,
                null, agent, [], "the fixture is missing", now, now),
        ])!;
        Assert.Contains("open: 0 pending, 1 running; finished: 1 done; stopped: 1 blocked/abandoned", prompt, StringComparison.Ordinal);
        Assert.Contains("- #1 [done] map the module", prompt, StringComparison.Ordinal);
        Assert.Contains($"claimed by {agent}", prompt, StringComparison.Ordinal);
        Assert.Contains("evidence: tool:1", prompt, StringComparison.Ordinal);
        Assert.Contains("note: mapped", prompt, StringComparison.Ordinal);
        Assert.Contains("note: the fixture is missing", prompt, StringComparison.Ordinal);

        var many = Enumerable.Range(1, 45)
            .Select(ordinal => new PlanIntent(Guid.NewGuid(), $"run:1:intent:{ordinal}", ordinal, $"intent {ordinal}", null,
                PlanIntentStatuses.Pending, null, null, [], null, now, now))
            .ToArray();
        var bounded = PlanLedgerPrompt.Format(many)!;
        Assert.Contains("- #40 [pending] intent 40", bounded, StringComparison.Ordinal);
        Assert.DoesNotContain("- #41 [pending]", bounded, StringComparison.Ordinal);
        Assert.Contains("(5 more intents are not shown", bounded, StringComparison.Ordinal);
    }

    [Fact]
    public void ThePlanLedgerToolsAreCoreOwned_AndAdmittedOnlyWhenTheFeatureIsEnabled()
    {
        Assert.True(CoreVirtualToolPolicy.IsCoreVirtual(CoreVirtualToolPolicy.PlanLedgerReadToolId));
        Assert.True(CoreVirtualToolPolicy.IsCoreVirtual(CoreVirtualToolPolicy.PlanLedgerUpdateToolId));
        Assert.True(CoreVirtualToolPolicy.IsPlanLedgerRead(CoreVirtualToolPolicy.PlanLedgerReadToolId));
        Assert.False(CoreVirtualToolPolicy.IsPlanLedgerRead(CoreVirtualToolPolicy.PlanLedgerUpdateToolId));
        Assert.Equal(ModeRuntimePolicyRegistry.PlanLedgerFeature,
            ExplorationToolPolicy.RequiredFeature(CoreVirtualToolPolicy.PlanLedgerUpdateToolId));

        Assert.Null(PlanLedgerVirtualTools.ManifestEntry("read_file"));
        var read = PlanLedgerVirtualTools.ManifestEntry(CoreVirtualToolPolicy.PlanLedgerReadToolId)!;
        Assert.Equal(CoreVirtualToolPolicy.PlanLedgerReadToolId, read.Id);
        Assert.False(read.RequiresApproval);
        Assert.False(read.MutatesWorkspace);
        Assert.Equal("safe", read.RetrySafety);
        Assert.True(read.InputSchema.TryGetProperty("properties", out var readProperties)
            && readProperties.TryGetProperty("status", out _));
        var update = PlanLedgerVirtualTools.ManifestEntry(CoreVirtualToolPolicy.PlanLedgerUpdateToolId)!;
        Assert.Equal("unsafe", update.RetrySafety);
        Assert.True(update.InputSchema.TryGetProperty("required", out var required)
            && required.EnumerateArray().Any(item => item.GetString() == "action"));

        var enabled = new ModeRuntimePolicyDto
        {
            Kind = ModeRuntimePolicyRegistry.AutonomousExplorationKind,
            Version = ModeRuntimePolicyRegistry.AutonomousExplorationVersion,
            Features = [ModeRuntimePolicyRegistry.PlanLedgerFeature]
        };
        Assert.Null(ExplorationToolPolicy.Validate(enabled,
            [CoreVirtualToolPolicy.PlanLedgerReadToolId, CoreVirtualToolPolicy.PlanLedgerUpdateToolId], "mode 'x'"));
        var graphOnly = new ModeRuntimePolicyDto
        {
            Kind = ModeRuntimePolicyRegistry.AutonomousExplorationKind,
            Version = ModeRuntimePolicyRegistry.AutonomousExplorationVersion,
            Features = [ModeRuntimePolicyRegistry.ExplorationGraphFeature]
        };
        Assert.Equal(
            "mode 'x' declares tool 'plan_ledger_read' but its runtime_policy does not enable 'plan_ledger'.",
            ExplorationToolPolicy.Validate(graphOnly, [CoreVirtualToolPolicy.PlanLedgerReadToolId], "mode 'x'"));
        Assert.Equal(
            "mode 'x' declares tool 'plan_ledger_update' but its runtime_policy does not enable 'plan_ledger'.",
            ExplorationToolPolicy.Validate(null, [CoreVirtualToolPolicy.PlanLedgerUpdateToolId], "mode 'x'"));
    }

    private (IPlanLedger Ledger, Guid Tenant, Guid Workspace) Services()
    {
        _ = _factory!.CreateClient();
        var scope = _factory.Services.GetRequiredService<ITenantContextAccessor>().Current;
        return (_factory.Services.GetRequiredService<IPlanLedger>(), scope.TenantId, scope.WorkspaceId);
    }

    private (IPlanLedger Ledger, IExplorationGraph Graph, Guid Tenant, Guid Workspace) GraphServices()
    {
        _ = _factory!.CreateClient();
        var scope = _factory.Services.GetRequiredService<ITenantContextAccessor>().Current;
        return (_factory.Services.GetRequiredService<IPlanLedger>(), _factory.Services.GetRequiredService<IExplorationGraph>(),
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
