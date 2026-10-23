using Microsoft.Extensions.Options;
using TinadecCore.Abstractions.Ports;

namespace TinadecCore.Governance;

/// <summary>
/// Governance-side implementation of the auto-approve policy for durable tool
/// approvals. It is a pure decision rule over caller-supplied facts and the
/// frozen options — it never mutates approval state and never touches a store,
/// so the lifecycle coordinator stays the sole writer and a policy that
/// misbehaves can only fail to release a call, never release one that the
/// binding checks would have rejected.
/// </summary>
/// <remarks>
/// The per-run budget is counted from the caller's durable decisions because
/// the tool-approval path persists its own decision rows. The permission-request
/// path in <see cref="GovernanceService"/> keeps its own counter over its own
/// authorization decisions; the two budgets are deliberately separate rather
/// than joined across stores, and both escalate instead of deny when spent.
/// </remarks>
public sealed class ToolApprovalAutoPolicy : IToolApprovalAutoPolicy
{
    private readonly IOptions<AutoApproveOptions> _options;
    private readonly IToolApprovalPolicySource? _policySource;

    public ToolApprovalAutoPolicy(
        IOptions<AutoApproveOptions> options,
        IToolApprovalPolicySource? policySource = null)
    {
        _options = options;
        _policySource = policySource;
    }

    public Task<ToolApprovalAutoPolicyVerdict> EvaluateAsync(
        ToolApprovalAutoPolicyContext context,
        CancellationToken cancellationToken = default)
    {
        var policy = (context.UseRuntimePolicy ? _policySource?.Current : null) ?? _options.Value.ToPolicy();
        if (!AutoApprovePolicyRules.Engages(policy, approveIntent: true, context.ToolId, context.Risk))
        {
            return Task.FromResult(new ToolApprovalAutoPolicyVerdict(ToolApprovalAutoPolicyOutcome.NotEngaged));
        }

        var remaining = policy.MaxPerRun - context.AutoPolicyUsesThisRun;
        return Task.FromResult(remaining > 0
            ? new ToolApprovalAutoPolicyVerdict(
                ToolApprovalAutoPolicyOutcome.Approved,
                ToolApprovalPolicy.PolicyVersion,
                "auto_policy_approved",
                remaining - 1)
            : new ToolApprovalAutoPolicyVerdict(
                ToolApprovalAutoPolicyOutcome.BudgetExhausted,
                ToolApprovalPolicy.PolicyVersion,
                "auto_policy_budget_exhausted"));
    }
}
