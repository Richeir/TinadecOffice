using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace TinadecCore.AspNetCore.Auth;

public static class AuthServiceExtensions
{
    public static IServiceCollection AddTinadecOidc(this IServiceCollection services, IConfiguration configuration)
    {
        services.AddOptions<TinadecOidcOptions>().Bind(configuration.GetSection(TinadecOidcOptions.SectionName));
        services.AddSingleton<OidcSessionStore>();
        services.AddHttpClient<OidcClient>();
        return services;
    }
}