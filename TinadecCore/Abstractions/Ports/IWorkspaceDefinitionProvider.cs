namespace TinadecCore.Abstractions.Ports;

public sealed record WorkspaceSourceRoot(string Id, string Path);
public sealed record WorkspaceFileGrant(string Id, string Path);
public sealed record WorkspaceDefinition(string Name, IReadOnlyList<WorkspaceSourceRoot> Roots,
    string PrimaryRootId, string Icon = "folder", string Color = "default", string ContentHash = "")
{
    /// <summary>
    /// Exact-file grants. Unlike a source folder, one grant authorizes only this path and
    /// never its containing directory. The files are host-authorized independently.
    /// </summary>
    public IReadOnlyList<WorkspaceFileGrant> Files { get; init; } = [];
    public string PrimaryPath => Roots.Single(x => x.Id == PrimaryRootId).Path;
}
public sealed record WorkspacePreview(bool Exists, string ProjectPath, string? StorageId,
    string? StorageRoot, WorkspaceDefinition? Workspace);
public sealed record WorkspaceEditRequest(string Name, IReadOnlyList<WorkspaceSourceRoot> Roots,
    string PrimaryRootId, string Icon = "folder", string Color = "default")
{
    public IReadOnlyList<WorkspaceFileGrant> Files { get; init; } = [];
}

/// <summary>Reads metadata within the trusted host's directory grants.</summary>
public interface IWorkspaceDefinitionProvider
{
    WorkspaceDefinition Read(bool requireAvailable = false);
    /// <summary>Host-owned historical grants, used only by frozen runs and stored snapshots.</summary>
    IReadOnlyList<WorkspaceSourceRoot> ReadHistoricalRoots() => Read().Roots;
    IReadOnlyList<WorkspaceFileGrant> ReadHistoricalFiles() => Read().Files;
}
public interface IWorkspaceRegistry
{
    WorkspaceDefinition ReadWorkspace(string storageId, bool requireAvailable = false);
    WorkspacePreview PreviewWorkspace(string projectPath);
    Task<WorkspaceDefinition> EditWorkspaceAsync(string storageId, WorkspaceEditRequest request,
        string expectedHash, CancellationToken ct = default);
}
