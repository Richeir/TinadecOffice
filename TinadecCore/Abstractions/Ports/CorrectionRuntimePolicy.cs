using TinadecCore.Contracts.Dtos;

namespace TinadecCore.Abstractions.Ports;

/// <summary>
/// Allow-list for host-owned mode workflows. Packs may choose a known policy and
/// its declared features, but may never ship executable behavior of their own.
/// Correction constants stay here for domain readability; every validation and
/// feature lookup delegates to <see cref="ModeRuntimePolicyRegistry"/>, so the
/// set of supported modes is data, not a code branch.
/// </summary>
public static class CorrectionRuntimePolicy
{
    public const string StructuredInvestigationKind = ModeRuntimePolicyRegistry.StructuredInvestigationKind;
    public const int StructuredInvestigationVersion = ModeRuntimePolicyRegistry.StructuredInvestigationVersion;
    public const string RequiredCoreCapability = ModeRuntimePolicyRegistry.StructuredInvestigationCapability;

    public const string CausalTraceFeature = "causal_trace";
    public const string CompletionContractFeature = "completion_contract";
    public const string FailingReproRequiredFeature = "failing_repro_required";
    public const string ClarificationLedgerFeature = "clarification_ledger";
    public const string UserReproductionReopensFeature = "user_reproduction_reopens";
    public const string LocalHunkRevertFeature = "local_hunk_revert";

    public static readonly IReadOnlySet<string> StructuredInvestigationFeatures =
        ModeRuntimePolicyRegistry.Definition(StructuredInvestigationKind, StructuredInvestigationVersion)!.Features;

    public static string? Validate(ModeRuntimePolicyDto? policy) => ModeRuntimePolicyRegistry.Validate(policy);

    public static bool Has(ModeRuntimePolicyDto? policy, string feature) =>
        ModeRuntimePolicyRegistry.Has(policy, StructuredInvestigationKind, feature);

    public static bool IsStructuredInvestigation(ModeRuntimePolicyDto? policy) =>
        Has(policy, CausalTraceFeature);
}
