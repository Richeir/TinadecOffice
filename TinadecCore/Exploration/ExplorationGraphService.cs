using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using TinadecCore.Abstractions.Ports;

namespace TinadecCore.Exploration;

/// <summary>
/// The session exploration graph over its own persistence (B1). Writes are idempotent on their source
/// key; reads always filter by the caller's tenant/workspace/session; coverage is derived from the
/// nodes rather than stored, so a node deleted or reclassified cannot leave a stale "covered" badge.
/// A digest is two facts written together: the compressed node, and the original text in the session's
/// evidence archive.
/// </summary>
public sealed class ExplorationGraphService(IDbContextFactory<ExplorationDbContext> factory, IEvidenceArchive evidence) : IExplorationGraph
{
    /// <summary>One node's content is kept up to this length; past it the cut is marked.</summary>
    public const int MaxContentChars = 16_000;
    public const int MaxEvidenceRefs = 32;
    private const int MaxTitleChars = 512;
    private const int MaxSourceKeyChars = 256;
    private const int MaxAssetKeyChars = 512;
    private const int MaxEvidenceRefChars = 512;
    private const int UncoveredListLimit = 100;

    public async Task<ExplorationNode> AppendNodeAsync(ExplorationScope scope, ExplorationNodeDraft node, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(node);
        RequireScope(scope);
        if (!ExplorationNodeKinds.IsKnown(node.Kind))
            throw new ArgumentException($"'{node.Kind}' is not an exploration node kind; use {string.Join(", ", ExplorationNodeKinds.All)}.", nameof(node));
        var title = Required(node.Title, "title", MaxTitleChars);
        var content = string.IsNullOrWhiteSpace(node.Content) ? null : Clip(node.Content.Trim(), MaxContentChars);
        var assetKey = NormalizeAssetKey(node.AssetKey);
        if (assetKey is { Length: > MaxAssetKeyChars }) throw new ArgumentException($"asset_key must be at most {MaxAssetKeyChars} characters.", nameof(node));
        var refs = NormalizeEvidenceRefs(node.EvidenceRefs);
        var sourceKey = SourceKey(node.SourceKey, () => $"node:{Guid.NewGuid():N}");
        var author = string.IsNullOrWhiteSpace(node.Author) ? null : Clip(node.Author.Trim(), 128);

        await using var db = await factory.CreateDbContextAsync(cancellationToken).ConfigureAwait(false);
        var existing = await db.Nodes.AsNoTracking()
            .Where(row => row.TenantId == scope.TenantId && row.WorkspaceId == scope.WorkspaceId
                && row.SessionId == scope.SessionId && row.SourceKey == sourceKey)
            .FirstOrDefaultAsync(cancellationToken).ConfigureAwait(false);
        if (existing is not null) return ToNode(existing);

        var now = DateTimeOffset.UtcNow;
        var row = new ExplorationNodeRecord
        {
            Id = Guid.NewGuid(),
            TenantId = scope.TenantId,
            WorkspaceId = scope.WorkspaceId,
            SessionId = scope.SessionId,
            RunId = scope.RunId,
            TaskId = scope.TaskId,
            AgentInstanceId = scope.AgentInstanceId,
            Kind = node.Kind,
            Title = title,
            Content = content,
            AssetKey = assetKey,
            EvidenceRefsJson = JsonSerializer.Serialize(refs),
            SourceKey = sourceKey,
            Author = author,
            CreatedAtUnixMs = now.ToUnixTimeMilliseconds(),
            CreatedAt = now
        };
        db.Nodes.Add(row);
        try
        {
            await db.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
            return ToNode(row);
        }
        catch (DbUpdateException)
        {
            // A concurrent append of the same source won the unique index; its node is the one.
            var winner = await db.Nodes.AsNoTracking()
                .Where(item => item.TenantId == scope.TenantId && item.WorkspaceId == scope.WorkspaceId
                    && item.SessionId == scope.SessionId && item.SourceKey == sourceKey)
                .FirstOrDefaultAsync(cancellationToken).ConfigureAwait(false);
            return winner is null ? throw new InvalidOperationException("The exploration node could not be written.") : ToNode(winner);
        }
    }

