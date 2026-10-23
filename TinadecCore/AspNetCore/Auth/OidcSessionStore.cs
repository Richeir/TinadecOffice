using System.Security.Cryptography;
using System.Text.Json;
using TinadecCore.Persistence;

namespace TinadecCore.AspNetCore.Auth;

/// <summary>The identity Core hands back to the Desktop after a Logto login.</summary>
public sealed record OidcIdentity(string Subject, string Nickname, string? AvatarUrl, string? Email);

/// <summary>On-disk shape. Token, identity and OP token travel together inside one encrypted blob.</summary>
internal sealed record OidcStoredSession(
    string Token,
    string Subject,
    string Nickname,
    string? AvatarUrl,
    string? Email,
    string AccessToken,
    DateTimeOffset ExpiresAt);

/// <summary>
/// Housekeeping for the OIDC login flow: pending logins (state → nonce) and active
/// sessions (opaque token → identity).
///
/// Sessions outlive the process. A Desktop launch spawns a fresh Core, so a process-scoped
/// session meant every launch asked the user to sign in again; the records are now written
/// through <see cref="ISecretStore"/> (DPAPI on Windows, an AES-GCM file on POSIX) and read
/// back on the first request. Pending logins stay in memory: a half-finished browser dance
/// is over in minutes and must not be resumable after a restart.
/// </summary>
public sealed class OidcSessionStore
{
    /// <summary>Only one blob: a desktop has one signed-in user, so enumeration beats a list API.</summary>
    private const string SecretReference = "oauth.sessions";

    /// <summary>
    /// Identity lifetime. There is no refresh token yet (the authorization request asks for
    /// `openid profile email`, not `offline_access`), so this is the longest a session can be
    /// honoured without sending the user back to the browser; 12 hours made that a daily chore.
    /// </summary>
    private static readonly TimeSpan SessionLifetime = TimeSpan.FromDays(30);
    private static readonly TimeSpan LoginLifetime = TimeSpan.FromMinutes(10);

    private sealed record PendingLogin(string Nonce, DateTimeOffset ExpiresAt);
    private sealed record CompletedLogin(string SessionToken, DateTimeOffset ExpiresAt);
    /// <summary>
    /// <paramref name="AccessToken"/> is Logto's opaque OP token, kept so the host can
    /// write the user's own profile through the Account API (<c>PATCH /api/my-account</c>).
    /// It never leaves the main process, and it is persisted only inside the encrypted store.
    /// </summary>
    private sealed record ActiveSession(OidcIdentity Identity, string AccessToken, DateTimeOffset ExpiresAt);

    private readonly ISecretStore? _secrets;
    private readonly object _sync = new();
    private readonly SemaphoreSlim _persistGate = new(1, 1);
    private readonly Dictionary<string, PendingLogin> _pending = new(StringComparer.Ordinal);
    private readonly Dictionary<string, CompletedLogin> _completed = new(StringComparer.Ordinal);
    private readonly Dictionary<string, ActiveSession> _sessions = new(StringComparer.Ordinal);
    private Task? _loadTask;

    /// <param name="secrets">
    /// Null keeps the store memory-only, which is what tests and hosts without a writable
    /// secret store get: the flow still works, it just does not survive a restart.
    /// </param>
    public OidcSessionStore(ISecretStore? secrets = null) => _secrets = secrets;

    /// <summary>
    /// Reads persisted sessions once. Every endpoint awaits this before touching the maps;
    /// after the first call it is a completed task, so the cost is a single dictionary check.
    /// </summary>
    public Task EnsureLoadedAsync()
    {
        lock (_sync) _loadTask ??= LoadAsync();
        return _loadTask;
    }

    private async Task LoadAsync()
    {
        if (_secrets is null) return;
        string? json;
        try
        {
            json = await _secrets.GetAsync(SecretReference).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            // An unreadable store must not break sign-in; it just starts this process empty.
            Console.Error.WriteLine($"[auth] could not read persisted sessions: {ex.Message}");
            return;
        }
        if (string.IsNullOrWhiteSpace(json)) return;

        OidcStoredSession[]? stored;
        try { stored = JsonSerializer.Deserialize<OidcStoredSession[]>(json); }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[auth] persisted sessions are unreadable: {ex.Message}");
            return;
        }
        if (stored is null) return;

