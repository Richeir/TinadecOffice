using System.Security.Cryptography;
using System.Text;
using TinadecCore.Abstractions.Ports;

namespace TinadecCore.Exploration;

/// <summary>
/// B7: folds the cold part of a session's exploration graph into one digest. Facts and findings keep
/// their citations; a record without one is reported as a belief, never as a conclusion; a
/// contradiction names the hypothesis a later record refuted. The folded originals are archived
/// verbatim before the summary stands in for them in the per-call context.
/// </summary>
public sealed class ContextDigestService : IContextDigest
{
    /// <summary>How many nodes one pass reads; material older than this window is folded by a later pass.</summary>
    public const int QueryLimit = 100;
    public const int DefaultKeepRecentNodes = 8;
    public const int MaxDigestChars = 12_000;
    private const int MaxFacts = 24;
    private const int MaxFindings = 24;
    private const int MaxUnconfirmed = 12;
    private const int MaxContradictions = 12;
    private const int MaxUncoveredAssets = 20;
    private const int MaxEvidenceRefs = 32;
    private const int MaxRefsPerLine = 4;
    private const int MaxTitleChars = 240;
    private const int MaxSnippetChars = 280;

    private readonly IExplorationGraph _graph;
    private readonly TimeProvider _clock;

    public ContextDigestService(IExplorationGraph graph, TimeProvider? clock = null)
    {
        _graph = graph;
        _clock = clock ?? TimeProvider.System;
    }

    public async Task<ContextDigestResult?> CompactAsync(ContextDigestRequest request, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        var nodes = await _graph.QueryAsync(request.Scope, new ExplorationQuery(Limit: QueryLimit), cancellationToken)
            .ConfigureAwait(false);
        var material = nodes.Where(node => node.Kind != ExplorationNodeKinds.Digest).ToArray();
        if (material.Length == 0) return null;

        var latestDigest = nodes.FirstOrDefault(node => node.Kind == ExplorationNodeKinds.Digest);
        var newest = material[0];
        // Nothing moved since the last fold: keep injecting the same compact view instead of
        // minting a digest that would say exactly what the previous one says.
        if (latestDigest is not null && latestDigest.CreatedAt >= newest.CreatedAt)
            return Reuse(latestDigest);

        var estimatedTokens = material.Sum(EstimateTokens);
        var idle = _clock.GetUtcNow() - newest.CreatedAt
            >= TimeSpan.FromMilliseconds(Math.Max(0, request.Settings.DigestAfterIdleMs));
        var overBudget = estimatedTokens > Math.Max(1, request.Settings.ContextCompactionTokens);
        if (!overBudget && !idle) return null;

        // Idle means every recorded node is cold; a budget overflow keeps the newest nodes hot
        // because a worker is likely still using them, but at least one node has to move.
        var keep = idle ? 0 : Math.Clamp(request.KeepRecentNodes, 0, material.Length);
        if (!idle && keep >= material.Length) keep = material.Length - 1;
        var folded = material.Skip(keep).ToArray();
        if (folded.Length == 0) return latestDigest is null ? null : Reuse(latestDigest);

        var contradictions = await _graph
            .QueryEdgesAsync(request.Scope, ExplorationEdgeKinds.Contradicts, QueryLimit, cancellationToken)
            .ConfigureAwait(false);
        var coverage = await _graph.CoverageAsync(request.Scope, cancellationToken).ConfigureAwait(false);
        var summary = Format(folded, request.Goal, contradictions, coverage);
        if (string.IsNullOrWhiteSpace(summary)) return null;

        var original = FormatOriginal(folded);
        // The view changes when coverage changes even though the folded material did not; the key
        // folds the view in so a stale digest cannot keep claiming an asset is uncovered.
        var sourceKey = "context-digest:" + Convert.ToHexString(SHA256.HashData(
            Encoding.UTF8.GetBytes("Exploration digest\n" + original + "\n" + summary))).ToLowerInvariant();
        var digest = await _graph.DigestAsync(request.Scope, new ExplorationDigestDraft(
            "Exploration digest", original, summary, sourceKey), cancellationToken).ConfigureAwait(false);
        return new ContextDigestResult(summary, digest.NodeId, digest.EvidenceId, folded.Length);
    }

    private static ContextDigestResult Reuse(ExplorationNode digest) =>
        new(string.IsNullOrWhiteSpace(digest.Content) ? digest.Title : digest.Content, digest.Id, null, 0);

    private static int EstimateTokens(ExplorationNode node) =>
        Math.Max(1, (node.Title.Length + (node.Content?.Length ?? 0)) / 2);

