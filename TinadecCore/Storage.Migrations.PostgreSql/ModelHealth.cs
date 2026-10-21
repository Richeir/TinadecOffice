using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using TinadecCore.Models;

namespace TinadecCore.Storage.Migrations.PostgreSql;

/// <summary>
/// Persistent breaker state for model candidates (B8). One row per
/// (tenant, workspace, provider instance, model); a shared outage is shared by
/// every route naming the same pair.
/// </summary>
[DbContext(typeof(ModelControlDbContext))]
[Migration("202610210002_ModelHealth")]
public sealed class ModelHealth : Migration
{
    protected override void Up(MigrationBuilder m) => m.Sql("""
        create table if not exists model_health (
            id uuid primary key,
            tenant_id uuid not null,
            workspace_id uuid not null,
            provider_instance_id uuid not null,
            model varchar(512) not null,
            consecutive_failures integer not null default 0,
            cooling_until timestamptz null,
            last_category varchar(64) null,
            updated_at timestamptz not null);
        create unique index if not exists ix_model_health_scope_candidate
            on model_health(tenant_id, workspace_id, provider_instance_id, model);
        """);

    protected override void Down(MigrationBuilder m) => m.Sql("drop table if exists model_health;");
}
