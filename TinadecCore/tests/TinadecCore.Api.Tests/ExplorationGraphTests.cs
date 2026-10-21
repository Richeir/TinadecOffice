using Microsoft.AspNetCore.Hosting;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using System.Text.Json;
using TinadecCore.Abstractions.Ports;
using TinadecCore.AgentGraph;
using TinadecCore.Contracts.Dtos;
using TinadecCore.Tools;

namespace TinadecCore.Api.Tests;

/// <summary>
/// B1: the session exploration graph. Writes are idempotent on their source key, every read stays
/// inside the caller's tenant/workspace/session, coverage counts only grounded records, and a digest
/// keeps the material it folded verbatim in the evidence archive.
/// </summary>
public sealed class ExplorationGraphTests : IAsyncLifetime
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "tinadec-exploration-tests", Guid.NewGuid().ToString("N"));
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
    public async Task RecordingTheSameSourceTwice_KeepsTheFirstNode_AndReadsStayInScope()
    {
        _factory = new Factory(_root);
        var (graph, tenant, workspace) = Services();
        var session = Guid.NewGuid();
        var scope = new ExplorationScope(tenant, workspace, session, Guid.NewGuid());

        var first = await graph.AppendNodeAsync(scope, new ExplorationNodeDraft(
            ExplorationNodeKinds.Fact, "order pipeline", Content: "first words", AssetKey: @".\src\Order.cs",
            EvidenceRefs: ["tool:1"], SourceKey: "task:1:1", Author: "worker.code"));
        var replay = await graph.AppendNodeAsync(scope, new ExplorationNodeDraft(
            ExplorationNodeKinds.Finding, "other words", Content: "second words", AssetKey: "src/Order.cs", SourceKey: "task:1:1"));

        Assert.Equal(first.Id, replay.Id);
        Assert.Equal("first words", replay.Content);
        // One spelling per asset: a Windows path and a slash path name the same node target.
        Assert.Equal("src/Order.cs", replay.AssetKey);
        Assert.Equal(["tool:1"], replay.EvidenceRefs);

        // The same source key in another session is another node, not a conflict.
        var secondSessionScope = new ExplorationScope(tenant, workspace, Guid.NewGuid(), scope.RunId);
        var elsewhere = await graph.AppendNodeAsync(secondSessionScope, new ExplorationNodeDraft(
            ExplorationNodeKinds.Fact, "order pipeline", Content: "elsewhere", SourceKey: "task:1:1"));
        Assert.NotEqual(first.Id, elsewhere.Id);

        // Even with the same session id, a foreign tenant reads nothing.
        var foreign = new ExplorationScope(Guid.NewGuid(), workspace, session);
        Assert.Empty(await graph.QueryAsync(foreign, new ExplorationQuery()));
        Assert.Single(await graph.QueryAsync(scope, new ExplorationQuery()));
        // And a query can narrow to the digest-free run that recorded it.
        Assert.Equal(first.Id, Assert.Single(await graph.QueryAsync(scope, new ExplorationQuery(Kind: ExplorationNodeKinds.Fact))).Id);
    }

    [Fact]
    public async Task CoverageCountsOnlyGroundedRecords_AndNeverCrossesTheCallersScope()
    {
        _factory = new Factory(_root);
        var (graph, tenant, workspace) = Services();
        var scope = new ExplorationScope(tenant, workspace, Guid.NewGuid(), Guid.NewGuid());

        await graph.UpsertAssetAsync(scope, new ExplorationAssetDraft("src/A.cs", ExplorationAssetKinds.File, "A"));
        await graph.UpsertAssetAsync(scope, new ExplorationAssetDraft("src/B.cs", ExplorationAssetKinds.File, "B"));
        await graph.UpsertAssetAsync(scope, new ExplorationAssetDraft("docs/readme.md", ExplorationAssetKinds.Document, "readme"));
        // Re-declaring an asset updates it in place; it does not grow the inventory.
        await graph.UpsertAssetAsync(scope, new ExplorationAssetDraft("src/B.cs", ExplorationAssetKinds.Module, "B module"));

        await graph.AppendNodeAsync(scope, new ExplorationNodeDraft(
            ExplorationNodeKinds.Fact, "A exports X", AssetKey: "src/A.cs", SourceKey: "fact:a"));
        // A hint is a belief without a citation: it must not make B look covered.
        await graph.AppendNodeAsync(scope, new ExplorationNodeDraft(
            ExplorationNodeKinds.Hint, "B probably exports Y", AssetKey: "src/B.cs", SourceKey: "hint:b"));

        var coverage = await graph.CoverageAsync(scope);
        Assert.Equal(3, coverage.Total);
        Assert.Equal(1, coverage.Covered);
        Assert.Equal(0.3333, coverage.Ratio);
        Assert.Equal(["docs/readme.md", "src/B.cs"], coverage.Uncovered.Select(asset => asset.Key));
        Assert.Equal(ExplorationAssetKinds.Module, coverage.Uncovered[1].Kind);

        var foreign = new ExplorationScope(Guid.NewGuid(), workspace, scope.SessionId);
        var empty = await graph.CoverageAsync(foreign);
        Assert.Equal(0, empty.Total);
        Assert.Equal(1d, empty.Ratio);
    }

    [Fact]
    public async Task LinksRequireBothEndsInTheSession_AndTheSameLinkIsKeptOnce()
    {
        _factory = new Factory(_root);
        var (graph, tenant, workspace) = Services();
        var scope = new ExplorationScope(tenant, workspace, Guid.NewGuid(), Guid.NewGuid());
        var fact = await graph.AppendNodeAsync(scope, new ExplorationNodeDraft(
            ExplorationNodeKinds.Fact, "A exports X", SourceKey: "fact:a"));
        var finding = await graph.AppendNodeAsync(scope, new ExplorationNodeDraft(
            ExplorationNodeKinds.Finding, "X is the only export", SourceKey: "finding:a"));

        var link = await graph.AppendEdgeAsync(scope, new ExplorationEdgeDraft(fact.Id, finding.Id, ExplorationEdgeKinds.Supports, "same file"));
        var replay = await graph.AppendEdgeAsync(scope, new ExplorationEdgeDraft(fact.Id, finding.Id, ExplorationEdgeKinds.Supports));
        Assert.Equal(link.Id, replay.Id);

        var elsewhere = await graph.AppendNodeAsync(
            new ExplorationScope(tenant, workspace, Guid.NewGuid()), new ExplorationNodeDraft(ExplorationNodeKinds.Fact, "foreign"));
        var refused = await Assert.ThrowsAsync<KeyNotFoundException>(() =>
            graph.AppendEdgeAsync(scope, new ExplorationEdgeDraft(fact.Id, elsewhere.Id, ExplorationEdgeKinds.Supports, SourceKey: "cross-session")));
        Assert.Contains("this session", refused.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ADigestKeepsTheFullMaterialInTheArchive_WhileTheNodeKeepsTheCompactView()
    {
        _factory = new Factory(_root);
        var (graph, tenant, workspace) = Services();
        var scope = new ExplorationScope(tenant, workspace, Guid.NewGuid(), Guid.NewGuid());
        var material = "investigation transcript " + new string('x', 18_000) + " ARCHIVE-ONLY-TAIL";

        var digest = await graph.DigestAsync(scope, new ExplorationDigestDraft(
            "round one", material, Summary: "compact view", SourceKey: "digest:round-1"));
        var node = Assert.Single(await graph.QueryAsync(scope, new ExplorationQuery(Kind: ExplorationNodeKinds.Digest)));
        Assert.Equal(digest.NodeId, node.Id);
        Assert.Equal("compact view", node.Content);
        Assert.True(node.Content!.Length < material.Length);
        Assert.DoesNotContain("ARCHIVE-ONLY-TAIL", node.Content, StringComparison.Ordinal);

        // The archive holds the lower layer's own words, in full.
        var factory = _factory.Services.GetRequiredService<IDbContextFactory<AgentGraphDbContext>>();
        await using var db = await factory.CreateDbContextAsync();
        var archived = await db.Evidence.AsNoTracking()
            .SingleAsync(row => row.SourceKey == $"exploration-digest:{digest.NodeId:N}");
        Assert.Equal(EvidenceKinds.ExplorationDigest, archived.Kind);
        Assert.Equal(digest.EvidenceId, archived.Id);
        Assert.Equal(material, archived.Content);

        // Re-digesting the same title and material keeps one node and one archive entry.
        var replay = await graph.DigestAsync(scope, new ExplorationDigestDraft(
            "round one", material, Summary: "compact view", SourceKey: "digest:round-1"));
        Assert.Equal(digest, replay);
        Assert.Single(await graph.QueryAsync(scope, new ExplorationQuery(Kind: ExplorationNodeKinds.Digest)));
        Assert.Equal(1, await db.Evidence.CountAsync(row => row.SessionId == scope.SessionId));
    }

    [Fact]
    public void AnExplorationToolRequiresTheFeatureThatBacksIt()
    {
        Assert.Null(ExplorationToolPolicy.Validate(null, ["read_file"], "mode 'x'"));

        var graphOnly = new ModeRuntimePolicyDto
        {
            Kind = ModeRuntimePolicyRegistry.AutonomousExplorationKind,
            Version = ModeRuntimePolicyRegistry.AutonomousExplorationVersion,
            Features = [ModeRuntimePolicyRegistry.ExplorationGraphFeature]
        };
        Assert.Null(ExplorationToolPolicy.Validate(graphOnly, ["read_file", "exploration_view"], "mode 'x'"));
        Assert.Equal(
            "mode 'x' declares tool 'exploration_coverage' but its runtime_policy does not enable 'asset_graph'.",
            ExplorationToolPolicy.Validate(graphOnly, ["exploration_coverage"], "mode 'x'"));
        Assert.Equal(
            "mode 'x' declares tool 'exploration_view' but its runtime_policy does not enable 'exploration_graph'.",
            ExplorationToolPolicy.Validate(null, ["exploration_view"], "mode 'x'"));
        Assert.True(ExplorationToolPolicy.IsExplorationTool("plan_ledger_update"));
        Assert.False(ExplorationToolPolicy.IsExplorationTool("read_file"));
    }

    [Fact]
    public async Task DeclaredExplorationToolsAreFrozenIntoTheManifest_EvenWithoutAProject()
    {
        var session = Guid.NewGuid();
        var resolver = new ToolManifestSnapshotResolver(new ProjectlessSessions(session), new UnusedProvider());
        var snapshot = await resolver.ResolveAsync(new ToolManifestSnapshotRequest(
            session,
            [
                CoreVirtualToolPolicy.ExplorationViewToolId,
                CoreVirtualToolPolicy.ExplorationRecordToolId,
                CoreVirtualToolPolicy.ExplorationCoverageToolId,
            ],
            AllowAllTools: false));

        Assert.Equal(2, snapshot.ProtocolVersion);
        Assert.Contains(snapshot.AuthorizedTools, tool => tool.Id == CoreVirtualToolPolicy.CreateWorkspaceToolId);
        var view = Assert.Single(snapshot.AuthorizedTools, tool => tool.Id == CoreVirtualToolPolicy.ExplorationViewToolId);
        Assert.False(view.RequiresApproval);
        Assert.False(view.MutatesWorkspace);
        Assert.Equal("safe", view.RetrySafety);
        Assert.Equal(JsonValueKind.Object, view.InputSchema.ValueKind);
        Assert.True(view.InputSchema.TryGetProperty("properties", out var properties)
            && properties.TryGetProperty("kind", out _));
        // A record without a source_key is a new node on every attempt, so the loop must not retry it blindly.
        Assert.Equal("unsafe", Assert.Single(
            snapshot.AuthorizedTools, tool => tool.Id == CoreVirtualToolPolicy.ExplorationRecordToolId).RetrySafety);
        Assert.Contains(snapshot.AuthorizedTools, tool => tool.Id == CoreVirtualToolPolicy.ExplorationCoverageToolId);
        Assert.Equal(4, snapshot.AuthorizedTools.Count);
    }

    private (IExplorationGraph Graph, Guid Tenant, Guid Workspace) Services()
    {
        _ = _factory!.CreateClient();
        var scope = _factory.Services.GetRequiredService<ITenantContextAccessor>().Current;
        return (_factory.Services.GetRequiredService<IExplorationGraph>(), scope.TenantId, scope.WorkspaceId);
    }

    private sealed class NoEmbeddings : IEmbeddingProvider
    {
        public Task<EmbeddingResult> GenerateAsync(EmbeddingRequest request, CancellationToken cancellationToken = default) =>
            Task.FromResult(new EmbeddingResult { IsAvailable = false, Detail = "No embedding model is configured." });
    }

    /// <summary>A free-conversation session: no project, so the frozen surface is built from virtual entries alone.</summary>
    private sealed class ProjectlessSessions(Guid session) : ISessionLocator
    {
        public Task<SessionReference?> FindAsync(Guid sessionId, CancellationToken cancellationToken = default) =>
            Task.FromResult<SessionReference?>(sessionId == session
                ? new SessionReference(sessionId, null, Guid.NewGuid(), Guid.NewGuid())
                : null);

        public Task<ProjectReference?> FindProjectAsync(Guid projectId, CancellationToken cancellationToken = default) =>
            Task.FromResult<ProjectReference?>(null);
    }

    private sealed class UnusedProvider : IToolProvider
    {
        public Task<ToolManifestDto> EnsureStartedAsync(string workspaceRoot, CancellationToken cancellationToken = default) =>
            throw new InvalidOperationException("A projectless manifest must not start a tool provider.");

        public Task<ToolWireResponseDto> CallAsync(string workspaceRoot, ToolWireRequestDto request, TimeSpan? timeout = null, CancellationToken cancellationToken = default) =>
            throw new InvalidOperationException("A projectless manifest must not call a tool provider.");

        public Task<ToolManifestDto> GetManifestAsync(string workspaceRoot, CancellationToken cancellationToken = default) =>
            throw new InvalidOperationException("A projectless manifest must not read a tool provider.");

        public Task ShutdownAsync(CancellationToken cancellationToken = default) => Task.CompletedTask;
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
