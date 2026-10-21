namespace TinadecCore.Abstractions.Ports;

/// <summary>
/// What an exploration node records. A <c>fact</c> is something checked against an asset or a tool
/// result; a <c>finding</c> is a conclusion drawn from facts; a <c>hint</c> is something the model
/// believes but could not cite — the weakest kind, never promoted to a conclusion on its own; an
/// <c>intent</c> is a unit of future work; a <c>digest</c> is a summary whose source was archived
/// verbatim.
/// </summary>
public static class ExplorationNodeKinds
{
    public const string Intent = "intent";
    public const string Fact = "fact";
    public const string Finding = "finding";
    public const string Hint = "hint";
    public const string Digest = "digest";

    public static readonly IReadOnlyList<string> All = [Intent, Fact, Finding, Hint, Digest];

    public static bool IsKnown(string? kind) => kind is not null && All.Contains(kind, StringComparer.Ordinal);

    /// <summary>Kinds that can cover an asset. A hint must not: believing something about a file is not looking at it.</summary>
    public static bool CoversAsset(string kind) => kind is Fact or Finding;
}

public static class ExplorationEdgeKinds
{
    public const string Supports = "supports";
    public const string Contradicts = "contradicts";
    public const string DependsOn = "depends_on";
    public const string Refines = "refines";
    public const string DerivedFrom = "derived_from";

    public static readonly IReadOnlyList<string> All = [Supports, Contradicts, DependsOn, Refines, DerivedFrom];

    public static bool IsKnown(string? kind) => kind is not null && All.Contains(kind, StringComparer.Ordinal);
}

public static class ExplorationAssetKinds
{
    public const string File = "file";
    public const string Directory = "directory";
    public const string Module = "module";
    public const string Endpoint = "endpoint";
    public const string Test = "test";
    public const string Config = "config";
    public const string Document = "document";
    public const string Other = "other";

    public static readonly IReadOnlyList<string> All = [File, Directory, Module, Endpoint, Test, Config, Document, Other];

    public static bool IsKnown(string? kind) => kind is not null && All.Contains(kind, StringComparer.Ordinal);
}

/// <summary>
/// Who an exploration write belongs to. Tenant, workspace, session and run are never arguments a
/// model can name: the tool layer builds this from the call's scope, so one session's graph cannot
/// be read or written by another.
/// </summary>
public sealed record ExplorationScope(
    Guid TenantId,
    Guid WorkspaceId,
    Guid SessionId,
    Guid? RunId = null,
    Guid? TaskId = null,
    Guid? AgentInstanceId = null);

/// <param name="SourceKey">Idempotency key within the session: recording the same source twice keeps one node.</param>
/// <param name="EvidenceRefs">What this node is grounded in (evidence ids, file paths, tool execution ids). Empty means a hint, never a fact.</param>
public sealed record ExplorationNodeDraft(
    string Kind,
    string Title,
    string? Content = null,
    string? AssetKey = null,
    IReadOnlyList<string>? EvidenceRefs = null,
    string? SourceKey = null,
    string? Author = null);

public sealed record ExplorationNode(
    Guid Id,
    Guid SessionId,
    Guid? RunId,
    Guid? TaskId,
    Guid? AgentInstanceId,
    string Kind,
    string Title,
    string? Content,
    string? AssetKey,
    IReadOnlyList<string> EvidenceRefs,
    string SourceKey,
    string? Author,
    DateTimeOffset CreatedAt);

public sealed record ExplorationEdgeDraft(
    Guid FromNodeId,
    Guid ToNodeId,
    string Kind,
    string? Label = null,
    string? SourceKey = null);

public sealed record ExplorationEdge(
    Guid Id,
    Guid SessionId,
    Guid? RunId,
    Guid FromNodeId,
    Guid ToNodeId,
    string Kind,
    string? Label,
    DateTimeOffset CreatedAt);

/// <param name="Key">The asset's identity (a path or identifier); normalized so one asset has one spelling.</param>
/// <param name="SourceKey">Optional caller key for idempotent asset registration.</param>
public sealed record ExplorationAssetDraft(
    string Key,
    string Kind = ExplorationAssetKinds.Other,
    string? Title = null,
    string? SourceKey = null);

public sealed record ExplorationAsset(
    Guid Id,
    string Key,
    string Kind,
    string? Title,
    DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt);

/// <param name="Ratio">Covered / total, or 1 when no asset was declared: an empty inventory is vacuously complete.</param>
/// <param name="Uncovered">Assets no fact or finding has looked at yet (bounded).</param>
public sealed record ExplorationCoverage(
    int Total,
    int Covered,
    double Ratio,
    IReadOnlyList<ExplorationAsset> Uncovered);

public sealed record ExplorationQuery(
    string? Kind = null,
    Guid? RunId = null,
    string? AssetKey = null,
    int Limit = 20);

/// <param name="Text">The original material, archived verbatim next to the digest.</param>
/// <param name="Summary">The digest itself; absent means the original is also the node's content.</param>
/// <param name="SourceKey">Idempotency key; absent derives one from title and text, so re-digesting the same material keeps one node.</param>
public sealed record ExplorationDigestDraft(
    string Title,
    string Text,
    string? Summary = null,
    string? SourceKey = null);

public sealed record ExplorationDigest(Guid NodeId, Guid EvidenceId);

/// <summary>
/// The session's exploration graph (B1): what was looked at, what was concluded from it, which assets
/// are still unseen, and digests whose sources stay in the evidence archive. Every write carries the
/// caller's scope, and every read filters by it.
/// </summary>
public interface IExplorationGraph
{
    /// <summary>Records one node. Returns the existing node when its source key was already recorded.</summary>
    Task<ExplorationNode> AppendNodeAsync(ExplorationScope scope, ExplorationNodeDraft node, CancellationToken cancellationToken = default);

    /// <summary>Reads nodes of the caller's session, newest first.</summary>
    Task<IReadOnlyList<ExplorationNode>> QueryAsync(ExplorationScope scope, ExplorationQuery query, CancellationToken cancellationToken = default);

    /// <summary>Links two nodes of the same session. Both must exist in the caller's scope; the same link is kept once.</summary>
    Task<ExplorationEdge> AppendEdgeAsync(ExplorationScope scope, ExplorationEdgeDraft edge, CancellationToken cancellationToken = default);

    /// <summary>Registers an asset (the coverage denominator) or refreshes its kind/title.</summary>
    Task<ExplorationAsset> UpsertAssetAsync(ExplorationScope scope, ExplorationAssetDraft asset, CancellationToken cancellationToken = default);

    Task<ExplorationCoverage> CoverageAsync(ExplorationScope scope, CancellationToken cancellationToken = default);

    /// <summary>Writes a digest node and archives its original text as <see cref="EvidenceKinds.ExplorationDigest"/>.</summary>
    Task<ExplorationDigest> DigestAsync(ExplorationScope scope, ExplorationDigestDraft digest, CancellationToken cancellationToken = default);
}
