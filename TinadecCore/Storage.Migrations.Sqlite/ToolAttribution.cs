using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using TinadecCore.Lifecycle;

namespace TinadecCore.Storage.Migrations.Sqlite;

/// <summary>
/// B5 tool attribution: what happened to a call beyond its transport status. Nullable on
/// purpose — every execution recorded before this migration has no attribution, and a
/// cancellation still has no honest ok/blocked/error verdict to name.
/// </summary>
[DbContext(typeof(LifecycleDbContext))]
[Migration("202610220003_ToolAttribution")]
public sealed class ToolAttribution : Migration
{
    protected override void Up(MigrationBuilder m) => m.Sql("""
        alter table tool_executions add column outcome text null;
        alter table tool_executions add column retryable integer null;
        alter table tool_executions add column policy_ref text null;
        alter table tool_executions add column agent_guidance text null;
        create index if not exists ix_tool_executions_run_outcome on tool_executions(run_id, outcome);
        """);

    protected override void Down(MigrationBuilder m) => m.Sql("""
        drop index if exists ix_tool_executions_run_outcome;
        alter table tool_executions drop column agent_guidance;
        alter table tool_executions drop column policy_ref;
        alter table tool_executions drop column retryable;
        alter table tool_executions drop column outcome;
        """);
}
