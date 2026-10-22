using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using TinadecCore.DmaEA;

namespace TinadecCore.Storage.Migrations.PostgreSql;

/// <summary>
/// Evaluation gate: immutable content-addressed suites, paired control/treatment
/// runs, and the run a promotion decision is bound to. Idempotent so a database
/// whose schema was completed by the runtime additive pass still accepts it.
/// </summary>
[DbContext(typeof(AgentControlDbContext))]
[Migration("202610220004_AgentEvaluation")]
public sealed class AgentEvaluation : Migration
{
    protected override void Up(MigrationBuilder m) => m.Sql("""
        alter table agent_candidates add column if not exists eval_run_id uuid null;
        create table if not exists agent_eval_suites (id uuid primary key, tenant_id uuid not null, workspace_id uuid not null, slug varchar(128) not null, name varchar(256) not null, description text null, status varchar(32) not null, definition_reference varchar(1024) not null, definition_hash varchar(128) not null, definition_length bigint not null, created_by_principal_id uuid not null, created_at timestamptz not null, updated_at timestamptz not null);
        create unique index if not exists ix_agent_eval_suites_scope_slug on agent_eval_suites(tenant_id, workspace_id, slug);
        create index if not exists ix_agent_eval_suites_scope_created on agent_eval_suites(tenant_id, workspace_id, created_at);
        create table if not exists agent_eval_runs (id uuid primary key, tenant_id uuid not null, workspace_id uuid not null, candidate_id uuid not null, suite_id uuid not null, source_instance_id uuid not null, suite_hash varchar(128) not null, control_agent_definition_id uuid null, control_agent_version_id uuid null, control_version_hash varchar(128) null, control_system_prompt_hash varchar(128) null, treatment_proposal_hash varchar(128) not null, treatment_system_prompt_hash varchar(128) null, status varchar(32) not null, gate_status varchar(32) null, cases_total integer not null, cases_passed integer not null, cases_failed integer not null, cases_blocked integer not null, eligible_pairs integer not null, blocked_pairs integer not null, control_pass_rate double precision null, treatment_pass_rate double precision null, weighted_pass_rate double precision null, lift double precision null, model_route varchar(64) not null, model varchar(256) null, report_reference varchar(1024) null, report_hash varchar(128) null, report_length bigint null, error text null, created_by_principal_id uuid not null, started_at timestamptz not null, completed_at timestamptz null);
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
        alter table agent_candidates drop column if exists eval_run_id;
        """);
}
