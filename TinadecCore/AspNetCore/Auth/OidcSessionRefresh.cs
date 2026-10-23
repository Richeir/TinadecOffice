using System.Collections.Concurrent;

namespace TinadecCore.AspNetCore.Auth;

/// <summary>
/// Keeps a restored session's access token usable.
///
/// The identity session is local, but anything that talks to Logto – writing the user's profile
/// – needs an OP token that lives about an hour. This is the one place that decides whether to
/// trade the refresh token for a new one, and it draws the line the whole login UX depends on:
/// only an explicit rejection from Logto (`invalid_grant`) signs the user out; a network failure
/// or a 5xx keeps the session and tries again next launch.
/// </summary>
public static class OidcSessionRefresh
{
    /// <summary>Refresh slightly early so a token cannot expire between the check and the call.</summary>
    private static readonly TimeSpan EarlyRefresh = TimeSpan.FromMinutes(1);

    /// <summary>
    /// One gate per session. Two windows starting together both call /auth/me; without this they
    /// would present the same refresh token twice, Logto's rotation would reject the second as
    /// reuse, and the user would be signed out by their own app opening.
    /// </summary>
    private static readonly ConcurrentDictionary<string, SemaphoreSlim> RefreshGates = new(StringComparer.Ordinal);

    public static async Task<OidcActiveSession?> EnsureFreshAsync(
        OidcSessionStore store,
        OidcClient client,
        string sessionToken,
        CancellationToken ct)
    {
        await store.EnsureLoadedAsync().ConfigureAwait(false);
        var session = store.GetSession(sessionToken);
        if (session is null) return null;
        if (!NeedsRefresh(session) || string.IsNullOrWhiteSpace(session.RefreshToken)) return session;

        var gate = RefreshGates.GetOrAdd(sessionToken, _ => new SemaphoreSlim(1, 1));
        await gate.WaitAsync(ct).ConfigureAwait(false);
        try
        {
            // Whoever held the gate before us may already have rotated the tokens.
            session = store.GetSession(sessionToken);
            if (session is null) return null;
            if (!NeedsRefresh(session) || string.IsNullOrWhiteSpace(session.RefreshToken)) return session;

            OidcTokenSet? refreshed;
            try
            {
                refreshed = await client.RefreshAsync(session.RefreshToken, ct).ConfigureAwait(false);
            }
            catch
            {
                // Logto unreachable or answered 5xx. The identity is still valid locally, so serve
                // it and leave the stored tokens alone; a real rejection is the only sign-out.
                return session;
            }

            if (refreshed is null)
            {
                // invalid_grant: the refresh chain is broken (reuse of a rotated token, revoke, or
                // expiry). This is the only outcome that drops the session.
                await store.RevokeAsync(sessionToken).ConfigureAwait(false);
                return null;
            }

            await store.UpdateTokensAsync(sessionToken, refreshed).ConfigureAwait(false);
            return session with
            {
                AccessToken = refreshed.AccessToken,
                RefreshToken = refreshed.RefreshToken ?? session.RefreshToken,
                AccessTokenExpiresAt = refreshed.ExpiresAt,
            };
        }
        finally
        {
            gate.Release();
        }
    }

    private static bool NeedsRefresh(OidcActiveSession session) =>
        session.AccessTokenExpiresAt <= DateTimeOffset.UtcNow + EarlyRefresh;
}
