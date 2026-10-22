using System.Diagnostics;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.AI;
using TinadecCore.Abstractions.Ports;
using TinadecCore.Contracts.Dtos;
using TinadecCore.Persistence;

namespace TinadecCore.DmaEA;

internal sealed class EvalSuiteNotFoundException(string message) : Exception(message);
internal sealed class EvalSuiteExistsException(string message) : Exception(message);
internal sealed class EvalSuiteCorruptException(string message) : Exception(message);
internal sealed class EvalRunInvalidException(string message) : Exception(message);
internal sealed class EvalRunIncompleteException(string message) : Exception(message);
internal sealed class EvalStaleException(string message) : Exception(message);
internal sealed class EvalGateFailedException(string message, IReadOnlyList<EvalGateFailure> failures) : Exception(message)
{
    public IReadOnlyList<EvalGateFailure> Failures { get; } = failures;
}
internal sealed class CandidateAlreadyDecidedException(string message) : Exception(message);

internal sealed record EvalGateDecision(AgentEvalRunRecord Run, EvalGateResult Gate);

internal sealed class AgentEvaluationService
{
    private static readonly TimeSpan PerCallTimeout = TimeSpan.FromSeconds(45);
    private static readonly TimeSpan RunBudget = TimeSpan.FromMinutes(5);
    private const int MaxExcerptLength = 2000;

    private static readonly JsonSerializerOptions ReportJson = new(JsonSerializerDefaults.Web)
    {
        PropertyNamingPolicy = JsonNamingPolicy.SnakeCaseLower
    };

    private readonly IDbContextFactory<AgentControlDbContext> _dbFactory;
    private readonly IContentStore _content;
    private readonly ITenantContextAccessor _tenant;
    private readonly IAgentVersionSnapshotReader _versions;
    private readonly IAgentChatClientFactory _chatClients;

    public AgentEvaluationService(
        IDbContextFactory<AgentControlDbContext> dbFactory,
        IContentStore content,
        ITenantContextAccessor tenant,
        IAgentVersionSnapshotReader versions,
        IAgentChatClientFactory chatClients)
    {
        _dbFactory = dbFactory;
        _content = content;
        _tenant = tenant;
        _versions = versions;
        _chatClients = chatClients;
    }

