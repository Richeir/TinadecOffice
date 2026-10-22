using TinadecCore.DmaEA;
using Xunit;

namespace TinadecCore.Api.Tests;

/// <summary>
/// The promotion gate is a pure function over a suite and a persisted report.
/// These tests pin the failure vocabulary and the exact threshold boundaries;
/// endpoint tests prove the gate is actually consulted before publishing.
/// </summary>
public sealed class AgentEvaluationGateTests
{
    [Fact]
    public void Evaluate_AllRequiredPass_WithoutBlockedPairs_Passes()
    {
        var suite = Suite(Case("a"), Case("b"));
        var report = Report("completed", Pair("a", "passed", "passed"), Pair("b", "passed", "passed"));

        var gate = EvalGateEvaluator.Evaluate(suite, report);

        Assert.Equal("passed", gate.Status);
        Assert.Empty(gate.Failures);
        Assert.Equal(2, gate.EligiblePairs);
        Assert.Equal(0, gate.BlockedPairs);
        Assert.Equal(1m, gate.ControlPassRate);
        Assert.Equal(1m, gate.TreatmentPassRate);
        Assert.Equal(1m, gate.WeightedPassRate);
        Assert.Equal(0m, gate.Lift);
        Assert.Contains("control_saturated", gate.Flags);
        Assert.Contains("treatment_saturated", gate.Flags);
        Assert.Contains("no_lift", gate.Flags);
    }

    [Fact]
    public void Evaluate_NoEligiblePairs_Fails()
    {
        var suite = Suite(Case("a"));
        var report = Report("completed", Pair("a", "error", "error"));

        var gate = EvalGateEvaluator.Evaluate(suite, report);

        Assert.Equal("failed", gate.Status);
        Assert.Contains(gate.Failures, failure => failure.Code == "no_eligible_pairs");
        Assert.Contains(gate.Failures, failure => failure.Code == "blocked_pairs");
        Assert.Equal(1, gate.BlockedPairs);
        Assert.Null(gate.ControlPassRate);
        Assert.Null(gate.TreatmentPassRate);
    }

    [Fact]
    public void Evaluate_BlockedPair_Fails()
    {
        var suite = Suite(Case("a"), Case("b"));
        var report = Report("completed", Pair("a", "passed", "passed"), Pair("b", "passed", "error"));

        var gate = EvalGateEvaluator.Evaluate(suite, report);

        Assert.Equal("failed", gate.Status);
        Assert.Contains(gate.Failures, failure => failure.Code == "blocked_pairs");
        Assert.Equal(1, gate.EligiblePairs);
        Assert.Equal(1, gate.BlockedPairs);
    }

    [Fact]
    public void Evaluate_RequiredTreatmentFailure_Fails()
    {
        var suite = Suite(Case("a"));
        var report = Report("completed", Pair("a", "passed", "failed"));

        var gate = EvalGateEvaluator.Evaluate(suite, report);

        Assert.Equal("failed", gate.Status);
        var failure = Assert.Single(gate.Failures, item => item.Code == "required_case_failed:a");
        Assert.Equal("a", failure.CaseId);
        // Every applicable rule is reported, not just the first one.
        Assert.Contains(gate.Failures, item => item.Code == "pass_rate_below_min");
        Assert.Contains(gate.Failures, item => item.Code == "regression_exceeded");
    }

    [Fact]
    public void Evaluate_OptionalCaseFailure_DoesNotFailTheRequiredRule()
    {
        var suite = Suite(Case("a", required: false, weight: 1m));
        var report = Report("completed", Pair("a", "passed", "failed", required: false));

        var gate = EvalGateEvaluator.Evaluate(suite, report);

        Assert.Equal("failed", gate.Status);
        Assert.DoesNotContain(gate.Failures, failure => failure.Code.StartsWith("required_case_failed", StringComparison.Ordinal));
        Assert.Contains(gate.Failures, failure => failure.Code == "pass_rate_below_min");
    }

