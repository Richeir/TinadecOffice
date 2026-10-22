using Microsoft.EntityFrameworkCore;
using TinadecCore.DmaEA;
using TinadecCore.Persistence;
using Xunit;

namespace TinadecCore.Api.Tests;

/// <summary>
/// The evaluation tables and the candidate's eval_run_id are bootstrap-owned:
/// databases created before migration 202610220004 must be reconciled by
/// EnsureTablesAsync, otherwise the first evaluation run fails at insert time.
/// </summary>
public sealed class AgentEvaluationSchemaTests
{
    [Fact]
    public async Task EnsureTables_RestoresEvalRunColumnAndCreatesEvaluationTables()
    {
        var databasePath = Path.Combine(Path.GetTempPath(), $"tinadec-agent-eval-schema-{Guid.NewGuid():N}.db");
        try
        {
            var options = new DbContextOptionsBuilder<AgentControlDbContext>()
                .UseSqlite($"Data Source={databasePath}")
                .Options;

            await using (var db = new AgentControlDbContext(options))
            {
                await DbContextSchemaBootstrapper.EnsureTablesAsync(db);
                // The pre-evaluation shape this test guards against.
                await db.Database.ExecuteSqlRawAsync("alter table agent_candidates drop column eval_run_id;");
            }

            await using (var db = new AgentControlDbContext(options))
            {
                await DbContextSchemaBootstrapper.EnsureTablesAsync(db);

                var candidateColumns = await db.Database
                    .SqlQueryRaw<string>("SELECT name AS \"Value\" FROM pragma_table_info('agent_candidates')")
                    .ToListAsync();
                Assert.Contains("eval_run_id", candidateColumns);

                var tables = await db.Database
                    .SqlQueryRaw<string>("SELECT name AS \"Value\" FROM sqlite_master WHERE type = 'table'")
                    .ToListAsync();
                Assert.Contains("agent_eval_suites", tables);
                Assert.Contains("agent_eval_runs", tables);

                var indexes = await db.Database
                    .SqlQueryRaw<string>("SELECT name AS \"Value\" FROM sqlite_master WHERE type = 'index'")
                    .ToListAsync();
                Assert.Contains("ix_agent_eval_suites_scope_slug", indexes);
                Assert.Contains("ix_agent_eval_suites_scope_created", indexes);
                Assert.Contains("ix_agent_eval_runs_scope_candidate_started", indexes);
                Assert.Contains("ix_agent_eval_runs_suite", indexes);
            }

            var tenantId = Guid.NewGuid();
            var workspaceId = Guid.NewGuid();
            var suiteId = Guid.NewGuid();
            var now = DateTimeOffset.UtcNow;
            await using (var db = new AgentControlDbContext(options))
            {
                db.EvalSuites.Add(new AgentEvalSuiteRecord
                {
                    Id = suiteId, TenantId = tenantId, WorkspaceId = workspaceId,
                    Slug = "reconciled", Name = "Reconciled suite",
                    DefinitionReference = "content/reconciled", DefinitionHash = new string('a', 64), DefinitionLength = 2,
                    CreatedByPrincipalId = Guid.NewGuid(), CreatedAt = now, UpdatedAt = now
                });
                db.EvalRuns.Add(new AgentEvalRunRecord
                {
                    Id = Guid.NewGuid(), TenantId = tenantId, WorkspaceId = workspaceId,
                    CandidateId = Guid.NewGuid(), SuiteId = suiteId, SourceInstanceId = Guid.NewGuid(),
                    SuiteHash = new string('a', 64), TreatmentProposalHash = new string('b', 64),
                    Status = "completed", GateStatus = "failed", ModelRoute = "chat",
                    CreatedByPrincipalId = Guid.NewGuid(), StartedAt = now
                });
                await db.SaveChangesAsync();
            }
        }
        finally
        {
            try { File.Delete(databasePath); } catch (IOException) { }
        }
    }
}
