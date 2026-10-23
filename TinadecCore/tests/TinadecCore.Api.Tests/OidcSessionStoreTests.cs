using System.Text.Json;
using TinadecCore.AspNetCore.Auth;
using TinadecCore.Persistence;

namespace TinadecCore.Api.Tests;

/// <summary>
/// The symptom behind these tests: every Desktop launch spawns a new Core, so a session that
/// only lived in a dictionary forced the user through the browser again on every start.
/// </summary>
public sealed class OidcSessionStoreTests
{
    private sealed class MemorySecretStore : ISecretStore
    {
        public Dictionary<string, string> Values { get; } = new(StringComparer.Ordinal);

        public Task<string> PutAsync(string secretReference, string value, CancellationToken cancellationToken = default)
        {
            Values[secretReference] = value;
            return Task.FromResult(secretReference);
        }

        public Task<bool> ExistsAsync(string secretReference, CancellationToken cancellationToken = default) =>
            Task.FromResult(Values.ContainsKey(secretReference));

        public Task<string?> GetAsync(string secretReference, CancellationToken cancellationToken = default) =>
            Task.FromResult(Values.TryGetValue(secretReference, out var value) ? value : null);

        public Task DeleteAsync(string secretReference, CancellationToken cancellationToken = default)
        {
            Values.Remove(secretReference);
            return Task.CompletedTask;
        }
    }

    private static readonly OidcIdentity Identity = new("sub-1", "Ada", "https://avatar", "ada@example.com");

    private static OidcTokenSet Tokens(string accessToken = "op-token", string? refreshToken = "refresh-token") =>
        new(accessToken, refreshToken, DateTimeOffset.UtcNow.AddHours(1));

    [Fact]
    public async Task A_session_survives_a_new_store_instance()
    {
        var secrets = new MemorySecretStore();
        var token = await new OidcSessionStore(secrets).CreateSessionAsync(Identity, Tokens());

        var afterRestart = new OidcSessionStore(secrets);
        await afterRestart.EnsureLoadedAsync();

        var session = afterRestart.GetSession(token);
        Assert.NotNull(session);
        Assert.Equal("Ada", session!.Identity.Nickname);
        Assert.Equal("ada@example.com", session.Identity.Email);
        Assert.Equal("op-token", session.AccessToken);
    }

    [Fact]
    public async Task Refresh_tokens_survive_a_restart()
    {
        var secrets = new MemorySecretStore();
        var token = await new OidcSessionStore(secrets).CreateSessionAsync(Identity, Tokens(refreshToken: "refresh-1"));

        var afterRestart = new OidcSessionStore(secrets);
        await afterRestart.EnsureLoadedAsync();

        var session = afterRestart.GetSession(token);
        Assert.NotNull(session);
        Assert.Equal("refresh-1", session!.RefreshToken);
        Assert.True(session.AccessTokenExpiresAt > DateTimeOffset.UtcNow.AddMinutes(30));
    }

    [Fact]
    public async Task A_session_written_before_refresh_tokens_existed_still_loads()
    {
        var secrets = new MemorySecretStore();
        // The 0.x shape: no RefreshToken, no AccessTokenExpiresAt. A stored login must keep working
        // (it simply cannot renew itself until the user signs in once more).
        secrets.Values["oauth.sessions"] = JsonSerializer.Serialize(new[]
        {
            new
            {
                Token = "legacy",
                Subject = "sub-1",
                Nickname = "Ada",
                AvatarUrl = (string?)null,
                Email = (string?)null,
                AccessToken = "op-token",
                ExpiresAt = DateTimeOffset.UtcNow.AddDays(1),
            },
        });

        var store = new OidcSessionStore(secrets);
        await store.EnsureLoadedAsync();

        var session = store.GetSession("legacy");
        Assert.NotNull(session);
        Assert.Equal("op-token", session!.AccessToken);
        Assert.Null(session.RefreshToken);
    }

    [Fact]
    public async Task Revoking_a_session_removes_it_from_disk()
    {
        var secrets = new MemorySecretStore();
        var store = new OidcSessionStore(secrets);
        var token = await store.CreateSessionAsync(Identity, Tokens());

        Assert.True(await store.RevokeAsync(token));

        var afterRestart = new OidcSessionStore(secrets);
        await afterRestart.EnsureLoadedAsync();
        Assert.Null(afterRestart.GetIdentity(token));
    }

    [Fact]
    public async Task A_profile_write_is_persisted_with_the_session()
    {
        var secrets = new MemorySecretStore();
        var store = new OidcSessionStore(secrets);
        var token = await store.CreateSessionAsync(Identity, Tokens());

        await store.UpdateIdentityAsync(token, Identity with { Nickname = "Ada Lovelace" });

        var afterRestart = new OidcSessionStore(secrets);
        await afterRestart.EnsureLoadedAsync();
        Assert.Equal("Ada Lovelace", afterRestart.GetIdentity(token)?.Nickname);
    }

    [Fact]
    public async Task Expired_rows_are_dropped_on_load()
    {
        var secrets = new MemorySecretStore();
        secrets.Values["oauth.sessions"] = JsonSerializer.Serialize(new[]
        {
            new
            {
                Token = "stale",
                Subject = "sub-1",
                Nickname = "Ada",
                AvatarUrl = (string?)null,
                Email = (string?)null,
                AccessToken = "op-token",
                ExpiresAt = DateTimeOffset.UtcNow.AddMinutes(-1),
            },
        });

        var store = new OidcSessionStore(secrets);
        await store.EnsureLoadedAsync();

        Assert.Null(store.GetIdentity("stale"));
    }

    [Fact]
    public async Task An_unreadable_store_starts_empty_instead_of_failing_sign_in()
    {
        var secrets = new MemorySecretStore();
        secrets.Values["oauth.sessions"] = "{ not json";

        var store = new OidcSessionStore(secrets);
        await store.EnsureLoadedAsync();

        var token = await store.CreateSessionAsync(Identity, Tokens());
        Assert.Equal("Ada", store.GetIdentity(token)?.Nickname);
    }

    [Fact]
    public async Task A_host_without_a_secret_store_still_creates_sessions()
    {
        var store = new OidcSessionStore();

        var token = await store.CreateSessionAsync(Identity, Tokens());

        Assert.Equal("Ada", store.GetIdentity(token)?.Nickname);
        await store.EnsureLoadedAsync();
        Assert.Equal("Ada", store.GetIdentity(token)?.Nickname);
    }

    [Fact]
    public async Task Pending_logins_do_not_survive_a_restart()
    {
        var secrets = new MemorySecretStore();
        var store = new OidcSessionStore(secrets);
        var (state, nonce) = store.BeginLogin();

        var afterRestart = new OidcSessionStore(secrets);
        await afterRestart.EnsureLoadedAsync();

        // A half-finished browser dance is not resumable; only completed sessions are.
        Assert.Null(afterRestart.ConsumeNonce(state));
        Assert.Equal(nonce, store.ConsumeNonce(state));
    }
}
