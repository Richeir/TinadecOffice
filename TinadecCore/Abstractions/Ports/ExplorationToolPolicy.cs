using TinadecCore.Contracts.Dtos;

namespace TinadecCore.Abstractions.Ports;

/// <summary>
/// Which runtime feature a Core-owned tool belongs to. A pack may declare a tool only when its mode's
/// runtime policy enables that feature — the tool is the mechanism, the feature is the promise that
/// the engine behind it exists. Kept in one table so install-time admission, the dispatcher and tests
/// cannot drift apart.
///
/// The tools of later slices (plan ledger, trace, dossier) are listed here now so a pack cannot declare
/// them ahead of the feature that authorizes them.
/// </summary>
public static class ExplorationToolPolicy
{
    private static readonly IReadOnlyDictionary<string, string> FeatureByTool =
        new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            [CoreVirtualToolPolicy.ExplorationViewToolId] = ModeRuntimePolicyRegistry.ExplorationGraphFeature,
            [CoreVirtualToolPolicy.ExplorationRecordToolId] = ModeRuntimePolicyRegistry.ExplorationGraphFeature,
            [CoreVirtualToolPolicy.ExplorationLinkToolId] = ModeRuntimePolicyRegistry.ExplorationGraphFeature,
            [CoreVirtualToolPolicy.ExplorationCoverageToolId] = ModeRuntimePolicyRegistry.AssetGraphFeature,
            [CoreVirtualToolPolicy.ExplorationDigestToolId] = ModeRuntimePolicyRegistry.MergedDigestFeature,
            [CoreVirtualToolPolicy.PlanLedgerReadToolId] = ModeRuntimePolicyRegistry.PlanLedgerFeature,
            [CoreVirtualToolPolicy.PlanLedgerUpdateToolId] = ModeRuntimePolicyRegistry.PlanLedgerFeature,
            [CoreVirtualToolPolicy.TraceSearchToolId] = ModeRuntimePolicyRegistry.CrossWorkerTraceFeature,
            ["run_dossier"] = ModeRuntimePolicyRegistry.RunDossierFeature,
        };

    /// <summary>The feature a tool depends on, or null when the tool is not part of the exploration surface.</summary>
    public static string? RequiredFeature(string? toolId) =>
        toolId is not null && FeatureByTool.TryGetValue(toolId.Trim(), out var feature) ? feature : null;

    public static bool IsExplorationTool(string? toolId) => RequiredFeature(toolId) is not null;

    /// <summary>
    /// Fail-closed admission of a mode's effective tool surface against its runtime policy. Returns the
    /// first violation, naming the tool and the missing feature, or null when every exploration tool is
    /// backed by a declared feature.
    /// </summary>
    public static string? Validate(ModeRuntimePolicyDto? policy, IEnumerable<string>? tools, string subject)
    {
        if (tools is null) return null;
        foreach (var tool in tools)
        {
            var feature = RequiredFeature(tool);
            if (feature is null || ModeRuntimePolicyRegistry.Has(policy, feature)) continue;
            return $"{subject} declares tool '{tool}' but its runtime_policy does not enable '{feature}'.";
        }
        return null;
    }
}
