using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using TinadecCore.Contracts.Dtos;
using TinadecCore.DmaEA;

namespace TinadecCore.AspNetCore.Endpoints;

/// <summary>
/// Paired evaluation surface. Suites are immutable; a run measures the source
/// instance's published prompt (control) against the sanitized candidate prompt
/// (treatment) and persists a content-addressed report. Promotion re-checks the
/// evidence and the gate instead of trusting these responses.
/// </summary>
internal static class AgentEvaluationEndpoints
{
    public static IEndpointRouteBuilder MapAgentEvaluationEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapPost("/api/v1/agent-evolution/suites", async (CreateEvalSuiteRequest? request, AgentEvaluationService evaluations, CancellationToken ct) =>
        {
            try
            {
                var suite = await evaluations.CreateSuiteAsync(request, ct);
                return Results.Created($"/api/v1/agent-evolution/suites/{suite.Id}", suite);
            }
            catch (EvalSuiteExistsException ex) { return Results.Conflict(new { code = "SUITE_EXISTS", message = ex.Message }); }
            catch (EvalSuiteCorruptException ex) { return EvidenceCorrupt(ex); }
            catch (InvalidDataException ex) { return Results.BadRequest(new { code = "INVALID_SUITE", message = ex.Message }); }
            catch (ArgumentException ex) { return Results.BadRequest(new { code = "INVALID_SUITE", message = ex.Message }); }
        });

        app.MapGet("/api/v1/agent-evolution/suites", async (AgentEvaluationService evaluations, CancellationToken ct) =>
            Results.Ok(await evaluations.ListSuitesAsync(ct)));

        app.MapGet("/api/v1/agent-evolution/suites/{suiteId:guid}", async (Guid suiteId, AgentEvaluationService evaluations, CancellationToken ct) =>
        {
            try
            {
                var suite = await evaluations.GetSuiteAsync(suiteId, ct);
                return suite is null
                    ? Results.NotFound(new { code = "SUITE_NOT_FOUND", suite_id = suiteId, message = "Evaluation suite was not found." })
                    : Results.Ok(suite);
            }
            catch (EvalSuiteCorruptException ex) { return EvidenceCorrupt(ex); }
        });

        app.MapPost("/api/v1/agent-evolution/proposals/{candidateId:guid}/eval-runs", async (Guid candidateId, StartEvalRunRequest? request, AgentEvaluationService evaluations, CancellationToken ct) =>
        {
            try
            {
                var detail = await evaluations.StartRunAsync(candidateId, request, ct);
                return Results.Created($"/api/v1/agent-evolution/eval-runs/{detail.Run.Id}", detail);
            }
            catch (KeyNotFoundException ex) { return Results.NotFound(new { code = "NOT_FOUND", candidate_id = candidateId, message = ex.Message }); }
            catch (CandidateAlreadyDecidedException ex) { return Results.Conflict(new { code = "ALREADY_DECIDED", candidate_id = candidateId, message = ex.Message }); }
            catch (EvalSuiteNotFoundException ex) { return Results.NotFound(new { code = "SUITE_NOT_FOUND", candidate_id = candidateId, message = ex.Message }); }
            catch (EvalSuiteCorruptException ex) { return EvidenceCorrupt(ex); }
            catch (InvalidDataException ex) { return Results.BadRequest(new { code = "INVALID_PROPOSAL", candidate_id = candidateId, message = ex.Message }); }
            catch (ArgumentException ex) { return Results.BadRequest(new { code = "INVALID_PROPOSAL", candidate_id = candidateId, message = ex.Message }); }
        });

        app.MapGet("/api/v1/agent-evolution/proposals/{candidateId:guid}/eval-runs", async (Guid candidateId, AgentEvaluationService evaluations, CancellationToken ct) =>
        {
            try
            {
                return Results.Ok(await evaluations.ListRunsAsync(candidateId, ct));
            }
            catch (KeyNotFoundException ex)
            {
                return Results.NotFound(new { code = "NOT_FOUND", candidate_id = candidateId, message = ex.Message });
            }
        });

        app.MapGet("/api/v1/agent-evolution/eval-runs/{runId:guid}", async (Guid runId, AgentEvaluationService evaluations, CancellationToken ct) =>
        {
            try
            {
                var detail = await evaluations.GetRunAsync(runId, ct);
                return detail is null
                    ? Results.NotFound(new { code = "NOT_FOUND", run_id = runId, message = "Evaluation run was not found." })
                    : Results.Ok(detail);
            }
            catch (EvalSuiteCorruptException ex) { return EvidenceCorrupt(ex); }
        });

        return app;
    }

    private static IResult EvidenceCorrupt(EvalSuiteCorruptException ex) =>
        Results.Json(new { code = "EVIDENCE_CORRUPT", message = ex.Message }, statusCode: StatusCodes.Status500InternalServerError);
}
