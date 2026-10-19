using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;

namespace TinadecCore.Api.Tests;

/// <summary>
/// The runtime policy surface exists because every ceiling that can stop a legitimate run lived
/// only inside runtime.toml. These assertions pin what the product shows: the effective numbers,
/// the file that owns them, and which keys an operator changed relative to the shipped baseline.
/// </summary>
public sealed class RuntimePolicyEndpointTests
{
    private sealed class PolicyFactory(string token) : IsolatedApiFactory
    {
        private readonly string _root = ApiTestStorage.CreateRoot("runtime-policy");
        public string Root => _root;
        // The policy document is host-owned, so the scope registers only through the trusted
        // host channel — the same token StorageScopeApiTests uses.
        protected override void ConfigureClient(HttpClient client)
        {
            base.ConfigureClient(client);
            client.DefaultRequestHeaders.Add("X-Tinadec-Host-Control", token);
        }
        protected override bool UsesManagedStorage => true;
        protected override string? ManagedUserRoot => _root;
        protected override void ConfigureIsolatedWebHost(IWebHostBuilder builder) =>
            builder.ConfigureAppConfiguration((_, cfg) => cfg.AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Logging:LogLevel:Default"] = "Warning",
                ["TinadecStorage:Enabled"] = "true",
                ["TinadecStorage:UserRoot"] = _root,
                ["TinadecTools:DefaultWorkspaceRoot"] = Path.Combine(_root, "workspace"),
            }));
        protected override void Dispose(bool disposing)
        {
            base.Dispose(disposing);
            Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
            if (Directory.Exists(_root)) Directory.Delete(_root, recursive: true);
        }
    }

    /// <summary>Runs one body against a fresh scope with the host-control token in place.</summary>
    private static async Task WithScopeAsync(Func<PolicyFactory, HttpClient, Task> body)
    {
        var token = Guid.NewGuid().ToString("N");
        var previous = Environment.GetEnvironmentVariable("TINADEC_HOST_CONTROL_TOKEN");
        Environment.SetEnvironmentVariable("TINADEC_HOST_CONTROL_TOKEN", token);
        try
        {
            using var factory = new PolicyFactory(token);
            using var client = factory.CreateClient();
            await body(factory, client);
        }
        finally
        {
            Environment.SetEnvironmentVariable("TINADEC_HOST_CONTROL_TOKEN", previous);
        }
    }

    [Fact]
    public async Task ReportsTheShippedCeilingsOfThisInstallation() => await WithScopeAsync(async (_, client) =>
    {
        var response = await client.GetAsync("/api/v1/agent-runtime-policy");
        Assert.Equal(System.Net.HttpStatusCode.OK, response.StatusCode);
        using var document = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        var root = document.RootElement;

        Assert.Equal("runtime", root.GetProperty("document_id").GetString());
        Assert.EndsWith("runtime.toml", root.GetProperty("source_path").GetString()!.Replace('\\', '/'), StringComparison.Ordinal);
        Assert.Equal("ready", root.GetProperty("diagnostic").GetProperty("state").GetString());

        // The numbers the shipped baseline carries. A fresh scope is seeded from that same file,
        // so it agrees with it and nothing is reported as customized.
        var spawn = root.GetProperty("spawn");
        Assert.Equal(2, spawn.GetProperty("max_depth").GetInt32());
        Assert.Equal(16, spawn.GetProperty("max_agents_per_run").GetInt32());
        Assert.Equal(4, spawn.GetProperty("max_parallel_workers").GetInt32());
        Assert.Equal(2, root.GetProperty("scheduling").GetProperty("max_active_runs_per_session").GetInt32());
        Assert.Equal(2, root.GetProperty("supervision").GetProperty("max_revision_rounds").GetInt32());
        Assert.Equal(131_072, root.GetProperty("context").GetProperty("default_token_budget").GetInt32());
        Assert.Equal(0, root.GetProperty("context").GetProperty("run_token_budget").GetInt32());
        Assert.Equal(500, root.GetProperty("tools").GetProperty("max_tool_calls").GetInt32());
        if (root.GetProperty("defaults_available").GetBoolean())
            Assert.Empty(root.GetProperty("deviations").EnumerateArray());
    });

    [Fact]
    public async Task ReportsAnEditedValueAsACustomizedKey() => await WithScopeAsync(async (factory, client) =>
    {
        var path = Path.Combine(factory.Root, "config", "runtime.toml");
        Assert.True(File.Exists(path), "The user scope seeds runtime.toml on start.");
        var text = await File.ReadAllTextAsync(path);
        await File.WriteAllTextAsync(path, text.Replace("max_active_runs_per_session = 2", "max_active_runs_per_session = 5", StringComparison.Ordinal));

        var response = await client.GetAsync("/api/v1/agent-runtime-policy");
        response.EnsureSuccessStatusCode();
        var root = await response.Content.ReadFromJsonAsync<JsonElement>();

        // The store re-hashes the document on read, so an edit is effective immediately rather
        // than on the next restart.
        Assert.Equal(5, root.GetProperty("scheduling").GetProperty("max_active_runs_per_session").GetInt32());
        var deviations = root.GetProperty("deviations").EnumerateArray().Select(item => item.GetString()).ToArray();
        Assert.Contains("scheduling.max_active_runs_per_session", deviations);
        // Only that key: the remaining ceilings are untouched, so they are still the shipped ones.
        Assert.Single(deviations);
    });
}
