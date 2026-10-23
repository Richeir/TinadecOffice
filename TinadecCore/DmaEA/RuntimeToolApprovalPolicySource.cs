using TinadecCore.Abstractions.Ports;

namespace TinadecCore.DmaEA;

/// <summary>
/// Reads the approval policy from the scope's runtime document on every
/// decision so a <c>runtime.toml</c> edit is effective without a restart,
/// exactly like the rest of the runtime policy.
/// </summary>
internal sealed class RuntimeToolApprovalPolicySource : IToolApprovalPolicySource
{
    private readonly IAgentRuntimeConfiguration _runtime;

    public RuntimeToolApprovalPolicySource(IAgentRuntimeConfiguration runtime) => _runtime = runtime;

    public ToolApprovalPolicy? Current => _runtime.Current.Approval;
}
