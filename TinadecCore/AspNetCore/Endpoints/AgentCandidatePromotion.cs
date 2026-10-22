using System.Text.Json;
using Microsoft.AspNetCore.Http;
using TinadecCore.AgentConfiguration;
using TinadecCore.DmaEA;

namespace TinadecCore.AspNetCore.Endpoints;

/// <summary>
/// Review-driven promotion of generated agent candidates. The pipeline stages
/// owned here are sanitization (minimal, clamped draft), evaluation evidence
/// re-check with a deterministic gate, review (the human decision that calls
/// this endpoint), and publish (immutable AgentVersion through the
/// AgentConfiguration boundary). Canary and activation remain future stages; a
/// promoted agent only becomes routable after an explicit mode binding by an
/// operator.
/// </summary>
internal static class AgentCandidatePromotion
{
    public static async Task<IResult> PromoteAsync(
        IAgentInstanceService instances,
        IAgentConfigurationService configurations,
        AgentEvaluationService evaluations,
        Guid candidateId,
        string? reason,
        Guid? evalRunId,
        CancellationToken cancellationToken)
    {
        try
        {
            var (candidate, proposal) = await instances.GetCandidateWithProposalAsync(candidateId, cancellationToken).ConfigureAwait(false);
            if (candidate.Status != "proposed")
            {
                return Results.Conflict(new { code = "ALREADY_DECIDED", candidate_id = candidateId, message = "Candidate has already been decided." });
            }
            if (evalRunId is not { } runId || runId == Guid.Empty)
            {
                return Unprocessable("EVAL_REQUIRED", candidateId, "Promotion requires the evaluation run that passed the gate.");
            }

            var sanitized = CandidateProposalSanitizer.Sanitize(candidate, proposal);
            // Re-read and re-hash the evidence: the promotion decision never trusts
            // the client's claim that a run passed, nor a stale in-row gate status.
            await evaluations.AssertPromotableAsync(candidate, sanitized, runId, cancellationToken).ConfigureAwait(false);

            var draft = JsonSerializer.SerializeToElement(await configurations.CreateDraftAsync("agent", sanitized.Payload, cancellationToken).ConfigureAwait(false));
            var agentId = draft.GetProperty("id").GetGuid();
            var revision = draft.GetProperty("revision").GetInt64();
            var published = JsonSerializer.SerializeToElement(await configurations.PublishAsync(agentId, revision, cancellationToken).ConfigureAwait(false));
            var decided = await instances.DecideCandidateAsync(candidateId, "promoted", reason, cancellationToken, agentId, runId).ConfigureAwait(false);
            return Results.Ok(new
            {
                id = decided.Id,
                source_run_id = decided.SourceRunId,
                name = decided.Name,
                layer = decided.Layer,
                agent_type = decided.AgentType,
                status = decided.Status,
                decision_reason = decided.DecisionReason,
                promoted_agent_id = decided.PromotedAgentId,
                eval_run_id = decided.EvalRunId,
                published_agent = new
                {
                    id = agentId,
                    version = published.GetProperty("version").GetInt32(),
                    content_hash = published.GetProperty("content_hash").GetString()
                }
            });
        }
        catch (KeyNotFoundException)
        {
            return Results.NotFound(new { code = "NOT_FOUND", candidate_id = candidateId, message = "Agent candidate was not found." });
        }
        catch (EvalRunInvalidException ex)
        {
            return Unprocessable("EVAL_RUN_INVALID", candidateId, ex.Message);
        }
        catch (EvalRunIncompleteException ex)
        {
            return Results.Conflict(new { code = "EVAL_RUN_INCOMPLETE", candidate_id = candidateId, message = ex.Message });
        }
        catch (EvalStaleException ex)
        {
            return Results.Conflict(new { code = "EVAL_STALE", candidate_id = candidateId, message = ex.Message });
        }
        catch (EvalGateFailedException ex)
        {
            return Results.Json(new
            {
                code = "EVAL_GATE_FAILED",
                candidate_id = candidateId,
                message = ex.Message,
                failures = ex.Failures.Select(failure => new
                {
                    code = failure.Code,
                    case_id = failure.CaseId,
                    detail = failure.Detail
                })
            }, statusCode: StatusCodes.Status422UnprocessableEntity);
        }
        catch (ArgumentException ex)
        {
            return Results.BadRequest(new { code = "INVALID_PROPOSAL", candidate_id = candidateId, message = ex.Message });
        }
        catch (InvalidDataException ex)
        {
            return Results.BadRequest(new { code = "INVALID_PROPOSAL", candidate_id = candidateId, message = ex.Message });
        }
        catch (InvalidOperationException ex)
        {
            return Results.Conflict(new { code = "ALREADY_DECIDED", candidate_id = candidateId, message = ex.Message });
        }
    }

    private static IResult Unprocessable(string code, Guid candidateId, string message) =>
        Results.Json(new { code, candidate_id = candidateId, message }, statusCode: StatusCodes.Status422UnprocessableEntity);
}
