using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using TinadecCore.DmaEA;

namespace TinadecCore.Storage.Migrations.Sqlite;

/// <summary>
/// Evaluation gate: immutable content-addressed suites, paired control/treatment
/// runs, and the run a promotion decision is bound to.
/// </summary>
[DbContext(typeof(AgentControlDbContext))]
[Migration("202610220004_AgentEvaluation")]
public sealed class AgentEvaluation : Migration
{
    protected override void Up(MigrationBuilder m) => m.Sql("""
        alter table agent_candidates add column eval_run_id text null;
        create table if not exists agent_eval_suites (id text primary key, tenant_id text not null, workspace_id text not null, slug text not null, name text not null, description text null, status text not null, definition_reference text not null, definition_hash text not null, definition_length integer not null, created_by_principal_id text not null, created_at text not null, updated_at text not null);
        create unique index if not exists ix_agent_eval_suites_scope_slug on agent_eval_suites(tenant_id, workspace_id, slug);
        create index if not exists ix_agent_eval_suites_scope_created on agent_eval_suites(tenant_id, workspace_id, created_at);
        create table if not exists agent_eval_runs (id text primary key, tenant_id text not null, workspace_id text not null, candidate_id text not null, suite_id text not null, source_instance_id text not null, suite_hash text not null, control_agent_definition_id text null, control_agent_version_id text null, control_version_hash text null, control_system_prompt_hash text null, treatment_proposal_hash text not null, treatment_system_prompt_hash text null, status text not null, gate_status text null, cases_total integer not null, cases_passed integer not null, cases_failed integer not null, cases_blocked integer not null, eligible_pairs integer not null, blocked_pairs integer not null, control_pass_rate real null, treatment_pass_rate real null, weighted_pass_rate real null, lift real null, model_route text not null, model text null, report_reference text null, report_hash text null, report_length integer null, error text null, created_by_principal_id text not null, started_at text not null, completed_at text null);
        create index if not exists ix_agent_eval_runs_scope_candidate_started on agent_eval_runs(tenant_id, workspace_id, candidate_id, started_at);
        create index if not exists ix_agent_eval_runs_suite on agent_eval_runs(suite_id);
        """);

    protected override void Down(MigrationBuilder m) => m.Sql("""
        drop index if exists ix_agent_eval_runs_suite;
        drop index if exists ix_agent_eval_runs_scope_candidate_started;
        drop table if exists agent_eval_runs;
        drop index if exists ix_agent_eval_suites_scope_created;
        drop index if exists ix_agent_eval_suites_scope_slug;
        drop table if exists agent_eval_suites;
        alter table agent_candidates drop column eval_run_id;
        """);
}
