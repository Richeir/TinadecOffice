using System.Diagnostics;
using TinadecCore.Runtime;
using Xunit;

namespace TinadecCore.Api.Tests;

/// <summary>
/// The storage section reads usage on every open, and a working install's cache holds tens of
/// thousands of files (measured: 27,221 files / 663 MiB, 152 s cold and ~20 s warm with
/// real-time scanning). A bounded walk is what keeps that a reading instead of an outage —
/// but a bounded walk that quietly reports a subtree as a total would be worse than the wait.
/// </summary>
public sealed class StorageStatisticsBudgetTests : IDisposable
{
    private readonly string _root = Directory.CreateTempSubdirectory("tinadec-stats-budget-").FullName;

    private string Write(string relative, int bytes = 8)
    {
        var path = Path.Combine(_root, relative);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllBytes(path, new byte[bytes]);
        return path;
    }

    [Fact]
    public void AWalkInsideItsBudgetCountsEveryFile()
    {
        Write("a.txt"); Write("b.txt"); Write(Path.Combine("nested", "c.txt"), 16);

        var (size, count, truncated) = StorageMaintenanceService.MeasureDirectory(
            _root, _root, TimeSpan.FromSeconds(30), CancellationToken.None);

        Assert.Equal(3, count);
        Assert.Equal(32, size);
        Assert.False(truncated);
    }

    [Fact]
    public void AnAbsentDirectoryReadsAsZeroInsteadOfThrowing()
    {
        var (size, count, truncated) = StorageMaintenanceService.MeasureDirectory(
            _root, Path.Combine(_root, "never-created"), TimeSpan.FromSeconds(30), CancellationToken.None);

        Assert.Equal(0, count);
        Assert.Equal(0, size);
        Assert.False(truncated);
    }

    // A budget already spent reports truncation rather than pretending a partial count is a
    // total. The zero budget makes this deterministic instead of racing a real clock.
    [Fact]
    public void ASpentBudgetReportsTruncationInsteadOfAPartialTotal()
    {
        for (var index = 0; index < 20; index++) Write($"f{index}.txt");

        var (_, count, truncated) = StorageMaintenanceService.MeasureDirectory(
            _root, _root, TimeSpan.Zero, CancellationToken.None);

        Assert.True(truncated);
        // Whatever it managed to see, it is not presented as the answer.
        Assert.True(count <= 20);
    }

    [Fact]
    public void ASpentBudgetStopsQuicklyInsteadOfWalkingEverything()
    {
        // Enough files that an unbudgeted walk is unmistakably slower than a stopped one.
        for (var index = 0; index < 400; index++) Write(Path.Combine($"d{index % 8}", $"f{index}.txt"));

        var started = Stopwatch.GetTimestamp();
        var (_, _, truncated) = StorageMaintenanceService.MeasureDirectory(
            _root, _root, TimeSpan.Zero, CancellationToken.None);
        var elapsed = Stopwatch.GetElapsedTime(started);

        Assert.True(truncated);
        // A generous ceiling: this asserts "it stopped", not a performance number.
        Assert.True(elapsed < TimeSpan.FromSeconds(5), $"walk took {elapsed}");
    }

    [Fact]
    public void ALinkInsideOwnedStorageIsRefusedRatherThanFollowed()
    {
        var target = Directory.CreateTempSubdirectory("tinadec-stats-outside-").FullName;
        try
        {
            Write("real.txt");
            // Directory links are what the boundary exists for; without the privilege to make
            // one, the file-link form exercises the same refusal.
            var link = Path.Combine(_root, "link.txt");
            try { File.CreateSymbolicLink(link, Path.Combine(target, "elsewhere.txt")); }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException or PlatformNotSupportedException)
            { return; }

            Assert.Throws<InvalidOperationException>(() => StorageMaintenanceService.MeasureDirectory(
                _root, _root, TimeSpan.FromSeconds(30), CancellationToken.None));
        }
        finally { try { Directory.Delete(target, true); } catch (IOException) { } }
    }

    public void Dispose()
    {
        try { Directory.Delete(_root, true); } catch (IOException) { }
    }
}
