using System.Runtime.CompilerServices;
using System.Text.RegularExpressions;

namespace TinadecCore.Architecture.Tests;

/// <summary>
/// Mode behavior is configuration, not identity: the runtime may only branch on
/// <c>ModeRuntimePolicyRegistry.Has(configuration.RuntimePolicy, feature)</c>.
/// A slug comparison would let a manifest rename itself into different behavior,
/// and a pack-installed mode could shadow another. These tests read the source
/// instead of reflected types because the defect is the literal itself.
/// </summary>
public sealed class ModePolicyArchitectureTests
{
    private static readonly string CoreRoot = LocateCoreRoot();

    private static readonly (string Name, Regex Pattern)[] SlugBranchPatterns =
    [
        ("slug-equality", new Regex(@"[A-Za-z_][A-Za-z0-9_]*\.Slug\s*==\s*""(?<slug>[^""]+)""", RegexOptions.Compiled)),
        ("literal-equality", new Regex(@"""(?<slug>[^""]+)""\s*==\s*[A-Za-z_][A-Za-z0-9_]*\.Slug", RegexOptions.Compiled)),
        ("slug-pattern", new Regex(@"[A-Za-z_][A-Za-z0-9_]*\.Slug\s+is\s+""(?<slug>[^""]+)""", RegexOptions.Compiled)),
        ("slug-equals", new Regex(@"\bSlug\s*\.\s*Equals\(\s*""(?<slug>[^""]+)""", RegexOptions.Compiled)),
        ("switch-case", new Regex(@"\bcase\s+""(?<slug>[^""]+)""\s*:", RegexOptions.Compiled)),
        ("string-equals", new Regex(@"\bstring\.Equals\([^)\r\n]*(?:Slug|ModeKey)[^)\r\n]*""(?<slug>[^""]+)""", RegexOptions.Compiled)),
    ];

    private static readonly HashSet<string> ForbiddenPolicySlugs = new(StringComparer.OrdinalIgnoreCase)
    {
        "artex",
        "correction",
    };

    private static readonly Regex ArtexLiteral =
        new(@"[""']artex[""']", RegexOptions.Compiled | RegexOptions.IgnoreCase);

    [Fact]
    public void ArtexSlugLiteral_DoesNotAppearInCoreSource()
    {
        var hits = new List<string>();
        foreach (var file in SourceFiles(CoreRoot))
        {
            var line = 0;
            foreach (var text in File.ReadLines(file))
            {
                line++;
                // Match the quoted literal only: identifiers such as ScalarText
                // contain the same letter run and are not mode identities.
                if (ArtexLiteral.IsMatch(text))
                    hits.Add($"{Relative(file)}:{line}: {text.Trim()}");
            }
        }

        Assert.True(hits.Count == 0,
            "The 'artex' literal must not exist in Core source; behavior belongs to runtime_policy features.\n"
            + string.Join("\n", hits));
    }

    [Fact]
    public void RuntimeBehavior_DoesNotBranchOnModeSlug()
    {
        var hits = new List<string>();
        foreach (var directory in new[] { "DmaEA", "Tools" })
        {
            foreach (var file in SourceFiles(Path.Combine(CoreRoot, directory)))
            {
                var line = 0;
                foreach (var text in File.ReadLines(file))
                {
                    line++;
                    foreach (var (name, pattern) in SlugBranchPatterns)
                    {
                        foreach (Match match in pattern.Matches(text))
                        {
                            var slug = match.Groups["slug"].Value;
                            if (!ForbiddenPolicySlugs.Contains(slug)) continue;
                            hits.Add($"{Relative(file)}:{line}: [{name}] {text.Trim()}");
                        }
                    }
                }
            }
        }

        Assert.True(hits.Count == 0,
            "Mode behavior must be selected by runtime_policy features, never by slug.\n"
            + string.Join("\n", hits));
    }

    [Fact]
    public void Scanner_DetectsKnownSlugBranches()
    {
        const string snippet = """
            if (mode.Slug == "artex") start();
            if ("correction" == mode.Slug) trace();
            switch (mode.Slug) { case "artex": break; }
            if (mode.Slug.Equals("artex")) resume();
            if (string.Equals(mode.Slug, "correction", StringComparison.Ordinal)) stop();
            if (mode.Slug == "team") allow();
            """;

        var found = FindSlugBranches(snippet).ToList();

        Assert.Contains(found, hit => hit.Line == 1 && hit.Slug == "artex");
        Assert.Contains(found, hit => hit.Line == 2 && hit.Slug == "correction");
        Assert.Contains(found, hit => hit.Line == 3 && hit.Slug == "artex");
        Assert.Contains(found, hit => hit.Line == 4 && hit.Slug == "artex");
        Assert.Contains(found, hit => hit.Line == 5 && hit.Slug == "correction");
        Assert.DoesNotContain(found, hit => hit.Line == 6);
    }

    private static IEnumerable<(int Line, string Slug)> FindSlugBranches(string source)
    {
        var line = 0;
        foreach (var text in source.Split('\n'))
        {
            line++;
            foreach (var (_, pattern) in SlugBranchPatterns)
            {
                foreach (Match match in pattern.Matches(text))
                {
                    var slug = match.Groups["slug"].Value;
                    if (ForbiddenPolicySlugs.Contains(slug)) yield return (line, slug);
                }
            }
        }
    }

    private static IEnumerable<string> SourceFiles(string root)
    {
        if (!Directory.Exists(root)) yield break;
        foreach (var file in Directory.EnumerateFiles(root, "*.cs", SearchOption.AllDirectories))
        {
            var parts = file.Split(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            if (parts.Any(part => part is "bin" or "obj" or "tests")) continue;
            yield return file;
        }
    }

    private static string Relative(string file) => Path.GetRelativePath(CoreRoot, file);

    private static string LocateCoreRoot([CallerFilePath] string sourceFile = "")
    {
        var directory = Path.GetDirectoryName(sourceFile)
            ?? throw new InvalidOperationException($"Cannot resolve the directory of {sourceFile}.");
        var root = Path.GetFullPath(Path.Combine(directory, "..", ".."));
        if (!File.Exists(Path.Combine(root, "TinadecCore.slnx")))
            throw new InvalidOperationException($"TinadecCore.slnx was not found under {root}.");
        return root;
    }
}
