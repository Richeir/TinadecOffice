using TinadecCore.Abstractions.Ports;
using TinadecCore.DmaEA;
using TinadecCore.Persistence;

namespace TinadecCore.AgentFramework.Tests;

/// <summary>
/// P1: a storage scope created before a baseline change keeps the old context budgets forever,
/// because seeding only writes a document that does not exist yet. These assertions pin the
/// upgrade contract: still-at-old-default values move, operator values do not, and a file that
/// was deliberately reverted stays reverted.
/// </summary>
public sealed class RuntimeConfigurationMigrationTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "tinadec-runtime-migration-" + Guid.NewGuid().ToString("N"));

    /// <summary>The shipped baseline as it looked before the 2026-10 context change.</summary>
    private const string OldBaseline = """
        # Runtime-only policy baseline.
        schema_version = 1

        [spawn]
        max_depth = 2
        max_agents_per_run = 16
        max_parallel_workers = 4

        [scheduling]
        max_active_runs_per_session = 2
        worker_retry_limit = 2
        preserve_partial_results = true

        [supervision]
        required_before_final = true
        max_revision_rounds = 2

        # Context policy. default_token_budget is the per-task context budget the loop
        # guard enforces; run_token_budget is the run-wide counterpart and is a FUSE.
        [context]
        default_token_budget = 65536
        recent_message_limit = 128
        run_token_budget = 1048576   # run-wide fuse
        optimistic_revision = true

        [memory]
        candidate_only = true
        retrieval_limit = 8

        [tools]
        provider = "tinadec-tools-process"
        mutation_requires_approval = true
        serialize_workspace_writes = true
        default_timeout_seconds = 600
        max_tool_rounds = 0
        max_tool_calls = 500
        """;

    public void Dispose()
    {
        if (Directory.Exists(_root)) Directory.Delete(_root, recursive: true);
    }

    [Fact]
    public void OldBaseline_IsUpgraded_AndTheDocumentStaysLoadable()
    {
        var scope = Scope();
        WriteConfig(scope, OldBaseline);

        Assert.True(RuntimeConfigurationMigration.Apply(scope));

        var text = ReadConfig(scope);
        // Values move…
        Assert.Contains("default_token_budget = 131072", text, StringComparison.Ordinal);
        Assert.Contains("run_token_budget = 0   # run-wide fuse", text, StringComparison.Ordinal);
        Assert.Contains("task_token_budget = 0", text, StringComparison.Ordinal);
        // …while the commentary that explains them survives the rewrite.
        Assert.Contains("# Context policy.", text, StringComparison.Ordinal);
        Assert.DoesNotContain("65536", text, StringComparison.Ordinal);
        Assert.DoesNotContain("1048576", text, StringComparison.Ordinal);
        // Everything outside [context] is untouched.
        Assert.Contains("max_depth = 2", text, StringComparison.Ordinal);
        Assert.Contains("max_tool_calls = 500", text, StringComparison.Ordinal);

        var snapshot = AgentRuntimeConfigurationStore.LoadSnapshotText(text, "runtime.toml", 1);
        Assert.Equal(131_072, snapshot.Context.DefaultTokenBudget);
        Assert.Equal(0, snapshot.Context.RunTokenBudget);
        Assert.Equal(0, snapshot.Context.EffectiveTaskTokenBudget);
        Assert.Equal(128, snapshot.Context.RecentMessageLimit);
    }

    [Fact]
    public void OperatorValues_AreNeverOverwritten()
    {
        var scope = Scope();
        WriteConfig(scope, """
            schema_version = 1

            [context]
            default_token_budget = 262144
            run_token_budget = 0
            task_token_budget = 400000
            recent_message_limit = 128
            """);

        Assert.False(RuntimeConfigurationMigration.Apply(scope));

        var text = ReadConfig(scope);
        Assert.Contains("default_token_budget = 262144", text, StringComparison.Ordinal);
        Assert.Contains("task_token_budget = 400000", text, StringComparison.Ordinal);
    }

    [Fact]
    public void MigratingOneKey_DoesNotAddTheAbsentKeyToARetunedDocument()
    {
        var scope = Scope();
        // The context window was retuned but the run fuse is still the old default: only that one
        // key may move, and the missing per-task fuse must not be re-introduced behind the
        // operator's back (that key is only added while the window is still the old baseline).
        WriteConfig(scope, """
            schema_version = 1

            [context]
            default_token_budget = 262144
            run_token_budget = 1048576
            recent_message_limit = 64
            """);

        Assert.True(RuntimeConfigurationMigration.Apply(scope));

        var text = ReadConfig(scope);
        Assert.Contains("default_token_budget = 262144", text, StringComparison.Ordinal);
        Assert.Contains("run_token_budget = 0", text, StringComparison.Ordinal);
        Assert.DoesNotContain("task_token_budget", text, StringComparison.Ordinal);
    }

    [Fact]
    public void SecondRun_IsANoOp()
    {
        var scope = Scope();
        WriteConfig(scope, OldBaseline);
        Assert.True(RuntimeConfigurationMigration.Apply(scope));
        var upgraded = ReadConfig(scope);

        Assert.False(RuntimeConfigurationMigration.Apply(scope));
        Assert.Equal(upgraded, ReadConfig(scope));
    }

    [Fact]
    public void DeliberateRevertAfterTheUpgrade_StaysReverted()
    {
        var scope = Scope();
        WriteConfig(scope, OldBaseline);
        Assert.True(RuntimeConfigurationMigration.Apply(scope));
        // The operator restores the old window on purpose once the upgrade has run.
        WriteConfig(scope, ReadConfig(scope).Replace("default_token_budget = 131072", "default_token_budget = 65536", StringComparison.Ordinal));

        Assert.False(RuntimeConfigurationMigration.Apply(scope));
        Assert.Contains("default_token_budget = 65536", ReadConfig(scope), StringComparison.Ordinal);
    }

    [Fact]
    public void MissingDocument_IsNotCreatedAndLeavesNoMarker()
    {
        var scope = Scope();
        Directory.CreateDirectory(scope.Config);

        Assert.False(RuntimeConfigurationMigration.Apply(scope));
        Assert.False(File.Exists(Path.Combine(scope.Config, "runtime.toml")));
        // No marker, so the upgrade is still evaluated once a document appears.
        Assert.False(File.Exists(Marker(scope)));
    }

    [Fact]
    public void CrlfDocument_KeepsItsLineEndings()
    {
        var scope = Scope();
        WriteConfig(scope, OldBaseline.Replace("\n", "\r\n", StringComparison.Ordinal));

        Assert.True(RuntimeConfigurationMigration.Apply(scope));

        var text = ReadConfig(scope);
        Assert.Contains("default_token_budget = 131072\r\n", text, StringComparison.Ordinal);
        // Reloading must not mix endings: every remaining line break is still CRLF.
        Assert.DoesNotContain("\n", text.Replace("\r\n", string.Empty, StringComparison.Ordinal), StringComparison.Ordinal);
    }

    [Fact]
    public void DocumentWithoutAContextTable_IsLeftAlone()
    {
        var scope = Scope();
        WriteConfig(scope, "schema_version = 1\n\n[spawn]\nmax_depth = 2\n");

        Assert.False(RuntimeConfigurationMigration.Apply(scope));
        Assert.Equal("schema_version = 1\n\n[spawn]\nmax_depth = 2\n", ReadConfig(scope));
    }

    private StorageScopeDescriptor Scope() =>
        new("user", "user", _root, ProjectRoot: null, ProjectId: null, Backend: "sqlite");

    private static string Marker(IScopeStorageLocations scope) =>
        Path.Combine(scope.State, ".configuration-migrations", RuntimeConfigurationMigration.Revision + ".applied");

    private static void WriteConfig(IScopeStorageLocations scope, string text)
    {
        Directory.CreateDirectory(scope.Config);
        File.WriteAllText(Path.Combine(scope.Config, "runtime.toml"), text);
    }

    private static string ReadConfig(IScopeStorageLocations scope) =>
        File.ReadAllText(Path.Combine(scope.Config, "runtime.toml"));
}
