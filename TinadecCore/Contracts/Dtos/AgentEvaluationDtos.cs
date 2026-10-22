using System.Text.Json;

namespace TinadecCore.Contracts.Dtos;

/// <summary>Body for POST /api/v1/agent-evolution/suites.</summary>
public sealed class CreateEvalSuiteRequest
{
    public int? SchemaVersion { get; init; }
    public string? Slug { get; init; }
    public string? Name { get; init; }
    public string? Description { get; init; }
    public EvalGateRequest? Gate { get; init; }
    public List<EvalCaseRequest>? Cases { get; init; }
}

public sealed class EvalGateRequest
{
    public decimal? MinPassRate { get; init; }
    public decimal? MaxRegression { get; init; }
}

public sealed class EvalCaseRequest
{
    public string? Id { get; init; }
    public string? Input { get; init; }
    public bool? Required { get; init; }
    public decimal? Weight { get; init; }
    public List<EvalAssertionRequest>? Assertions { get; init; }
}

public sealed class EvalAssertionRequest
{
    public string? Type { get; init; }
    public JsonElement Value { get; init; }
}

/// <summary>Body for POST /api/v1/agent-evolution/proposals/{candidateId}/eval-runs.</summary>
public sealed class StartEvalRunRequest
{
    public Guid? SuiteId { get; init; }
}

public sealed class EvalSuiteSummaryResponse
{
    public Guid Id { get; init; }
    public string Slug { get; init; } = string.Empty;
    public string Name { get; init; } = string.Empty;
    public string? Description { get; init; }
    public string Status { get; init; } = string.Empty;
    public string DefinitionHash { get; init; } = string.Empty;
    public long DefinitionLength { get; init; }
    public DateTimeOffset CreatedAt { get; init; }
    public DateTimeOffset UpdatedAt { get; init; }
}

public sealed class EvalSuiteDetailResponse
{
    public Guid Id { get; init; }
    public string Slug { get; init; } = string.Empty;
    public string Name { get; init; } = string.Empty;
    public string? Description { get; init; }
    public string Status { get; init; } = string.Empty;
    public string DefinitionReference { get; init; } = string.Empty;
    public string DefinitionHash { get; init; } = string.Empty;
    public long DefinitionLength { get; init; }
    public Guid CreatedByPrincipalId { get; init; }
    public DateTimeOffset CreatedAt { get; init; }
    public DateTimeOffset UpdatedAt { get; init; }
    public JsonElement Definition { get; init; }
}

public sealed class EvalRunSummaryResponse
{
    public Guid Id { get; init; }
    public Guid CandidateId { get; init; }
    public Guid SuiteId { get; init; }
    public Guid SourceInstanceId { get; init; }
    public string SuiteHash { get; init; } = string.Empty;
    public Guid? ControlAgentDefinitionId { get; init; }
    public Guid? ControlAgentVersionId { get; init; }
    public string? ControlVersionHash { get; init; }
    public string? ControlSystemPromptHash { get; init; }
    public string TreatmentProposalHash { get; init; } = string.Empty;
    public string? TreatmentSystemPromptHash { get; init; }
    public string Status { get; init; } = string.Empty;
    public string? GateStatus { get; init; }
    public int CasesTotal { get; init; }
    public int CasesPassed { get; init; }
    public int CasesFailed { get; init; }
    public int CasesBlocked { get; init; }
    public int EligiblePairs { get; init; }
    public int BlockedPairs { get; init; }
    public double? ControlPassRate { get; init; }
    public double? TreatmentPassRate { get; init; }
    public double? WeightedPassRate { get; init; }
    public double? Lift { get; init; }
    public string ModelRoute { get; init; } = string.Empty;
    public string? Model { get; init; }
    public string? ReportReference { get; init; }
    public string? ReportHash { get; init; }
    public long? ReportLength { get; init; }
    public string? Error { get; init; }
    public Guid CreatedByPrincipalId { get; init; }
    public DateTimeOffset StartedAt { get; init; }
    public DateTimeOffset? CompletedAt { get; init; }
}

public sealed class EvalRunDetailResponse
{
    public EvalRunSummaryResponse Run { get; init; } = new();
    public JsonElement? Report { get; init; }
}
