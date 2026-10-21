using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using TinadecCore.Exploration;

namespace TinadecCore.Storage.Migrations.Sqlite;

/// <summary>
/// B1 exploration graph: what was looked at (assets), what was recorded (nodes) and
/// how the records relate (edges). Created idempotently; DbContextSchemaBootstrapper
/// remains the additive fallback if migrations lag. PG counterpart lives in the
/// PostgreSql migration project (same batch).
/// </summary>
[DbContext(typeof(ExplorationDbContext))]
[Migration("202610220001_ExplorationGraph")]
public sealed class ExplorationGraph : Migration
{
    protected override void Up(MigrationBuilder m) => m.Sql("""
        create table if not exists exploration_nodes (
            id text primary key,
            tenant_id text not null, workspace_id text not null, session_id text not null,
            run_id text null, task_id text null, agent_instance_id text null,
            kind text not null, title text not null, content text null, asset_key text null,
            evidence_refs_json text not null default '[]', source_key text not null, author text null,
            created_at_unix_ms integer not null, created_at text not null
        );
        create unique index if not exists ux_exploration_nodes_source on exploration_nodes(session_id, source_key);
        create index if not exists ix_exploration_nodes_scope_created on exploration_nodes(tenant_id, workspace_id, session_id, created_at_unix_ms);
        create index if not exists ix_exploration_nodes_session_kind on exploration_nodes(session_id, kind);
        create index if not exists ix_exploration_nodes_session_asset on exploration_nodes(session_id, asset_key);

        create table if not exists exploration_edges (
            id text primary key,
            tenant_id text not null, workspace_id text not null, session_id text not null,
            run_id text null, from_node_id text not null, to_node_id text not null,
            kind text not null, label text null, source_key text not null,
            created_at_unix_ms integer not null, created_at text not null
        );
        create unique index if not exists ux_exploration_edges_source on exploration_edges(session_id, source_key);
        create index if not exists ix_exploration_edges_scope_created on exploration_edges(tenant_id, workspace_id, session_id, created_at_unix_ms);
        create index if not exists ix_exploration_edges_session_from on exploration_edges(session_id, from_node_id);

        create table if not exists exploration_assets (
            id text primary key,
            tenant_id text not null, workspace_id text not null, session_id text not null,
            run_id text null, key text not null, kind text not null, title text null, source_key text null,
            created_at_unix_ms integer not null, created_at text not null,
            updated_at_unix_ms integer not null, updated_at text not null
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
