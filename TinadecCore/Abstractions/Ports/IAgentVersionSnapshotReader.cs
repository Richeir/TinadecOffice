namespace TinadecCore.Abstractions.Ports;

/// <summary>
/// Reads the immutable published snapshot of an agent version. Evolution uses it
/// as the control arm of an evaluation without depending on AgentConfiguration.
/// </summary>
public interface IAgentVersionSnapshotReader
{
    Task<AgentVersionSnapshot?> GetAsync(
        Guid tenantId,
        Guid workspaceId,
        Guid agentVersionId,
        CancellationToken cancellationToken = default);
}

public sealed record AgentVersionSnapshot(
    Guid AgentDefinitionId,
    Guid AgentVersionId,
    string ContentHash,
    string SystemPrompt,
    string SnapshotJson);
