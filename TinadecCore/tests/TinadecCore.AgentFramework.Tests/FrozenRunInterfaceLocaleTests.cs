using System.Text.Json;
using TinadecCore.Abstractions.Ports;
using TinadecCore.DmaEA;

namespace TinadecCore.AgentFramework.Tests;

public sealed class FrozenRunInterfaceLocaleTests
{
    private static FrozenRunConfigurationV1 Configuration(string? interfaceLocale = null) => new(
        FrozenRunConfigurationV1.CurrentSchemaVersion,
        "baseline",
        1,
        Guid.NewGuid(),
        "profile",
        "ask",
        new SpawnPolicy(1, 1, 1),
        new SchedulingPolicy(1, 1, true),
        new SupervisionPolicy(false, 0),
        new ContextPolicy(65536, 8, true),
        new MemoryPolicy(true, 4, [], []),
        new ToolRuntimePolicy("none", true, true, 60, 0),
        [],
        [],
        [])
    {
        InterfaceLocale = interfaceLocale
    };

    [Fact]
    public void MissingInterfaceLocaleIsOmittedAndRoundTripsByteIdentically()
    {
        var json = Configuration().ToCanonicalJson();
        using var document = JsonDocument.Parse(json);
        Assert.False(document.RootElement.TryGetProperty("interfaceLocale", out _));

        var reparsed = JsonSerializer.Deserialize<FrozenRunConfigurationV1>(json, FrozenRunConfigurationV1.JsonOptions);
        Assert.NotNull(reparsed);
        Assert.Null(reparsed!.InterfaceLocale);
        Assert.Equal(json, reparsed.ToCanonicalJson());
    }

    [Fact]
    public void FrozenInterfaceLocaleSurvivesAResumeRoundTrip()
    {
        var json = Configuration("ja").ToCanonicalJson();
        var reparsed = JsonSerializer.Deserialize<FrozenRunConfigurationV1>(json, FrozenRunConfigurationV1.JsonOptions);
        Assert.Equal("ja", reparsed!.InterfaceLocale);
        Assert.Equal(json, reparsed.ToCanonicalJson());
    }

    [Fact]
    public async Task DefaultSubmissionForwardsLocaleToTheSessionResolver()
    {
        var resolver = new CapturingResolver();
        await ((IAgentRuntimeConfigurationResolver)resolver).ResolveSubmissionAsync(new FullDuplexInvocation(
            Guid.NewGuid(), "goal", "client", null, null, null, InterfaceLocale: "ru"));

        Assert.Equal("ru", resolver.SeenLocale);
    }

    [Fact]
    public async Task DefaultSubmissionForwardsLocaleToTheModeResolver()
    {
        var resolver = new CapturingResolver();
        await ((IAgentRuntimeConfigurationResolver)resolver).ResolveSubmissionAsync(new FullDuplexInvocation(
            Guid.NewGuid(), "goal", "client", null, null, null,
            ModeVersionId: Guid.NewGuid(), InterfaceLocale: "zh-TW"));

        Assert.Equal("zh-TW", resolver.SeenLocale);
    }

    [Fact]
    public async Task DefaultSubmissionForwardsLocaleToTheSpaceResolver()
    {
        var resolver = new CapturingResolver();
        await ((IAgentRuntimeConfigurationResolver)resolver).ResolveSubmissionAsync(new FullDuplexInvocation(
            Guid.NewGuid(), "goal", "client", null, null, null,
            SpaceOptions: new SpaceRunOptions(), InterfaceLocale: "en"));

        Assert.Equal("en", resolver.SeenLocale);
    }

    private sealed class CapturingResolver : IAgentRuntimeConfigurationResolver
    {
        public string? SeenLocale { get; private set; }

        public Task<FrozenRunConfigurationV1> ResolveAsync(
            Guid sessionId,
            string? permissionMode,
            SessionModelOverride? meetingModelOverride = null,
            string? interfaceLocale = null,
            CancellationToken cancellationToken = default)
        {
            SeenLocale = interfaceLocale;
            return Task.FromResult(Configuration(interfaceLocale));
        }

        public Task<FrozenRunConfigurationV1> ResolveForModeAsync(
            Guid sessionId,
            Guid modeVersionId,
            string? permissionMode,
            SessionModelOverride? meetingModelOverride = null,
            string? interfaceLocale = null,
            CancellationToken cancellationToken = default)
        {
            SeenLocale = interfaceLocale;
            return Task.FromResult(Configuration(interfaceLocale));
        }

        public Task<FrozenRunConfigurationV1> ResolveSpaceAsync(
            Guid sessionId,
            SpaceRunOptions options,
            string? permissionMode,
            SessionModelOverride? meetingModelOverride = null,
            string? interfaceLocale = null,
            CancellationToken cancellationToken = default)
        {
            SeenLocale = interfaceLocale;
            return Task.FromResult(Configuration(interfaceLocale));
        }
    }
}
