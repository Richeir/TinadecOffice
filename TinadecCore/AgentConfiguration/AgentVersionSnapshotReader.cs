using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using TinadecCore.Abstractions.Ports;

namespace TinadecCore.AgentConfiguration;

internal sealed class AgentVersionSnapshotReader : IAgentVersionSnapshotReader
{
    private readonly IDbContextFactory<AgentConfigurationDbContext> _dbFactory;

    public AgentVersionSnapshotReader(IDbContextFactory<AgentConfigurationDbContext> dbFactory) => _dbFactory = dbFactory;

    public async Task<AgentVersionSnapshot?> GetAsync(Guid tenantId, Guid workspaceId, Guid agentVersionId, CancellationToken cancellationToken = default)
    {
        if (agentVersionId == Guid.Empty) return null;
        await using var db = await _dbFactory.CreateDbContextAsync(cancellationToken).ConfigureAwait(false);
        var version = await db.AgentVersions.AsNoTracking()
            .SingleOrDefaultAsync(x => x.Id == agentVersionId
                && x.TenantId == tenantId
                && x.WorkspaceId == workspaceId
                && x.Status == "published", cancellationToken)
            .ConfigureAwait(false);
        if (version is null || string.IsNullOrWhiteSpace(version.ContentHash)) return null;
        return new AgentVersionSnapshot(
            version.AgentDefinitionId,
            version.Id,
            version.ContentHash,
            ReadSystemPrompt(version.SnapshotJson),
            version.SnapshotJson);
    }

    private static string ReadSystemPrompt(string snapshotJson)
    {
        if (string.IsNullOrWhiteSpace(snapshotJson)) return string.Empty;
        try
        {
            using var document = JsonDocument.Parse(snapshotJson);
            return document.RootElement.ValueKind == JsonValueKind.Object
                && document.RootElement.TryGetProperty("system_prompt", out var prompt)
                && prompt.ValueKind == JsonValueKind.String
                    ? prompt.GetString() ?? string.Empty
                    : string.Empty;
        }
        catch (JsonException)
        {
            return string.Empty;
        }
    }
}
