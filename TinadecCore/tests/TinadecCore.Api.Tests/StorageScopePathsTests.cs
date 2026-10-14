using TinadecCore.Persistence;

namespace TinadecCore.Api.Tests;

/// <summary>
/// The storage link guard checks a scope's root and what lies under it, not the directories above
/// it: those are where the host put the scope. Checking them refused every scope under macOS's
/// /var (a link to /private/var, where the temporary directory lives) and /tmp.
/// </summary>
public sealed class StorageScopePathsTests : IDisposable
{
    private readonly string _parent = Path.Combine(Path.GetTempPath(), "tinadec-links-" + Guid.NewGuid().ToString("N"));

    public StorageScopePathsTests() => Directory.CreateDirectory(_parent);
    public void Dispose() { try { Directory.Delete(_parent, true); } catch (IOException) { } }

    private bool TryLink(string link, string target)
    {
        try { Directory.CreateSymbolicLink(link, target); return true; }
        catch (Exception ex) when (ex is UnauthorizedAccessException or IOException or PlatformNotSupportedException) { return false; }
    }

    [Fact]
    public void LinksAboveTheRootAreTheHostsChoice_LinksAtOrBelowItAreRefused()
    {
        var real = Directory.CreateDirectory(Path.Combine(_parent, "real")).FullName;
        if (!TryLink(Path.Combine(_parent, "alias"), real)) return; // no symlink privilege here
        // A scope reached through a link above it (like /var/folders on macOS) is accepted.
        var root = Directory.CreateDirectory(Path.Combine(_parent, "alias", "scope")).FullName;
        StorageScopePaths.RejectLinks(root, Path.Combine(root, "config", "models.toml"));

        // A link inside the scope still redirects its writes: refused.
        Directory.CreateDirectory(Path.Combine(root, "outside"));
        Assert.True(TryLink(Path.Combine(root, "config"), Path.Combine(root, "outside")));
        Assert.Throws<InvalidOperationException>(() => StorageScopePaths.RejectLinks(root, Path.Combine(root, "config", "models.toml")));

        // A root that is itself a link: refused.
        var linkedRoot = Path.Combine(_parent, "linked-root");
        Assert.True(TryLink(linkedRoot, real));
        Assert.Throws<InvalidOperationException>(() => StorageScopePaths.RejectLinks(linkedRoot));
    }
}
