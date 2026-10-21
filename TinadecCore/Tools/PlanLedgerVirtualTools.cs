using System.Text.Json;
using TinadecCore.Abstractions.Ports;
using TinadecCore.Contracts.Dtos;

namespace TinadecCore.Tools;

/// <summary>
/// Manifest entries for the run's shared plan ledger (B2). Core executes them against its own
/// exploration state; the <c>plan_ledger</c> feature is checked at pack admission, and claim
/// ownership is checked by the ledger itself on every update.
/// </summary>
internal static class PlanLedgerVirtualTools
{
    public static ToolManifestEntryDto? ManifestEntry(string? toolId)
    {
        if (!CoreVirtualToolPolicy.IsPlanLedger(toolId)) return null;
        var id = string.Equals(toolId, CoreVirtualToolPolicy.PlanLedgerReadToolId, StringComparison.OrdinalIgnoreCase)
            ? CoreVirtualToolPolicy.PlanLedgerReadToolId
            : CoreVirtualToolPolicy.PlanLedgerUpdateToolId;
        return new ToolManifestEntryDto
        {
            Id = id,
            Description = Descriptions[id],
            RequiresApproval = false,
            InputSchema = JsonDocument.Parse(Schemas[id]).RootElement.Clone(),
            Risk = "low",
            MutatesWorkspace = false,
            // claim/complete/block are idempotent, but add appends a new intent on every attempt.
            RetrySafety = id == CoreVirtualToolPolicy.PlanLedgerReadToolId ? "safe" : "unsafe",
            ConfirmationFields = [],
        };
    }

    private static readonly IReadOnlyDictionary<string, string> Descriptions = new Dictionary<string, string>(StringComparer.Ordinal)
    {
        [CoreVirtualToolPolicy.PlanLedgerReadToolId] =
            "Read this run's shared plan: every intent in order, with its status, the worker that claimed it and the last note. "
            + "Read it before starting work and use the ids to claim the next pending intent.",
        [CoreVirtualToolPolicy.PlanLedgerUpdateToolId] =
            "Update this run's shared plan. claim an intent before working on it; complete it when done; block it with the reason when you "
            + "cannot finish. add appends a new intent for the rest of the run. Only the worker that claimed an intent may complete or block it.",
    };

    private static readonly IReadOnlyDictionary<string, string> Schemas = new Dictionary<string, string>(StringComparer.Ordinal)
    {
        [CoreVirtualToolPolicy.PlanLedgerReadToolId] = """
            {"type":"object","properties":{
              "status":{"type":"string","enum":["pending","running","done","blocked","abandoned"],"description":"Only intents in this state."}},
             "additionalProperties":false}
            """,
        [CoreVirtualToolPolicy.PlanLedgerUpdateToolId] = """
            {"type":"object","properties":{
              "action":{"type":"string","enum":["add","claim","complete","block"],"description":"What to do with the ledger."},
              "intent_id":{"type":"string","description":"An id plan_ledger_read returned; required except for add."},
              "title":{"type":"string","description":"For add: one line that says what work the intent covers."},
              "content":{"type":"string","description":"For add: the detail a worker needs."},
              "note":{"type":"string","description":"For complete: what was done. For block: why it cannot proceed."}},
             "required":["action"],"additionalProperties":false}
            """,
    };
}