    public async Task<IReadOnlyList<ExplorationNode>> QueryAsync(ExplorationScope scope, ExplorationQuery query, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(query);
        RequireScope(scope);
        if (query.Kind is { Length: > 0 } kind && !ExplorationNodeKinds.IsKnown(kind))
            throw new ArgumentException($"'{kind}' is not an exploration node kind; use {string.Join(", ", ExplorationNodeKinds.All)}.", nameof(query));
        var assetKey = NormalizeAssetKey(query.AssetKey);
        var limit = Math.Clamp(query.Limit, 1, 100);

        await using var db = await factory.CreateDbContextAsync(cancellationToken).ConfigureAwait(false);
        var rows = db.Nodes.AsNoTracking()
            .Where(row => row.TenantId == scope.TenantId && row.WorkspaceId == scope.WorkspaceId && row.SessionId == scope.SessionId);
        if (query.Kind is { Length: > 0 }) rows = rows.Where(row => row.Kind == query.Kind);
        if (query.RunId is { } runId) rows = rows.Where(row => row.RunId == runId);
        if (assetKey is not null) rows = rows.Where(row => row.AssetKey == assetKey);
        var selected = await rows.OrderByDescending(row => row.CreatedAtUnixMs)
            .Take(limit)
            .ToListAsync(cancellationToken).ConfigureAwait(false);
        return selected.Select(ToNode).ToArray();
    }

    public async Task<ExplorationEdge> AppendEdgeAsync(ExplorationScope scope, ExplorationEdgeDraft edge, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(edge);
        RequireScope(scope);
        if (!ExplorationEdgeKinds.IsKnown(edge.Kind))
            throw new ArgumentException($"'{edge.Kind}' is not an exploration edge kind; use {string.Join(", ", ExplorationEdgeKinds.All)}.", nameof(edge));
        if (edge.FromNodeId == Guid.Empty || edge.ToNodeId == Guid.Empty)
            throw new ArgumentException("from_node_id and to_node_id are required.", nameof(edge));
        if (edge.FromNodeId == edge.ToNodeId)
            throw new ArgumentException("A node cannot be linked to itself.", nameof(edge));
        var sourceKey = SourceKey(edge.SourceKey, () => $"edge:{edge.FromNodeId:N}:{edge.ToNodeId:N}:{edge.Kind}");
        var label = string.IsNullOrWhiteSpace(edge.Label) ? null : Clip(edge.Label.Trim(), MaxTitleChars);

        await using var db = await factory.CreateDbContextAsync(cancellationToken).ConfigureAwait(false);
        var existing = await db.Edges.AsNoTracking()
            .Where(row => row.TenantId == scope.TenantId && row.WorkspaceId == scope.WorkspaceId
                && row.SessionId == scope.SessionId && row.SourceKey == sourceKey)
            .FirstOrDefaultAsync(cancellationToken).ConfigureAwait(false);
        if (existing is not null) return ToEdge(existing);

        // Both ends must be nodes of this session: a link is not a way to address another session's graph.
        var ends = new[] { edge.FromNodeId, edge.ToNodeId };
        var found = await db.Nodes.AsNoTracking()
            .Where(row => row.TenantId == scope.TenantId && row.WorkspaceId == scope.WorkspaceId
                && row.SessionId == scope.SessionId && ends.Contains(row.Id))
            .Select(row => row.Id)
            .ToListAsync(cancellationToken).ConfigureAwait(false);
        if (found.Count != 2)
            throw new KeyNotFoundException("Both ends of a link must be nodes recorded in this session.");

        var now = DateTimeOffset.UtcNow;
        var record = new ExplorationEdgeRecord
        {
            Id = Guid.NewGuid(),
            TenantId = scope.TenantId,
            WorkspaceId = scope.WorkspaceId,
            SessionId = scope.SessionId,
            RunId = scope.RunId,
            FromNodeId = edge.FromNodeId,
            ToNodeId = edge.ToNodeId,
            Kind = edge.Kind,
            Label = label,
            SourceKey = sourceKey,
            CreatedAtUnixMs = now.ToUnixTimeMilliseconds(),
            CreatedAt = now
        };
        db.Edges.Add(record);
        try
        {
            await db.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
            return ToEdge(record);
        }
        catch (DbUpdateException)
        {
            var winner = await db.Edges.AsNoTracking()
                .Where(item => item.TenantId == scope.TenantId && item.WorkspaceId == scope.WorkspaceId
                    && item.SessionId == scope.SessionId && item.SourceKey == sourceKey)
                .FirstOrDefaultAsync(cancellationToken).ConfigureAwait(false);
            return winner is null ? throw new InvalidOperationException("The exploration link could not be written.") : ToEdge(winner);
        }
    }