        var now = DateTimeOffset.UtcNow;
        lock (_sync)
        {
            foreach (var row in stored)
            {
                if (string.IsNullOrEmpty(row.Token) || row.ExpiresAt <= now) continue;
                _sessions[row.Token] = new ActiveSession(
                    new OidcIdentity(
                        row.Subject ?? string.Empty,
                        row.Nickname ?? string.Empty,
                        row.AvatarUrl,
                        row.Email),
                    row.AccessToken ?? string.Empty,
                    row.ExpiresAt);
            }
        }
    }

    public (string State, string Nonce) BeginLogin()
    {
        var state = RandomToken();
        var nonce = RandomToken();
        lock (_sync) _pending[state] = new PendingLogin(nonce, DateTimeOffset.UtcNow + LoginLifetime);
        return (state, nonce);
    }

    public string? ConsumeNonce(string state)
    {
        lock (_sync)
        {
            if (_pending.Remove(state, out var pending) && pending.ExpiresAt > DateTimeOffset.UtcNow)
                return pending.Nonce;
            return null;
        }
    }

    public async Task<string> CreateSessionAsync(OidcIdentity identity, string accessToken)
    {
        var token = RandomToken();
        lock (_sync) _sessions[token] = new ActiveSession(identity, accessToken ?? string.Empty, DateTimeOffset.UtcNow + SessionLifetime);
        await PersistAsync().ConfigureAwait(false);
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
        lock (_sync) _completed[state] = new CompletedLogin(sessionToken, DateTimeOffset.UtcNow + LoginLifetime);
    }

    /// <summary>One-time read: the first successful poll removes the entry to prevent replay.</summary>
    public string? CheckLogin(string state)
    {
        if (string.IsNullOrWhiteSpace(state)) return null;
        lock (_sync)
        {
            if (!_completed.Remove(state, out var completed)) return null;
            if (completed.ExpiresAt <= DateTimeOffset.UtcNow) return null;
            return completed.SessionToken;
        }
    }

    public OidcIdentity? GetIdentity(string token) => GetSession(token)?.Identity;

    /// <summary>The session's identity plus the Logto token needed to write it back.</summary>
    public (OidcIdentity Identity, string AccessToken)? GetSession(string token)
    {
        if (string.IsNullOrWhiteSpace(token)) return null;
        lock (_sync)
        {
            if (!_sessions.TryGetValue(token, out var session)) return null;
            if (session.ExpiresAt <= DateTimeOffset.UtcNow)
            {
                _sessions.Remove(token);
                return null;
            }
            return (session.Identity, session.AccessToken);
        }
    }

    /// <summary>Replaces the stored identity after a profile write, keeping the session alive.</summary>
    public async Task UpdateIdentityAsync(string token, OidcIdentity identity)
    {
        var changed = false;
        lock (_sync)
        {
            if (_sessions.TryGetValue(token, out var session))
            {
                _sessions[token] = session with { Identity = identity };
                changed = true;
            }
        }
        if (changed) await PersistAsync().ConfigureAwait(false);
    }

    public async Task<bool> RevokeAsync(string token)
    {
        bool removed;
        lock (_sync) removed = !string.IsNullOrWhiteSpace(token) && _sessions.Remove(token);
        if (removed) await PersistAsync().ConfigureAwait(false);
        return removed;
    }

    /// <summary>
    /// Writes the live sessions through the encrypted store. Serialised so two logins cannot
    /// interleave a stale snapshot over a newer one; a failed write is logged and dropped —
    /// the session still works for this process, it just will not survive a restart.
    /// </summary>
    private async Task PersistAsync()
    {
        if (_secrets is null) return;
        await _persistGate.WaitAsync().ConfigureAwait(false);
        try
        {
            OidcStoredSession[] snapshot;
            lock (_sync)
            {
                var now = DateTimeOffset.UtcNow;
                snapshot = _sessions
                    .Where(pair => pair.Value.ExpiresAt > now)
                    .Select(pair => new OidcStoredSession(
                        pair.Key,
                        pair.Value.Identity.Subject,
                        pair.Value.Identity.Nickname,
                        pair.Value.Identity.AvatarUrl,
                        pair.Value.Identity.Email,
                        pair.Value.AccessToken,
                        pair.Value.ExpiresAt))
                    .ToArray();
            }
            await _secrets.PutAsync(SecretReference, JsonSerializer.Serialize(snapshot)).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[auth] could not persist sessions: {ex.Message}");
        }
        finally
        {
            _persistGate.Release();
        }
    }

    private static string RandomToken() =>
        Convert.ToBase64String(RandomNumberGenerator.GetBytes(32))
            .TrimEnd('=').Replace('+', '-').Replace('/', '_');
}