    [Fact]
    public void Evaluate_WeightedPassRateBelowMinimum_Fails()
    {
        var suite = SuiteWithGate(new EvalGateDefinition(0.5m, 1m), Case("light", required: false, weight: 1m), Case("heavy", required: false, weight: 3m));
        var report = Report("completed", Pair("light", "passed", "passed", required: false, weight: 1m), Pair("heavy", "passed", "failed", required: false, weight: 3m));

        var gate = EvalGateEvaluator.Evaluate(suite, report);

        Assert.Equal(0.25m, gate.WeightedPassRate);
        Assert.Contains(gate.Failures, failure => failure.Code == "pass_rate_below_min");
    }

    [Fact]
    public void Evaluate_RegressionBeyondLimit_Fails()
    {
        var suite = SuiteWithGate(new EvalGateDefinition(0m, 0.4m), Case("a", required: false), Case("b", required: false));
        var report = Report("completed", Pair("a", "passed", "passed", required: false), Pair("b", "passed", "failed", required: false));

        var gate = EvalGateEvaluator.Evaluate(suite, report);

        Assert.Equal(0.5m, gate.TreatmentPassRate);
        Assert.Equal(1m, gate.ControlPassRate);
        Assert.Contains(gate.Failures, failure => failure.Code == "regression_exceeded");
    }

    [Fact]
    public void Evaluate_RegressionExactlyAtLimit_Passes()
    {
        // Equality is allowed: the rule is "regressed by MORE than max_regression".
        var suite = SuiteWithGate(new EvalGateDefinition(0m, 0.5m), Case("a", required: false), Case("b", required: false));
        var report = Report("completed", Pair("a", "passed", "passed", required: false), Pair("b", "passed", "failed", required: false));

        var gate = EvalGateEvaluator.Evaluate(suite, report);

        Assert.Equal("passed", gate.Status);
        Assert.Empty(gate.Failures);
    }

    [Fact]
    public void Evaluate_FailedRun_FailsEvenWhenCasesLookGreen()
    {
        var suite = Suite(Case("a"));
        var report = Report("failed", Pair("a", "passed", "passed")) with { Error = "budget_exceeded" };

        var gate = EvalGateEvaluator.Evaluate(suite, report);

        Assert.Equal("failed", gate.Status);
        var failure = Assert.Single(gate.Failures);
        Assert.Equal("run_failed", failure.Code);
        Assert.Equal("budget_exceeded", failure.Detail);
    }

    [Fact]
    public void Evaluate_CaseMissingFromReport_IsBlocked()
    {
        var suite = Suite(Case("a"));
        var report = Report("completed");

        var gate = EvalGateEvaluator.Evaluate(suite, report);

        Assert.Equal("failed", gate.Status);
        Assert.Equal(1, gate.BlockedPairs);
        Assert.Contains(gate.Failures, failure => failure.Code == "blocked_pairs" && failure.CaseId == "a");
        Assert.Contains(gate.Failures, failure => failure.Code == "required_case_failed:a");
    }

    private static EvalSuiteDefinition Suite(params EvalCaseDefinition[] cases) =>
        SuiteWithGate(EvalGateDefinition.Default, cases);

    private static EvalSuiteDefinition SuiteWithGate(EvalGateDefinition gate, params EvalCaseDefinition[] cases) => new()
    {
        Slug = "suite",
        Name = "Suite",
        Gate = gate,
        Cases = cases.ToList()
    };

    private static EvalCaseDefinition Case(string id, bool required = true, decimal weight = 1m) => new()
    {
        Id = id,
        Input = "input",
        Required = required,
        Weight = weight,
        Assertions = [new EvalAssertionDefinition { Type = EvalAssertionTypes.MinChars, Number = 0 }]
    };

    private static EvalReportCase Pair(string id, string control, string treatment, bool required = true, decimal weight = 1m) => new()
    {
        Id = id,
        Required = required,
        Weight = weight,
        Status = control == "error" || treatment == "error"
            ? "blocked"
            : control == "passed" && treatment == "passed" ? "passed" : "failed",
        Control = new EvalReportArm { Status = control },
        Treatment = new EvalReportArm { Status = treatment }
    };

    private static EvalReport Report(string status, params EvalReportCase[] cases) => new()
    {
        Status = status,
        Cases = cases.ToList()
    };
}