    public async Task<IReadOnlyList<ExplorationEdge>> QueryEdgesAsync(
        ExplorationScope scope,
        string? kind = null,
        int limit = 100,
        CancellationToken cancellationToken = default)
    {
        RequireScope(scope);
        if (kind is { Length: > 0 } && !ExplorationEdgeKinds.IsKnown(kind))
            throw new ArgumentException($"'{kind}' is not an exploration edge kind; use {string.Join(", ", ExplorationEdgeKinds.All)}.", nameof(kind));
        var take = Math.Clamp(limit, 1, 200);

        await using var db = await factory.CreateDbContextAsync(cancellationToken).ConfigureAwait(false);
        var rows = db.Edges.AsNoTracking()
            .Where(row => row.TenantId == scope.TenantId && row.WorkspaceId == scope.WorkspaceId && row.SessionId == scope.SessionId);
        if (kind is { Length: > 0 }) rows = rows.Where(row => row.Kind == kind);
        var selected = await rows.OrderByDescending(row => row.CreatedAtUnixMs)
            .Take(take)
            .ToListAsync(cancellationToken).ConfigureAwait(false);
        return selected.Select(ToEdge).ToArray();
    }

    public async Task<ExplorationAsset> UpsertAssetAsync(ExplorationScope scope, ExplorationAssetDraft asset, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(asset);
        RequireScope(scope);
        var key = NormalizeAssetKey(asset.Key);
        if (key is null) throw new ArgumentException("An asset needs a key.", nameof(asset));
        if (key.Length > MaxAssetKeyChars) throw new ArgumentException($"asset key must be at most {MaxAssetKeyChars} characters.", nameof(asset));
        if (!ExplorationAssetKinds.IsKnown(asset.Kind))
            throw new ArgumentException($"'{asset.Kind}' is not an exploration asset kind; use {string.Join(", ", ExplorationAssetKinds.All)}.", nameof(asset));
        var title = string.IsNullOrWhiteSpace(asset.Title) ? null : Clip(asset.Title.Trim(), MaxTitleChars);
        string? sourceKey = null;
        if (!string.IsNullOrWhiteSpace(asset.SourceKey))
        {
            sourceKey = asset.SourceKey.Trim();
            if (sourceKey.Length > MaxSourceKeyChars) throw new ArgumentException($"source_key must be at most {MaxSourceKeyChars} characters.", nameof(asset));
        }
        var now = DateTimeOffset.UtcNow;

        await using var db = await factory.CreateDbContextAsync(cancellationToken).ConfigureAwait(false);
        var existing = await db.Assets
            .FirstOrDefaultAsync(row => row.TenantId == scope.TenantId && row.WorkspaceId == scope.WorkspaceId
                && row.SessionId == scope.SessionId && row.Key == key, cancellationToken).ConfigureAwait(false);
        if (existing is not null)
        {
            existing.Kind = asset.Kind;
            existing.Title = title ?? existing.Title;
            existing.SourceKey ??= sourceKey;
            existing.UpdatedAtUnixMs = now.ToUnixTimeMilliseconds();
            existing.UpdatedAt = now;
            await db.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
            return ToAsset(existing);
        }

        var record = new ExplorationAssetRecord
        {
            Id = Guid.NewGuid(),
            TenantId = scope.TenantId,
            WorkspaceId = scope.WorkspaceId,
            SessionId = scope.SessionId,
            RunId = scope.RunId,
            Key = key,
            Kind = asset.Kind,
            Title = title,
            SourceKey = sourceKey,
            CreatedAtUnixMs = now.ToUnixTimeMilliseconds(),
            CreatedAt = now,
            UpdatedAtUnixMs = now.ToUnixTimeMilliseconds(),
            UpdatedAt = now
        };
        db.Assets.Add(record);
        await db.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        return ToAsset(record);
    }

    public async Task<ExplorationCoverage> CoverageAsync(ExplorationScope scope, CancellationToken cancellationToken = default)
    {
        RequireScope(scope);
        await using var db = await factory.CreateDbContextAsync(cancellationToken).ConfigureAwait(false);
        var assets = await db.Assets.AsNoTracking()
            .Where(row => row.TenantId == scope.TenantId && row.WorkspaceId == scope.WorkspaceId && row.SessionId == scope.SessionId)
            .OrderBy(row => row.Key)
            .ToListAsync(cancellationToken).ConfigureAwait(false);
        // Only a fact or a finding looked at an asset. A hint is a belief without a citation and must
        // not make the inventory look covered.
        var covered = await db.Nodes.AsNoTracking()
            .Where(row => row.TenantId == scope.TenantId && row.WorkspaceId == scope.WorkspaceId && row.SessionId == scope.SessionId
                && row.AssetKey != null
                && (row.Kind == ExplorationNodeKinds.Fact || row.Kind == ExplorationNodeKinds.Finding))
            .Select(row => row.AssetKey!)
            .Distinct()
            .ToListAsync(cancellationToken).ConfigureAwait(false);
        var coveredKeys = new HashSet<string>(covered, StringComparer.Ordinal);
        var uncovered = assets.Where(row => !coveredKeys.Contains(row.Key)).ToList();
        var total = assets.Count;
        var ratio = total == 0 ? 1d : Math.Round((total - uncovered.Count) / (double)total, 4);
        return new ExplorationCoverage(total, total - uncovered.Count, ratio,
            uncovered.Take(UncoveredListLimit).Select(ToAsset).ToArray());
    }

