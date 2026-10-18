using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using TinadecCore.AgentConfiguration;
using TinadecCore.Memory;

namespace TinadecCore.Api.Tests;

/// <summary>
/// GET /api/v1/sessions used to read the workspace-defaults row once per session
/// — one DbContext and one query each. On a real project (9 sessions, one
/// defaults row) that list call cost ~270 ms; the batched read brings it to
/// ~54 ms. This pins the observable contract end to end: every listed session
/// still reports has_update / latest_mode_version_id exactly as the database says,
/// and a foreign workspace's default never leaks into the answer.
///
/// Honest scope: this guards the *result*, not the query count. Reverting to a
/// per-session read would still pass it — that is a performance regression, and
/// it is guarded by the measured numbers and review, not by this test. What this
/// test does catch is a projection that reports the wrong default or the wrong
/// has_update, which is the user-visible failure mode of the same edit.
/// </summary>
public sealed class SessionListModeDefaultsTests
{
    [Fact]
    public async Task EveryListedSessionReportsTheWorkspaceDefaultState()
    {
        var root = Path.Combine(Path.GetTempPath(), "tinadec-session-list", Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            using var factory = new SessionListFactory(root);
            using var client = factory.CreateClient();

            var project = await (await client.PostAsJsonAsync("/api/v1/projects",
                new { name = "session-defaults", path = Path.Combine(root, "workspace") }))
                .Content.ReadFromJsonAsync<JsonElement>();
            var projectId = project.GetProperty("id").GetGuid();

            // Three sessions so the batched read has more than one consumer.
            var created = new List<Guid>();
            for (var index = 0; index < 3; index++)
            {
                var session = await (await client.PostAsJsonAsync("/api/v1/sessions",
                    new { project_id = projectId, title = $"session {index}" }))
                    .Content.ReadFromJsonAsync<JsonElement>();
                created.Add(session.GetProperty("id").GetGuid());
            }

            Guid? expectedDefault;
            var storedModes = new Dictionary<Guid, Guid?>();
            using (var scope = factory.Services.CreateScope())
            {
                await using var cfg = await scope.ServiceProvider
                    .GetRequiredService<IDbContextFactory<AgentConfigurationDbContext>>().CreateDbContextAsync();
                var ownDefaults = await cfg.WorkspaceDefaults.AsNoTracking().FirstOrDefaultAsync();
                Assert.NotNull(ownDefaults);
                expectedDefault = ownDefaults!.DefaultModeVersionId;
                // A foreign workspace whose default differs: the batched read filters by
                // workspace, so this row must never leak into has_update for our sessions.
                // Dropping the workspace predicate is exactly the regression this catches.
                cfg.WorkspaceDefaults.Add(new WorkspaceDefaultsRecord
                {
                    TenantId = ownDefaults.TenantId,
                    WorkspaceId = Guid.NewGuid(),
                    DefaultModeVersionId = Guid.NewGuid(),
                    Status = "active",
                    CreatedAt = DateTimeOffset.UtcNow,
                    UpdatedAt = DateTimeOffset.UtcNow
                });
                await cfg.SaveChangesAsync();
                await using var memory = await scope.ServiceProvider
                    .GetRequiredService<IDbContextFactory<MemoryDbContext>>().CreateDbContextAsync();
                foreach (var id in created)
                {
                    storedModes[id] = (await memory.Sessions.AsNoTracking().FirstOrDefaultAsync(x => x.Id == id))?.ModeVersionId;
                }
            }

            var listed = await client.GetFromJsonAsync<JsonElement[]>("/api/v1/sessions?lifecycle_status=active");
            Assert.NotNull(listed);
            var byId = listed!.ToDictionary(x => x.GetProperty("id").GetGuid());

            foreach (var id in created)
            {
                Assert.True(byId.ContainsKey(id), $"session {id} is missing from the list");
                var item = byId[id];
                Assert.Equal(
                    expectedDefault is not null && storedModes[id] != expectedDefault,
                    item.GetProperty("has_update").GetBoolean());
                if (expectedDefault is null)
                    Assert.Equal(JsonValueKind.Null, item.GetProperty("latest_mode_version_id").ValueKind);
                else
                    Assert.Equal(expectedDefault.Value, item.GetProperty("latest_mode_version_id").GetGuid());
            }
        }
        finally
        {
            try { Directory.Delete(root, true); } catch { }
        }
    }

    private sealed class SessionListFactory : IsolatedApiFactory
    {
        private readonly string _root;
        public SessionListFactory(string root) => _root = root;

        protected override void ConfigureIsolatedWebHost(Microsoft.AspNetCore.Hosting.IWebHostBuilder builder)
        {
            builder.ConfigureAppConfiguration((_, configuration) => configuration.AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["TinadecPersistence:Sqlite:DatabasePath"] = Path.Combine(_root, "tinadec.db"),
                ["TinadecPersistence:DataRoot"] = Path.Combine(_root, "data"),
                ["Logging:LogLevel:Default"] = "Warning"
            }));
        }
    }
}