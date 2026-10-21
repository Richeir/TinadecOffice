using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using TinadecCore.AgentConfiguration;

namespace TinadecCore.Storage.Migrations.Sqlite;

/// <summary>Sqlite counterpart of the PostgreSql AgentPackI18n migration.</summary>
[DbContext(typeof(AgentConfigurationDbContext))]
[Migration("202610210001_AgentPackI18n")]
public sealed class AgentPackI18n : Migration
{
    protected override void Up(MigrationBuilder m) => m.Sql("""
        alter table agent_definitions add column i18n_json text null;
        alter table agent_modes add column i18n_json text null;
        alter table mode_nodes add column i18n_json text null;
        alter table prompt_pipelines add column i18n_json text null;
        alter table prompt_versions add column i18n_json text null;
        """);

    protected override void Down(MigrationBuilder m) => m.Sql("""
        alter table prompt_versions drop column i18n_json;
        alter table prompt_pipelines drop column i18n_json;
        alter table mode_nodes drop column i18n_json;
        alter table agent_modes drop column i18n_json;
        alter table agent_definitions drop column i18n_json;
        """);
}
