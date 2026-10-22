using System.Text.Json;

namespace TinadecCore.Contracts.Dtos;

/// <summary>Body for POST /api/v1/agent-evolution/generate.</summary>
public sealed record GenerateProposalRequest(
    Guid SourceRunId,
    Guid SourceInstanceId,
    string Name,
    string Layer,
    string AgentType,
    double Confidence,
    JsonElement Proposal,
    Guid? ProjectId = null);

/// <summary>Body for both promotion routes (evolution and legacy candidate alias).</summary>
public sealed class PromoteAgentCandidateRequest
{
    public string? Reason { get; init; }
    public Guid? EvalRunId { get; init; }
}
