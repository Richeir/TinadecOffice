using Microsoft.Data.Sqlite;
using TinadecCore.Runtime;
using Xunit;

namespace TinadecCore.Api.Tests;

/// <summary>
/// The deletion preview, export and vector snapshot all copy a live SQLite file. A single
/// <c>BackupDatabase</c> throws the moment the source is busy (CI saw SQLITE_BUSY_RECOVERY as a
/// 500); the shared helper waits a busy spell out.
/// </summary>
public sealed class StorageBackupRetryTests : IDisposable
{
    private readonly string _root = Directory.CreateTempSubdirectory("tinadec-backup-retry-").FullName;

    [Fact]
    public async Task ABackupWaitsOutABriefLockInsteadOfFailing()
    {
        var source = Path.Combine(_root, "source.db");
        await using var holder = new SqliteConnection($"Data Source={source};Pooling=False");
        await holder.OpenAsync();
        await using (var setup = holder.CreateCommand())
        {
            // Rollback journal on purpose: under WAL a writer would not block the reader at all.
            setup.CommandText = "PRAGMA journal_mode=DELETE; CREATE TABLE facts(x); INSERT INTO facts VALUES (42);";
            await setup.ExecuteNonQueryAsync();
        }
        await using (var lockIt = holder.CreateCommand()) { lockIt.CommandText = "BEGIN EXCLUSIVE"; await lockIt.ExecuteNonQueryAsync(); }

        await using var reader = new SqliteConnection($"Data Source={source};Mode=ReadOnly;Pooling=False");
        await using var target = new SqliteConnection($"Data Source={Path.Combine(_root, "copy.db")};Pooling=False");
        await reader.OpenAsync(); await target.OpenAsync();
        // The bare call is what the code used to do: it gives up at once.
        var busy = Assert.Throws<SqliteException>(() => reader.BackupDatabase(target));
        Assert.Contains(busy.SqliteErrorCode & 0xFF, new[] { 5, 6 });

        var release = Task.Run(async () =>
        {
            await Task.Delay(300);
            await using var commit = holder.CreateCommand(); commit.CommandText = "COMMIT"; await commit.ExecuteNonQueryAsync();
        });
        await StorageMaintenanceService.BackupAsync(reader, target, CancellationToken.None);
        await release;

        await using var check = target.CreateCommand(); check.CommandText = "SELECT x FROM facts";
        Assert.Equal(42L, await check.ExecuteScalarAsync());
    }

    public void Dispose()
    {
        SqliteConnection.ClearAllPools();
        try { Directory.Delete(_root, true); } catch (IOException) { }
    }
}
