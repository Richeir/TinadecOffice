using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using TinadecCore.Lifecycle;

namespace TinadecCore.Storage.Migrations.PostgreSql;

/// <summary>
/// B5 tool attribution: what happened to a call beyond its transport status. Idempotent so a
/// database whose schema was completed by the runtime additive pass still accepts the migration.
/// </summary>
[DbContext(typeof(LifecycleDbContext))]
[Migration("202610220003_ToolAttribution")]
public sealed class ToolAttribution : Migration
{
    protected override void Up(MigrationBuilder m) => m.Sql("""
        alter table tool_executions add column if not exists outcome varchar(16) null;
        alter table tool_executions add column if not exists retryable boolean null;
        alter table tool_executions add column if not exists policy_ref varchar(256) null;
        alter table tool_executions add column if not exists agent_guidance varchar(1024) null;
        create index if not exists ix_tool_executions_run_outcome on tool_executions(run_id, outcome);
        """);

    protected override void Down(MigrationBuilder m) => m.Sql("""
        drop index if exists ix_tool_executions_run_outcome;
        alter table tool_executions drop column if exists agent_guidance;
        alter table tool_executions drop column if exists policy_ref;
        alter table tool_executions drop column if exists retryable;
        alter table tool_executions drop column if exists outcome;
        """);
}
