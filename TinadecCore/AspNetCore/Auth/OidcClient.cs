using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.Options;

namespace TinadecCore.AspNetCore.Auth;

/// <summary>
/// Talks to Logto's OIDC endpoints: discovery, authorization-url construction,
/// authorization-code exchange, RS256 id_token validation against JWKS, and a
/// userinfo fetch for the profile claims (nickname / picture / email) the
/// Desktop surfaces. Kept hand-rolled so the login surface has no dependency on
/// a JWT library beyond what the shared framework provides.
/// </summary>
public sealed class OidcClient
{
    private sealed record Discovery(string AuthorizationEndpoint, string TokenEndpoint, string UserinfoEndpoint, string JwksUri);

    private readonly TinadecOidcOptions _options;
    private readonly HttpClient _http;
    private Discovery? _discovery;

    public OidcClient(IOptions<TinadecOidcOptions> options, HttpClient http)
    {
        _options = options.Value;
        _http = http;
    }

    public async Task<string> BuildAuthorizationUrlAsync(string state, string nonce, CancellationToken ct)
    {
        var d = await GetDiscoveryAsync(ct).ConfigureAwait(false);
        var query = string.Join('&',
            "response_type=code",
            $"client_id={Uri.EscapeDataString(_options.ClientId)}",
            $"redirect_uri={Uri.EscapeDataString(_options.RedirectUri)}",
            "scope=openid%20profile%20email",
            $"state={Uri.EscapeDataString(state)}",
            $"nonce={Uri.EscapeDataString(nonce)}");
        return $"{d.AuthorizationEndpoint}?{query}";
    }

    public async Task<(OidcIdentity Identity, string AccessToken)?> ExchangeAsync(string code, string expectedNonce, CancellationToken ct)
    {
        var d = await GetDiscoveryAsync(ct).ConfigureAwait(false);

        using var request = new HttpRequestMessage(HttpMethod.Post, d.TokenEndpoint);
        request.Content = new FormUrlEncodedContent(new Dictionary<string, string>
        {
            ["grant_type"] = "authorization_code",
            ["code"] = code,
            ["redirect_uri"] = _options.RedirectUri,
            ["client_id"] = _options.ClientId,
        });
        // Logto's Traditional Web apps authenticate the confidential client with
        // client_secret_basic by default (RFC 6749 §2.3.1): the id/secret go in the
        // Authorization header, not the POST body.
        request.Headers.Authorization = new AuthenticationHeaderValue(
            "Basic",
            Convert.ToBase64String(Encoding.UTF8.GetBytes($"{_options.ClientId}:{_options.ClientSecret}")));

        using var response = await _http.SendAsync(request, ct).ConfigureAwait(false);
        if (!response.IsSuccessStatusCode)
        {
            var errorBody = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
            throw new InvalidOperationException($"Logto token endpoint returned {(int)response.StatusCode}: {errorBody}");
        }
        using var tokenJson = await ParseAsync(response, ct).ConfigureAwait(false);

        var idToken = Str(tokenJson.RootElement, "id_token");
        var accessToken = Str(tokenJson.RootElement, "access_token");
        if (string.IsNullOrWhiteSpace(idToken)) return null;

        var claims = await ValidateIdTokenAsync(idToken, expectedNonce, d, ct).ConfigureAwait(false);
        if (claims is null) return null;
        if (!claims.TryGetValue("sub", out var subject) || string.IsNullOrEmpty(subject))
            return null;

        // Profile claims are more reliably present on the userinfo endpoint than in
        // the id_token; fall back to id_token claims for anything userinfo omitted.
        var profile = await FetchUserinfoAsync(accessToken, d, ct).ConfigureAwait(false);
        var name = profile.Name ?? Claim(claims, "name") ?? Claim(claims, "preferred_username") ?? Claim(claims, "username");
        var picture = profile.AvatarUrl ?? Claim(claims, "picture");
        var email = profile.Email ?? Claim(claims, "email");

        var nickname = string.IsNullOrWhiteSpace(name) ? subject : name;
        return (new OidcIdentity(subject, nickname, picture, email), accessToken ?? "");
    }

    /// <summary>
    /// Writes the signed-in user's own profile through Logto's Account API. Uses
    /// the user's OP token (empty-resource access token) rather than a management
    /// token, so the write carries exactly the user's own authority.
    /// </summary>
    public async Task<OidcIdentity> UpdateProfileAsync(string accessToken, string subject, string nickname, string? avatarUrl, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(accessToken))
            throw new InvalidOperationException("The login session carries no Logto access token.");

        var payload = new Dictionary<string, object?> { ["name"] = nickname };
        // Logto treats an explicit null as "clear the field"; only send avatar when
        // the caller asked to change it, so a nickname edit cannot wipe the picture.
        if (avatarUrl is not null) payload["avatar"] = avatarUrl;

