using Microsoft.AspNetCore.Hosting;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using TinadecCore.Abstractions.Ports;
using TinadecCore.AgentGraph;
using TinadecCore.DmaEA;
using TinadecCore.Exploration;

namespace TinadecCore.Api.Tests;

/// <summary>
/// B7: the cold-subgraph digest. A context that fits is never folded; an overflowing or idle graph
/// is folded once, the originals stay in the evidence archive, and the compact view keeps citations
/// apart from beliefs so a hint cannot pass as a conclusion.
/// </summary>
public sealed class ContextDigestTests : IAsyncLifetime
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "tinadec-context-digest-tests", Guid.NewGuid().ToString("N"));
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
    public async Task ACompactFreshGraph_IsNotFolded()
    {
        _factory = new Factory(_root);
        var (graph, tenant, workspace) = Services();
        var scope = new ExplorationScope(tenant, workspace, Guid.NewGuid(), Guid.NewGuid());
        await graph.AppendNodeAsync(scope, new ExplorationNodeDraft(
            ExplorationNodeKinds.Fact, "small fact", Content: "one line", EvidenceRefs: ["tool:1"]));

        var service = new ContextDigestService(graph, new ManualTime(DateTimeOffset.UtcNow));
        var settings = new AutonomousExplorationSettings
        {
            ContextCompactionTokens = 10_000,
            DigestAfterIdleMs = 86_400_000
        };

        Assert.Null(await service.CompactAsync(new ContextDigestRequest(scope, settings)));
        Assert.Empty(await graph.QueryAsync(scope, new ExplorationQuery(Kind: ExplorationNodeKinds.Digest)));
    }

    [Fact]
    public async Task AnOverBudgetGraph_FoldsTheColdNodes_AndArchivesTheirOriginals()
    {
        _factory = new Factory(_root);
        var (graph, tenant, workspace) = Services();
        var scope = new ExplorationScope(tenant, workspace, Guid.NewGuid(), Guid.NewGuid());
        for (var index = 0; index < 12; index++)
        {
            await graph.AppendNodeAsync(scope, new ExplorationNodeDraft(
                ExplorationNodeKinds.Finding,
                $"finding {index}",
                Content: new string((char)('a' + index), 2_000) + $" MARKER-{index}",
                EvidenceRefs: [$"tool:{index}"],
                SourceKey: $"finding:{index}"));
            // Distinct millisecond stamps so "newest four" is a fact of the fixture, not of the clock.
            await Task.Delay(5);
        }

        var service = new ContextDigestService(graph, new ManualTime(DateTimeOffset.UtcNow));
        var settings = new AutonomousExplorationSettings
        {
            ContextCompactionTokens = 1_000,
            DigestAfterIdleMs = 86_400_000
        };
        var result = await service.CompactAsync(new ContextDigestRequest(scope, settings, "ship it", KeepRecentNodes: 4));

        Assert.NotNull(result);
        Assert.Equal(8, result!.FoldedNodes);
        Assert.Contains("ship it", result.Text, StringComparison.Ordinal);
        Assert.Contains("Findings (cited):", result.Text, StringComparison.Ordinal);
        var digestNode = Assert.Single(await graph.QueryAsync(scope, new ExplorationQuery(Kind: ExplorationNodeKinds.Digest)));
        Assert.Equal(result.NodeId, digestNode.Id);

        var factory = _factory.Services.GetRequiredService<IDbContextFactory<AgentGraphDbContext>>();
        await using var db = await factory.CreateDbContextAsync();
        var archived = await db.Evidence.AsNoTracking()
            .SingleAsync(row => row.SourceKey == $"exploration-digest:{digestNode.Id:N}");
        Assert.Equal(EvidenceKinds.ExplorationDigest, archived.Kind);
        Assert.Equal(result.EvidenceId, archived.Id);
        Assert.Contains("MARKER-0", archived.Content, StringComparison.Ordinal);
        Assert.Contains("MARKER-7", archived.Content, StringComparison.Ordinal);
        // The newest four stay hot: they are still in the graph and the digest did not archive them.
        Assert.DoesNotContain("MARKER-8", archived.Content, StringComparison.Ordinal);
        Assert.DoesNotContain("MARKER-11", archived.Content, StringComparison.Ordinal);
    }

    [Fact]
    public async Task AnIdleGraph_FoldsOnce_AndTheNextCallReusesTheSameDigest()
    {
        _factory = new Factory(_root);
        var (graph, tenant, workspace) = Services();
        var scope = new ExplorationScope(tenant, workspace, Guid.NewGuid(), Guid.NewGuid());
        await graph.AppendNodeAsync(scope, new ExplorationNodeDraft(
            ExplorationNodeKinds.Fact, "cold fact", Content: "recorded before the pause", EvidenceRefs: ["tool:cold"]));

        var service = new ContextDigestService(graph, new ManualTime(DateTimeOffset.UtcNow.AddMinutes(11)));
        var settings = new AutonomousExplorationSettings
        {
            ContextCompactionTokens = 1_000_000,
            DigestAfterIdleMs = 600_000
        };
        var first = await service.CompactAsync(new ContextDigestRequest(scope, settings));
        Assert.NotNull(first);
        Assert.Equal(1, first!.FoldedNodes);
        Assert.NotNull(first.EvidenceId);

        var again = await service.CompactAsync(new ContextDigestRequest(scope, settings));
        Assert.NotNull(again);
        Assert.Equal(first.NodeId, again!.NodeId);
        Assert.Null(again.EvidenceId);
        Assert.Equal(0, again.FoldedNodes);
        Assert.Single(await graph.QueryAsync(scope, new ExplorationQuery(Kind: ExplorationNodeKinds.Digest)));
    }

    [Fact]
    public async Task TheDigestSeparatesCitedConclusionsFromHints_AndNamesUncoveredAssets()
    {
        _factory = new Factory(_root);
        var (graph, tenant, workspace) = Services();
        var scope = new ExplorationScope(tenant, workspace, Guid.NewGuid(), Guid.NewGuid());
        await graph.AppendNodeAsync(scope, new ExplorationNodeDraft(
            ExplorationNodeKinds.Fact, "api returns 200", Content: "checked over HTTP", EvidenceRefs: ["tool:http"], SourceKey: "fact:api"));
        var hint = await graph.AppendNodeAsync(scope, new ExplorationNodeDraft(
            ExplorationNodeKinds.Hint, "cache is misconfigured", SourceKey: "hint:cache"));
        var refuting = await graph.AppendNodeAsync(scope, new ExplorationNodeDraft(
            ExplorationNodeKinds.Fact, "cache config is correct", Content: "read the config", EvidenceRefs: ["tool:read"], SourceKey: "fact:cache"));
        await graph.AppendEdgeAsync(scope, new ExplorationEdgeDraft(refuting.Id, hint.Id, ExplorationEdgeKinds.Contradicts));
        await graph.UpsertAssetAsync(scope, new ExplorationAssetDraft("src/Pay.cs", ExplorationAssetKinds.File));

        var service = new ContextDigestService(graph, new ManualTime(DateTimeOffset.UtcNow.AddMinutes(11)));
        var result = await service.CompactAsync(new ContextDigestRequest(scope, new AutonomousExplorationSettings
        {
            ContextCompactionTokens = 1_000_000,
            DigestAfterIdleMs = 600_000
        }));

        Assert.NotNull(result);
        var text = result!.Text;
        var unconfirmedIndex = text.IndexOf("Unconfirmed", StringComparison.Ordinal);
        Assert.True(unconfirmedIndex > 0);
        var confirmedPart = text[..unconfirmedIndex];
        Assert.Contains("api returns 200", confirmedPart, StringComparison.Ordinal);
        Assert.DoesNotContain("cache is misconfigured", confirmedPart, StringComparison.Ordinal);
        Assert.Contains("cache is misconfigured", text[unconfirmedIndex..], StringComparison.Ordinal);
        Assert.Contains("Refuted hypotheses:", text, StringComparison.Ordinal);
        Assert.Contains("contradicted by cache config is correct", text, StringComparison.Ordinal);
        Assert.Contains("Uncovered assets:", text, StringComparison.Ordinal);
        Assert.Contains("src/Pay.cs", text, StringComparison.Ordinal);
        Assert.Contains("tool:http", text, StringComparison.Ordinal);
    }

    [Fact]
    public void AttachingTheDigest_KeepsTheBudgetAndTheDroppedList()
    {
        var pack = new ContextPack
        {
            SessionId = "session",
            RunId = "run",
            TokenBudget = 4_096,
            EstimatedTokens = 3_000,
            Evidence = [new ContextEvidence { Source = "recent", Content = "x", EstimatedTokens = 3_000 }],
            Dropped = [new ContextEvidence { Source = "old", Content = "y", EstimatedTokens = 200 }]
        };
        var digest = new ContextDigestResult("digest text", Guid.NewGuid(), Guid.NewGuid(), 3);

        var attached = FullDuplexRunEngine.WithDigestEvidence(pack, digest);

        Assert.Equal(4_096, attached.TokenBudget);
        Assert.Equal(pack.Dropped, attached.Dropped);
        Assert.Equal(3_000 + digest.Text.Length / 2, attached.EstimatedTokens);
        var evidence = Assert.Single(attached.Evidence, item => item.Source == "exploration-digest");
        Assert.Equal(digest.Text, evidence.Content);
        Assert.Equal(1, pack.Evidence.Count);
        Assert.Same(pack, FullDuplexRunEngine.WithDigestEvidence(
            pack, new ContextDigestResult(" ", Guid.NewGuid(), null, 0)));
    }

    private (IExplorationGraph Graph, Guid Tenant, Guid Workspace) Services()
    {
        _ = _factory!.CreateClient();
        var scope = _factory.Services.GetRequiredService<ITenantContextAccessor>().Current;
        return (_factory.Services.GetRequiredService<IExplorationGraph>(), scope.TenantId, scope.WorkspaceId);
    }

    private sealed class ManualTime(DateTimeOffset utcNow) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => utcNow;
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
