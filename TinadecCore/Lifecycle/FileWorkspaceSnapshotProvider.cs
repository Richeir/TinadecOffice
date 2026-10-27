using TinadecCore.Abstractions.Ports;

namespace TinadecCore.Lifecycle;

/// <summary>Snapshots one exact-file grant without widening authority to its parent directory.</summary>
internal sealed class FileWorkspaceSnapshotProvider : IWorkspaceSnapshotProvider
{
    public string Kind => "file";
    public bool CanHandle(string workspaceRoot) => File.Exists(workspaceRoot);

    public async Task<WorkspaceSnapshotDocument> CaptureAsync(
        WorkspaceSnapshotCaptureRequest request,
        CancellationToken cancellationToken = default)
    {
        var path = Path.GetFullPath(request.WorkspaceRoot);
        if (!File.Exists(path)) throw new FileNotFoundException("Exact file was not found.", path);
        if ((File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
            throw new UnauthorizedAccessException("Exact-file snapshots refuse symbolic links.");

        var info = new FileInfo(path);
        var hash = await WorkspaceSnapshotProviderSupport.HashFileAsync(path, cancellationToken).ConfigureAwait(false);
        string? content = null;
        if (info.Length <= WorkspaceSnapshotProviderSupport.MaxSingleFileBytes && request.MaxBytes > 0)
            content = Convert.ToBase64String(await File.ReadAllBytesAsync(path, cancellationToken).ConfigureAwait(false));
        var row = new WorkspaceSnapshotFile(Path.GetFileName(path), info.Length, hash, content);
        return new(
            WorkspaceSnapshotProviderSupport.SnapshotSchemaVersion,
            Kind,
            false,
            request.IncludeHidden,
            WorkspaceSnapshotProviderSupport.ComputeWorkspaceHash([row]),
            [row]);
    }

    public async Task<WorkspaceSnapshotProviderRestoreResult> RestoreAsync(
        string workspaceRoot,
        WorkspaceSnapshotDocument snapshot,
        WorkspaceSnapshotProviderRestoreRequest request,
        CancellationToken cancellationToken = default)
    {
        var path = Path.GetFullPath(workspaceRoot);
        var current = File.Exists(path)
            ? await WorkspaceSnapshotProviderSupport.HashFileAsync(path, cancellationToken).ConfigureAwait(false)
            : null;
        var expected = request.ExpectedWorkspaceHash ?? snapshot.WorkspaceHash;
        if (!string.Equals(current, expected, StringComparison.OrdinalIgnoreCase) && !request.AllowConflicts)
            throw new WorkspaceSnapshotConflictException("Exact file changed after the snapshot was reviewed.", ["workspace_hash"]);
        var row = snapshot.Files.SingleOrDefault() ?? throw new InvalidDataException("Exact-file snapshot is empty.");
        if (row.ContentBase64 is null) throw new WorkspaceSnapshotFileNotCapturedException(row.Path);
        var bytes = Convert.FromBase64String(row.ContentBase64);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var temporary = path + ".tinadec-restore-" + Guid.NewGuid().ToString("N") + ".tmp";
        await File.WriteAllBytesAsync(temporary, bytes, cancellationToken).ConfigureAwait(false);
        try
        {
            if (File.Exists(path)) File.Move(temporary, path, overwrite: true);
            else File.Move(temporary, path);
        }
        finally
        {
            if (File.Exists(temporary)) File.Delete(temporary);
        }
        return new("restored", snapshot.WorkspaceHash, [], 1);
    }
}
