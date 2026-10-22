namespace TinadecCore.DmaEA;

internal sealed record EvalGateFailure(string Code, string? CaseId, string? Detail);

internal sealed record EvalGateResult(
    string Status,
    IReadOnlyList<EvalGateFailure> Failures,
    int CasesTotal,
    int CasesPassed,
    int CasesFailed,
    int CasesBlocked,
    int EligiblePairs,
    int BlockedPairs,
    decimal? ControlPassRate,
    decimal? TreatmentPassRate,
    decimal WeightedPassRate,
    decimal Lift,
    IReadOnlyList<string> Flags);

internal static class EvalGateEvaluator
{
    public const string Passed = "passed";
    public const string Failed = "failed";
    public const string CompletedRun = "completed";

    /// <summary>
    /// Deterministic GO/NO-GO over a persisted report. Promotion recomputes this
    /// from suite and report bytes instead of trusting the stored gate_status.
    /// </summary>
    public static EvalGateResult Evaluate(EvalSuiteDefinition suite, EvalReport report)
    {
        var reportCases = report.Cases.ToDictionary(item => item.Id, StringComparer.Ordinal);
        var failures = new List<EvalGateFailure>();
        if (!string.Equals(report.Status, CompletedRun, StringComparison.Ordinal))
        {
            failures.Add(new EvalGateFailure(
                "run_failed",
                null,
                string.IsNullOrWhiteSpace(report.Error) ? "Evaluation run did not complete." : report.Error));
        }

        var casesPassed = 0;
        var casesFailed = 0;
        var casesBlocked = 0;
        var controlPassed = 0;
        var treatmentPassed = 0;
        var eligibleWeight = 0m;
        var treatmentPassedWeight = 0m;
        var requiredFailures = new List<EvalGateFailure>();

        foreach (var definition in suite.Cases)
        {
            if (!reportCases.TryGetValue(definition.Id, out var reported))
            {
                casesBlocked++;
                failures.Add(new EvalGateFailure("blocked_pairs", definition.Id, "Case is missing from the report."));
                if (definition.Required)
                    requiredFailures.Add(new EvalGateFailure($"required_case_failed:{definition.Id}", definition.Id, "Treatment did not pass."));
                continue;
            }

            if (string.Equals(reported.Status, "passed", StringComparison.Ordinal))
            {
                casesPassed++;
                eligibleWeight += definition.Weight;
                controlPassed++;
                treatmentPassed++;
                treatmentPassedWeight += definition.Weight;
            }
            else if (string.Equals(reported.Status, "failed", StringComparison.Ordinal))
            {
                casesFailed++;
                eligibleWeight += definition.Weight;
                if (string.Equals(reported.Control.Status, "passed", StringComparison.Ordinal)) controlPassed++;
                if (string.Equals(reported.Treatment.Status, "passed", StringComparison.Ordinal))
                {
                    treatmentPassed++;
                    treatmentPassedWeight += definition.Weight;
                }
            }
            else
            {
                casesBlocked++;
            }

            if (definition.Required && !string.Equals(reported.Treatment.Status, "passed", StringComparison.Ordinal))
                requiredFailures.Add(new EvalGateFailure($"required_case_failed:{definition.Id}", definition.Id, "Treatment did not pass."));
        }

        var eligiblePairs = casesPassed + casesFailed;
        var blockedPairs = casesBlocked;
        decimal? controlPassRate = eligiblePairs == 0 ? null : (decimal)controlPassed / eligiblePairs;
        decimal? treatmentPassRate = eligiblePairs == 0 ? null : (decimal)treatmentPassed / eligiblePairs;
        var weightedPassRate = eligibleWeight == 0m ? 0m : treatmentPassedWeight / eligibleWeight;
        var lift = controlPassRate is null || treatmentPassRate is null ? 0m : treatmentPassRate.Value - controlPassRate.Value;

        if (eligiblePairs == 0)
            failures.Add(new EvalGateFailure("no_eligible_pairs", null, "No case produced answers on both arms."));
        if (blockedPairs > 0)
            failures.Add(new EvalGateFailure("blocked_pairs", null, $"{blockedPairs} case(s) were blocked."));
        failures.AddRange(requiredFailures);
        if (weightedPassRate < suite.Gate.MinPassRate)
            failures.Add(new EvalGateFailure(
                "pass_rate_below_min",
                null,
                $"weighted_pass_rate {weightedPassRate} is below {suite.Gate.MinPassRate}."));
        if (controlPassRate is not null && treatmentPassRate is not null
            && treatmentPassRate.Value < controlPassRate.Value - suite.Gate.MaxRegression)
            failures.Add(new EvalGateFailure(
                "regression_exceeded",
                null,
                $"treatment_pass_rate {treatmentPassRate.Value} regressed by more than {suite.Gate.MaxRegression}."));

        var flags = new List<string>();
        if (controlPassRate == 1m) flags.Add("control_saturated");
        if (treatmentPassRate == 1m) flags.Add("treatment_saturated");
        if (eligiblePairs > 0 && lift == 0m) flags.Add("no_lift");
        if (lift < 0m) flags.Add("negative_delta");

        return new EvalGateResult(
            failures.Count == 0 ? Passed : Failed,
            failures,
            suite.Cases.Count,
            casesPassed,
            casesFailed,
            casesBlocked,
            eligiblePairs,
            blockedPairs,
            controlPassRate,
            treatmentPassRate,
            weightedPassRate,
            lift,
            flags);
    }
}
