using System.Text.Json;
using TinadecCore.Contracts.Dtos;

namespace TinadecCore.Abstractions.Ports;

/// <summary>
/// One host-owned workflow a pack may select. <see cref="Features"/> is the
/// complete allow-list and <see cref="RequiredFeatures"/> the minimum a pack must
/// declare; dependencies are declared as data so validation never grows a
/// per-mode branch.
/// </summary>
public sealed record ModePolicyDefinition(
    string Kind,
    int Version,
    string RequiredCoreCapability,
    IReadOnlySet<string> Features,
    IReadOnlyList<string> RequiredFeatures,
    IReadOnlyList<ModePolicyFeatureDependency> Dependencies,
    Func<JsonElement?, string?>? ValidateSettings = null,
    JsonElement? DefaultSettings = null);

public sealed record ModePolicyFeatureDependency(string Feature, string Requires);

/// <summary>
/// Registry of every runtime policy Core understands. Adding a mode behavior is a
/// registration here plus a manifest that selects it — never a slug comparison in
/// the engine.
/// </summary>
public static class ModeRuntimePolicyRegistry
{
    public const string StructuredInvestigationKind = "structured_investigation";
    public const int StructuredInvestigationVersion = 1;
    public const string StructuredInvestigationCapability = "structured_investigation_v1";

    public const string AutonomousExplorationKind = "autonomous_exploration";
    public const int AutonomousExplorationVersion = 1;
    public const string AutonomousExplorationCapability = "autonomous_exploration_v1";

    public const string ExplorationGraphFeature = "exploration_graph";
    public const string AssetGraphFeature = "asset_graph";
    public const string PlanLedgerFeature = "plan_ledger";
    public const string EventDrivenPlanningFeature = "event_driven_planning";
    public const string CrossWorkerTraceFeature = "cross_worker_trace";
    public const string WorkerSettlementFeature = "worker_settlement";
    public const string EvidenceRefsRequiredFeature = "evidence_refs_required";
    public const string MergedDigestFeature = "merged_digest";
    public const string StructuredContextCompactionFeature = "structured_context_compaction";
    public const string ModelHealthFailoverFeature = "model_health_failover";
    public const string RunDossierFeature = "run_dossier";
    public const string SideQuestionFeature = "side_question";

    public static readonly IReadOnlySet<string> AutonomousExplorationFeatures =
        new HashSet<string>(StringComparer.Ordinal)
        {
            ExplorationGraphFeature,
            AssetGraphFeature,
            PlanLedgerFeature,
            EventDrivenPlanningFeature,
            CrossWorkerTraceFeature,
            WorkerSettlementFeature,
            EvidenceRefsRequiredFeature,
            MergedDigestFeature,
            StructuredContextCompactionFeature,
            ModelHealthFailoverFeature,
            RunDossierFeature,
            SideQuestionFeature,
        };

    private static readonly IReadOnlyDictionary<string, ModePolicyDefinition> ByKind =
        new Dictionary<string, ModePolicyDefinition>(StringComparer.Ordinal)
        {
            [Key(StructuredInvestigationKind, StructuredInvestigationVersion)] = new(
                StructuredInvestigationKind,
                StructuredInvestigationVersion,
                StructuredInvestigationCapability,
                new HashSet<string>(StringComparer.Ordinal)
                {
                    CorrectionRuntimePolicy.CausalTraceFeature,
                    CorrectionRuntimePolicy.CompletionContractFeature,
                    CorrectionRuntimePolicy.FailingReproRequiredFeature,
                    CorrectionRuntimePolicy.ClarificationLedgerFeature,
                    CorrectionRuntimePolicy.UserReproductionReopensFeature,
                    CorrectionRuntimePolicy.LocalHunkRevertFeature,
                },
                [CorrectionRuntimePolicy.CausalTraceFeature],
                [
                    new(CorrectionRuntimePolicy.FailingReproRequiredFeature, CorrectionRuntimePolicy.CompletionContractFeature),
                    new(CorrectionRuntimePolicy.UserReproductionReopensFeature, CorrectionRuntimePolicy.CompletionContractFeature),
                    new(CorrectionRuntimePolicy.LocalHunkRevertFeature, CorrectionRuntimePolicy.UserReproductionReopensFeature),
                ],
                _ => null),
            [Key(AutonomousExplorationKind, AutonomousExplorationVersion)] = new(
                AutonomousExplorationKind,
                AutonomousExplorationVersion,
                AutonomousExplorationCapability,
                AutonomousExplorationFeatures,
                [ExplorationGraphFeature],
                [
                    new(EventDrivenPlanningFeature, PlanLedgerFeature),
                    new(CrossWorkerTraceFeature, ExplorationGraphFeature),
                    new(MergedDigestFeature, ExplorationGraphFeature),
                    new(RunDossierFeature, WorkerSettlementFeature),
                    new(SideQuestionFeature, EventDrivenPlanningFeature),
                ],
                AutonomousExplorationSettings.Validate,
                AutonomousExplorationSettings.ToJsonElement()),
        };

