using Microsoft.EntityFrameworkCore;

namespace TinadecCore.Exploration;

/// <summary>
/// Persistence for the session exploration graph (B1). Three tables, one concern: what was looked at
/// (assets), what was recorded (nodes), and how the records relate (edges). The graph is session-scoped
/// — a session is where a line of investigation lives — and rows carry tenant/workspace so a scope
/// read can never cross them.
/// </summary>
public sealed class ExplorationDbContext(DbContextOptions<ExplorationDbContext> options) : DbContext(options)
{
    public DbSet<ExplorationNodeRecord> Nodes => Set<ExplorationNodeRecord>();
    public DbSet<ExplorationEdgeRecord> Edges => Set<ExplorationEdgeRecord>();
    public DbSet<ExplorationAssetRecord> Assets => Set<ExplorationAssetRecord>();

    protected override void OnModelCreating(ModelBuilder model)
    {
        model.UseTinadecSnakeCase();
        model.Entity<ExplorationNodeRecord>(e =>
        {
            e.ToTable("exploration_nodes");
            e.HasKey(x => x.Id);
            // One node per source per session: a settlement or a tool retry re-recording the same fact
            // is a no-op, not a duplicate.
            e.HasIndex(x => new { x.SessionId, x.SourceKey }).IsUnique();
            // Query reads a session's nodes newest first; coverage reads one kind.
            e.HasIndex(x => new { x.TenantId, x.WorkspaceId, x.SessionId, x.CreatedAtUnixMs });
            e.HasIndex(x => new { x.SessionId, x.Kind });
            e.HasIndex(x => new { x.SessionId, x.AssetKey });
            // The plan ledger reads one run's intents by status; other node kinds leave both null.
            e.HasIndex(x => new { x.RunId, x.Status });
            e.Property(x => x.Kind).HasMaxLength(32);
            e.Property(x => x.Title).HasMaxLength(512);
            e.Property(x => x.AssetKey).HasMaxLength(512);
            e.Property(x => x.SourceKey).HasMaxLength(256);
            e.Property(x => x.Author).HasMaxLength(128);
            e.Property(x => x.Status).HasMaxLength(32);
        });
        model.Entity<ExplorationEdgeRecord>(e =>
        {
            e.ToTable("exploration_edges");
            e.HasKey(x => x.Id);
            e.HasIndex(x => new { x.SessionId, x.SourceKey }).IsUnique();
            e.HasIndex(x => new { x.TenantId, x.WorkspaceId, x.SessionId, x.CreatedAtUnixMs });
            e.HasIndex(x => new { x.SessionId, x.FromNodeId });
            e.Property(x => x.Kind).HasMaxLength(32);
            e.Property(x => x.Label).HasMaxLength(512);
            e.Property(x => x.SourceKey).HasMaxLength(256);
        });
        model.Entity<ExplorationAssetRecord>(e =>
        {
            e.ToTable("exploration_assets");
            e.HasKey(x => x.Id);
            // One asset row per key per session, whichever spelling first declared it.
            e.HasIndex(x => new { x.SessionId, x.Key }).IsUnique();
            e.HasIndex(x => new { x.SessionId, x.Kind });
            e.Property(x => x.Key).HasMaxLength(512);
            e.Property(x => x.Kind).HasMaxLength(32);
            e.Property(x => x.Title).HasMaxLength(512);
            e.Property(x => x.SourceKey).HasMaxLength(256);
        });
    }
}

public sealed class ExplorationNodeRecord
{
    public Guid Id { get; set; }
    public Guid TenantId { get; set; }
    public Guid WorkspaceId { get; set; }
    public Guid SessionId { get; set; }
    public Guid? RunId { get; set; }
    public Guid? TaskId { get; set; }
    public Guid? AgentInstanceId { get; set; }
    public string Kind { get; set; } = string.Empty;
    public string Title { get; set; } = string.Empty;
    public string? Content { get; set; }
    public string? AssetKey { get; set; }
    /// <summary>JSON array of evidence ids, paths or execution ids the node is grounded in.</summary>
    public string EvidenceRefsJson { get; set; } = "[]";
    public string SourceKey { get; set; } = string.Empty;
    public string? Author { get; set; }
    /// <summary>Plan-ledger state; null for every non-intent node, which has no workflow state.</summary>
    public string? Status { get; set; }
    /// <summary>The worker instance that claimed the intent; only it may complete or block it.</summary>
    public Guid? ClaimedByAgentInstanceId { get; set; }
    /// <summary>Why the intent was completed or blocked, in the writer's words.</summary>
    public string? Note { get; set; }
    /// <summary>Ordering column: SQLite cannot order by DateTimeOffset.</summary>
    public long CreatedAtUnixMs { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public long? UpdatedAtUnixMs { get; set; }
    public DateTimeOffset? UpdatedAt { get; set; }
}

public sealed class ExplorationEdgeRecord
{
    public Guid Id { get; set; }
    public Guid TenantId { get; set; }
    public Guid WorkspaceId { get; set; }
    public Guid SessionId { get; set; }
    public Guid? RunId { get; set; }
    public Guid FromNodeId { get; set; }
    public Guid ToNodeId { get; set; }
    public string Kind { get; set; } = string.Empty;
    public string? Label { get; set; }
    public string SourceKey { get; set; } = string.Empty;
    public long CreatedAtUnixMs { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
}

/// <summary>An asset the investigation knows about. Coverage is derived: a fact or finding naming its key covers it.</summary>
public sealed class ExplorationAssetRecord
{
    public Guid Id { get; set; }
    public Guid TenantId { get; set; }
    public Guid WorkspaceId { get; set; }
    public Guid SessionId { get; set; }
    public Guid? RunId { get; set; }
    public string Key { get; set; } = string.Empty;
    public string Kind { get; set; } = string.Empty;
    public string? Title { get; set; }
    public string? SourceKey { get; set; }
    public long CreatedAtUnixMs { get; set; }
    public DateTimeOffset CreatedAt { get; set; }
    public long UpdatedAtUnixMs { get; set; }
    public DateTimeOffset UpdatedAt { get; set; }
}
