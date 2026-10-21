namespace TinadecCore.Abstractions.Ports;

/// <summary>
/// The five interface locales the desktop ships. Locale is frozen at admission so
/// a resumed run keeps the language it started in, and resource overlays always
/// have a deterministic fallback instead of leaking a raw key.
/// </summary>
public static class RunLocaleResolver
{
    public const string DefaultLocale = "zh-CN";

    public static readonly IReadOnlyList<string> SupportedLocales = ["zh-CN", "zh-TW", "en", "ja", "ru"];

    public static string Normalize(string? locale)
    {
        if (string.IsNullOrWhiteSpace(locale)) return DefaultLocale;
        var trimmed = locale.Trim();
        if (SupportedLocales.Contains(trimmed, StringComparer.OrdinalIgnoreCase))
            return SupportedLocales.First(item => string.Equals(item, trimmed, StringComparison.OrdinalIgnoreCase));
        if (trimmed.StartsWith("zh", StringComparison.OrdinalIgnoreCase))
            return trimmed.Contains("TW", StringComparison.OrdinalIgnoreCase) || trimmed.Contains("HK", StringComparison.OrdinalIgnoreCase)
                ? "zh-TW"
                : "zh-CN";
        var language = trimmed.Split('-')[0];
        return SupportedLocales.FirstOrDefault(item => string.Equals(item, language, StringComparison.OrdinalIgnoreCase))
            ?? DefaultLocale;
    }

    /// <summary>Overlay lookup chain: exact locale, then zh-TW→zh-CN, then null (base value).</summary>
    public static IReadOnlyList<string> FallbackChain(string? locale)
    {
        var normalized = Normalize(locale);
        return normalized == "zh-TW" ? ["zh-TW", "zh-CN"] : [normalized];
    }

    public static string LanguageName(string locale) => Normalize(locale) switch
    {
        "zh-TW" => "Traditional Chinese",
        "en" => "English",
        "ja" => "Japanese",
        "ru" => "Russian",
        _ => "Simplified Chinese",
    };
}
