namespace TinadecCore.Abstractions.Ports;

/// <summary>
/// The states one shared plan intent can be in. The ledger is append-with-status, not a mutable
/// checklist: abandoning keeps the intent visible so a later reader can tell "we decided not to"
/// from "nobody ever wrote it down".
/// </summary>
public static class PlanIntentStatuses
{
    public const string Pending = "pending";
    public const string Running = "running";
    public const string Done = "done";
    public const string Blocked = "blocked";
    public const string Abandoned = "abandoned";

    public static readonly IReadOnlyList<string> All = [Pending, Running, Done, Blocked, Abandoned];

    public static bool IsKnown(string? status) =>
        status is not null && All.Contains(status, StringComparer.OrdinalIgnoreCase);

    public static bool IsTerminal(string? status) =>
        string.Equals(status, Done, StringComparison.OrdinalIgnoreCase)
        || string.Equals(status, Blocked, StringComparison.OrdinalIgnoreCase)
        || string.Equals(status, Abandoned, StringComparison.OrdinalIgnoreCase);
}

/// <summary>
/// Who a ledger read or write belongs to. Run and session are never arguments a model can name;
/// the tool layer builds this from the call's scope, so one run cannot claim another run's work.
/// </summary>
public sealed record PlanLedgerScope(
    Guid TenantId,
    Guid WorkspaceId,
    Guid SessionId,
    Guid RunId,
    Guid? TaskId = null,
    Guid? AgentInstanceId = null);

/// <param name="Ordinal">Stable position in the run's plan; the source key is <c>run:{runId}:intent:{ordinal}</c>.</param>
/// <param name="ClaimedByAgentInstanceId">The worker that took the intent; only that instance may complete or block it.</param>
/// <param name="Note">Why it was completed or blocked; the last writer's words, bounded.</param>
public sealed record PlanIntent(
    Guid Id,
    string SourceKey,
    int Ordinal,
    string Title,
    string? Content,
    string Status,
    Guid? TaskId,
    Guid? ClaimedByAgentInstanceId,
    IReadOnlyList<string> EvidenceRefs,
    string? Note,
    DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt);

public sealed record PlanIntentDraft(
    string Title,
    string? Content = null,
    IReadOnlyList<string>? EvidenceRefs = null);

/// <summary>
/// A write the ledger refused because the caller does not own the intent. The message starts with
/// <c>policy_denied</c> so the tool wire and the prompt can tell it apart from a malformed call.
/// </summary>
public sealed class PlanLedgerDeniedException(string message) : InvalidOperationException(message);

/// <summary>
/// The run's shared plan (B2): ordered intents, who claimed each one, and how it ended. Workers
/// read it before starting and update only what they claimed; a planner replaces the open part
/// without erasing what already finished.
/// </summary>
public interface IPlanLedger
{
    /// <summary>Lists the run's intents in ordinal order, optionally narrowed to one status.</summary>
    Task<IReadOnlyList<PlanIntent>> ListAsync(
        PlanLedgerScope scope,
        string? status = null,
        CancellationToken cancellationToken = default);

    /// <summary>Appends intents as pending work. Returns them in the order they were appended.</summary>
    Task<IReadOnlyList<PlanIntent>> AddAsync(
        PlanLedgerScope scope,
        IReadOnlyList<PlanIntentDraft> intents,
        CancellationToken cancellationToken = default);

    /// <summary>Claims a pending intent for the caller. Re-claiming one's own running intent is idempotent.</summary>
    Task<PlanIntent> ClaimAsync(PlanLedgerScope scope, Guid intentId, CancellationToken cancellationToken = default);

    /// <summary>Marks the caller's claimed intent done. Completed work is never reopened by a replan.</summary>
    Task<PlanIntent> CompleteAsync(
        PlanLedgerScope scope,
        Guid intentId,
        string? note = null,
        CancellationToken cancellationToken = default);

    /// <summary>Marks the caller's claimed intent blocked with a reason.</summary>
    Task<PlanIntent> BlockAsync(
        PlanLedgerScope scope,
        Guid intentId,
        string reason,
        CancellationToken cancellationToken = default);

    /// <summary>
    /// Replaces the open part of the plan: pending and running intents become abandoned, done and
    /// blocked intents stay as history, and the supplied drafts are appended after the highest ordinal.
    /// </summary>
    Task<IReadOnlyList<PlanIntent>> ReplanAsync(
        PlanLedgerScope scope,
        IReadOnlyList<PlanIntentDraft> intents,
        CancellationToken cancellationToken = default);
}
