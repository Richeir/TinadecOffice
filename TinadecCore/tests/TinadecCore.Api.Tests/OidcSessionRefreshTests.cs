using System.Net;
using System.Text;
using Microsoft.Extensions.Options;
using TinadecCore.AspNetCore.Auth;
using TinadecCore.Persistence;

namespace TinadecCore.Api.Tests;

/// <summary>
/// The line this file pins down: only an explicit rejection from Logto signs the user out.
/// A network failure must never do it, and a successful refresh must be written to disk before
/// the old (rotated) refresh token stops being the one we hold.
/// </summary>
public sealed class OidcSessionRefreshTests
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

    private sealed class StubHandler : HttpMessageHandler
    {
        public int TokenCalls { get; private set; }
        public bool ThrowOnToken { get; set; }
        public HttpResponseMessage TokenResponse { get; set; } = Json("""
            {"access_token":"new-at","refresh_token":"new-rt","expires_in":3600,"token_type":"Bearer"}
            """);

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            var url = request.RequestUri!.ToString();
            if (url.EndsWith("/.well-known/openid-configuration", StringComparison.Ordinal))
            {
                return Task.FromResult(Json("""
                    {"authorization_endpoint":"https://issuer.test/oidc/auth",
                     "token_endpoint":"https://issuer.test/oidc/token",
                     "userinfo_endpoint":"https://issuer.test/oidc/me",
                     "jwks_uri":"https://issuer.test/oidc/jwks"}
                    """));
            }
            TokenCalls += 1;
            if (ThrowOnToken) throw new HttpRequestException("issuer unreachable");
            return Task.FromResult(TokenResponse);
        }

        public static HttpResponseMessage Json(string body, HttpStatusCode status = HttpStatusCode.OK) =>
            new(status) { Content = new StringContent(body, Encoding.UTF8, "application/json") };
    }

    private static readonly OidcIdentity Identity = new("sub-1", "Ada", "https://avatar", "ada@example.com");

    private static OidcClient Client(StubHandler handler) => new(
        Options.Create(new TinadecOidcOptions
        {
            Authority = "https://issuer.test/oidc",
            ClientId = "cid",
            ClientSecret = "secret",
            RedirectUri = "http://127.0.0.1:48730/auth/callback",
        }),
        new HttpClient(handler));

    private static OidcTokenSet Tokens(string accessToken, string? refreshToken, TimeSpan lifetime) =>
        new(accessToken, refreshToken, DateTimeOffset.UtcNow + lifetime);

    [Fact]
    public async Task Refreshes_an_expired_access_token_and_persists_the_rotation()
    {
        var secrets = new MemorySecretStore();
        var store = new OidcSessionStore(secrets);
        var token = await store.CreateSessionAsync(Identity, Tokens("old-at", "old-rt", TimeSpan.FromMinutes(-5)));
        var handler = new StubHandler();

        var session = await OidcSessionRefresh.EnsureFreshAsync(store, Client(handler), token, CancellationToken.None);

        Assert.NotNull(session);
        Assert.Equal("new-at", session!.AccessToken);
        Assert.Equal("new-rt", session.RefreshToken);
        Assert.Equal(1, handler.TokenCalls);

        // A rotation that is not on disk is a logout waiting for the next restart.
        var afterRestart = new OidcSessionStore(secrets);
        await afterRestart.EnsureLoadedAsync();
        Assert.Equal("new-at", afterRestart.GetSession(token)!.AccessToken);
        Assert.Equal("new-rt", afterRestart.GetSession(token)!.RefreshToken);
    }

    [Fact]
    public async Task An_invalid_grant_drops_the_session()
    {
        var secrets = new MemorySecretStore();
        var store = new OidcSessionStore(secrets);
        var token = await store.CreateSessionAsync(Identity, Tokens("old-at", "old-rt", TimeSpan.FromMinutes(-5)));
        var handler = new StubHandler
        {
            TokenResponse = StubHandler.Json("""{"error":"invalid_grant"}""", HttpStatusCode.BadRequest),
        };

        var session = await OidcSessionRefresh.EnsureFreshAsync(store, Client(handler), token, CancellationToken.None);

        Assert.Null(session);
        Assert.Null(store.GetSession(token));
    }

    [Fact]
    public async Task A_transient_failure_keeps_the_session()
    {
        var secrets = new MemorySecretStore();
        var store = new OidcSessionStore(secrets);
        var token = await store.CreateSessionAsync(Identity, Tokens("old-at", "old-rt", TimeSpan.FromMinutes(-5)));
        var handler = new StubHandler { ThrowOnToken = true };

        var session = await OidcSessionRefresh.EnsureFreshAsync(store, Client(handler), token, CancellationToken.None);

        Assert.NotNull(session);
        Assert.Equal("old-at", session!.AccessToken);
        Assert.NotNull(store.GetSession(token));
    }

    [Fact]
    public async Task A_live_access_token_is_not_refreshed()
    {
        var secrets = new MemorySecretStore();
        var store = new OidcSessionStore(secrets);
        var token = await store.CreateSessionAsync(Identity, Tokens("old-at", "old-rt", TimeSpan.FromMinutes(30)));
        var handler = new StubHandler();

        var session = await OidcSessionRefresh.EnsureFreshAsync(store, Client(handler), token, CancellationToken.None);

        Assert.Equal("old-at", session!.AccessToken);
        Assert.Equal(0, handler.TokenCalls);
    }

    [Fact]
    public async Task A_session_without_a_refresh_token_is_served_unchanged()
    {
        var secrets = new MemorySecretStore();
        var store = new OidcSessionStore(secrets);
        var token = await store.CreateSessionAsync(Identity, Tokens("old-at", null, TimeSpan.FromMinutes(-5)));
        var handler = new StubHandler();

        var session = await OidcSessionRefresh.EnsureFreshAsync(store, Client(handler), token, CancellationToken.None);

        Assert.Equal("old-at", session!.AccessToken);
        Assert.Equal(0, handler.TokenCalls);
    }

    [Fact]
    public async Task Concurrent_callers_share_one_refresh()
    {
        var secrets = new MemorySecretStore();
        var store = new OidcSessionStore(secrets);
        var token = await store.CreateSessionAsync(Identity, Tokens("old-at", "old-rt", TimeSpan.FromMinutes(-5)));
        var handler = new StubHandler();
        var client = Client(handler);

        var results = await Task.WhenAll(
            OidcSessionRefresh.EnsureFreshAsync(store, client, token, CancellationToken.None),
            OidcSessionRefresh.EnsureFreshAsync(store, client, token, CancellationToken.None));

        // Two rotations of the same refresh token would be reported as reuse and revoke the chain.
        Assert.Equal(1, handler.TokenCalls);
        Assert.All(results, result => Assert.Equal("new-at", result!.AccessToken));
    }

    [Fact]
    public async Task An_unknown_session_stays_unknown()
    {
        var store = new OidcSessionStore(new MemorySecretStore());

        Assert.Null(await OidcSessionRefresh.EnsureFreshAsync(store, Client(new StubHandler()), "nope", CancellationToken.None));
    }
}
