namespace TinadecCore.DmaEA;

/// <summary>
/// Reads a runtime policy snapshot and says which numbers differ from the baseline this build
/// ships.
///
/// <para>
/// Why: every one of these ceilings is editable, but only inside <c>runtime.toml</c>. A person
/// whose Team run stopped after two workers, or whose run was refused because two were already
/// active, had no place in the product to read the number that stopped it — the answer lived in a
/// file they did not know about. The policy surface reports the effective values plus the shipped
/// ones, so "this is the default" and "somebody changed this" are distinguishable at a glance.
/// </para>
/// </summary>
/// <summary>Outcome of comparing the effective policy with the baseline this build ships.</summary>
/// <param name="DefaultsAvailable">False when the baseline could not be read; deviations are then empty, not "none".</param>
/// <param name="Deviations">Dotted keys (<c>scheduling.max_active_runs_per_session</c>) whose value an operator changed.</param>
public sealed record RuntimePolicyComparison(bool DefaultsAvailable, IReadOnlyList<string> Deviations);

public static class AgentRuntimePolicyReport
{
    /// <summary>
    /// Compares the effective policy with the bundled baseline. An unreadable or broken baseline
    /// reports <c>DefaultsAvailable = false</c> instead of failing: the effective values are still
    /// worth showing, only the comparison is dropped.
    /// </summary>
    public static RuntimePolicyComparison Compare(AgentRuntimeConfigurationSnapshot effective, string bundledPath)
    {
        ArgumentNullException.ThrowIfNull(effective);
        var baseline = ReadBaseline(bundledPath);
        if (baseline is null) return new RuntimePolicyComparison(false, []);
        var keys = new List<string>();
        void Compare(string key, object? actual, object? shipped)
        {
            if (!Equals(actual, shipped)) keys.Add(key);
        }
        Compare("spawn.max_depth", effective.Spawn.MaxDepth, baseline.Spawn.MaxDepth);
        Compare("spawn.max_agents_per_run", effective.Spawn.MaxAgentsPerRun, baseline.Spawn.MaxAgentsPerRun);
        Compare("spawn.max_parallel_workers", effective.Spawn.MaxParallelWorkers, baseline.Spawn.MaxParallelWorkers);
        Compare("scheduling.max_active_runs_per_session", effective.Scheduling.MaxActiveRunsPerSession, baseline.Scheduling.MaxActiveRunsPerSession);
        Compare("scheduling.worker_retry_limit", effective.Scheduling.WorkerRetryLimit, baseline.Scheduling.WorkerRetryLimit);
        Compare("scheduling.preserve_partial_results", effective.Scheduling.PreservePartialResults, baseline.Scheduling.PreservePartialResults);
        Compare("supervision.required_before_final", effective.Supervision.RequiredBeforeFinal, baseline.Supervision.RequiredBeforeFinal);
        Compare("supervision.max_revision_rounds", effective.Supervision.MaxRevisionRounds, baseline.Supervision.MaxRevisionRounds);
        Compare("context.default_token_budget", effective.Context.DefaultTokenBudget, baseline.Context.DefaultTokenBudget);
        // The effective value, so a legacy document without the key is judged by what it runs with.
        Compare("context.task_token_budget", effective.Context.EffectiveTaskTokenBudget, baseline.Context.EffectiveTaskTokenBudget);
        Compare("context.run_token_budget", effective.Context.RunTokenBudget, baseline.Context.RunTokenBudget);
        Compare("context.recent_message_limit", effective.Context.RecentMessageLimit, baseline.Context.RecentMessageLimit);
        Compare("tools.max_tool_calls", effective.Tools.MaxToolCalls, baseline.Tools.MaxToolCalls);
        Compare("tools.max_tool_rounds", effective.Tools.MaxToolRounds, baseline.Tools.MaxToolRounds);
        Compare("tools.default_timeout_seconds", effective.Tools.DefaultTimeoutSeconds, baseline.Tools.DefaultTimeoutSeconds);
        return new RuntimePolicyComparison(true, keys);
    }

    /// <summary>
    /// The shipped baseline of this installation. An unreadable or broken baseline must not fail
    /// the report: the effective values are still worth showing, only the comparison is dropped.
    /// </summary>
    private static AgentRuntimeConfigurationSnapshot? ReadBaseline(string bundledPath)
    {
        if (string.IsNullOrWhiteSpace(bundledPath) || !File.Exists(bundledPath)) return null;
        try
        {
            return AgentRuntimeConfigurationStore.LoadSnapshot(bundledPath, 0);
        }
        catch (Exception error) when (error is IOException or InvalidDataException or FormatException or OverflowException or ArgumentException)
        {
            return null;
        }
    }

    /// <summary>Location of the policy baseline this build ships.</summary>
    public static string BundledPath => Path.Combine(AppContext.BaseDirectory, "Configuration", "default-agent-runtime.toml");
}
