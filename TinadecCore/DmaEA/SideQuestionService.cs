using System.Text.Json;
using TinadecCore.Abstractions;
using TinadecCore.Abstractions.Ports;

namespace TinadecCore.DmaEA;

/// <param name="ClientMessageId">Idempotency key for a retried ask; absent means every call is its own question.</param>
public sealed record SideQuestionRequest(Guid ParentRunId, string Question, string? ClientMessageId = null);

public sealed record SideQuestionResult(Guid RunId, Guid TurnId, Guid MessageId, bool Existing);

/// <summary>
/// B3: answers a question about a run without touching that run's exploration state. The question
/// becomes its own run over a COPY of the parent's frozen configuration — same agents, prompts and
/// tool manifest, but no runtime policy (so no settlement/digest/planning writes) and no exploration
/// or plan-ledger grants (so a worker cannot record into the session's graph either; coverage is
/// session-scoped, not run-scoped). The answer is archived as
/// <see cref="EvidenceKinds.SideQuestion"/> by the engine's finalization.
/// </summary>
public sealed class SideQuestionService
{
    /// <summary>The run kind of an isolated side-question run. Lifecycle admits it with a parent run.</summary>
    public const string RunKind = "side_question";

    private readonly ILifecycleManager _lifecycle;
    private readonly IConversationStore _conversations;
    private readonly IFullDuplexRunEngine _engine;

    public SideQuestionService(ILifecycleManager lifecycle, IConversationStore conversations, IFullDuplexRunEngine engine)
    {
        _lifecycle = lifecycle;
        _conversations = conversations;
        _engine = engine;
    }

    public async Task<SideQuestionResult> AskAsync(SideQuestionRequest request, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        if (string.IsNullOrWhiteSpace(request.Question))
            throw new RunAdmissionException("invalid_side_question", "A side question needs a question.");
        var question = request.Question.Trim();
        if (question.Length > 20000)
            throw new RunAdmissionException("invalid_side_question", "A side question must be at most 20000 characters.");

        var parent = await _lifecycle.GetRunStateAsync(request.ParentRunId.ToString(), cancellationToken).ConfigureAwait(false);
        if (!Guid.TryParse(parent.SessionId, out var sessionId) || !Guid.TryParse(parent.RunId, out var parentRunId))
            throw new RunAdmissionException("invalid_side_question", "The parent run has no durable identity.");
        var frozen = await _lifecycle.GetFrozenRunConfigurationAsync(parent.RunId, cancellationToken).ConfigureAwait(false)
            ?? throw new RunAdmissionException("side_question_unavailable", "The parent run has no frozen configuration.");

        FrozenRunConfigurationV1 body;
        try { body = JsonSerializer.Deserialize<FrozenRunConfigurationV1>(frozen.Content, FrozenRunConfigurationV1.JsonOptions)!; }
        catch (JsonException ex) { throw new RunAdmissionException("side_question_unavailable", $"The parent run's frozen configuration is unreadable: {ex.Message}"); }
        if (body is null || !ModeRuntimePolicyRegistry.Has(body.RuntimePolicy, ModeRuntimePolicyRegistry.SideQuestionFeature))
            throw new RunAdmissionException("side_question_disabled", "The parent run's runtime policy does not enable 'side_question'.");

        var clientMessageId = string.IsNullOrWhiteSpace(request.ClientMessageId)
            ? $"side-question:{Guid.NewGuid():N}"
            : request.ClientMessageId.Trim();
        var existingMessage = await _conversations.FindMessageByClientMessageIdAsync(sessionId, clientMessageId, cancellationToken).ConfigureAwait(false);
        if (existingMessage is not null)
        {
            if (!string.Equals(existingMessage.Content, question, StringComparison.Ordinal))
                throw new RunAdmissionException("IDEMPOTENCY_KEY_REUSE", "The client message id was already used for a different question.");
            var existingTurn = await _conversations.FindTurnByUserMessageAsync(existingMessage.Id, cancellationToken).ConfigureAwait(false);
            if (existingTurn?.RunId is { } existingRunId)
                return new SideQuestionResult(existingRunId, existingTurn.Id, existingMessage.Id, Existing: true);
            throw new RunAdmissionException("IDEMPOTENCY_KEY_REUSE", "The client message id was already used, but its question was never admitted.");
        }

        var copy = Isolate(body);
        var beforeRevision = await _conversations.GetContextRevisionAsync(sessionId, cancellationToken).ConfigureAwait(false);
        var message = await _conversations.AppendMessageAsync(sessionId, "user", question,
            clientMessageId: clientMessageId, cancellationToken: cancellationToken).ConfigureAwait(false);
        var turn = await _conversations.CreateTurnAsync(sessionId, message.Id, "new_task", beforeRevision, cancellationToken).ConfigureAwait(false);
        var started = await _lifecycle.StartOrGetRunAsync(new RunStartRequest(
            sessionId.ToString(),
            message.Id.ToString(),
            turn.Id.ToString(),
            beforeRevision,
            body.BaselineVersion,
            copy.ContentHash,
            copy.PermissionMode,
            copy.RuntimeProfileId,
            parent.InitiatedByPrincipalId,
            parent.RunId,
            RunKind: RunKind), cancellationToken).ConfigureAwait(false);
        var runId = Guid.Parse(started.RunId);
        await _conversations.AttachRunAsync(turn.Id, runId, cancellationToken).ConfigureAwait(false);
        if (started.Existing)
            return new SideQuestionResult(runId, turn.Id, message.Id, Existing: true);

        await _lifecycle.FreezeRunConfigurationAsync(runId.ToString(), copy.ToLifecycleWrite(), cancellationToken).ConfigureAwait(false);
        await _lifecycle.AppendEventAsync(runId, "task.accepted", new
        {
            run_id = runId,
            turn_id = turn.Id,
            context_revision = beforeRevision,
            configuration_hash = copy.ContentHash,
            runtime_profile_id = copy.RuntimeProfileId,
            parent_run_id = parentRunId,
            run_kind = RunKind
        }, "Isolated side-question run admitted.", cancellationToken: cancellationToken).ConfigureAwait(false);
        await _lifecycle.AppendRunStreamAsync(runId.ToString(), new DurableRunStreamAppend(
            turn.Id,
            "ack",
            message.Id,
            IdempotencyKey: $"run:{runId}:turn:{turn.Id}:ack"), cancellationToken).ConfigureAwait(false);
        await _engine.EnqueueAsync(runId, cancellationToken).ConfigureAwait(false);
        return new SideQuestionResult(runId, turn.Id, message.Id, Existing: false);
    }