    public async Task<EvalSuiteDetailResponse> CreateSuiteAsync(CreateEvalSuiteRequest? request, CancellationToken cancellationToken = default)
    {
        var definition = EvalSuiteValidator.FromRequest(request);
        var bytes = EvalSuiteJson.Serialize(definition);
        var hash = ContentHashing.Sha256Hex(bytes);
        var scope = _tenant.Current;
        await using var db = await _dbFactory.CreateDbContextAsync(cancellationToken).ConfigureAwait(false);
        if (await db.EvalSuites.AnyAsync(
                x => x.TenantId == scope.TenantId && x.WorkspaceId == scope.WorkspaceId && x.Slug == definition.Slug,
                cancellationToken).ConfigureAwait(false))
        {
            throw new EvalSuiteExistsException($"Evaluation suite '{definition.Slug}' already exists in this workspace.");
        }

        ContentReference reference;
        await using (var stream = new MemoryStream(bytes, writable: false))
        {
            reference = await _content.PutAsync(
                new ContentWriteRequest(scope.TenantId, scope.WorkspaceId, "agent-eval-suite", "application/json", stream),
                cancellationToken).ConfigureAwait(false);
        }
        if (!string.Equals(reference.Sha256, hash, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("Content store returned a different hash for the suite definition.");

        var now = DateTimeOffset.UtcNow;
        var row = new AgentEvalSuiteRecord
        {
            Id = Guid.NewGuid(),
            TenantId = scope.TenantId,
            WorkspaceId = scope.WorkspaceId,
            Slug = definition.Slug,
            Name = definition.Name,
            Description = definition.Description,
            Status = "active",
            DefinitionReference = reference.Value,
            DefinitionHash = hash,
            DefinitionLength = reference.Length,
            CreatedByPrincipalId = scope.PrincipalId,
            CreatedAt = now,
            UpdatedAt = now
        };
        db.EvalSuites.Add(row);
        try
        {
            await db.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        }
        catch (DbUpdateException)
        {
            throw new EvalSuiteExistsException($"Evaluation suite '{definition.Slug}' already exists in this workspace.");
        }
        return ToDetail(row, ToDefinitionElement(definition));
    }

    public async Task<IReadOnlyList<EvalSuiteSummaryResponse>> ListSuitesAsync(CancellationToken cancellationToken = default)
    {
        var scope = _tenant.Current;
        await using var db = await _dbFactory.CreateDbContextAsync(cancellationToken).ConfigureAwait(false);
        var rows = await db.EvalSuites.AsNoTracking()
            .Where(x => x.TenantId == scope.TenantId && x.WorkspaceId == scope.WorkspaceId)
            .ToListAsync(cancellationToken).ConfigureAwait(false);
        // SQLite stores DateTimeOffset as text and cannot order by it server-side.
        rows.Sort((a, b) => b.CreatedAt.CompareTo(a.CreatedAt));
        return rows.Select(ToSummary).ToList();
    }

    public async Task<EvalSuiteDetailResponse?> GetSuiteAsync(Guid suiteId, CancellationToken cancellationToken = default)
    {
        if (suiteId == Guid.Empty) return null;
        var scope = _tenant.Current;
        await using var db = await _dbFactory.CreateDbContextAsync(cancellationToken).ConfigureAwait(false);
        var row = await db.EvalSuites.AsNoTracking().SingleOrDefaultAsync(
            x => x.Id == suiteId && x.TenantId == scope.TenantId && x.WorkspaceId == scope.WorkspaceId,
            cancellationToken).ConfigureAwait(false);
        if (row is null) return null;
        try
        {
            var definition = await ReadSuiteDefinitionAsync(row, cancellationToken).ConfigureAwait(false);
            return ToDetail(row, ToDefinitionElement(definition));
        }
        catch (InvalidDataException ex)
        {
            throw new EvalSuiteCorruptException(ex.Message);
        }
    }

    public async Task<EvalRunDetailResponse> StartRunAsync(Guid candidateId, StartEvalRunRequest? request, CancellationToken cancellationToken = default)
    {
        var scope = _tenant.Current;
        var candidate = await LoadCandidateAsync(candidateId, scope, cancellationToken).ConfigureAwait(false);
        if (!string.Equals(candidate.Status, "proposed", StringComparison.Ordinal))
            throw new CandidateAlreadyDecidedException("Candidate has already been decided.");
        if (request?.SuiteId is not { } suiteId || suiteId == Guid.Empty)
            throw new EvalSuiteNotFoundException("Evaluation suite was not found.");
        var (suiteRow, suite) = await LoadSuiteAsync(suiteId, scope, cancellationToken).ConfigureAwait(false);
        var proposal = await ReadProposalAsync(candidate, cancellationToken).ConfigureAwait(false);
        var sanitized = CandidateProposalSanitizer.Sanitize(candidate, proposal);

        var instance = await FindInstanceAsync(candidate.SourceInstanceId, scope, cancellationToken).ConfigureAwait(false);
        var control = await ResolveControlAsync(scope, instance, cancellationToken).ConfigureAwait(false);

        var startedAt = DateTimeOffset.UtcNow;
        var run = new AgentEvalRunRecord
        {
            Id = Guid.NewGuid(),
            TenantId = scope.TenantId,
            WorkspaceId = scope.WorkspaceId,
            CandidateId = candidate.Id,
            SuiteId = suiteRow.Id,
            SourceInstanceId = candidate.SourceInstanceId,
            SuiteHash = suiteRow.DefinitionHash,
            ControlAgentDefinitionId = control.Snapshot?.AgentDefinitionId,
            ControlAgentVersionId = control.Snapshot?.AgentVersionId,
            ControlVersionHash = control.Snapshot?.ContentHash,
            ControlSystemPromptHash = control.PromptHash,
            TreatmentProposalHash = candidate.ProposalHash,
            TreatmentSystemPromptHash = sanitized.SystemPromptHash,
            Status = "running",
            ModelRoute = "chat",
            CreatedByPrincipalId = scope.PrincipalId,
            StartedAt = startedAt
        };
        await using (var db = await _dbFactory.CreateDbContextAsync(cancellationToken).ConfigureAwait(false))
        {
            db.EvalRuns.Add(run);
            await db.SaveChangesAsync(cancellationToken).ConfigureAwait(false);
        }

        var report = new EvalReport
        {
            Suite = new EvalReportSuite
            {
                Id = suiteRow.Id,
                Slug = suiteRow.Slug,
                Hash = suiteRow.DefinitionHash,
                Gate = suite.Gate
            },
            Control = new EvalReportControl
            {
                AgentDefinitionId = control.Snapshot?.AgentDefinitionId,
                AgentVersionId = control.Snapshot?.AgentVersionId,
                VersionHash = control.Snapshot?.ContentHash,
                SystemPromptHash = control.PromptHash
            },
            Treatment = new EvalReportTreatment
            {
                ProposalHash = candidate.ProposalHash,
                SystemPromptHash = sanitized.SystemPromptHash
            },
            Model = new EvalReportModel { Route = "chat" },
            Status = "completed",
            StartedAt = startedAt
        };

        if (control.Error is not null)
            return await CompleteAsync(scope, suiteRow, suite, run, report, "failed", control.Error, null, cancellationToken).ConfigureAwait(false);

        using var budget = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        budget.CancelAfter(RunBudget);
        ChatResolution? resolution = null;
        IChatClient? client = null;
        try
        {
            resolution = await _chatClients.ResolveChatAsync("chat", budget.Token).ConfigureAwait(false);
            if (resolution.IsAvailable)
                client = await _chatClients.CreateAsync(resolution, budget.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return await CompleteAsync(scope, suiteRow, suite, run, report, "failed",
                budget.IsCancellationRequested ? "budget_exceeded" : "model_unavailable", resolution, cancellationToken).ConfigureAwait(false);
        }
        catch (Exception) when (!cancellationToken.IsCancellationRequested)
        {
            return await CompleteAsync(scope, suiteRow, suite, run, report, "failed", "model_unavailable", resolution, cancellationToken).ConfigureAwait(false);
        }

        report = report with
        {
            Model = new EvalReportModel
            {
                Route = "chat",
                Model = resolution?.Model,
                ModelId = resolution?.ModelId,
                Protocol = resolution?.Protocol
            }
        };
        if (client is null)
            return await CompleteAsync(scope, suiteRow, suite, run, report, "failed", "model_unavailable", resolution, cancellationToken).ConfigureAwait(false);

        try
        {
            var cases = new List<EvalReportCase>(suite.Cases.Count);
            var controlUsage = new UsageTotals();
            var treatmentUsage = new UsageTotals();
            var runError = (string?)null;
            foreach (var definition in suite.Cases)
            {
                if (budget.IsCancellationRequested)
                {
                    runError = "budget_exceeded";
                    cases.Add(BlockedCase(definition, "budget_exceeded"));
                    continue;
                }
                var controlArm = await ExecuteArmAsync(client, "control", control.Prompt!, definition, budget.Token, cancellationToken).ConfigureAwait(false);
                controlUsage.Add(controlArm.Usage);
                if (controlArm.BudgetExceeded)
                {
                    runError = "budget_exceeded";
                    cases.Add(BlockedCase(definition, "budget_exceeded"));
                    continue;
                }
                var treatmentArm = await ExecuteArmAsync(client, "treatment", sanitized.SystemPrompt, definition, budget.Token, cancellationToken).ConfigureAwait(false);
                treatmentUsage.Add(treatmentArm.Usage);
                if (treatmentArm.BudgetExceeded)
                {
                    runError = "budget_exceeded";
                    cases.Add(BlockedCase(definition, "budget_exceeded"));
                    continue;
                }
                cases.Add(new EvalReportCase
                {
                    Id = definition.Id,
                    Required = definition.Required,
                    Weight = definition.Weight,
                    Status = PairStatus(controlArm.Report, treatmentArm.Report),
                    ElapsedMs = controlArm.Report.ElapsedMs + treatmentArm.Report.ElapsedMs,
                    Control = controlArm.Report,
                    Treatment = treatmentArm.Report
                });
            }

            report = report with
            {
                Cases = cases,
                Usage = new EvalReportUsageSection
                {
                    Control = controlUsage.ToReport(),
                    Treatment = treatmentUsage.ToReport()
                }
            };
            return await CompleteAsync(scope, suiteRow, suite, run, report,
                runError is null ? "completed" : "failed", runError, resolution, cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            client.Dispose();
        }
    }

    public async Task<IReadOnlyList<EvalRunSummaryResponse>> ListRunsAsync(Guid candidateId, CancellationToken cancellationToken = default)
    {
        var scope = _tenant.Current;
        await using var db = await _dbFactory.CreateDbContextAsync(cancellationToken).ConfigureAwait(false);
        if (!await db.Candidates.AsNoTracking().AnyAsync(
                x => x.Id == candidateId && x.TenantId == scope.TenantId && x.WorkspaceId == scope.WorkspaceId,
                cancellationToken).ConfigureAwait(false))
        {
            throw new KeyNotFoundException("Agent candidate was not found.");
        }
        var rows = await db.EvalRuns.AsNoTracking()
            .Where(x => x.TenantId == scope.TenantId && x.WorkspaceId == scope.WorkspaceId && x.CandidateId == candidateId)
            .ToListAsync(cancellationToken).ConfigureAwait(false);
        // SQLite stores DateTimeOffset as text and cannot order by it server-side.
        rows.Sort((a, b) => b.StartedAt.CompareTo(a.StartedAt));
        return rows.Take(50).Select(ToSummary).ToList();
    }

    public async Task<EvalRunDetailResponse?> GetRunAsync(Guid runId, CancellationToken cancellationToken = default)
    {
        if (runId == Guid.Empty) return null;
        var scope = _tenant.Current;
        await using var db = await _dbFactory.CreateDbContextAsync(cancellationToken).ConfigureAwait(false);
        var row = await db.EvalRuns.AsNoTracking().SingleOrDefaultAsync(
            x => x.Id == runId && x.TenantId == scope.TenantId && x.WorkspaceId == scope.WorkspaceId,
            cancellationToken).ConfigureAwait(false);
        if (row is null) return null;
        JsonElement? reportElement = null;
        if (!string.IsNullOrWhiteSpace(row.ReportReference) && !string.IsNullOrWhiteSpace(row.ReportHash) && row.ReportLength is not null)
        {
            var (_, element) = await ReadReportAsync(row, cancellationToken).ConfigureAwait(false);
            reportElement = element;
        }
        return new EvalRunDetailResponse
        {
            Run = ToSummary(row),
            Report = reportElement
        };
    }

    /// <summary>
    /// Promotion evidence check. Everything is re-read and re-hashed here instead of
    /// trusting the stored gate status, so a tampered or stale run cannot authorize a
    /// deployment.
    /// </summary>
    public async Task<EvalGateDecision> AssertPromotableAsync(
        AgentCandidateRecord candidate,
        SanitizedCandidateProposal sanitized,
        Guid evalRunId,
        CancellationToken cancellationToken = default)
    {
        var scope = _tenant.Current;
        await using var db = await _dbFactory.CreateDbContextAsync(cancellationToken).ConfigureAwait(false);
        var run = await db.EvalRuns.AsNoTracking().SingleOrDefaultAsync(
            x => x.Id == evalRunId && x.TenantId == scope.TenantId && x.WorkspaceId == scope.WorkspaceId,
            cancellationToken).ConfigureAwait(false);
        if (run is null || run.CandidateId != candidate.Id)
            throw new EvalRunInvalidException("Evaluation run does not belong to this candidate.");
        if (!string.Equals(run.Status, "completed", StringComparison.Ordinal))
            throw new EvalRunIncompleteException("Evaluation run has not completed.");

        var suiteRow = await db.EvalSuites.AsNoTracking().SingleOrDefaultAsync(
            x => x.Id == run.SuiteId && x.TenantId == scope.TenantId && x.WorkspaceId == scope.WorkspaceId,
            cancellationToken).ConfigureAwait(false);
        if (suiteRow is null) throw new EvalStaleException("Evaluation suite no longer exists.");
        EvalSuiteDefinition suite;
        try
        {
            suite = await ReadSuiteDefinitionAsync(suiteRow, cancellationToken).ConfigureAwait(false);
        }
        catch (InvalidDataException ex)
        {
            throw new EvalStaleException(ex.Message);
        }
        if (!HashEquals(suiteRow.DefinitionHash, run.SuiteHash))
            throw new EvalStaleException("Evaluation suite hash no longer matches the run.");
        if (!HashEquals(candidate.ProposalHash, run.TreatmentProposalHash))
            throw new EvalStaleException("Candidate proposal changed after the evaluation run.");
        if (!HashEquals(sanitized.SystemPromptHash, run.TreatmentSystemPromptHash))
            throw new EvalStaleException("Candidate system prompt changed after the evaluation run.");

        var instance = await FindInstanceAsync(candidate.SourceInstanceId, scope, cancellationToken).ConfigureAwait(false);
        if (instance is null)
            throw new EvalStaleException("Source agent instance no longer exists.");
        if (run.ControlAgentVersionId is not { } controlVersionId
            || instance.AgentVersionId != controlVersionId
            || !HashEquals(instance.AgentVersionHash, run.ControlVersionHash))
        {
            throw new EvalStaleException("Control agent version changed after the evaluation run.");
        }
        var snapshot = await _versions.GetAsync(scope.TenantId, scope.WorkspaceId, controlVersionId, cancellationToken).ConfigureAwait(false);
        if (snapshot is null
            || !HashEquals(snapshot.ContentHash, run.ControlVersionHash)
            || !HashEquals(ContentHashing.Sha256Hex(snapshot.SystemPrompt.Trim()), run.ControlSystemPromptHash))
        {
            throw new EvalStaleException("Control agent version snapshot changed after the evaluation run.");
        }

        EvalReport report;
        try
        {
            (report, _) = await ReadReportAsync(run, cancellationToken).ConfigureAwait(false);
        }
        catch (InvalidDataException ex)
        {
            throw new EvalStaleException(ex.Message);
        }
        var gate = EvalGateEvaluator.Evaluate(suite, report);
        if (!string.Equals(run.GateStatus, EvalGateEvaluator.Passed, StringComparison.Ordinal)
            || !string.Equals(gate.Status, EvalGateEvaluator.Passed, StringComparison.Ordinal))
        {
            throw new EvalGateFailedException("Evaluation gate failed.", gate.Failures);
        }
        return new EvalGateDecision(run, gate);
    }

    private async Task<ControlResolution> ResolveControlAsync(
        TenantContext scope,
        AgentInstanceRecord? instance,
        CancellationToken cancellationToken)
    {
        if (instance is null || instance.AgentVersionId == Guid.Empty)
            return new ControlResolution(null, null, null, "control_unavailable");
        var snapshot = await _versions.GetAsync(scope.TenantId, scope.WorkspaceId, instance.AgentVersionId, cancellationToken).ConfigureAwait(false);
        if (snapshot is null)
            return new ControlResolution(null, null, null, "control_unavailable");
        if (!HashEquals(instance.AgentVersionHash, snapshot.ContentHash))
            return new ControlResolution(snapshot, null, null, "control_version_mismatch");
        var prompt = snapshot.SystemPrompt.Trim();
        if (prompt.Length == 0)
            return new ControlResolution(snapshot, null, null, "control_prompt_missing");
        return new ControlResolution(snapshot, prompt, ContentHashing.Sha256Hex(prompt), null);
    }

    private async Task<EvalArmExecution> ExecuteArmAsync(
        IChatClient client,
        string arm,
        string instructions,
        EvalCaseDefinition definition,
        CancellationToken runToken,
        CancellationToken requestToken)
    {
        if (runToken.IsCancellationRequested)
            return new EvalArmExecution(new EvalReportArm { Status = "error", Error = "budget_exceeded" }, null, true);
        using var callTimeout = CancellationTokenSource.CreateLinkedTokenSource(runToken);
        callTimeout.CancelAfter(PerCallTimeout);
        var started = Stopwatch.GetTimestamp();
        try
        {
            var turn = await Maf18RuntimeAdapter.RunGovernanceTurnAsync(
                client,
                $"agent-eval-{arm}-{definition.Id}",
                "agent_eval",
                "Paired evaluation turn",
                new ChatOptions
                {
                    Instructions = instructions,
                    ToolMode = ChatToolMode.None,
                    MaxOutputTokens = 1024
                },
                definition.Input,
                callTimeout.Token).ConfigureAwait(false);
            var elapsed = ElapsedMs(started);
            if (!turn.HasAnswer)
            {
                return new EvalArmExecution(
                    new EvalReportArm { Status = "error", Error = "empty_answer", ElapsedMs = elapsed },
                    turn.Usage, false);
            }
            return new EvalArmExecution(EvaluateAssertions(definition, turn.AnswerText, elapsed), turn.Usage, false);
        }
        catch (OperationCanceledException) when (requestToken.IsCancellationRequested)
        {
            throw;
        }
        catch (OperationCanceledException)
        {
            return new EvalArmExecution(
                new EvalReportArm
                {
                    Status = "error",
                    Error = runToken.IsCancellationRequested ? "budget_exceeded" : "timeout",
                    ElapsedMs = ElapsedMs(started)
                },
                null,
                runToken.IsCancellationRequested);
        }
        catch (Exception)
        {
            return new EvalArmExecution(
                new EvalReportArm { Status = "error", Error = "model_error", ElapsedMs = ElapsedMs(started) },
                null, false);
        }
    }

    private static EvalReportArm EvaluateAssertions(EvalCaseDefinition definition, string answer, long elapsed)
    {
        var assertions = new List<EvalReportAssertion>(definition.Assertions.Count);
        var passed = true;
        foreach (var assertion in definition.Assertions)
        {
            var result = assertion.Type switch
            {
                EvalAssertionTypes.Contains => new EvalReportAssertion
                {
                    Type = assertion.Type,
                    Passed = answer.Contains(assertion.Text!, StringComparison.Ordinal),
                    Detail = null
                },
                EvalAssertionTypes.NotContains => new EvalReportAssertion
                {
                    Type = assertion.Type,
                    Passed = !answer.Contains(assertion.Text!, StringComparison.Ordinal),
                    Detail = null
                },
                EvalAssertionTypes.Regex => MatchRegex(answer, assertion.Text!),
                EvalAssertionTypes.MinChars => new EvalReportAssertion
                {
                    Type = assertion.Type,
                    Passed = answer.Length >= assertion.Number,
                    Detail = null
                },
                EvalAssertionTypes.MaxChars => new EvalReportAssertion
                {
                    Type = assertion.Type,
                    Passed = answer.Length <= assertion.Number,
                    Detail = null
                },
                _ => new EvalReportAssertion { Type = assertion.Type, Passed = false, Detail = "unknown assertion type" }
            };
            if (!result.Passed)
            {
                passed = false;
                result = new EvalReportAssertion
                {
                    Type = result.Type,
                    Passed = false,
                    Detail = result.Detail ?? $"assertion '{result.Type}' failed"
                };
            }
            assertions.Add(result);
        }
        return new EvalReportArm
        {
            Status = passed ? "passed" : "failed",
            Assertions = assertions,
            OutputExcerpt = Excerpt(answer),
            OutputSha256 = ContentHashing.Sha256Hex(answer),
            OutputLength = answer.Length,
            ElapsedMs = elapsed
        };
    }

    private static EvalReportAssertion MatchRegex(string answer, string pattern)
    {
        try
        {
            var match = Regex.IsMatch(answer, pattern, RegexOptions.CultureInvariant, EvalSuiteContract.RegexTimeout);
            return new EvalReportAssertion
            {
                Type = EvalAssertionTypes.Regex,
                Passed = match,
                Detail = match ? null : "pattern did not match"
            };
        }
        catch (RegexMatchTimeoutException)
        {
            return new EvalReportAssertion { Type = EvalAssertionTypes.Regex, Passed = false, Detail = "regex timed out" };
        }
        catch (ArgumentException)
        {
            return new EvalReportAssertion { Type = EvalAssertionTypes.Regex, Passed = false, Detail = "regex is invalid" };
        }
    }

    private async Task<EvalRunDetailResponse> CompleteAsync(
        TenantContext scope,
        AgentEvalSuiteRecord suiteRow,
        EvalSuiteDefinition suite,
        AgentEvalRunRecord run,
        EvalReport report,
        string status,
        string? error,
        ChatResolution? resolution,
        CancellationToken cancellationToken)
    {
        var completedAt = DateTimeOffset.UtcNow;
        var draft = report with
        {
            Status = status,
            Error = error,
            CompletedAt = completedAt,
            Model = report.Model with
            {
                Route = "chat",
                Model = resolution?.Model,
                ModelId = resolution?.ModelId,
                Protocol = resolution?.Protocol
            }
        };
        var gate = EvalGateEvaluator.Evaluate(suite, draft);
        var final = draft with { Gate = ToReportGate(gate) };
        var bytes = JsonSerializer.SerializeToUtf8Bytes(final, ReportJson);
        ContentReference reference;
        await using (var stream = new MemoryStream(bytes, writable: false))
        {
            reference = await _content.PutAsync(
                new ContentWriteRequest(scope.TenantId, scope.WorkspaceId, "agent-eval-report", "application/json", stream),
                cancellationToken).ConfigureAwait(false);
        }

        await using var db = await _dbFactory.CreateDbContextAsync(cancellationToken).ConfigureAwait(false);
        var row = await db.EvalRuns.SingleAsync(
            x => x.Id == run.Id && x.TenantId == scope.TenantId && x.WorkspaceId == scope.WorkspaceId,
            cancellationToken).ConfigureAwait(false);
        row.Status = status;
        row.GateStatus = gate.Status;
        row.CasesTotal = gate.CasesTotal;
        row.CasesPassed = gate.CasesPassed;
        row.CasesFailed = gate.CasesFailed;
        row.CasesBlocked = gate.CasesBlocked;
        row.EligiblePairs = gate.EligiblePairs;
        row.BlockedPairs = gate.BlockedPairs;
        row.ControlPassRate = ToDouble(gate.ControlPassRate);
        row.TreatmentPassRate = ToDouble(gate.TreatmentPassRate);
        row.WeightedPassRate = (double)gate.WeightedPassRate;
        row.Lift = (double)gate.Lift;
        row.Model = resolution?.Model;
        row.ReportReference = reference.Value;
        row.ReportHash = reference.Sha256;
        row.ReportLength = reference.Length;
        row.Error = error;
        row.CompletedAt = completedAt;
        await db.SaveChangesAsync(cancellationToken).ConfigureAwait(false);

        using var document = JsonDocument.Parse(bytes);
        return new EvalRunDetailResponse
        {
            Run = ToSummary(row),
            Report = document.RootElement.Clone()
        };
    }

    private async Task<EvalSuiteDefinition> ReadSuiteDefinitionAsync(AgentEvalSuiteRecord row, CancellationToken cancellationToken)
    {
        var bytes = await ReadContentAsync(
            new ContentReference(row.DefinitionReference, row.DefinitionHash, row.DefinitionLength, "application/json"),
            cancellationToken).ConfigureAwait(false);
        return EvalSuiteValidator.FromCanonical(bytes);
    }

    private async Task<(AgentEvalSuiteRecord Row, EvalSuiteDefinition Suite)> LoadSuiteAsync(
        Guid suiteId,
        TenantContext scope,
        CancellationToken cancellationToken)
    {
        await using var db = await _dbFactory.CreateDbContextAsync(cancellationToken).ConfigureAwait(false);
        var row = await db.EvalSuites.AsNoTracking().SingleOrDefaultAsync(
            x => x.Id == suiteId && x.TenantId == scope.TenantId && x.WorkspaceId == scope.WorkspaceId,
            cancellationToken).ConfigureAwait(false);
        if (row is null) throw new EvalSuiteNotFoundException("Evaluation suite was not found.");
        try
        {
            var suite = await ReadSuiteDefinitionAsync(row, cancellationToken).ConfigureAwait(false);
            return (row, suite);
        }
        catch (InvalidDataException ex)
        {
            throw new EvalSuiteCorruptException(ex.Message);
        }
    }

    private async Task<AgentCandidateRecord> LoadCandidateAsync(Guid candidateId, TenantContext scope, CancellationToken cancellationToken)
    {
        await using var db = await _dbFactory.CreateDbContextAsync(cancellationToken).ConfigureAwait(false);
        return await db.Candidates.AsNoTracking().SingleOrDefaultAsync(
            x => x.Id == candidateId && x.TenantId == scope.TenantId && x.WorkspaceId == scope.WorkspaceId,
            cancellationToken).ConfigureAwait(false)
            ?? throw new KeyNotFoundException("Agent candidate was not found.");
    }

    private async Task<AgentInstanceRecord?> FindInstanceAsync(Guid instanceId, TenantContext scope, CancellationToken cancellationToken)
    {
        if (instanceId == Guid.Empty) return null;
        await using var db = await _dbFactory.CreateDbContextAsync(cancellationToken).ConfigureAwait(false);
        return await db.Instances.AsNoTracking().SingleOrDefaultAsync(
            x => x.Id == instanceId && x.TenantId == scope.TenantId && x.WorkspaceId == scope.WorkspaceId,
            cancellationToken).ConfigureAwait(false);
    }

    private async Task<JsonElement> ReadProposalAsync(AgentCandidateRecord candidate, CancellationToken cancellationToken)
    {
        var bytes = await ReadContentAsync(
            new ContentReference(candidate.ProposalReference, candidate.ProposalHash, candidate.ProposalLength, "application/json"),
            cancellationToken).ConfigureAwait(false);
        using var document = JsonDocument.Parse(bytes);
        return document.RootElement.Clone();
    }

    private async Task<(EvalReport Report, JsonElement Element)> ReadReportAsync(AgentEvalRunRecord row, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(row.ReportReference) || string.IsNullOrWhiteSpace(row.ReportHash) || row.ReportLength is null)
            throw new InvalidDataException("Evaluation run has no report.");
        var bytes = await ReadContentAsync(
            new ContentReference(row.ReportReference, row.ReportHash, row.ReportLength.Value, "application/json"),
            cancellationToken).ConfigureAwait(false);
        var report = JsonSerializer.Deserialize<EvalReport>(bytes, ReportJson)
            ?? throw new InvalidDataException("Evaluation report is empty.");
        using var document = JsonDocument.Parse(bytes);
        return (report, document.RootElement.Clone());
    }

    private async Task<byte[]> ReadContentAsync(ContentReference reference, CancellationToken cancellationToken)
    {
        await using var stream = await _content.OpenReadAsync(reference, cancellationToken).ConfigureAwait(false);
        using var memory = new MemoryStream();
        await stream.CopyToAsync(memory, cancellationToken).ConfigureAwait(false);
        var bytes = memory.ToArray();
        if (bytes.LongLength != reference.Length
            || !HashEquals(ContentHashing.Sha256Hex(bytes), reference.Sha256))
        {
            throw new InvalidDataException("Content-addressed evidence failed verification.");
        }
        return bytes;
    }

    private static EvalReportCase BlockedCase(EvalCaseDefinition definition, string error) => new()
    {
        Id = definition.Id,
        Required = definition.Required,
        Weight = definition.Weight,
        Status = "blocked",
        Control = new EvalReportArm { Status = "error", Error = error },
        Treatment = new EvalReportArm { Status = "error", Error = error }
    };

    private static string PairStatus(EvalReportArm control, EvalReportArm treatment)
    {
        if (string.Equals(control.Status, "error", StringComparison.Ordinal)
            || string.Equals(treatment.Status, "error", StringComparison.Ordinal))
        {
            return "blocked";
        }
        return string.Equals(control.Status, "passed", StringComparison.Ordinal)
            && string.Equals(treatment.Status, "passed", StringComparison.Ordinal)
            ? "passed"
            : "failed";
    }

    private static EvalReportGate ToReportGate(EvalGateResult result) => new()
    {
        Status = result.Status,
        Failures = result.Failures.ToList(),
        CasesTotal = result.CasesTotal,
        CasesPassed = result.CasesPassed,
        CasesFailed = result.CasesFailed,
        CasesBlocked = result.CasesBlocked,
        EligiblePairs = result.EligiblePairs,
        BlockedPairs = result.BlockedPairs,
        ControlPassRate = result.ControlPassRate,
        TreatmentPassRate = result.TreatmentPassRate,
        WeightedPassRate = result.WeightedPassRate,
        Lift = result.Lift,
        Flags = result.Flags.ToList()
    };

    private static EvalSuiteSummaryResponse ToSummary(AgentEvalSuiteRecord row) => new()
    {
        Id = row.Id,
        Slug = row.Slug,
        Name = row.Name,
        Description = row.Description,
        Status = row.Status,
        DefinitionHash = row.DefinitionHash,
        DefinitionLength = row.DefinitionLength,
        CreatedAt = row.CreatedAt,
        UpdatedAt = row.UpdatedAt
    };

    private static EvalSuiteDetailResponse ToDetail(AgentEvalSuiteRecord row, JsonElement definition) => new()
    {
        Id = row.Id,
        Slug = row.Slug,
        Name = row.Name,
        Description = row.Description,
        Status = row.Status,
        DefinitionReference = row.DefinitionReference,
        DefinitionHash = row.DefinitionHash,
        DefinitionLength = row.DefinitionLength,
        CreatedByPrincipalId = row.CreatedByPrincipalId,
        CreatedAt = row.CreatedAt,
        UpdatedAt = row.UpdatedAt,
        Definition = definition
    };

    private static EvalRunSummaryResponse ToSummary(AgentEvalRunRecord row) => new()
    {
        Id = row.Id,
        CandidateId = row.CandidateId,
        SuiteId = row.SuiteId,
        SourceInstanceId = row.SourceInstanceId,
        SuiteHash = row.SuiteHash,
        ControlAgentDefinitionId = row.ControlAgentDefinitionId,
        ControlAgentVersionId = row.ControlAgentVersionId,
        ControlVersionHash = row.ControlVersionHash,
        ControlSystemPromptHash = row.ControlSystemPromptHash,
        TreatmentProposalHash = row.TreatmentProposalHash,
        TreatmentSystemPromptHash = row.TreatmentSystemPromptHash,
        Status = row.Status,
        GateStatus = row.GateStatus,
        CasesTotal = row.CasesTotal,
        CasesPassed = row.CasesPassed,
        CasesFailed = row.CasesFailed,
        CasesBlocked = row.CasesBlocked,
        EligiblePairs = row.EligiblePairs,
        BlockedPairs = row.BlockedPairs,
        ControlPassRate = row.ControlPassRate,
        TreatmentPassRate = row.TreatmentPassRate,
        WeightedPassRate = row.WeightedPassRate,
        Lift = row.Lift,
        ModelRoute = row.ModelRoute,
        Model = row.Model,
        ReportReference = row.ReportReference,
        ReportHash = row.ReportHash,
        ReportLength = row.ReportLength,
        Error = row.Error,
        CreatedByPrincipalId = row.CreatedByPrincipalId,
        StartedAt = row.StartedAt,
        CompletedAt = row.CompletedAt
    };

    private static JsonElement ToDefinitionElement(EvalSuiteDefinition definition)
    {
        using var document = JsonDocument.Parse(EvalSuiteJson.Serialize(definition));
        return document.RootElement.Clone();
    }

    private static bool HashEquals(string? left, string? right) =>
        !string.IsNullOrWhiteSpace(left)
        && !string.IsNullOrWhiteSpace(right)
        && string.Equals(left, right, StringComparison.OrdinalIgnoreCase);

    private static double? ToDouble(decimal? value) => value is null ? null : (double)value.Value;

    private static long ElapsedMs(long startedTimestamp) =>
        (long)Math.Round(Stopwatch.GetElapsedTime(startedTimestamp).TotalMilliseconds);

    private static string Excerpt(string text)
    {
        if (text.Length <= MaxExcerptLength) return text;
        var length = MaxExcerptLength;
        if (char.IsHighSurrogate(text[length - 1])) length--;
        return text[..length];
    }

    private sealed record ControlResolution(AgentVersionSnapshot? Snapshot, string? Prompt, string? PromptHash, string? Error);

    private sealed record EvalArmExecution(EvalReportArm Report, ModelUsage? Usage, bool BudgetExceeded);

    private sealed class UsageTotals
    {
        private long _input;
        private long _output;
        private long _total;

        public void Add(ModelUsage? usage)
        {
            if (usage is null) return;
            _input += usage.InputTokens ?? 0;
            _output += usage.OutputTokens ?? 0;
            _total += usage.TotalTokens ?? (usage.InputTokens ?? 0) + (usage.OutputTokens ?? 0);
        }

        public EvalReportUsage ToReport() => new()
        {
            InputTokens = _input,
            OutputTokens = _output,
            TotalTokens = _total
        };
    }
}
