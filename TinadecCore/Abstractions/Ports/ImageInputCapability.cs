using System.Text.Json;

namespace TinadecCore.Abstractions.Ports;

/// <summary>
/// Provider-neutral image-input budget. A provider must opt in explicitly for HTTP
/// protocols; process-backed harnesses are resolved from their own capability snapshot.
/// </summary>
public sealed record ImageInputPolicy(
    bool Enabled,
    long MaxImageBytes = ImageInputCapability.DefaultMaxImageBytes,
    int MaxImagesPerTurn = ImageInputCapability.DefaultMaxImagesPerTurn)
{
    public static ImageInputPolicy Disabled { get; } = new(false);
}

public static class ImageInputCapability
{
    public const long DefaultMaxImageBytes = 20L * 1024 * 1024;
    public const int DefaultMaxImagesPerTurn = 8;
    public const long MaxImageBytesCeiling = 32L * 1024 * 1024;
    public const int MaxImagesPerTurnCeiling = 8;

    public static ImageInputPolicy Resolve(JsonElement providerConfig, string? protocol, string? model)
    {
        var normalized = ChatProtocols.Normalize(protocol);
        if (normalized is ChatProtocols.Acp)
        {
            var discovered = DiscoveredAcpImageInput(providerConfig);
            var configured = ReadConfigured(providerConfig, model, null);
            return discovered
                ? (configured ?? new ImageInputPolicy(true)) with { Enabled = true }
                : ImageInputPolicy.Disabled;
        }

        if (normalized is ChatProtocols.OpenAiChat or ChatProtocols.OpenAiResponses or ChatProtocols.AnthropicMessages)
            return ReadConfigured(providerConfig, model, false) ?? ImageInputPolicy.Disabled;

        return ImageInputPolicy.Disabled;
    }

    public static ImageInputPolicy ResolveBase(JsonElement providerConfig, string? protocol)
    {
        var normalized = ChatProtocols.Normalize(protocol);
        if (normalized is ChatProtocols.Acp)
        {
            var discovered = DiscoveredAcpImageInput(providerConfig);
            var configured = ReadConfigured(providerConfig, null, null);
            return discovered
                ? (configured ?? new ImageInputPolicy(true)) with { Enabled = true }
                : ImageInputPolicy.Disabled;
        }
        if (normalized is ChatProtocols.OpenAiChat or ChatProtocols.OpenAiResponses or ChatProtocols.AnthropicMessages)
            return ReadConfigured(providerConfig, null, false) ?? ImageInputPolicy.Disabled;
        return ImageInputPolicy.Disabled;
    }

    public static void Validate(JsonElement providerConfig)
    {
        if (!providerConfig.TryGetProperty("image_input", out var value)
            || value.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined) return;
        _ = ReadConfigured(providerConfig, null, false);
    }

    private static ImageInputPolicy? ReadConfigured(JsonElement providerConfig, string? model, bool? discovered)
    {
        if (!providerConfig.TryGetProperty("image_input", out var value)
            || value.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined) return null;
        if (value.ValueKind != JsonValueKind.Object)
            throw new ArgumentException("image_input must be an object.");

        var enabled = discovered ?? false;
        long maxBytes = DefaultMaxImageBytes;
        var maxImages = DefaultMaxImagesPerTurn;
        ReadFields(value, ref enabled, ref maxBytes, ref maxImages);

        if (model is not null && value.TryGetProperty("model_overrides", out var overrides))
        {
            if (overrides.ValueKind != JsonValueKind.Object)
                throw new ArgumentException("image_input.model_overrides must be an object keyed by model id.");
            if (overrides.TryGetProperty(model, out var modelValue))
            {
                if (modelValue.ValueKind != JsonValueKind.Object)
                    throw new ArgumentException($"image_input.model_overrides.{model} must be an object.");
                ReadFields(modelValue, ref enabled, ref maxBytes, ref maxImages);
            }
        }
        return new ImageInputPolicy(enabled, maxBytes, maxImages);
    }

    private static bool DiscoveredAcpImageInput(JsonElement providerConfig) =>
        providerConfig.TryGetProperty("_capabilities", out var capabilities)
        && capabilities.ValueKind == JsonValueKind.Object
        && capabilities.TryGetProperty("image_input", out var image)
        && image.ValueKind == JsonValueKind.True;

    private static void ReadFields(JsonElement value, ref bool enabled, ref long maxBytes, ref int maxImages)
    {
        foreach (var property in value.EnumerateObject())
        {
            switch (property.Name)
            {
                case "enabled":
                    if (property.Value.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
                        throw new ArgumentException("image_input.enabled must be boolean.");
                    enabled = property.Value.GetBoolean();
                    break;
                case "max_image_bytes":
                    if (!property.Value.TryGetInt64(out maxBytes) || maxBytes is <= 0 or > MaxImageBytesCeiling)
                        throw new ArgumentException($"image_input.max_image_bytes must be 1..{MaxImageBytesCeiling}.");
                    break;
                case "max_images_per_turn":
                    if (!property.Value.TryGetInt32(out maxImages) || maxImages is <= 0 or > MaxImagesPerTurnCeiling)
                        throw new ArgumentException($"image_input.max_images_per_turn must be 1..{MaxImagesPerTurnCeiling}.");
                    break;
                case "model_overrides":
                    break;
                default:
                    throw new ArgumentException($"Unknown image_input field '{property.Name}'.");
            }
        }
    }
}