        using var request = new HttpRequestMessage(HttpMethod.Patch, _options.AccountApiUrl);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
        request.Content = new StringContent(JsonSerializer.Serialize(payload), Encoding.UTF8, "application/json");

        using var response = await _http.SendAsync(request, ct).ConfigureAwait(false);
        if (!response.IsSuccessStatusCode)
        {
            var errorBody = await response.Content.ReadAsStringAsync(ct).ConfigureAwait(false);
            throw new InvalidOperationException($"Logto Account API returned {(int)response.StatusCode}: {errorBody}");
        }

        // Read back through userinfo so the stored identity is what Logto now holds,
        // not merely what we asked it to hold.
        var d = await GetDiscoveryAsync(ct).ConfigureAwait(false);
        var profile = await FetchUserinfoAsync(accessToken, d, ct).ConfigureAwait(false);
        return new OidcIdentity(
            subject,
            string.IsNullOrWhiteSpace(profile.Name) ? nickname : profile.Name,
            avatarUrl is null ? profile.AvatarUrl : avatarUrl,
            profile.Email);
    }

    private sealed record Userinfo(string? Name, string? AvatarUrl, string? Email);

    private async Task<Userinfo> FetchUserinfoAsync(string? accessToken, Discovery d, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(accessToken)) return new Userinfo(null, null, null);
        using var request = new HttpRequestMessage(HttpMethod.Get, d.UserinfoEndpoint);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", accessToken);
        using var response = await _http.SendAsync(request, ct).ConfigureAwait(false);
        if (!response.IsSuccessStatusCode) return new Userinfo(null, null, null);
        using var ui = await ParseAsync(response, ct).ConfigureAwait(false);
        return new Userinfo(
            Str(ui.RootElement, "name") ?? Str(ui.RootElement, "preferred_username") ?? Str(ui.RootElement, "username"),
            Str(ui.RootElement, "picture") ?? Str(ui.RootElement, "avatar"),
            Str(ui.RootElement, "email"));
    }

    private async Task<Discovery> GetDiscoveryAsync(CancellationToken ct)
    {
        if (_discovery is not null) return _discovery;
        var url = _options.Authority.TrimEnd('/') + "/.well-known/openid-configuration";
        using var doc = await GetJsonDocAsync(url, ct).ConfigureAwait(false);
        _discovery = new Discovery(
            Str(doc.RootElement, "authorization_endpoint") ?? throw new InvalidOperationException("OIDC discovery is missing authorization_endpoint."),
            Str(doc.RootElement, "token_endpoint") ?? throw new InvalidOperationException("OIDC discovery is missing token_endpoint."),
            Str(doc.RootElement, "userinfo_endpoint") ?? throw new InvalidOperationException("OIDC discovery is missing userinfo_endpoint."),
            Str(doc.RootElement, "jwks_uri") ?? throw new InvalidOperationException("OIDC discovery is missing jwks_uri."));
        return _discovery;
    }

    private async Task<Dictionary<string, string>?> ValidateIdTokenAsync(string jwt, string expectedNonce, Discovery d, CancellationToken ct)
    {
        var parts = jwt.Split('.');
        if (parts.Length != 3) return null;

        var headerText = Base64UrlDecodeString(parts[0]);
        var payloadText = Base64UrlDecodeString(parts[1]);
        byte[] signature;
        try { signature = Base64UrlDecode(parts[2]); } catch { return null; }

        using var header = JsonDocument.Parse(headerText);
        // Logto signs with ES384 (P-384); RS* stays supported for other issuers.
        var alg = Str(header.RootElement, "alg");
        if (alg is not ("RS256" or "RS384" or "RS512" or "ES256" or "ES384" or "ES512")) return null;
        var kid = Str(header.RootElement, "kid");
        if (string.IsNullOrWhiteSpace(kid)) return null;

        using var payload = JsonDocument.Parse(payloadText);
        var root = payload.RootElement;

        var iss = Str(root, "iss");
        if (iss is null || !string.Equals(iss.TrimEnd('/'), _options.Authority.TrimEnd('/'), StringComparison.OrdinalIgnoreCase))
            return null;
        if (!AudienceMatches(root, _options.ClientId)) return null;

        var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        var exp = Epoch(root, "exp");
        if (exp is null || exp <= now) return null;
        var nbf = Epoch(root, "nbf");
        if (nbf is not null && nbf > now + 60) return null;

        if (Str(root, "nonce") != expectedNonce) return null;

        if (!await VerifySignatureAsync($"{parts[0]}.{parts[1]}", signature, kid, alg, d.JwksUri, ct).ConfigureAwait(false))
            return null;

        // Copy the string claims out before `payload` is disposed: a JsonElement keeps
        // pointing at its JsonDocument's buffer and throws once that document is gone.
        var claims = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var property in root.EnumerateObject())
        {
            if (property.Value.ValueKind == JsonValueKind.String && property.Value.GetString() is { } value)
                claims[property.Name] = value;
        }
        return claims;
    }

    private static bool AudienceMatches(JsonElement payload, string clientId)
    {
        if (!payload.TryGetProperty("aud", out var aud)) return false;
        if (aud.ValueKind == JsonValueKind.String) return aud.GetString() == clientId;
        if (aud.ValueKind == JsonValueKind.Array)
        {
            foreach (var item in aud.EnumerateArray())
                if (item.ValueKind == JsonValueKind.String && item.GetString() == clientId) return true;
        }
        return false;
    }

    private async Task<bool> VerifySignatureAsync(string signedData, byte[] signature, string kid, string alg, string jwksUri, CancellationToken ct)
    {
        using var doc = await GetJsonDocAsync(jwksUri, ct).ConfigureAwait(false);
        if (!doc.RootElement.TryGetProperty("keys", out var keys)) return false;
        var data = Encoding.ASCII.GetBytes(signedData);
        foreach (var key in keys.EnumerateArray())
        {
            if (Str(key, "kid") != kid) continue;
            var kty = Str(key, "kty");

            if (kty == "EC" && alg.StartsWith("ES", StringComparison.Ordinal))
            {
                var crv = Str(key, "crv");
                var curve = crv switch
                {
                    "P-256" => ECCurve.NamedCurves.nistP256,
                    "P-384" => ECCurve.NamedCurves.nistP384,
                    "P-521" => ECCurve.NamedCurves.nistP521,
                    _ => (ECCurve?)null,
                };
                if (curve is null) break;
                var hash = crv switch { "P-256" => HashAlgorithmName.SHA256, "P-384" => HashAlgorithmName.SHA384, _ => HashAlgorithmName.SHA512 };
                var x = Str(key, "x");
                var y = Str(key, "y");
                if (string.IsNullOrWhiteSpace(x) || string.IsNullOrWhiteSpace(y)) continue;
                using var ec = ECDsa.Create();
                ec.ImportParameters(new ECParameters
                {
                    Curve = curve.Value,
                    Q = new ECPoint { X = Base64UrlDecode(x), Y = Base64UrlDecode(y) },
                });
                // JWT ES* signatures are raw R||S, which is ECDsa's default IEEE P1363 format.
                return ec.VerifyData(data, signature, hash);
            }

            if (kty == "RSA" && alg.StartsWith("RS", StringComparison.Ordinal))
            {
                var n = Str(key, "n");
                var e = Str(key, "e");
                if (string.IsNullOrWhiteSpace(n) || string.IsNullOrWhiteSpace(e)) continue;
                var hash = alg switch { "RS384" => HashAlgorithmName.SHA384, "RS512" => HashAlgorithmName.SHA512, _ => HashAlgorithmName.SHA256 };
                using var rsa = RSA.Create();
                rsa.ImportParameters(new RSAParameters
                {
                    Modulus = Base64UrlDecode(n),
                    Exponent = Base64UrlDecode(e),
                });
                return rsa.VerifyData(data, signature, hash, RSASignaturePadding.Pkcs1);
            }

            break;
        }
        return false;
    }

    private async Task<JsonDocument> GetJsonDocAsync(string url, CancellationToken ct)
    {
        using var response = await _http.GetAsync(url, ct).ConfigureAwait(false);
        response.EnsureSuccessStatusCode();
        return await ParseAsync(response, ct).ConfigureAwait(false);
    }

    private static async Task<JsonDocument> ParseAsync(HttpResponseMessage response, CancellationToken ct)
    {
        await using var stream = await response.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
        return await JsonDocument.ParseAsync(stream, cancellationToken: ct).ConfigureAwait(false);
    }

    private static string? Str(JsonElement element, string name) =>
        element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;

    private static string? Claim(Dictionary<string, string> claims, string name) =>
        claims.TryGetValue(name, out var value) && !string.IsNullOrWhiteSpace(value) ? value : null;

    private static long? Epoch(JsonElement element, string name)
    {
        if (!element.TryGetProperty(name, out var value)) return null;
        if (value.ValueKind == JsonValueKind.Number && value.TryGetInt64(out var number)) return number;
        if (value.ValueKind == JsonValueKind.String && long.TryParse(value.GetString(), out var parsed)) return parsed;
        return null;
    }

    private static string Base64UrlDecodeString(string value) => Encoding.UTF8.GetString(Base64UrlDecode(value));

    private static byte[] Base64UrlDecode(string value)
    {
        var buffer = value.Replace('-', '+').Replace('_', '/');
        buffer = (buffer.Length % 4) switch
        {
            2 => buffer + "==",
            3 => buffer + "=",
            _ => buffer,
        };
        return Convert.FromBase64String(buffer);
    }
}