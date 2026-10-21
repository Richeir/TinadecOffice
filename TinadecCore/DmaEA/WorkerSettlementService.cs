using Microsoft.Extensions.Logging;
using TinadecCore.Abstractions;
using TinadecCore.Abstractions.Ports;

namespace TinadecCore.DmaEA;

/// <summary>
/// What one finished worker hands to settlement. Built by the engine from the durable task node: the
/// turn ids are the tool executions the worker itself ran, and the archived evidence id is the
/// <c>task_result</c> entry the engine just wrote, so both can be cited without another query.
/// </summary>
public sealed record WorkerSettlementRequest(
    Guid TaskId,
    string TaskTitle,
    string Status,
    string? ResultSummary,
    string? WorkerHandle,
    string? WorkerAgentSlug,
    Guid? WorkerAgentId,
    int Attempt,
    IReadOnlyList<string> ToolExecutionIds,
    Guid? ArchivedEvidenceId);

/// <param name="NodeKind">The exploration node the settlement wrote (<c>finding</c> or <c>hint</c>), or null when none.</param>
/// <param name="IntentsUpdated">Running intents the settling worker owned that were closed by this settlement.</param>
public sealed record WorkerSettlementResult(
    bool Applied,
    string? NodeKind,
    IReadOnlyList<string> EvidenceRefs,
    int IntentsUpdated)
{
    public static readonly WorkerSettlementResult NotApplied = new(false, null, [], 0);
}

/// <summary>
/// B4: turns a terminal worker result into shared state. When the frozen policy enables
/// <c>worker_settlement</c>:
/// <list type="bullet">
/// <item>the result becomes an exploration <c>finding</c> when it cites at least one execution or
/// archived-evidence ref, and a <c>hint</c> when it cites none — an uncited belief is never promoted;</item>
/// <item>the plan intents the finishing worker claimed are completed (task completed) or blocked
/// (task failed/blocked), so a planner sees the plan move instead of guessing.</item>
/// </list>
/// Each write is additionally gated by the feature that owns its store, and the ledger enforces
/// claim ownership itself — settlement never overrides a <c>policy_denied</c>.
/// </summary>
public sealed class WorkerSettlementService
{
    /// <summary>Both the graph and the ledger cap refs at 32; keep the settlement inside that.</summary>
    public const int MaxEvidenceRefs = 32;
    private const int MaxNoteChars = 1000;

    private readonly IExplorationGraph? _graph;
    private readonly IPlanLedger? _ledger;
    private readonly ILogger<WorkerSettlementService>? _logger;

    public WorkerSettlementService(
        IExplorationGraph? graph = null,
        IPlanLedger? ledger = null,
        ILogger<WorkerSettlementService>? logger = null)
    {
        _graph = graph;
        _ledger = ledger;
        _logger = logger;
    }