    /// <summary>
    /// The isolated copy: no runtime policy (every B mechanism reads it, and an absent policy enables
    /// none), no TinaChat intent binding, no spatial preparation, and no exploration/ledger grants on
    /// any agent. A wildcard grant is materialized against the frozen manifest first, so removing the
    /// exploration ids narrows the surface instead of being ignored by the wildcard.
    /// </summary>
    internal static FrozenRunConfigurationV1 Isolate(FrozenRunConfigurationV1 parent)
    {
        var grantable = parent.ToolManifest
            .Select(entry => entry.Id)
            .Where(id => !CoreVirtualToolPolicy.IsExploration(id) && !CoreVirtualToolPolicy.IsPlanLedger(id))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();
        return parent with
        {
            RuntimePolicy = null,
            TinaChatInput = null,
            SpaceOptions = null,
            SpacePreparationToolIds = null,
            OperationAgents = WithoutExplorationGrants(parent.OperationAgents, grantable),
            ExecutionAgents = WithoutExplorationGrants(parent.ExecutionAgents, grantable)
        };
    }

    private static IReadOnlyList<RuntimeAgentDefinition> WithoutExplorationGrants(
        IReadOnlyList<RuntimeAgentDefinition> agents, IReadOnlyList<string> grantable) =>
        agents.Select(agent => agent.AllowedTools.Contains("*", StringComparer.Ordinal)
            ? agent with { AllowedTools = grantable }
            : agent with
            {
                AllowedTools = agent.AllowedTools
                    .Where(id => !CoreVirtualToolPolicy.IsExploration(id) && !CoreVirtualToolPolicy.IsPlanLedger(id))
                    .ToArray()
            }).ToArray();
}
