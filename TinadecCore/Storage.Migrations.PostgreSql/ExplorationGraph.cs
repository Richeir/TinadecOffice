using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using TinadecCore.Exploration;

namespace TinadecCore.Storage.Migrations.PostgreSql;

/// <summary>
/// B1 exploration graph: what was looked at (assets), what was recorded (nodes) and
/// how the records relate (edges). Created idempotently; DbContextSchemaBootstrapper
/// remains the additive fallback if migrations lag. SQLite counterpart lives in the
/// Sqlite migration project (same batch).
/// </summary>
[DbContext(typeof(ExplorationDbContext))]
[Migration("202610220001_ExplorationGraph")]
public sealed class ExplorationGraph : Migration
{
    protected override void Up(MigrationBuilder m) => m.Sql("""
        create table if not exists exploration_nodes (
            id uuid primary key,
            tenant_id uuid not null, workspace_id uuid not null, session_id uuid not null,
            run_id uuid null, task_id uuid null, agent_instance_id uuid null,
            kind varchar(32) not null, title varchar(512) not null, content text null, asset_key varchar(512) null,
            evidence_refs_json text not null default '[]', source_key varchar(256) not null, author varchar(128) null,
            created_at_unix_ms bigint not null, created_at timestamptz not null
        );
        create unique index if not exists ux_exploration_nodes_source on exploration_nodes(session_id, source_key);
        create index if not exists ix_exploration_nodes_scope_created on exploration_nodes(tenant_id, workspace_id, session_id, created_at_unix_ms);
        create index if not exists ix_exploration_nodes_session_kind on exploration_nodes(session_id, kind);
        create index if not exists ix_exploration_nodes_session_asset on exploration_nodes(session_id, asset_key);

        create table if not exists exploration_edges (
            id uuid primary key,
            tenant_id uuid not null, workspace_id uuid not null, session_id uuid not null,
            run_id uuid null, from_node_id uuid not null, to_node_id uuid not null,
            kind varchar(32) not null, label varchar(512) null, source_key varchar(256) not null,
            created_at_unix_ms bigint not null, created_at timestamptz not null
        );
        create unique index if not exists ux_exploration_edges_source on exploration_edges(session_id, source_key);
        create index if not exists ix_exploration_edges_scope_created on exploration_edges(tenant_id, workspace_id, session_id, created_at_unix_ms);
        create index if not exists ix_exploration_edges_session_from on exploration_edges(session_id, from_node_id);

        create table if not exists exploration_assets (
            id uuid primary key,
            tenant_id uuid not null, workspace_id uuid not null, session_id uuid not null,
            run_id uuid null, key varchar(512) not null, kind varchar(32) not null, title varchar(512) null, source_key varchar(256) null,
            created_at_unix_ms bigint not null, created_at timestamptz not null,
            updated_at_unix_ms bigint not null, updated_at timestamptz not null
        );
        create unique index if not exists ux_exploration_assets_key on exploration_assets(session_id, key);
        create index if not exists ix_exploration_assets_session_kind on exploration_assets(session_id, kind);
        """);

    protected override void Down(MigrationBuilder m) => m.Sql("""
        drop table if exists exploration_assets;
        drop table if exists exploration_edges;
        drop table if exists exploration_nodes;
        """);
}
