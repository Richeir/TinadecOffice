using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using TinadecCore.Memory;

namespace TinadecCore.Storage.Migrations.Sqlite;

[DbContext(typeof(MemoryDbContext))]
[Migration("202610270001_AttachmentExposures")]
public sealed class AttachmentExposures : Migration
{
    protected override void Up(MigrationBuilder m) => m.Sql("""
        create table if not exists message_attachments (
            id text not null primary key,
            tenant_id text not null,
            workspace_id text not null,
            session_id text not null,
            message_id text null,
            file_name text not null,
            media_type text not null,
            content_reference text not null,
            content_hash text not null,
            content_length integer not null,
            origin text not null default 'composer',
            project_id text null,
            source_path text null,
            delivered_to_model integer not null default 0,
            delivered_run_id text null,
            delivered_at text null,
            created_by_principal_id text not null,
            created_at text not null,
            bound_at text null
        );
        """);

    protected override void Down(MigrationBuilder m) { }
}
