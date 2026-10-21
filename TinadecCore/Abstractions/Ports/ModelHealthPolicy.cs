namespace TinadecCore.Abstractions.Ports;

/// <summary>
/// Circuit-breaker rules for the frozen model candidate chain. A candidate that keeps answering
/// with a <em>transient</em> failure is taken out of the chain for a while instead of being
/// hammered once per invocation — which is the situation a route with several candidates exists
/// for, and the one a single-candidate route has no other way to survive.
///
/// Two rules are deliberate and load-bearing:
/// <list type="bullet">
/// <item>Only <see cref="CountsAsFailure"/> categories count. A rejected request, a missing
/// credential or an unavailable candidate are deterministic facts about configuration; cooling the
/// provider for those would hide a user error behind "try again shortly" and would make a
/// mis-typed model name look like an outage.</item>
/// <item>Nothing here ever substitutes a model. When every candidate is cooling the caller gets
/// <see cref="PoolExhaustedCategory"/> and the run fails: silently walking to a model the frozen
/// plan never declared would be an unauthorized model, not resilience.</item>
/// </list>
///
/// The rules live in Abstractions because the resolver (Runtime) and the invocation factory (DmaEA)
/// both reason about them, and business modules may not reference each other.
/// </summary>
public static class ModelHealthPolicy
{
    /// <summary>Reported when the chain was non-empty but every candidate is cooling down.</summary>
    public const string PoolExhaustedCategory = "model_pool_exhausted";

    public const int DefaultFailureThreshold = 3;
    public const int DefaultCooldownSeconds = 60;
    public const int MaxFailureThreshold = 20;
    public const int MinCooldownSeconds = 5;
    public const int MaxCooldownSeconds = 3600;

    /// <summary>
    /// The failure categories that mean "the provider did not answer, try again later" — exactly the
    /// ones the invocation factory's fallback taxonomy treats as retryable
    /// (<c>ModelInvocationFailure.Classify</c> with <c>CanFallback = true</c>).
    /// Those two lists cannot be one constant across the module boundary (the classifier is DmaEA
    /// internal), so <c>ModelHealthPolicyTests</c> drives the classifier over real exception shapes and
    /// fails the moment a category is retryable on one side and uncounted on the other.
    /// </summary>
    public static IReadOnlySet<string> RetryableCategories { get; } = new HashSet<string>(StringComparer.Ordinal)
    {
        "rate_limited",
        "provider_server_error",
        "timeout",
        "connection_failed",
        // The classifier's remaining fallback: an exception that carries a sub-400 status code is a
        // contradiction, but the classifier retries it, so the breaker has to count it or the two
        // lists disagree about the same shape.
        "provider_error",
    };

    public static bool CountsAsFailure(string? errorCategory) =>
        errorCategory is not null && RetryableCategories.Contains(errorCategory);

    public static bool IsCooling(DateTimeOffset? coolingUntil, DateTimeOffset now) =>
        coolingUntil is { } until && until > now;

    /// <summary>
    /// The breaker keys a chain contributes. A candidate is keyed only when it is available and carries
    /// both a provider instance and a model name; an entry whose harness picks the model has no stable
    /// key, and inventing one (an empty model name) would merge unrelated harnesses into one record.
    /// </summary>
    public static IReadOnlyCollection<(Guid ProviderInstanceId, string Model)> CoolingKeys(
        IReadOnlyList<ChatResolution> chain) =>
        chain
            .Where(item => item.IsAvailable && item.ProviderInstanceId is { } id && !string.IsNullOrWhiteSpace(item.Model))
            .Select(item => (ProviderInstanceId: item.ProviderInstanceId!.Value, Model: item.Model!))
            .Distinct()
            .ToArray();

    /// <summary>
    /// Drops the candidates that are cooling. When every entry was dropped the result is a single
    /// unavailable candidate naming the pool — never a surviving entry the frozen plan did not declare,
    /// because "walk to whatever is left" is exactly the substitution this policy forbids.
    /// </summary>
    public static IReadOnlyList<ChatResolution> ApplyCooling(
        IReadOnlyList<ChatResolution> chain,
        IReadOnlySet<(Guid ProviderInstanceId, string Model)> cooling)
    {
        if (chain.Count == 0 || cooling.Count == 0) return chain;

        // Keyed by the same shape so an unkeyed entry (no provider or no model) can never be "found" in
        // the cooling set by accident; it always stays and keeps the pool from looking exhausted.
        var kept = chain
            .Where(item => item.ProviderInstanceId is not { } id
                           || string.IsNullOrWhiteSpace(item.Model)
                           || !cooling.Contains((id, item.Model!)))
            .ToArray();
        if (kept.Length > 0) return kept;

        var names = string.Join(", ", chain.Select(item => item.Model ?? item.ModelId ?? "unknown"));
        return
        [
            new ChatResolution
            {
                IsAvailable = false,
                UnavailableCategory = PoolExhaustedCategory,
                Error = $"Every model candidate is cooling down after repeated transient failures ({names}). Retry later or repair the route.",
                Model = chain[0].Model,
                ModelId = chain[0].ModelId,
                Protocol = chain[0].Protocol,
                ProviderInstanceId = chain[0].ProviderInstanceId,
                ProviderVersionId = chain[0].ProviderVersionId,
                RouteId = chain[0].RouteId,
                RouteVersionId = chain[0].RouteVersionId,
                StrategySource = chain[0].StrategySource,
                CandidatePosition = chain[0].CandidatePosition
            }
        ];
    }
}
