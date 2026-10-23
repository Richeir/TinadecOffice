namespace TinadecCore.Abstractions.Ports;

/// <summary>
/// Supplies the effective, user-editable approval policy. DmaEA reads it from
/// the scope's <c>runtime.toml</c>; embedded hosts that register no runtime
/// document fall back to the compiled <c>AutoApproveOptions</c>.
/// </summary>
public interface IToolApprovalPolicySource
{
    /// <summary>Null when the scope's runtime.toml has no [approval] section.</summary>
    ToolApprovalPolicy? Current { get; }
}
