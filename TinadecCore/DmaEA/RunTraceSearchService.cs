using System.Text.Json;
using Microsoft.Extensions.Logging;
using TinadecCore.Abstractions;
using TinadecCore.Abstractions.Ports;
using TinadecCore.Contracts.Events;

namespace TinadecCore.DmaEA;

/// <summary>
/// B4: reads one run's trace across the workers that produced it — the durable event journal, the
/// tool executions, and (when the caller searches for text) the session's evidence archive. Every
/// result goes through the projections the conversation feed already uses, so a trace can never show
/// more than the UI does: arguments are redacted, credential-shaped results are withheld, and each
/// section stops at the frozen <c>trace_result_limit</c>.
/// </summary>
public sealed class RunTraceSearchService : IRunTraceSearch
{
    /// <summary>Matched with the bounded projection, never the stored result.</summary>
    public const int PreviewBytes = 4096;
    private const int EvidenceSectionLimit = 20;

    private readonly ILifecycleManager _lifecycle;
    private readonly IToolExecutionCoordinator _executions;
    private readonly IEvidenceArchive? _evidence;
    private readonly ILogger<RunTraceSearchService>? _logger;

    public RunTraceSearchService(
        ILifecycleManager lifecycle,
        IToolExecutionCoordinator executions,
        IEvidenceArchive? evidence = null,
        ILogger<RunTraceSearchService>? logger = null)
    {
        _lifecycle = lifecycle;
        _executions = executions;
        _evidence = evidence;
        _logger = logger;
    }

    public async Task<RunTraceResult> SearchAsync(RunTraceQuery query, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(query);
        var limit = Math.Clamp(query.Limit, 1, 100);
        var text = string.IsNullOrWhiteSpace(query.Query) ? null : query.Query.Trim();
        var truncated = false;

        var matched = new List<RunTraceEvent>();
        IReadOnlyList<EventEnvelope> events;
        try
        {
            events = await _lifecycle.ReplayEventsAsync(query.SessionId, 0, cancellationToken).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
        {
            // A trace is a read of what already happened; a journal read failure returns the
            // sections that did resolve instead of failing the whole search.
            _logger?.TryLogDebug(ex, "Could not replay the event journal for run {RunId}.", query.RunId);
            events = [];
        }

        foreach (var envelope in events)
        {
            if (Matches(envelope, query, text) is not { } item) continue;
            matched.Add(item);
        }

        var ordered = matched.OrderByDescending(item => item.Timestamp).ToArray();
        if (ordered.Length > limit)
        {
            truncated = true;
            ordered = ordered[..limit];
        }

        IReadOnlyList<RunTraceTool> tools;
        try
        {
            var executions = await _executions.ListForRunAsync(
                query.RunId, query.TaskId, query.AgentInstanceId, limit + 1, cancellationToken).ConfigureAwait(false);
            if (executions.Count > limit) truncated = true;
            tools = executions
                .Take(limit)
                .Select(execution => new RunTraceTool(
                    execution.AgentInstanceId,
                    execution.CreatedAt,
                    ToolResultPreviewProjector.Project(execution, PreviewBytes)))
                .Where(tool => text is null || Contains(tool.Preview, text))
                .ToArray();
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
        {
            _logger?.TryLogDebug(ex, "Could not list the tool executions of run {RunId}.", query.RunId);
            tools = [];
        }

        IReadOnlyList<EvidenceHit> evidence = [];
        if (text is not null && _evidence is not null)
        {
            var evidenceLimit = Math.Min(limit, EvidenceSectionLimit);
            try
            {
                var recall = await _evidence.RecallAsync(new EvidenceRecallQuery(
                    query.TenantId, query.WorkspaceId, query.SessionId, text, RunId: query.RunId, Limit: evidenceLimit),
                    cancellationToken).ConfigureAwait(false);
                evidence = recall.Hits;
                if (evidence.Count >= evidenceLimit) truncated = true;
            }
            catch (Exception ex) when (ex is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
            {
                _logger?.TryLogDebug(ex, "Could not search the evidence archive of run {RunId}.", query.RunId);
            }
        }

        return new RunTraceResult(ordered, tools, evidence, limit, truncated);
    }

    /// <summary>
    /// The event as the model may see it, or null when the run/task/agent/text filters exclude it.
    /// The payload is redacted before it is matched or returned, so a search can never quote a
    /// secret the feed itself would hide.
    /// </summary>
    private static RunTraceEvent? Matches(EventEnvelope envelope, RunTraceQuery query, string? text)
    {
        if (!Guid.TryParse(envelope.RunId, out var runId) || runId != query.RunId) return null;
        JsonElement? maybePayload = null;
        if (envelope.Payload.TryGetValue("payload", out var raw)
            && raw is JsonElement element && element.ValueKind == JsonValueKind.Object)
            maybePayload = element;
        if (query.TaskId is { } task && (maybePayload is not { } taskPayload || PayloadGuid(taskPayload, "task_id") != task))
            return null;
        if (query.AgentInstanceId is { } agent
            && (maybePayload is not { } agentPayload || PayloadGuid(agentPayload, "agent_instance_id") != agent))
            return null;

        var payloadJson = maybePayload is { } payload
            ? ApprovalEvidenceProjector.RedactSecrets(payload.GetRawText())
            : null;
        var summary = envelope.Payload.TryGetValue("summary", out var rawSummary) ? rawSummary?.ToString() : null;
        if (text is not null
            && !envelope.EventType.Contains(text, StringComparison.OrdinalIgnoreCase)
            && !(summary?.Contains(text, StringComparison.OrdinalIgnoreCase) ?? false)
            && !(payloadJson?.Contains(text, StringComparison.OrdinalIgnoreCase) ?? false))
            return null;

        return new RunTraceEvent(envelope.EventId, envelope.EventType, envelope.Timestamp, summary, payloadJson);
    }

    private static Guid? PayloadGuid(JsonElement payload, string name)
    {
        if (!payload.TryGetProperty(name, out var value)) return null;
        return value.ValueKind switch
        {
            JsonValueKind.String => Guid.TryParse(value.GetString(), out var parsed) ? parsed : null,
            _ => null,
        };
    }

    private static bool Contains(object value, string text) =>
        JsonSerializer.Serialize(value, PreviewJson).Contains(text, StringComparison.OrdinalIgnoreCase);

    private static readonly JsonSerializerOptions PreviewJson = new(JsonSerializerDefaults.Web);
}
