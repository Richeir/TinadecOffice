using System.Collections.Concurrent;
using System.Security.Cryptography;

namespace TinadecCore.AspNetCore.Auth;

/// <summary>The identity Core hands back to the Desktop after a Logto login.</summary>
public sealed record OidcIdentity(string Subject, string Nickname, string? AvatarUrl, string? Email);

/// <summary>
/// In-memory housekeeping for the OIDC login flow: pending logins (state → nonce)
/// and active sessions (opaque token → identity). Sessions are process-scoped by
/// design — a Core restart clears them, matching the Desktop's per-launch trust
/// model. A future replication step can move these onto <c>ITenantContext</c>.
/// </summary>
public sealed class OidcSessionStore
{
    private static readonly TimeSpan SessionLifetime = TimeSpan.FromHours(12);
    private static readonly TimeSpan LoginLifetime = TimeSpan.FromMinutes(10);

    private sealed record PendingLogin(string Nonce, DateTimeOffset ExpiresAt);
    private sealed record CompletedLogin(string SessionToken, DateTimeOffset ExpiresAt);
    /// <summary>
    /// <paramref name="AccessToken"/> is Logto's opaque OP token, kept so the host can
    /// write the user's own profile through the Account API (<c>PATCH /api/my-account</c>).
    /// It never leaves the main process.
    /// </summary>
    private sealed record ActiveSession(OidcIdentity Identity, string AccessToken, DateTimeOffset ExpiresAt);

    private readonly ConcurrentDictionary<string, PendingLogin> _pending = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, CompletedLogin> _completed = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, ActiveSession> _sessions = new(StringComparer.Ordinal);

    public (string State, string Nonce) BeginLogin()
    {
        var state = RandomToken();
        var nonce = RandomToken();
        _pending[state] = new PendingLogin(nonce, DateTimeOffset.UtcNow + LoginLifetime);
        return (state, nonce);
    }

    public string? ConsumeNonce(string state)
    {
        if (_pending.TryRemove(state, out var pending) && pending.ExpiresAt > DateTimeOffset.UtcNow)
            return pending.Nonce;
        return null;
    }

    public string CreateSession(OidcIdentity identity, string accessToken)
    {
        var token = RandomToken();
        _sessions[token] = new ActiveSession(identity, accessToken ?? "", DateTimeOffset.UtcNow + SessionLifetime);
        return token;
    }

    /// <summary>
    /// Records a session token as the result of a login, keyed by the OIDC
    /// <c>state</c> an in-browser flow started with. The system browser cannot
    /// hand the token to Electron directly, so the desktop polls it back.
    /// </summary>
    public void CompleteLogin(string state, string sessionToken)
    {
        if (string.IsNullOrWhiteSpace(state) || string.IsNullOrWhiteSpace(sessionToken)) return;
        _completed[state] = new CompletedLogin(sessionToken, DateTimeOffset.UtcNow + LoginLifetime);
    }

    /// <summary>One-time read: the first successful poll removes the entry to prevent replay.</summary>
    public string? CheckLogin(string state)
    {
        if (string.IsNullOrWhiteSpace(state)) return null;
        if (!_completed.TryRemove(state, out var completed)) return null;
        if (completed.ExpiresAt <= DateTimeOffset.UtcNow) return null;
        return completed.SessionToken;
    }

    public OidcIdentity? GetIdentity(string token) => GetSession(token)?.Identity;

    /// <summary>The session's identity plus the Logto token needed to write it back.</summary>
    public (OidcIdentity Identity, string AccessToken)? GetSession(string token)
    {
        if (string.IsNullOrWhiteSpace(token)) return null;
        if (!_sessions.TryGetValue(token, out var session)) return null;
        if (session.ExpiresAt <= DateTimeOffset.UtcNow) { _sessions.TryRemove(token, out _); return null; }
        return (session.Identity, session.AccessToken);
    }

    /// <summary>Replaces the stored identity after a profile write, keeping the session alive.</summary>
    public void UpdateIdentity(string token, OidcIdentity identity)
    {
        if (string.IsNullOrWhiteSpace(token)) return;
        if (_sessions.TryGetValue(token, out var session))
            _sessions[token] = session with { Identity = identity };
    }

    public bool Revoke(string token) => !string.IsNullOrWhiteSpace(token) && _sessions.TryRemove(token, out _);

    private static string RandomToken() =>
        Convert.ToBase64String(RandomNumberGenerator.GetBytes(32))
            .TrimEnd('=').Replace('+', '-').Replace('/', '_');
}