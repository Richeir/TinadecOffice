using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using TinadecCore.Models;

namespace TinadecCore.Storage.Migrations.Sqlite;

/// <summary>Sqlite counterpart of the PostgreSql ModelHealth migration.</summary>
[DbContext(typeof(ModelControlDbContext))]
[Migration("202610210002_ModelHealth")]
public sealed class ModelHealth : Migration
{
    protected override void Up(MigrationBuilder m) => m.Sql("""
        create table if not exists model_health (
            id text primary key,
            tenant_id text not null,
            workspace_id text not null,
            provider_instance_id text not null,
            model text not null,
            consecutive_failures integer not null default 0,
            cooling_until text null,
            last_category text null,
            updated_at text not null);
        create unique index if not exists ix_model_health_scope_candidate
            on model_health(tenant_id, workspace_id, provider_instance_id, model);
        """);

    protected override void Down(MigrationBuilder m) => m.Sql("drop table if exists model_health;");
}
