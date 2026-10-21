using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using TinadecCore.Abstractions.Ports;
using TinadecCore.Contracts.Dtos;
using TinadecCore.DmaEA;
using TinadecCore.Lifecycle;
using TinadecCore.Tools;

namespace TinadecCore.Api.Tests;

/// <summary>
/// B4 cross-worker trace: one read that joins the event journal, the tool executions and the evidence
/// archive of a single run. The security guarantee is the feed's: arguments are redacted before they
/// are matched or returned, other runs and other workers are filtered out, and the limit is the
/// frozen <c>trace_result_limit</c>, narrowed — never widened — by the caller.
/// </summary>
public sealed class RunTraceSearchTests : IAsyncLifetime
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private readonly string _root = Path.Combine(Path.GetTempPath(), "tinadec-trace-search-tests", Guid.NewGuid().ToString("N"));
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
    public async Task TraceIsScopedToItsRun_RedactsSecrets_AndFiltersByWorkerAndTask()
    {
        _factory = new Factory(_root);
        var (projectId, sessionId) = await CreateProjectAndSessionAsync();
        var runId = await InsertRunAsync(sessionId);
        var otherRunId = await InsertRunAsync(sessionId);
        var taskA = Guid.NewGuid();
        var workerA = Guid.NewGuid();
        var workerB = Guid.NewGuid();
        var lifecycle = _factory.Services.GetRequiredService<ILifecycleManager>();

        await lifecycle.AppendEventAsync(runId, "worker.completed",
            new { task_id = taskA, agent_instance_id = workerA, api_key = "sk-live-abc123" }, "worker A finished");
        await lifecycle.AppendEventAsync(runId, "worker.completed",
            new { task_id = Guid.NewGuid(), agent_instance_id = workerB }, "worker B finished");
        await lifecycle.AppendEventAsync(otherRunId, "worker.completed",
            new { task_id = taskA, agent_instance_id = workerA }, "another run finished");

        var executionA = await CompletedExecutionAsync(projectId, sessionId, runId, taskA, workerA);
        await CompletedExecutionAsync(projectId, sessionId, runId, Guid.NewGuid(), workerB);

        var trace = _factory.Services.GetRequiredService<IRunTraceSearch>();
        var scope = _factory.Services.GetRequiredService<ITenantContextAccessor>().Current;
        var all = await trace.SearchAsync(new RunTraceQuery(scope.TenantId, scope.WorkspaceId, sessionId, runId, Limit: 20));

        Assert.Equal(2, all.Events.Count);
        Assert.DoesNotContain(all.Events, item => item.Summary == "another run finished");
        var first = Assert.Single(all.Events, item => item.Summary == "worker A finished");
        Assert.Contains("[redacted]", first.PayloadJson, StringComparison.Ordinal);
        Assert.DoesNotContain("sk-live-abc123", first.PayloadJson, StringComparison.Ordinal);

        Assert.Equal(2, all.Tools.Count);
        var cited = Assert.Single(all.Tools, tool => tool.Preview.ExecutionId == executionA.Id.ToString());
        Assert.DoesNotContain("sk-tool-secret", cited.Preview.Arguments?.ToJsonString() ?? string.Empty, StringComparison.Ordinal);
        Assert.Contains("[redacted]", cited.Preview.Arguments?.ToJsonString() ?? string.Empty, StringComparison.Ordinal);

        var byWorker = await trace.SearchAsync(new RunTraceQuery(
            scope.TenantId, scope.WorkspaceId, sessionId, runId, AgentInstanceId: workerA, Limit: 20));
        Assert.Equal("worker A finished", Assert.Single(byWorker.Events).Summary);
        Assert.Equal(executionA.Id.ToString(), Assert.Single(byWorker.Tools).Preview.ExecutionId);

        var byTask = await trace.SearchAsync(new RunTraceQuery(
            scope.TenantId, scope.WorkspaceId, sessionId, runId, TaskId: taskA, Limit: 20));
        Assert.Equal("worker A finished", Assert.Single(byTask.Events).Summary);
        Assert.Equal(executionA.Id.ToString(), Assert.Single(byTask.Tools).Preview.ExecutionId);

        var byText = await trace.SearchAsync(new RunTraceQuery(
            scope.TenantId, scope.WorkspaceId, sessionId, runId, Query: "worker A finished", Limit: 20));
        Assert.Equal("worker A finished", Assert.Single(byText.Events).Summary);
    }

    [Fact]
    public async Task TheLimitIsHonored_AndReportsTruncation()
    {
        _factory = new Factory(_root);
        var (_, sessionId) = await CreateProjectAndSessionAsync();
        var runId = await InsertRunAsync(sessionId);
        var lifecycle = _factory.Services.GetRequiredService<ILifecycleManager>();
        for (var index = 0; index < 3; index++)
        {
            await lifecycle.AppendEventAsync(runId, "worker.completed",
                new { task_id = Guid.NewGuid(), agent_instance_id = Guid.NewGuid() }, $"worker {index} finished");
        }

        var trace = _factory.Services.GetRequiredService<IRunTraceSearch>();
        var scope = _factory.Services.GetRequiredService<ITenantContextAccessor>().Current;
        var result = await trace.SearchAsync(new RunTraceQuery(
            scope.TenantId, scope.WorkspaceId, sessionId, runId, Limit: 2));

        Assert.Equal(2, result.Events.Count);
        Assert.Equal(2, result.Limit);
        Assert.True(result.Truncated);
    }

    private async Task<ToolExecutionSnapshot> CompletedExecutionAsync(
        Guid projectId, Guid sessionId, Guid runId, Guid taskId, Guid agentId)
    {
        const string parameters = """{"filepath":"a.ts","api_key":"sk-tool-secret"}""";
        var scope = _factory!.Services.GetRequiredService<ITenantContextAccessor>().Current;
        var coordinator = _factory.Services.GetRequiredService<IToolExecutionCoordinator>();
        var preparation = await coordinator.PrepareAsync(new ToolExecutionPrepareRequest(
            scope.TenantId, scope.WorkspaceId, projectId, sessionId, runId, taskId, agentId,
            "read_file", "low", false, false, parameters, ToolParametersHash.Compute(parameters),
            $"trace:{Guid.NewGuid():N}", "trace search test"));
        Assert.Equal("running", (await coordinator.TryStartAsync(preparation.Execution.Id)).Status);
        return await coordinator.CompleteAsync(preparation.Execution.Id,
            """{"success":true,"file_hash":"h","all_contents":[{"content":{"Content":"export const a = 1;","LineNumber":1},"line_hash":"x"}]}""",
            toolSuccess: true);
    }

    private async Task<(Guid ProjectId, Guid SessionId)> CreateProjectAndSessionAsync()
    {
        var client = _factory!.CreateClient();
        var projectPath = Path.Combine(_root, $"ws-{Guid.NewGuid():N}");
        Directory.CreateDirectory(projectPath);
        var project = await (await client.PostAsJsonAsync("/api/v1/projects", new { name = "Trace", path = projectPath }, Json))
            .Content.ReadFromJsonAsync<JsonElement>();
        var projectId = project.GetProperty("id").GetGuid();
        var session = await (await client.PostAsJsonAsync("/api/v1/sessions", new { project_id = projectId, title = "Trace" }, Json))
            .Content.ReadFromJsonAsync<JsonElement>();
        return (projectId, session.GetProperty("id").GetGuid());
    }

    private async Task<Guid> InsertRunAsync(Guid sessionId)
    {
        var scope = _factory!.Services.GetRequiredService<ITenantContextAccessor>().Current;
        await using var db = await _factory.Services.GetRequiredService<IDbContextFactory<LifecycleDbContext>>().CreateDbContextAsync();
        var run = new RunRecord
        {
            Id = Guid.NewGuid(),
            TenantId = scope.TenantId,
            WorkspaceId = scope.WorkspaceId,
            SessionId = sessionId,
            InitiatedByPrincipalId = Guid.NewGuid(),
            TriggerMessageId = Guid.NewGuid(),
            Status = "running",
            CreatedAt = DateTimeOffset.UtcNow,
            UpdatedAt = DateTimeOffset.UtcNow
        };
        db.Runs.Add(run);
        await db.SaveChangesAsync();
        return run.Id;
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
            }));
    }
}
