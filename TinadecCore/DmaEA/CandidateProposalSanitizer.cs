using System.Text.Json;
using TinadecCore.Abstractions;

namespace TinadecCore.DmaEA;

internal sealed record SanitizedCandidateProposal(
    Dictionary<string, object?> Payload,
    string SystemPrompt,
    string SystemPromptHash);

/// <summary>
/// Builds the single draft payload used by both evaluation and promotion, so the
/// prompt under test and the prompt that ships can never drift apart.
/// </summary>
internal static class CandidateProposalSanitizer
{
    public static SanitizedCandidateProposal Sanitize(AgentCandidateRecord candidate, JsonElement proposal)
    {
        if (proposal.ValueKind != JsonValueKind.Object)
            throw new InvalidDataException("Candidate proposal must be a JSON object.");
        var name = String(proposal, "display_name") ?? String(proposal, "name") ?? candidate.Name;
        if (string.IsNullOrWhiteSpace(name))
            throw new InvalidDataException("Candidate proposal needs a display name.");
        var layer = (String(proposal, "layer") ?? candidate.Layer).Trim().ToLowerInvariant();
        AgentLayerNames.Require(layer);
        var systemPrompt = String(proposal, "system_prompt");
        if (string.IsNullOrWhiteSpace(systemPrompt))
            throw new InvalidDataException("Candidate proposal needs a system_prompt before promotion.");
        systemPrompt = systemPrompt.Trim();

        var capabilities = new List<string>();
        if (proposal.TryGetProperty("capabilities", out var capabilitiesNode) && capabilitiesNode.ValueKind == JsonValueKind.Array)
        {
            capabilities.AddRange(capabilitiesNode.EnumerateArray()
                .Where(item => item.ValueKind == JsonValueKind.String)
                .Select(item => item.GetString()!.Trim())
                .Where(item => item.Length > 0));
        }

        var payload = new Dictionary<string, object?>
        {
            ["display_name"] = name.Trim(),
            ["slug"] = String(proposal, "slug") ?? name,
            ["layer"] = layer,
            ["role"] = String(proposal, "role") ?? candidate.AgentType,
            ["description"] = String(proposal, "description") ?? $"Promoted from candidate {candidate.Id}.",
            ["capabilities"] = capabilities,
            ["model_strategy"] = new Dictionary<string, object?> { ["kind"] = "inherit" },
            ["tool_scope"] = Array.Empty<string>(),
            ["system_prompt"] = systemPrompt
        };
        return new SanitizedCandidateProposal(
            payload,
            systemPrompt,
            ContentHashing.Sha256Hex(systemPrompt));
    }

    private static string? String(JsonElement element, string name) =>
        element.TryGetProperty(name, out var property) && property.ValueKind == JsonValueKind.String
            ? property.GetString()
            : null;
}
