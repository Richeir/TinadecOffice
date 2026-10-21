using TinadecCore.Contracts.Dtos;

namespace TinadecCore.Abstractions.Ports;

/// <summary>
/// What one cross-worker trace search asks for. Tenant, workspace, session and run come from the
/// call's scope, never from model arguments; task and agent can only narrow the run's own trace.
/// </summary>
/// <param name="Query">Free text matched against event type/summary/payload, tool id and recall; absent means "list".</param>
/// <param name="Limit">Per-section ceiling, already clamped to the frozen <c>trace_result_limit</c> by the caller.</param>
public sealed record RunTraceQuery(
    Guid TenantId,
    Guid WorkspaceId,
    Guid SessionId,
    Guid RunId,
    Guid? TaskId = null,
    Guid? AgentInstanceId = null,
    string? Query = null,
    int Limit = 20);

/// <param name="PayloadJson">The event's payload after secret redaction, serialized for the model.</param>
public sealed record RunTraceEvent(
    string EventId,
    string EventType,
    DateTimeOffset Timestamp,
    string? Summary,
    string? PayloadJson);

/// <param name="Preview">The same bounded, redacted projection the conversation feed shows.</param>
public sealed record RunTraceTool(
    Guid AgentInstanceId,
    DateTimeOffset CreatedAt,
    ToolExecutionPreviewDto Preview);

/// <param name="Truncated">True when any section stopped at <paramref name="Limit"/> and more rows exist.</param>
public sealed record RunTraceResult(
    IReadOnlyList<RunTraceEvent> Events,
    IReadOnlyList<RunTraceTool> Tools,
    IReadOnlyList<EvidenceHit> Evidence,
    int Limit,
    bool Truncated);

/// <summary>
/// B4: one run's trace across workers — its durable events, its tool executions (with the redacted
/// preview projection) and, when a text query is given, the session's evidence archive. Read-only and
/// session scoped; the <c>cross_worker_trace</c> feature is checked before the tool is served.
/// </summary>
public interface IRunTraceSearch
{
    Task<RunTraceResult> SearchAsync(RunTraceQuery query, CancellationToken cancellationToken = default);
}
