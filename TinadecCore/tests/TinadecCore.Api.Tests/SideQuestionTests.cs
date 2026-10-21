using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using TinadecCore.Abstractions.Ports;
using TinadecCore.Contracts.Dtos;
using TinadecCore.DmaEA;
using TinadecCore.Lifecycle;

namespace TinadecCore.Api.Tests;

/// <summary>
/// B3 side questions: a question about a run becomes an isolated run over a copy of the parent's
/// frozen configuration. The copy carries no runtime policy and no exploration/plan-ledger grants,
/// so answering it cannot write the session's exploration graph or move its plan ledger.
/// </summary>
public sealed class SideQuestionTests : IAsyncLifetime
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "tinadec-side-question-tests", Guid.NewGuid().ToString("N"));
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
    public void AnIsolatedCopyDropsThePolicyAndEveryExplorationGrant()
    {
        var parent = ParentBody(Policy(withSideQuestion: true));
        var copy = SideQuestionService.Isolate(parent);

        Assert.Null(copy.RuntimePolicy);
        Assert.Null(copy.TinaChatInput);
        Assert.Null(copy.SpaceOptions);
        Assert.Null(copy.SpacePreparationToolIds);

        // A wildcard grant is materialized against the frozen manifest before the exploration ids
        // are removed - otherwise the wildcard would keep authorizing exactly what we removed.
        var narrowed = copy.ExecutionAgents.Single(agent => agent.Id == "wildcard-worker");
        Assert.Equal(["read_file", "shell"], narrowed.AllowedTools);
        var explicitGrants = copy.ExecutionAgents.Single(agent => agent.Id == "explicit-worker");
        Assert.Equal(["read_file"], explicitGrants.AllowedTools);

        // The manifest itself must stay byte-identical: dispatch hashes it against the live
        // TinadecTools process, so narrowing the manifest would fail every tool call instead of
        // narrowing the grants.
        Assert.Equal(parent.ToolManifest.Select(entry => entry.Id), copy.ToolManifest.Select(entry => entry.Id));
        Assert.NotEqual(parent.ContentHash, copy.ContentHash);
    }

    [Fact]
    public async Task AQuestionIsRejectedWhenTheParentsPolicyDoesNotEnableIt()
    {
        _factory = new Factory(_root);
        var (parentRunId, _, _) = await PrepareParentAsync(Policy(withSideQuestion: false));
        var service = _factory.Services.GetRequiredService<SideQuestionService>();

        var error = await Assert.ThrowsAsync<RunAdmissionException>(() =>
            service.AskAsync(new SideQuestionRequest(parentRunId, "What did the worker find?")));
        Assert.Equal("side_question_disabled", error.Code);
    }

    [Fact]
    public async Task AnEnabledQuestionAdmitsAnIsolatedRunThatNeverTouchesTheSessionGraph()
    {
        _factory = new Factory(_root);
        var (parentRunId, sessionId, _) = await PrepareParentAsync(Policy(withSideQuestion: true));
        var service = _factory.Services.GetRequiredService<SideQuestionService>();
        var lifecycle = _factory.Services.GetRequiredService<StorageLifecycleService>();

        var answer = await service.AskAsync(new SideQuestionRequest(parentRunId, "What did the worker find?", "side-question-1"));

        Assert.False(answer.Existing);
        var run = await _factory.Services.GetRequiredService<ILifecycleManager>().GetRunStateAsync(answer.RunId.ToString());
        Assert.Equal(SideQuestionService.RunKind, run.RunKind);
        Assert.Equal(parentRunId.ToString(), run.ParentRunId);

        var frozen = await lifecycle.GetFrozenRunConfigurationAsync(answer.RunId);
        Assert.NotNull(frozen);
        var body = JsonSerializer.Deserialize<FrozenRunConfigurationV1>(frozen!.Content, FrozenRunConfigurationV1.JsonOptions)!;
        Assert.Null(body.RuntimePolicy);
        Assert.Null(body.TinaChatInput);
        Assert.Null(body.SpaceOptions);
        Assert.DoesNotContain(body.ExecutionAgents.SelectMany(agent => agent.AllowedTools), CoreVirtualToolPolicy.IsExploration);
        Assert.DoesNotContain(body.ExecutionAgents.SelectMany(agent => agent.AllowedTools), CoreVirtualToolPolicy.IsPlanLedger);
        // The manifest still declares them; only the grants were narrowed.
        Assert.Contains(body.ToolManifest, entry => CoreVirtualToolPolicy.IsExploration(entry.Id));

        // The parent is untouched: its own frozen body still carries the policy and the grants.
        var parentFrozen = await lifecycle.GetFrozenRunConfigurationAsync(parentRunId);
        var parentBody = JsonSerializer.Deserialize<FrozenRunConfigurationV1>(parentFrozen!.Content, FrozenRunConfigurationV1.JsonOptions)!;
        Assert.NotNull(parentBody.RuntimePolicy);
        Assert.Equal(["*"], parentBody.ExecutionAgents.Single(agent => agent.Id == "wildcard-worker").AllowedTools);
        Assert.Contains("exploration_view", parentBody.ExecutionAgents.Single(agent => agent.Id == "explicit-worker").AllowedTools);

        var scope = _factory.Services.GetRequiredService<ITenantContextAccessor>().Current;
        var graph = _factory.Services.GetRequiredService<IExplorationGraph>();
        var nodes = await graph.QueryAsync(new ExplorationScope(scope.TenantId, scope.WorkspaceId, sessionId, answer.RunId), new ExplorationQuery());
        Assert.Empty(nodes);

        var replay = await service.AskAsync(new SideQuestionRequest(parentRunId, "What did the worker find?", "side-question-1"));
        Assert.True(replay.Existing);
        Assert.Equal(answer.RunId, replay.RunId);
    }

    private async Task<(Guid ParentRunId, Guid SessionId, Guid ModeVersionId)> PrepareParentAsync(ModeRuntimePolicyDto policy)
    {
        var client = _factory!.CreateClient();
        var session = await (await client.PostAsJsonAsync("/api/v1/sessions", new { view_mode = "space" })).Content.ReadFromJsonAsync<JsonElement>();
        var sessionId = session.GetProperty("id").GetGuid();
        var modeVersionId = session.GetProperty("mode_version_id").GetGuid();
        var message = await (await client.PostAsJsonAsync($"/api/v1/sessions/{sessionId}/messages", new { content = "Investigate" }))
            .Content.ReadFromJsonAsync<JsonElement>();
        var lifecycle = _factory.Services.GetRequiredService<StorageLifecycleService>();
        var run = await lifecycle.StartRunAsync(sessionId, message.GetProperty("id").GetGuid());
        await lifecycle.FreezeRunConfigurationAsync(run.Id, ParentBody(policy).ToLifecycleWrite());
        return (run.Id, sessionId, modeVersionId);
    }

    private static FrozenRunConfigurationV1 ParentBody(ModeRuntimePolicyDto policy)
    {
        var manifest = new[] { "read_file", "shell", "exploration_view", "exploration_record", "exploration_digest", "plan_ledger_read", "plan_ledger_update" }
            .Select(id => new FrozenToolManifestEntry(id, id, JsonSerializer.SerializeToElement(new { type = "object" }), "read", false, false, "safe", []))
            .ToArray();
        var wildcard = new RuntimeAgentDefinition("wildcard-worker", "operation", "worker", "persistent", [], false, "workspace")
        {
            AllowedTools = ["*"]
        };
        var explicitGrants = new RuntimeAgentDefinition("explicit-worker", "operation", "worker", "persistent", [], false, "workspace")
        {
            AllowedTools = ["read_file", "exploration_view", "plan_ledger_update"]
        };
        return new FrozenRunConfigurationV1(
            FrozenRunConfigurationV1.CurrentSchemaVersion, "baseline", 1, Guid.NewGuid(), "artex", "ask",
            new(2, 16, 4), new(2, 2, true), new(true, 2), new(65536, 128, true),
            new(true, 8, [], []), new("test", true, true, 60, 0),
            [wildcard], [wildcard, explicitGrants], [])
        {
            TinaChatInput = new TinaChatInputBinding(Guid.NewGuid(), Guid.NewGuid(), Guid.NewGuid()),
            SpaceOptions = new(),
            SpacePreparationToolIds = ["read_file"],
            RuntimePolicy = policy,
            ToolManifest = manifest,
            ToolManifestProtocolVersion = 2
        };
    }

    private static ModeRuntimePolicyDto Policy(bool withSideQuestion) => new()
    {
        Kind = ModeRuntimePolicyRegistry.AutonomousExplorationKind,
        Version = ModeRuntimePolicyRegistry.AutonomousExplorationVersion,
        Features = withSideQuestion
            ?
            [
                ModeRuntimePolicyRegistry.ExplorationGraphFeature,
                ModeRuntimePolicyRegistry.PlanLedgerFeature,
                ModeRuntimePolicyRegistry.EventDrivenPlanningFeature,
                ModeRuntimePolicyRegistry.SideQuestionFeature
            ]
            : [ModeRuntimePolicyRegistry.ExplorationGraphFeature]
    };

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