    public static IReadOnlyCollection<ModePolicyDefinition> Definitions => ByKind.Values.ToArray();

    public static ModePolicyDefinition? Definition(string kind, int version) =>
        ByKind.TryGetValue(Key(kind, version), out var definition) ? definition : null;

    public static ModePolicyDefinition? Definition(ModeRuntimePolicyDto? policy) =>
        policy is null ? null : Definition(policy.Kind, policy.Version);

    public static string? RequiredCapability(string kind)
    {
        var match = Definitions.FirstOrDefault(item => string.Equals(item.Kind, kind, StringComparison.Ordinal));
        return match?.RequiredCoreCapability;
    }

    public static string? Validate(ModeRuntimePolicyDto? policy)
    {
        if (policy is null) return null;
        var definition = Definition(policy);
        if (definition is null)
            return $"runtime_policy '{policy.Kind}@{policy.Version}' is not supported.";

        var features = policy.Features.Distinct(StringComparer.Ordinal).ToArray();
        var unknown = features.Where(feature => !definition.Features.Contains(feature)).ToArray();
        if (unknown.Length > 0)
            return $"runtime_policy.features contains unsupported values: {string.Join(", ", unknown)}.";

        foreach (var required in definition.RequiredFeatures)
        {
            if (!features.Contains(required, StringComparer.Ordinal))
                return $"runtime_policy.features must include '{required}'.";
        }

        foreach (var dependency in definition.Dependencies)
        {
            if (features.Contains(dependency.Feature, StringComparer.Ordinal)
                && !features.Contains(dependency.Requires, StringComparer.Ordinal))
                return $"'{dependency.Feature}' requires '{dependency.Requires}'.";
        }

        return definition.ValidateSettings?.Invoke(policy.Settings);
    }

    public static bool Has(ModeRuntimePolicyDto? policy, string feature) =>
        policy is not null
        && Definition(policy) is { } definition
        && definition.Features.Contains(feature)
        && policy.Features.Contains(feature, StringComparer.Ordinal);

    public static bool Has(ModeRuntimePolicyDto? policy, string kind, string feature) =>
        policy is not null
        && string.Equals(policy.Kind, kind, StringComparison.Ordinal)
        && Has(policy, feature);

    public static bool Is(ModeRuntimePolicyDto? policy, string kind) =>
        policy is not null && string.Equals(policy.Kind, kind, StringComparison.Ordinal);

    public static bool IsAutonomousExploration(ModeRuntimePolicyDto? policy) =>
        Is(policy, AutonomousExplorationKind)
        && policy!.Version == AutonomousExplorationVersion;

    private static string Key(string kind, int version) => $"{kind}@{version}";
}

/// <summary>
/// Frozen numeric knobs for the autonomous exploration runtime. Absent values
/// take the defaults below; validation is fail-closed on unknown keys and ranges.
/// </summary>
public sealed record AutonomousExplorationSettings
{
    public int PlannerDebounceMs { get; init; } = 1500;
    public int PlannerHeartbeatMs { get; init; } = 30000;
    public int MaxParallelWorkers { get; init; } = 4;
    public int MaxIntentsPerCycle { get; init; } = 8;
    public int MaxWorkerRounds { get; init; } = 20;
    public int DigestAfterIdleMs { get; init; } = 600000;
    public int ContextCompactionTokens { get; init; } = 60000;
    public int TraceResultLimit { get; init; } = 20;
    public double CoverageMinRatio { get; init; } = 0.6;
    public int MaxRetriesPerIntent { get; init; } = 2;

