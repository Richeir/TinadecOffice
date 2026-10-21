using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using TinadecCore.Exploration;

namespace TinadecCore.Storage.Migrations.Sqlite;

/// <summary>
/// B2 plan ledger: intents are exploration nodes of kind <c>intent</c>, so the ledger only adds the
/// workflow columns to that table. Nullable on purpose: every node recorded before this migration,
/// and every node that is not an intent, has no status and no owner. PG counterpart lives in the
/// PostgreSql migration project (same batch).
/// </summary>
[DbContext(typeof(ExplorationDbContext))]
[Migration("202610220002_PlanLedger")]
public sealed class PlanLedger : Migration
{
    protected override void Up(MigrationBuilder m) => m.Sql("""
        alter table exploration_nodes add column status text null;
        alter table exploration_nodes add column claimed_by_agent_instance_id text null;
        alter table exploration_nodes add column note text null;
        alter table exploration_nodes add column updated_at_unix_ms integer null;
        alter table exploration_nodes add column updated_at text null;
        create index if not exists ix_exploration_nodes_run_status on exploration_nodes(run_id, status);
        """);

    protected override void Down(MigrationBuilder m) => m.Sql("""
        drop index if exists ix_exploration_nodes_run_status;
        alter table exploration_nodes drop column updated_at;
        alter table exploration_nodes drop column updated_at_unix_ms;
        alter table exploration_nodes drop column note;
        alter table exploration_nodes drop column claimed_by_agent_instance_id;
        alter table exploration_nodes drop column status;
        """);
}
