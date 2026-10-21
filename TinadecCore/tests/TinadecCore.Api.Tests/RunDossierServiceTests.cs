using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using TinadecCore.Abstractions.Ports;
using TinadecCore.DmaEA;
using TinadecCore.Lifecycle;

namespace TinadecCore.Api.Tests;

/// <summary>
/// B9 run_dossier: one run's dossier is assembled from the records that run already left behind.
/// Every section is read-only and bounded, a section this host cannot read is named rather than
/// reported as empty, and the totals are the counts before the limit cut anything off.
/// </summary>
public sealed class RunDossierServiceTests : IAsyncLifetime
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "tinadec-run-dossier-tests", Guid.NewGuid().ToString("N"));
    private DossierFactory? _factory;

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
            try
            {
                Directory.Delete(_root, recursive: true);
                break;
            }
            catch (IOException)
            {
                await Task.Delay(300);
            }
        }
    }

    [Fact]
    public async Task ReportsTheRunsOwnIntentsFindingsAndOpenQuestions()
    {
        var run = await CreateRunAsync();
        var ledger = _factory!.Services.GetRequiredService<IPlanLedger>();
        var graph = _factory.Services.GetRequiredService<IExplorationGraph>();
        var worker = Guid.NewGuid();
        var plan = LedgerScope(run, worker);
        var intents = await ledger.AddAsync(plan,
            [new PlanIntentDraft("Map the endpoint"), new PlanIntentDraft("Probe the failure")]);
        await ledger.ClaimAsync(plan, intents[0].Id);
        await ledger.CompleteAsync(plan, intents[0].Id, "mapped");

        var exploration = ExplorationScope(run, worker);
        await graph.AppendNodeAsync(exploration, new ExplorationNodeDraft(
            ExplorationNodeKinds.Fact,
            "The endpoint is registered",
            "Confirmed against the tool manifest.",
            EvidenceRefs: ["tool:execution-1", "file:src/tools.ts"],
            SourceKey: "fact-endpoint"));
        await graph.AppendNodeAsync(exploration, new ExplorationNodeDraft(
            ExplorationNodeKinds.Hint,
            "The harness may be stale",
            SourceKey: "hint-stale"));

        var dossier = await Dossier().BuildAsync(Query(run));

        Assert.NotNull(dossier);
        Assert.Equal(run.RunId.ToString(), dossier.Run.RunId);
        Assert.Equal("planning", dossier.Run.Status);
        Assert.Equal("root", dossier.Run.RunKind);
        Assert.Equal("default", dossier.Run.PermissionMode);
        Assert.Null(dossier.Run.CompletedAt);
        Assert.Null(dossier.Run.TerminalErrorCategory);

        Assert.Collection(
            dossier.Intents,
            first =>
            {
                // Ordinals are one-based: the ledger derives the next one from the highest existing
                // source key, so an empty run starts at 1 rather than 0.
                Assert.Equal(1, first.Ordinal);
                Assert.Equal("Map the endpoint", first.Title);
                Assert.Equal(PlanIntentStatuses.Done, first.Status);
                Assert.Equal("mapped", first.Note);
            },
            second =>
            {
                Assert.Equal(2, second.Ordinal);
                Assert.Equal("Probe the failure", second.Title);
                Assert.Equal(PlanIntentStatuses.Pending, second.Status);
            });

        Assert.Equal(2, dossier.Findings.Count);
        var fact = dossier.Findings[0];
        Assert.Equal(ExplorationNodeKinds.Fact, fact.Kind);
        Assert.Equal("The endpoint is registered", fact.Title);
        Assert.Equal("Confirmed against the tool manifest.", fact.Content);
        Assert.Contains("file:src/tools.ts", fact.EvidenceRefs);
        // A hint is what the run believed without grounding it, so it is never mixed in with the
        // cited half: facts and findings come first, hints after.
        Assert.Equal(ExplorationNodeKinds.Hint, dossier.Findings[^1].Kind);

        Assert.Contains("pending intent: Probe the failure", dossier.OpenQuestions);
        Assert.Contains("unverified: The harness may be stale", dossier.OpenQuestions);
        Assert.DoesNotContain(dossier.OpenQuestions, question => question.Contains("Map the endpoint", StringComparison.Ordinal));

        // A run with no journal yet is a fact the dossier must state: "no tasks" would hide it.
        Assert.Equal(
            new[] { "The event journal has no replay for this run; task outcomes are absent." },
            dossier.Notes);

        Assert.Equal(0, dossier.Totals.Tasks);
        Assert.Equal(2, dossier.Totals.Intents);
        Assert.Equal(2, dossier.Totals.Findings);
        Assert.Equal(dossier.OpenQuestions.Count, dossier.Totals.OpenQuestions);
        Assert.Equal(2, dossier.Totals.EvidenceRefs);
        Assert.False(dossier.Totals.Truncated);
    }

    [Fact]
    public async Task RefusesARunThatIsNotVisibleFromTheCallersScope()
    {
        var run = await CreateRunAsync();
        var dossier = Dossier();
        var query = Query(run);

        // Control: the same query from the caller's own scope answers, so the four refusals below
        // measure the scope check rather than a broken fixture.
        Assert.NotNull(await dossier.BuildAsync(query));
        Assert.Null(await dossier.BuildAsync(query with { TenantId = Guid.NewGuid() }));
        Assert.Null(await dossier.BuildAsync(query with { WorkspaceId = Guid.NewGuid() }));
        Assert.Null(await dossier.BuildAsync(query with { SessionId = Guid.NewGuid() }));
        Assert.Null(await dossier.BuildAsync(query with { RunId = Guid.NewGuid() }));
    }

    [Fact]
    public async Task NarrowsTheReadAndNeverWidensIt()
    {
        var run = await CreateRunAsync();
        var ledger = _factory!.Services.GetRequiredService<IPlanLedger>();
        await ledger.AddAsync(LedgerScope(run, Guid.NewGuid()),
            [new PlanIntentDraft("one"), new PlanIntentDraft("two"), new PlanIntentDraft("three"), new PlanIntentDraft("four")]);
        var dossier = Dossier();

        var narrow = await dossier.BuildAsync(Query(run) with { Limit = 2 });
        Assert.NotNull(narrow);
        Assert.Equal(new[] { "one", "two" }, narrow.Intents.Select(intent => intent.Title).ToArray());
        Assert.Equal(4, narrow.Totals.Intents);
        Assert.True(narrow.Totals.Truncated);
        // The open-question list is derived from the listed rows, so a cut section has to say so
        // instead of silently reporting fewer unresolved items than the run has.
        Assert.Contains(narrow.Notes, note => note.StartsWith("Open questions are derived", StringComparison.Ordinal));

        var clampedLow = await dossier.BuildAsync(Query(run) with { Limit = 0 });
        Assert.Single(clampedLow!.Intents);

        var clampedHigh = await dossier.BuildAsync(Query(run) with { Limit = 500 });
        Assert.Equal(4, clampedHigh!.Intents.Count);
        Assert.False(clampedHigh.Totals.Truncated);
        Assert.DoesNotContain(clampedHigh.Notes, note => note.StartsWith("Open questions are derived", StringComparison.Ordinal));
    }

    [Fact]
    public async Task BoundsEveryFreeTextFieldAndTheEvidenceList()
    {
        var run = await CreateRunAsync();
        var graph = _factory!.Services.GetRequiredService<IExplorationGraph>();
        var refs = Enumerable.Range(0, 10).Select(index => $"tool:execution-{index}").ToArray();
        await graph.AppendNodeAsync(ExplorationScope(run, Guid.NewGuid()), new ExplorationNodeDraft(
            ExplorationNodeKinds.Finding,
            "Oversized finding",
            new string('x', 4000),
            EvidenceRefs: refs,
            SourceKey: "finding-long",
            Author: new string('a', 400)));

        var dossier = await Dossier().BuildAsync(Query(run) with { Limit = 50 });

        Assert.NotNull(dossier);
        var finding = Assert.Single(dossier.Findings);
        Assert.Equal(RunDossierService.MaxContentChars + 1, finding.Content!.Length);
        Assert.EndsWith("…", finding.Content);
        Assert.Equal(8, finding.EvidenceRefs.Count);
        Assert.Contains("tool:execution-0", finding.EvidenceRefs);
        Assert.EndsWith("…", finding.Author);
        Assert.True(finding.Author!.Length <= RunDossierService.MaxContentChars);
        Assert.Equal(8, dossier.Totals.EvidenceRefs);
    }

    [Fact]
    public async Task AHostWithoutTheOptionalSourcesNamesWhatItCouldNotRead()
    {
        var run = await CreateRunAsync();
        // Constructed directly: the point is a host that has the lifecycle rows only, which the DI
        // graph never is (every port is registered).
        var dossier = await new RunDossierService(_factory!.Services.GetRequiredService<ILifecycleManager>())
            .BuildAsync(Query(run));

        Assert.NotNull(dossier);
        Assert.Equal(run.RunId.ToString(), dossier.Run.RunId);
        Assert.Empty(dossier.Tasks);
        Assert.Empty(dossier.Intents);
        Assert.Empty(dossier.Findings);
        Assert.Empty(dossier.OpenQuestions);
        Assert.False(dossier.Totals.Truncated);
        Assert.Equal(
            new[]
            {
                "Task replay is not configured on this host; task outcomes are absent.",
                "The plan ledger is not configured on this host; planned intents are absent.",
                "The exploration graph is not configured on this host; findings and hints are absent."
            },
            dossier.Notes);
    }

    [Fact]
    public async Task AFailingSectionOnlyDegradesThatSectionAndKeepsItsReasonPrivate()
    {
        var run = await CreateRunAsync();
        var dossier = await new RunDossierService(
                _factory!.Services.GetRequiredService<ILifecycleManager>(),
                _factory.Services.GetRequiredService<IRunReplayService>(),
                _factory.Services.GetRequiredService<IPlanLedger>(),
                new BrokenExplorationGraph())
            .BuildAsync(Query(run));

        Assert.NotNull(dossier);
        Assert.Equal(
            "The exploration graph could not be read for this run; findings and hints are absent.",
            Assert.Single(dossier.Notes.Where(note => note.Contains("exploration graph could not be read", StringComparison.Ordinal))));
        // The driver's own words never reach the model: this note is what the tool will print.
        Assert.DoesNotContain(dossier.Notes, note => note.Contains("secret", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(dossier.Notes, note => note.Contains("backend", StringComparison.OrdinalIgnoreCase));
        Assert.Empty(dossier.Findings);
        Assert.Equal("planning", dossier.Run.Status);
    }

    private IRunDossier Dossier() => _factory!.Services.GetRequiredService<IRunDossier>();

    private static RunDossierQuery Query(RunFixture run) =>
        new(run.TenantId, run.WorkspaceId, run.SessionId, run.RunId);

    private static PlanLedgerScope LedgerScope(RunFixture run, Guid worker) =>
        new(run.TenantId, run.WorkspaceId, run.SessionId, run.RunId, AgentInstanceId: worker);

    private static ExplorationScope ExplorationScope(RunFixture run, Guid worker) =>
        new(run.TenantId, run.WorkspaceId, run.SessionId, run.RunId, AgentInstanceId: worker);

    private async Task<RunFixture> CreateRunAsync()
    {
        _factory ??= new DossierFactory(_root);
        var client = _factory.CreateClient();
        var project = await PostAsync(client, "/api/v1/projects",
            new { name = "dossier-workspace", path = Path.Combine(_root, "dossier-workspace") });
        var session = await PostAsync(client, "/api/v1/sessions",
            new { project_id = project.GetProperty("id").GetGuid(), title = "Dossier session" });
        var sessionId = session.GetProperty("id").GetGuid();
        var message = await PostAsync(client, $"/api/v1/sessions/{sessionId}/messages",
            new { content = "Investigate this run" });
        var run = await _factory.Services.GetRequiredService<StorageLifecycleService>()
            .StartRunAsync(sessionId, message.GetProperty("id").GetGuid());
        var scope = _factory.Services.GetRequiredService<ITenantContextAccessor>().Current;
        return new RunFixture(scope.TenantId, scope.WorkspaceId, sessionId, run.Id);
    }

    private static async Task<JsonElement> PostAsync(HttpClient client, string path, object body)
    {
        var response = await client.PostAsJsonAsync(path, body);
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        return await response.Content.ReadFromJsonAsync<JsonElement>();
    }

    private sealed record RunFixture(Guid TenantId, Guid WorkspaceId, Guid SessionId, Guid RunId);

    /// <summary>Every read fails the way a broken graph would, with text a model must never see.</summary>
    private sealed class BrokenExplorationGraph : IExplorationGraph
    {
        private static InvalidOperationException Boom() =>
            new("no such table: secret_graph (backend sqlite at C:\\secret\\tinadec.db)");

        public Task<ExplorationNode> AppendNodeAsync(ExplorationScope scope, ExplorationNodeDraft node, CancellationToken cancellationToken = default) =>
            throw Boom();

        public Task<IReadOnlyList<ExplorationNode>> QueryAsync(ExplorationScope scope, ExplorationQuery query, CancellationToken cancellationToken = default) =>
            throw Boom();

        public Task<ExplorationEdge> AppendEdgeAsync(ExplorationScope scope, ExplorationEdgeDraft edge, CancellationToken cancellationToken = default) =>
            throw Boom();

        public Task<IReadOnlyList<ExplorationEdge>> QueryEdgesAsync(ExplorationScope scope, string? kind = null, int limit = 100, CancellationToken cancellationToken = default) =>
            throw Boom();

        public Task<ExplorationAsset> UpsertAssetAsync(ExplorationScope scope, ExplorationAssetDraft asset, CancellationToken cancellationToken = default) =>
            throw Boom();

        public Task<ExplorationCoverage> CoverageAsync(ExplorationScope scope, CancellationToken cancellationToken = default) =>
            throw Boom();

        public Task<ExplorationDigest> DigestAsync(ExplorationScope scope, ExplorationDigestDraft digest, CancellationToken cancellationToken = default) =>
            throw Boom();
    }

    private sealed class DossierFactory(string root) : IsolatedApiFactory
    {
        protected override void ConfigureIsolatedWebHost(IWebHostBuilder builder) => builder
            .ConfigureAppConfiguration((_, config) => config.AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["TinadecPersistence:Sqlite:DatabasePath"] = Path.Combine(root, "tinadec.db"),
                ["TinadecPersistence:DataRoot"] = Path.Combine(root, "data"),
                // The evidence indexer is a background writer this test does not exercise; leaving it on
                // would only add embedding work whose result nothing here reads.
                ["TinadecEvidence:IndexEnabled"] = "false",
                ["Logging:LogLevel:Default"] = "Warning"
            }));
    }
}