    public async Task<WorkerSettlementResult> SettleAsync(
        RunState run,
        FrozenRunConfigurationV1 configuration,
        WorkerSettlementRequest request,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(run);
        ArgumentNullException.ThrowIfNull(configuration);
        ArgumentNullException.ThrowIfNull(request);
        if (!ModeRuntimePolicyRegistry.Has(configuration.RuntimePolicy, ModeRuntimePolicyRegistry.WorkerSettlementFeature))
            return WorkerSettlementResult.NotApplied;
        if (request.Status is not ("completed" or "failed" or "blocked")) return WorkerSettlementResult.NotApplied;
        if (!Guid.TryParse(run.TenantId, out var tenantId) || !Guid.TryParse(run.WorkspaceId, out var workspaceId)
            || !Guid.TryParse(run.SessionId, out var sessionId) || !Guid.TryParse(run.RunId, out var runId))
            return WorkerSettlementResult.NotApplied;

        var refs = EvidenceRefs(request);
        string? nodeKind = null;
        if (_graph is not null
            && ModeRuntimePolicyRegistry.Has(configuration.RuntimePolicy, ModeRuntimePolicyRegistry.ExplorationGraphFeature)
            && request.Status == "completed"
            && !string.IsNullOrWhiteSpace(request.ResultSummary))
        {
            // A completed task's answer is a conclusion; without a citation it is only a hint.
            nodeKind = refs.Count > 0 ? ExplorationNodeKinds.Finding : ExplorationNodeKinds.Hint;
            try
            {
                await _graph.AppendNodeAsync(
                    new ExplorationScope(tenantId, workspaceId, sessionId, runId, request.TaskId, request.WorkerAgentId),
                    new ExplorationNodeDraft(
                        nodeKind,
                        request.TaskTitle,
                        request.ResultSummary,
                        EvidenceRefs: refs,
                        SourceKey: $"settle:{runId:N}:{request.TaskId:N}:{request.Attempt}",
                        Author: request.WorkerHandle ?? request.WorkerAgentSlug),
                    cancellationToken).ConfigureAwait(false);
            }
            catch (Exception ex) when (ex is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
            {
                _logger?.TryLogDebug(ex, "Could not record the settlement of task {TaskId} in run {RunId}.",
                    request.TaskId, runId);
            }
        }

        var intentsUpdated = await CloseIntentsAsync(
            configuration.RuntimePolicy, tenantId, workspaceId, sessionId, runId, request, cancellationToken)
            .ConfigureAwait(false);
        return new WorkerSettlementResult(true, nodeKind, refs, intentsUpdated);
    }

    private async Task<int> CloseIntentsAsync(
        Contracts.Dtos.ModeRuntimePolicyDto? policy,
        Guid tenantId,
        Guid workspaceId,
        Guid sessionId,
        Guid runId,
        WorkerSettlementRequest request,
        CancellationToken cancellationToken)
    {
        if (_ledger is null || request.WorkerAgentId is not { } worker
            || !ModeRuntimePolicyRegistry.Has(policy, ModeRuntimePolicyRegistry.PlanLedgerFeature))
            return 0;
        var readScope = new PlanLedgerScope(tenantId, workspaceId, sessionId, runId);
        IReadOnlyList<PlanIntent> running;
        try
        {
            running = await _ledger.ListAsync(readScope, PlanIntentStatuses.Running, cancellationToken).ConfigureAwait(false);
        }
        catch (Exception ex) when (ex is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
        {
            _logger?.TryLogDebug(ex, "Could not read the plan ledger of run {RunId} at task settlement.", runId);
            return 0;
        }

        var scope = readScope with { TaskId = request.TaskId, AgentInstanceId = worker };
        var note = Clip(request.ResultSummary, MaxNoteChars);
        var updated = 0;
        foreach (var intent in running.Where(intent => intent.ClaimedByAgentInstanceId == worker))
        {
            try
            {
                if (request.Status == "completed")
                {
                    await _ledger.CompleteAsync(scope, intent.Id, note, cancellationToken).ConfigureAwait(false);
                }
                else
                {
                    await _ledger.BlockAsync(scope, intent.Id,
                        Clip($"task {request.TaskId:N} ended {request.Status}: {request.ResultSummary}", MaxNoteChars)!,
                        cancellationToken).ConfigureAwait(false);
                }
                updated++;
            }
            catch (Exception ex) when (ex is PlanLedgerDeniedException or KeyNotFoundException or ArgumentException)
            {
                // Ownership is the ledger's answer, not something settlement may override.
                _logger?.TryLogDebug(ex, "Settlement left intent {IntentId} of run {RunId} unchanged.", intent.Id, runId);
            }
            catch (Exception ex) when (ex is not OperationCanceledException || !cancellationToken.IsCancellationRequested)
            {
                _logger?.TryLogDebug(ex, "Could not close intent {IntentId} of run {RunId} at settlement.", intent.Id, runId);
            }
        }
        return updated;
    }

    /// <summary>The archived result first, then the worker's own tool executions, newest turn last.</summary>
    private static IReadOnlyList<string> EvidenceRefs(WorkerSettlementRequest request)
    {
        var refs = new List<string>();
        if (request.ArchivedEvidenceId is { } evidenceId) refs.Add($"evidence:{evidenceId:N}");
        foreach (var executionId in request.ToolExecutionIds)
        {
            if (!Guid.TryParse(executionId, out var id)) continue;
            var reference = $"execution:{id:D}";
            if (refs.Count >= MaxEvidenceRefs) break;
            if (!refs.Contains(reference, StringComparer.Ordinal)) refs.Add(reference);
        }
        return refs;
    }

    private static string? Clip(string? value, int max)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        var text = value.Trim();
        return text.Length <= max ? text : text[..max] + "…";
    }
}
