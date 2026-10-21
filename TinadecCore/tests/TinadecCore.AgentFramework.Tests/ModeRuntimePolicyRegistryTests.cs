using System.Text.Json;
using TinadecCore.Abstractions.Ports;
using TinadecCore.Contracts.Dtos;

namespace TinadecCore.AgentFramework.Tests;

public sealed class ModeRuntimePolicyRegistryTests
{
    private static ModeRuntimePolicyDto Autonomous(params string[] features) => new()
    {
        Kind = ModeRuntimePolicyRegistry.AutonomousExplorationKind,
        Version = ModeRuntimePolicyRegistry.AutonomousExplorationVersion,
        Features = features,
    };

    private static ModeRuntimePolicyDto Correction(params string[] features) => new()
    {
        Kind = CorrectionRuntimePolicy.StructuredInvestigationKind,
        Version = CorrectionRuntimePolicy.StructuredInvestigationVersion,
        Features = features,
    };

    [Fact]
    public void StructuredInvestigationRequiresCausalTrace()
    {
        Assert.Equal(
            "runtime_policy.features must include 'causal_trace'.",
            ModeRuntimePolicyRegistry.Validate(Correction()));
        Assert.Equal(
            "runtime_policy.features must include 'causal_trace'.",
            ModeRuntimePolicyRegistry.Validate(
                Correction(CorrectionRuntimePolicy.CompletionContractFeature)));
    }

    [Fact]
    public void AutonomousExplorationRequiresExplorationGraph()
    {
        Assert.Equal(
            "runtime_policy.features must include 'exploration_graph'.",
            ModeRuntimePolicyRegistry.Validate(Autonomous()));
        Assert.Equal(
            "runtime_policy.features must include 'exploration_graph'.",
            ModeRuntimePolicyRegistry.Validate(
                Autonomous(ModeRuntimePolicyRegistry.AssetGraphFeature)));
    }

    [Fact]
    public void EmptyFeaturesNeverPasses()
    {
        Assert.NotNull(ModeRuntimePolicyRegistry.Validate(Correction()));
        Assert.NotNull(ModeRuntimePolicyRegistry.Validate(Autonomous()));
    }

    [Fact]
    public void FullFeatureSetPasses()
    {
        Assert.Null(ModeRuntimePolicyRegistry.Validate(
            Correction(CorrectionRuntimePolicy.StructuredInvestigationFeatures.ToArray())));
        Assert.Null(ModeRuntimePolicyRegistry.Validate(
            Autonomous(ModeRuntimePolicyRegistry.AutonomousExplorationFeatures.ToArray())));
    }

    [Fact]
    public void DependenciesStillApplyToRequiredFeature()
    {
        Assert.Equal(
            "'event_driven_planning' requires 'plan_ledger'.",
            ModeRuntimePolicyRegistry.Validate(Autonomous(
                ModeRuntimePolicyRegistry.ExplorationGraphFeature,
                ModeRuntimePolicyRegistry.EventDrivenPlanningFeature)));
    }

    [Fact]
    public void AutonomousSettingsAreFailClosed()
    {
        using var unknown = JsonDocument.Parse("""{"planner_debounce_ms":1500,"nope":1}""");
        Assert.Equal(
            "runtime_policy.settings contains an unknown key: 'nope'.",
            ModeRuntimePolicyRegistry.Validate(new ModeRuntimePolicyDto
            {
                Kind = ModeRuntimePolicyRegistry.AutonomousExplorationKind,
                Version = ModeRuntimePolicyRegistry.AutonomousExplorationVersion,
                Features = ModeRuntimePolicyRegistry.AutonomousExplorationFeatures.ToArray(),
                Settings = unknown.RootElement.Clone(),
            }));

        using var outOfRange = JsonDocument.Parse("""{"coverage_min_ratio":1.5}""");
        Assert.Equal(
            "runtime_policy.settings.coverage_min_ratio must be between 0 and 1.",
            ModeRuntimePolicyRegistry.Validate(new ModeRuntimePolicyDto
            {
                Kind = ModeRuntimePolicyRegistry.AutonomousExplorationKind,
                Version = ModeRuntimePolicyRegistry.AutonomousExplorationVersion,
                Features = ModeRuntimePolicyRegistry.AutonomousExplorationFeatures.ToArray(),
                Settings = outOfRange.RootElement.Clone(),
            }));
    }
}