    private static readonly IReadOnlyDictionary<string, (int Min, int Max)> IntegerRanges =
        new Dictionary<string, (int, int)>(StringComparer.Ordinal)
        {
            ["planner_debounce_ms"] = (200, 60000),
            ["planner_heartbeat_ms"] = (1000, 600000),
            ["max_parallel_workers"] = (1, 16),
            ["max_intents_per_cycle"] = (1, 64),
            ["max_worker_rounds"] = (1, 200),
            ["digest_after_idle_ms"] = (60000, 86400000),
            ["context_compaction_tokens"] = (8000, 500000),
            ["trace_result_limit"] = (1, 100),
            ["max_retries_per_intent"] = (0, 10),
        };

    private static readonly HashSet<string> KnownKeys =
        new(IntegerRanges.Keys.Append("coverage_min_ratio"), StringComparer.Ordinal);

    public static string? Validate(JsonElement? settings)
    {
        if (settings is null || settings.Value.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined)
            return null;
        if (settings.Value.ValueKind != JsonValueKind.Object)
            return "runtime_policy.settings must be an object.";

        foreach (var property in settings.Value.EnumerateObject())
        {
            if (!KnownKeys.Contains(property.Name))
                return $"runtime_policy.settings contains an unknown key: '{property.Name}'.";
            if (property.Name == "coverage_min_ratio")
            {
                if (property.Value.ValueKind != JsonValueKind.Number
                    || !property.Value.TryGetDouble(out var ratio)
                    || ratio < 0 || ratio > 1)
                    return "runtime_policy.settings.coverage_min_ratio must be between 0 and 1.";
                continue;
            }

            var (min, max) = IntegerRanges[property.Name];
            if (property.Value.ValueKind != JsonValueKind.Number
                || !property.Value.TryGetInt32(out var number)
                || number < min || number > max)
                return $"runtime_policy.settings.{property.Name} must be an integer between {min} and {max}.";
        }
        return null;
    }

    public static AutonomousExplorationSettings From(JsonElement? settings)
    {
        var defaults = new AutonomousExplorationSettings();
        if (settings is null || settings.Value.ValueKind != JsonValueKind.Object) return defaults;
        var json = settings.Value;
        return defaults with
        {
            PlannerDebounceMs = Int(json, "planner_debounce_ms", defaults.PlannerDebounceMs),
            PlannerHeartbeatMs = Int(json, "planner_heartbeat_ms", defaults.PlannerHeartbeatMs),
            MaxParallelWorkers = Int(json, "max_parallel_workers", defaults.MaxParallelWorkers),
            MaxIntentsPerCycle = Int(json, "max_intents_per_cycle", defaults.MaxIntentsPerCycle),
            MaxWorkerRounds = Int(json, "max_worker_rounds", defaults.MaxWorkerRounds),
            DigestAfterIdleMs = Int(json, "digest_after_idle_ms", defaults.DigestAfterIdleMs),
            ContextCompactionTokens = Int(json, "context_compaction_tokens", defaults.ContextCompactionTokens),
            TraceResultLimit = Int(json, "trace_result_limit", defaults.TraceResultLimit),
            CoverageMinRatio = Double(json, "coverage_min_ratio", defaults.CoverageMinRatio),
            MaxRetriesPerIntent = Int(json, "max_retries_per_intent", defaults.MaxRetriesPerIntent),
        };
    }

    private static readonly JsonSerializerOptions SnakeCaseJson = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower
    };

    public static JsonElement ToJsonElement() =>
        JsonSerializer.SerializeToElement(new AutonomousExplorationSettings(), SnakeCaseJson);

    private static int Int(JsonElement element, string name, int fallback) =>
        element.TryGetProperty(name, out var value) && value.TryGetInt32(out var parsed) ? parsed : fallback;

    private static double Double(JsonElement element, string name, double fallback) =>
        element.TryGetProperty(name, out var value) && value.TryGetDouble(out var parsed) ? parsed : fallback;
}
