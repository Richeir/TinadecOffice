using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using TinadecCore.AgentConfiguration;

namespace TinadecCore.Storage.Migrations.PostgreSql;

/// <summary>
/// Adds per-locale overlays to pack-managed resources. Nullable so old rows and
/// packs without overlays keep their exact serialized shape.
/// </summary>
[DbContext(typeof(AgentConfigurationDbContext))]
[Migration("202610210001_AgentPackI18n")]
public sealed class AgentPackI18n : Migration
{
    protected override void Up(MigrationBuilder m) => m.Sql("""
        alter table agent_definitions add column if not exists i18n_json text null;
        alter table agent_modes add column if not exists i18n_json text null;
        alter table mode_nodes add column if not exists i18n_json text null;
        alter table prompt_pipelines add column if not exists i18n_json text null;
        alter table prompt_versions add column if not exists i18n_json text null;
        """);

    protected override void Down(MigrationBuilder m) => m.Sql("""
        alter table prompt_versions drop column if exists i18n_json;
        alter table prompt_pipelines drop column if exists i18n_json;
        alter table mode_nodes drop column if exists i18n_json;
        alter table agent_modes drop column if exists i18n_json;
        alter table agent_definitions drop column if exists i18n_json;
        """);
}
