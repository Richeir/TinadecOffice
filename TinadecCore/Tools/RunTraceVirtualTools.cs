using System.Text.Json;
using TinadecCore.Abstractions.Ports;
using TinadecCore.Contracts.Dtos;

namespace TinadecCore.Tools;

/// <summary>
/// Manifest entry for cross-worker trace search (B4). Core executes it against its own event
/// journal, tool-execution table and evidence archive; the <c>cross_worker_trace</c> feature is
/// checked at pack admission and again before the call is served.
/// </summary>
internal static class RunTraceVirtualTools
{
    public static ToolManifestEntryDto? ManifestEntry(string? toolId)
    {
        if (!CoreVirtualToolPolicy.IsTraceSearch(toolId)) return null;
        return new ToolManifestEntryDto
        {
            Id = CoreVirtualToolPolicy.TraceSearchToolId,
            Description =
                "Search this run's trace across its workers: durable events, tool executions with redacted "
                + "arguments and bounded result previews, and the session's evidence archive. Narrow by task, "
                + "agent instance or free text; each section is capped by the mode's trace_result_limit.",
            RequiresApproval = false,
            InputSchema = JsonDocument.Parse(Schema).RootElement.Clone(),
            Risk = "low",
            MutatesWorkspace = false,
            RetrySafety = "safe",
            ConfirmationFields = [],
        };
    }

    private const string Schema = """
        {"type":"object","properties":{
          "task_id":{"type":"string","description":"Only events and tool calls of this task."},
          "agent_instance_id":{"type":"string","description":"Only events and tool calls of this worker instance."},
          "query":{"type":"string","description":"Free text matched against event type, summary, payload, tool id and archived evidence."},
          "limit":{"type":"number","description":"Narrower per-section result cap; the mode's trace_result_limit is the ceiling."}},
         "additionalProperties":false}
        """;
}
