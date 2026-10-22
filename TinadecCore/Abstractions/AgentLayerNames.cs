namespace TinadecCore.Abstractions;

/// <summary>Single vocabulary for agent layers shared by configuration and evolution.</summary>
public static class AgentLayerNames
{
    public const string Operation = "operation";
    public const string Execution = "execution";

    public static bool IsValid(string? layer) => layer is Operation or Execution;

    public static string Require(string? layer) => IsValid(layer)
        ? layer!
        : throw new ArgumentException("Layer must be 'operation' or 'execution'.");
}
