using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using TinadecCore.Abstractions;
using TinadecCore.Abstractions.Ports;
using TinadecCore.Persistence;

namespace TinadecCore.Exploration;

/// <summary>
/// The session exploration graph (B1). Registered as its own module so a host can compose Core without
/// it: the tables stay empty and the dispatcher simply does not offer the tools when this module is
/// absent. The evidence archive the digest writes to belongs to AgentGraph, reached through its port.
/// </summary>
public sealed class ExplorationModuleRegistrar : IModuleRegistrar
{
    public string ModuleId => "exploration";

    public void Register(ITinadecCoreBuilder builder)
    {
        builder.Services.AddDbContextFactory<ExplorationDbContext>((sp, options) => options.UseTinadecDatabase(sp));
        builder.Services.AddSingleton<IStorageMigrationParticipant, DbContextMigrationParticipant<ExplorationDbContext>>();
        builder.Services.AddSingleton<ExplorationGraphService>();
        builder.Services.AddSingleton<IExplorationGraph>(sp => sp.GetRequiredService<ExplorationGraphService>());
        builder.Services.AddSingleton<PlanLedgerService>();
        builder.Services.AddSingleton<IPlanLedger>(sp => sp.GetRequiredService<PlanLedgerService>());
        builder.RegisterModule(new ModuleDescriptor
        {
            ModuleId = ModuleId,
            Version = "0.1.0",
            Dependencies = ["abstractions", "persistence", "agent_graph"],
            Capabilities = ["exploration_graph", "asset_coverage", "exploration_digest", "plan_ledger"],
            Language = "C#",
            MafPrimitives = [],
            RegistrationStatus = ModuleRegistrationStatus.Registered
        });
    }
}
