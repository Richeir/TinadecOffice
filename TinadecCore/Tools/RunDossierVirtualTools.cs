using System.Text.Json;
using TinadecCore.Abstractions.Ports;
using TinadecCore.Contracts.Dtos;

namespace TinadecCore.Tools;

/// <summary>
/// Manifest entry for the run dossier (B9). Core assembles it from the run's own records, so it never
/// reaches a tool child process; the <c>run_dossier</c> feature is checked at pack admission and
/// again before the read is served.
/// </summary>
internal static class RunDossierVirtualTools
{
    public static ToolManifestEntryDto? ManifestEntry(string? toolId)
    {
        if (!CoreVirtualToolPolicy.IsRunDossier(toolId)) return null;
        return new ToolManifestEntryDto
        {
            Id = CoreVirtualToolPolicy.RunDossierToolId,
            Description =
                "Read this run's dossier: its status and ending, every task outcome, every planned intent with the last note, "
                + "the facts and findings the investigation recorded, and the questions the run left open. "
                + "Read-only. Use it when asked what happened, what was already tried, or what is still unresolved — "
                + "it reports recorded facts only, never a guess.",
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
          "limit":{"type":"integer","minimum":1,"maximum":50,
            "description":"Rows per section at most. Ask for fewer to keep the answer small; the host caps it."}},
         "additionalProperties":false}
        """;
}
