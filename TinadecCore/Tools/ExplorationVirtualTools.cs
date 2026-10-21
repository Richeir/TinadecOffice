using System.Text.Json;
using TinadecCore.Abstractions.Ports;
using TinadecCore.Contracts.Dtos;

namespace TinadecCore.Tools;

/// <summary>
/// Manifest entries for the exploration graph's tools (B1). Core executes them against its own
/// session state, so they never reach a tool child process; each tool is only callable when the
/// mode's runtime policy declares the feature behind it (validated at pack admission).
/// </summary>
internal static class ExplorationVirtualTools
{
    public static ToolManifestEntryDto? ManifestEntry(string? toolId)
    {
        if (!CoreVirtualToolPolicy.IsExploration(toolId)) return null;
        var id = CoreVirtualToolPolicy.ExplorationToolIds
            .Single(candidate => string.Equals(candidate, toolId, StringComparison.OrdinalIgnoreCase));
        return new ToolManifestEntryDto
        {
            Id = id,
            Description = Descriptions[id],
            RequiresApproval = false,
            InputSchema = JsonDocument.Parse(Schemas[id]).RootElement.Clone(),
            Risk = "low",
            MutatesWorkspace = false,
            // A record without a stable source_key is a new node on every attempt; the caller supplies
            // one when it wants a retry to be a no-op. The other four key on content, endpoints or
            // their own id, so replaying them keeps one row.
            RetrySafety = string.Equals(id, CoreVirtualToolPolicy.ExplorationRecordToolId, StringComparison.Ordinal) ? "unsafe" : "safe",
            ConfirmationFields = [],
        };
    }

    private static readonly IReadOnlyDictionary<string, string> Descriptions = new Dictionary<string, string>(StringComparer.Ordinal)
    {
        [CoreVirtualToolPolicy.ExplorationViewToolId] =
            "Read what this session has recorded about the investigation: intents, facts, findings, hints and digests, newest first. "
            + "Each node names the asset it is about and the evidence it is grounded in. Use the ids it returns to link nodes and cite them.",
        [CoreVirtualToolPolicy.ExplorationRecordToolId] =
            "Record what you learned, and declare the assets it is about so coverage can see them. A fact or finding must cite the evidence "
            + "that grounds it in evidence_refs (tool execution ids, paths, or evidence archive ids); with no citation, record a hint. "
            + "Findings are usable in the final report; hints are not. Pass source_key when a retry must not duplicate the record.",
        [CoreVirtualToolPolicy.ExplorationLinkToolId] =
            "Link two nodes of this session: supports, contradicts, depends_on, refines or derived_from. Both ids come from exploration_view; "
            + "a link is how a conclusion reaches the evidence that produced it.",
        [CoreVirtualToolPolicy.ExplorationCoverageToolId] =
            "How much of the declared asset inventory is covered by facts or findings, with the uncovered assets listed. Use it before "
            + "deciding the investigation is finished; a hint never counts as coverage.",
        [CoreVirtualToolPolicy.ExplorationDigestToolId] =
            "Fold a body of material into a compact digest node. The full text is archived verbatim beside the session's evidence, so the "
            + "summary can always be traced back to what was actually said. The optional summary is what the graph keeps; without it the text is.",
    };

    private static readonly IReadOnlyDictionary<string, string> Schemas = new Dictionary<string, string>(StringComparer.Ordinal)
    {
        [CoreVirtualToolPolicy.ExplorationViewToolId] = """
            {"type":"object","properties":{
              "kind":{"type":"string","enum":["intent","fact","finding","hint","digest"],"description":"Only nodes of this kind."},
              "run_id":{"type":"string","description":"Only nodes recorded by this run."},
              "asset_key":{"type":"string","description":"Only nodes about this asset."},
              "limit":{"type":"integer","minimum":1,"maximum":100,"description":"How many nodes (default 20)."}},
             "additionalProperties":false}
            """,
        [CoreVirtualToolPolicy.ExplorationRecordToolId] = """
            {"type":"object","properties":{
              "kind":{"type":"string","enum":["intent","fact","finding","hint"],"description":"What this record is."},
              "title":{"type":"string","description":"One line that says what was learned."},
              "content":{"type":"string","description":"The detail; bounded."},
              "asset_key":{"type":"string","description":"The file, module, endpoint, test or document it is about."},
              "asset_kind":{"type":"string","enum":["file","directory","module","endpoint","test","config","document","other"]},
              "evidence_refs":{"type":"array","items":{"type":"string"},"description":"What grounds it: execution ids, paths, evidence ids. Required for a fact or finding."},
              "assets":{"type":"array","description":"Assets this record shows exist, so coverage can count them.","items":{"type":"object","properties":{
                "key":{"type":"string"},"kind":{"type":"string","enum":["file","directory","module","endpoint","test","config","document","other"]},"title":{"type":"string"}},
                "required":["key"],"additionalProperties":false}},
              "source_key":{"type":"string","description":"Stable idempotency key; the same key never records twice."}},
             "required":["kind","title"],"additionalProperties":false}
            """,
        [CoreVirtualToolPolicy.ExplorationLinkToolId] = """
            {"type":"object","properties":{
              "from_node_id":{"type":"string","description":"An id exploration_view returned."},
              "to_node_id":{"type":"string","description":"An id exploration_view returned."},
              "kind":{"type":"string","enum":["supports","contradicts","depends_on","refines","derived_from"]},
              "label":{"type":"string","description":"Optional short note on why they relate."},
              "source_key":{"type":"string"}},
             "required":["from_node_id","to_node_id","kind"],"additionalProperties":false}
            """,
        [CoreVirtualToolPolicy.ExplorationCoverageToolId] = """
            {"type":"object","properties":{},"additionalProperties":false}
            """,
        [CoreVirtualToolPolicy.ExplorationDigestToolId] = """
            {"type":"object","properties":{
              "title":{"type":"string","description":"What this digest covers."},
              "text":{"type":"string","description":"The full material being folded; archived verbatim."},
              "summary":{"type":"string","description":"The compact view the graph keeps; the text itself when omitted."},
              "source_key":{"type":"string"}},
             "required":["title","text"],"additionalProperties":false}
            """,
    };
}