    public async Task<ExplorationDigest> DigestAsync(ExplorationScope scope, ExplorationDigestDraft digest, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(digest);
        RequireScope(scope);
        var title = Required(digest.Title, "title", MaxTitleChars);
        if (string.IsNullOrWhiteSpace(digest.Text)) throw new ArgumentException("A digest needs the original text it folded.", nameof(digest));
        var text = digest.Text.Trim();
        var summary = string.IsNullOrWhiteSpace(digest.Summary) ? null : Clip(digest.Summary.Trim(), MaxContentChars);
        // Re-digesting the same material with the same title keeps one node: the default key is
        // derived, so a retried call cannot fork the graph.
        var sourceKey = SourceKey(digest.SourceKey,
            () => $"digest:{Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(title + "\n" + text))).ToLowerInvariant()}");

        var node = await AppendNodeAsync(scope, new ExplorationNodeDraft(
            ExplorationNodeKinds.Digest, title, summary ?? text, SourceKey: sourceKey), cancellationToken).ConfigureAwait(false);
        var evidenceId = await evidence.AppendAsync(new EvidenceEntry(
            scope.TenantId, scope.WorkspaceId, scope.SessionId, scope.RunId, scope.TaskId,
            EvidenceKinds.ExplorationDigest, title, null, text,
            $"exploration-digest:{node.Id:N}"), cancellationToken).ConfigureAwait(false);
        return new ExplorationDigest(node.Id, evidenceId);
    }

    private static void RequireScope(ExplorationScope scope)
    {
        ArgumentNullException.ThrowIfNull(scope);
        if (scope.TenantId == Guid.Empty || scope.WorkspaceId == Guid.Empty || scope.SessionId == Guid.Empty)
            throw new ArgumentException("Exploration belongs to a tenant, workspace and session.", nameof(scope));
    }

    private static string Required(string? value, string field, int max)
    {
        if (string.IsNullOrWhiteSpace(value)) throw new ArgumentException($"{field} is required.");
        var text = value.Trim();
        if (text.Length > max) throw new ArgumentException($"{field} must be at most {max} characters.");
        return text;
    }

    private static string SourceKey(string? value, Func<string> fallback)
    {
        var key = string.IsNullOrWhiteSpace(value) ? fallback() : value.Trim();
        if (key.Length > MaxSourceKeyChars) throw new ArgumentException($"source_key must be at most {MaxSourceKeyChars} characters.");
        return key;
    }

    /// <summary>One asset has one spelling: slashes are the separator, not the host's mood.</summary>
    private static string? NormalizeAssetKey(string? key)
    {
        if (string.IsNullOrWhiteSpace(key)) return null;
        var normalized = key.Trim().Replace('\\', '/');
        while (normalized.StartsWith("./", StringComparison.Ordinal)) normalized = normalized[2..];
        return normalized.Length == 0 ? null : normalized;
    }

    private static IReadOnlyList<string> NormalizeEvidenceRefs(IReadOnlyList<string>? refs)
    {
        if (refs is not { Count: > 0 }) return [];
        if (refs.Count > MaxEvidenceRefs) throw new ArgumentException($"evidence_refs must contain at most {MaxEvidenceRefs} entries.");
        var result = new List<string>(refs.Count);
        foreach (var reference in refs)
        {
            var value = reference?.Trim();
            if (string.IsNullOrEmpty(value)) continue;
            if (value.Length > MaxEvidenceRefChars) throw new ArgumentException($"Each evidence_ref must be at most {MaxEvidenceRefChars} characters.");
            if (!result.Contains(value, StringComparer.Ordinal)) result.Add(value);
        }
        return result;
    }

    private static string Clip(string value, int max) => value.Length <= max ? value : value[..max] + " …(truncated)";

    private static ExplorationNode ToNode(ExplorationNodeRecord row) => new(
        row.Id, row.SessionId, row.RunId, row.TaskId, row.AgentInstanceId, row.Kind, row.Title, row.Content, row.AssetKey,
        JsonSerializer.Deserialize<string[]>(row.EvidenceRefsJson) ?? [], row.SourceKey, row.Author, row.CreatedAt);

    private static ExplorationEdge ToEdge(ExplorationEdgeRecord row) => new(
        row.Id, row.SessionId, row.RunId, row.FromNodeId, row.ToNodeId, row.Kind, row.Label, row.CreatedAt);

    private static ExplorationAsset ToAsset(ExplorationAssetRecord row) => new(
        row.Id, row.Key, row.Kind, row.Title, row.CreatedAt, row.UpdatedAt);
}
