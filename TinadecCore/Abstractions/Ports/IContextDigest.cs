namespace TinadecCore.Abstractions.Ports;

/// <param name="Text">The compact view to put in front of the model.</param>
/// <param name="EvidenceId">The archive entry holding the folded originals; null when an existing digest was reused.</param>
/// <param name="FoldedNodes">How many nodes this call folded; zero when an existing digest was reused.</param>
public sealed record ContextDigestResult(string Text, Guid NodeId, Guid? EvidenceId, int FoldedNodes);

/// <param name="Goal">The run's user goal, when the caller has it; it heads the digest so folded facts still read in context.</param>
/// <param name="KeepRecentNodes">Nodes left hot because a worker is still working on them.</param>
public sealed record ContextDigestRequest(
    ExplorationScope Scope,
    AutonomousExplorationSettings Settings,
    string? Goal = null,
    int KeepRecentNodes = 8);

/// <summary>
/// Folds the cold part of a session's exploration graph into one digest (B7). A digest is a view,
/// not a replacement: folded nodes stay in the graph and their originals stay in the evidence
/// archive, so a later question can still reach the material the summary compressed.
/// </summary>
public interface IContextDigest
{
    /// <summary>
    /// Returns the digest to put in front of the next model call, folding older graph nodes when the
    /// graph's text exceeds <see cref="AutonomousExplorationSettings.ContextCompactionTokens"/> or has
    /// been idle for <see cref="AutonomousExplorationSettings.DigestAfterIdleMs"/>. Null while the
    /// graph is small and fresh and no digest exists: compaction must not spend a summary on a
    /// context that already fits.
    /// </summary>
    Task<ContextDigestResult?> CompactAsync(ContextDigestRequest request, CancellationToken cancellationToken = default);
}