    private static string Format(
        IReadOnlyList<ExplorationNode> folded,
        string? goal,
        IReadOnlyList<ExplorationEdge> contradictions,
        ExplorationCoverage coverage)
    {
        var ordered = folded.OrderBy(node => node.CreatedAt).ToArray();
        var byId = ordered.ToDictionary(node => node.Id);
        var confirmedFacts = ordered
            .Where(node => node.Kind == ExplorationNodeKinds.Fact && node.EvidenceRefs.Count > 0)
            .Take(MaxFacts).ToArray();
        var findings = ordered
            .Where(node => node.Kind == ExplorationNodeKinds.Finding && node.EvidenceRefs.Count > 0)
            .Take(MaxFindings).ToArray();
        var unconfirmed = ordered
            .Where(node => node.Kind == ExplorationNodeKinds.Hint
                || node.Kind is ExplorationNodeKinds.Fact or ExplorationNodeKinds.Finding && node.EvidenceRefs.Count == 0)
            .Take(MaxUnconfirmed).ToArray();
        var refuted = contradictions
            .Where(edge => byId.ContainsKey(edge.ToNodeId))
            .Select(edge => (Hypothesis: byId[edge.ToNodeId], RefutedBy: edge.FromNodeId))
            .Take(MaxContradictions).ToArray();
        var refs = ordered
            .SelectMany(node => node.EvidenceRefs)
            .Distinct(StringComparer.Ordinal)
            .Take(MaxEvidenceRefs)
            .ToArray();

        var text = new StringBuilder();
        text.Append("Session exploration digest: ")
            .Append(ordered.Length)
            .AppendLine(" older node(s) folded to save context. The graph tools and the evidence archive still hold the originals; a hint is a belief without a citation and is never a conclusion.");
        if (!string.IsNullOrWhiteSpace(goal))
            text.Append("Goal: ").AppendLine(Clip(goal.Trim(), MaxTitleChars * 2));

        AppendSection(text, "Confirmed facts (cited):", confirmedFacts.Select(Line).ToArray());
        AppendSection(text, "Findings (cited):", findings.Select(Line).ToArray());
        AppendSection(text, "Unconfirmed (do not treat as conclusions):", unconfirmed.Select(Line).ToArray());
        AppendSection(text, "Refuted hypotheses:", refuted
            .Select(pair => $"- {Clip(pair.Hypothesis.Title, MaxTitleChars)} — contradicted by {Clip(TitleOf(pair.RefutedBy, byId), MaxTitleChars)}")
            .ToArray());
        AppendSection(text, "Uncovered assets:", coverage.Uncovered
            .Take(MaxUncoveredAssets)
            .Select(asset => $"- {Clip(asset.Key, MaxTitleChars)}{(asset.Title is null ? string.Empty : $" ({asset.Title})")}")
            .ToArray());
        if (refs.Length > 0)
            text.Append("Evidence refs: ").AppendLine(string.Join(", ", refs));
        return text.ToString().TrimEnd();
    }

    private static string TitleOf(Guid nodeId, IReadOnlyDictionary<Guid, ExplorationNode> byId) =>
        byId.TryGetValue(nodeId, out var node) ? node.Title : nodeId.ToString("N");

    private static void AppendSection(StringBuilder text, string heading, IReadOnlyList<string> lines)
    {
        if (lines.Count == 0) return;
        if (text.Length >= MaxDigestChars) return;
        text.AppendLine(heading);
        foreach (var line in lines)
        {
            if (text.Length >= MaxDigestChars)
            {
                text.AppendLine("- … (more folded material is in the archive)");
                return;
            }
            text.AppendLine(line);
        }
    }

    private static string Line(ExplorationNode node)
    {
        var refs = node.EvidenceRefs.Count switch
        {
            0 => "refs: (none)",
            <= MaxRefsPerLine => $"refs: {string.Join(", ", node.EvidenceRefs)}",
            _ => $"refs: {string.Join(", ", node.EvidenceRefs.Take(MaxRefsPerLine))} +{node.EvidenceRefs.Count - MaxRefsPerLine}"
        };
        var snippet = string.IsNullOrWhiteSpace(node.Content) ? null : Clip(Collapse(node.Content), MaxSnippetChars);
        return snippet is null
            ? $"- {Clip(node.Title, MaxTitleChars)} [{refs}]"
            : $"- {Clip(node.Title, MaxTitleChars)}: {snippet} [{refs}]";
    }

    private static string FormatOriginal(IReadOnlyList<ExplorationNode> folded)
    {
        var text = new StringBuilder();
        foreach (var node in folded.OrderBy(item => item.CreatedAt))
        {
            text.Append('[').Append(node.Kind).Append("] ").AppendLine(node.Title);
            if (!string.IsNullOrWhiteSpace(node.Content)) text.AppendLine(node.Content);
            if (node.AssetKey is not null) text.Append("asset: ").AppendLine(node.AssetKey);
            if (node.EvidenceRefs.Count > 0) text.Append("refs: ").AppendLine(string.Join(", ", node.EvidenceRefs));
            text.AppendLine();
        }
        return text.ToString().TrimEnd();
    }

    private static string Collapse(string value) =>
        string.Join(' ', value.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries));

    private static string Clip(string value, int max) => value.Length <= max ? value : value[..max] + "…";
}
