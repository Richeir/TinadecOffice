using TinadecCore.Abstractions.Ports;

namespace TinadecCore.Persistence;

public static class StorageScopePaths
{
    public static string UserRoot(string? configured = null) => Path.GetFullPath(
        configured ?? Environment.GetEnvironmentVariable("TINADEC_HOME") ??
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".tinadec"));

    public static StorageScopeDescriptor User(string? configured = null) => new("user", "user", UserRoot(configured));

    public static string NormalizeProjectRoot(string input)
    {
        if (string.IsNullOrWhiteSpace(input) || !Path.IsPathRooted(input))
            throw new ArgumentException("Project path must be absolute.", nameof(input));
        var directory = new DirectoryInfo(Path.GetFullPath(input));
        if (!directory.Exists) throw new DirectoryNotFoundException("The selected project directory does not exist.");
        var resolved = directory.ResolveLinkTarget(returnFinalTarget: true);
        return Path.TrimEndingDirectorySeparator(resolved?.FullName ?? directory.FullName);
    }

    public static string Contained(string root, string relative)
    {
        if (string.IsNullOrWhiteSpace(relative) || Path.IsPathRooted(relative))
            throw new ArgumentException("A relative owned path is required.", nameof(relative));
        var fullRoot = Path.TrimEndingDirectorySeparator(Path.GetFullPath(root));
        var result = Path.GetFullPath(Path.Combine(fullRoot, relative));
        var comparison = OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
        if (!result.StartsWith(fullRoot + Path.DirectorySeparatorChar, comparison))
            throw new InvalidOperationException("The path escaped its storage scope.");
        RejectLinks(fullRoot, result);
        return result;
    }

    public static void RejectLinks(string root, string? destination = null)
    {
        var fullRoot = Path.TrimEndingDirectorySeparator(Path.GetFullPath(root));
        var target = Path.GetFullPath(destination ?? root);
        var comparison = OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
        if (!string.Equals(fullRoot, Path.TrimEndingDirectorySeparator(target), comparison)
            && !target.StartsWith(fullRoot + Path.DirectorySeparatorChar, comparison))
            throw new InvalidOperationException("The path escaped its storage scope.");
        // The scope's own root and everything under it — not the directories above it. Those are
        // where the host chose to put the scope, and a link there redirects nothing inside it;
        // checking them refused every scope under macOS's /var -> /private/var (the temporary
        // directory) and /tmp -> /private/tmp.
        var current = fullRoot;
        CheckNotLink(current);
        foreach (var segment in Path.GetRelativePath(fullRoot, target).Split(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar))
        {
            if (segment is "." or "") continue;
            current = Path.Combine(current, segment);
            CheckNotLink(current);
        }

        static void CheckNotLink(string path)
        {
            try
            {
                if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
                    throw new InvalidOperationException("Owned storage must not contain symbolic links or junctions: " + path);
            }
            catch (FileNotFoundException) { }
            catch (DirectoryNotFoundException) { }
        }
    }
}
