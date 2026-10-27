using System.Text;
using System.Text.Json;
using Microsoft.Extensions.AI;
using TinadecCore.Abstractions.Ports;
using TinadecCore.DmaEA;

namespace TinadecCore.AgentFramework.Tests;

public sealed class ImageInputCapabilityTests
{
    [Fact]
    public void HttpProviderMustOptIn_AndModelOverrideWins()
    {
        using var document = JsonDocument.Parse("""
            {
              "image_input": {
                "enabled": true,
                "max_image_bytes": 100,
                "max_images_per_turn": 3,
                "model_overrides": {
                  "text-only": { "enabled": false }
                }
              }
            }
            """);

        var vision = ImageInputCapability.Resolve(document.RootElement, ChatProtocols.OpenAiChat, "vision");
        var text = ImageInputCapability.Resolve(document.RootElement, ChatProtocols.OpenAiChat, "text-only");
        var missing = ImageInputCapability.Resolve(
            JsonSerializer.SerializeToElement(new { }),
            ChatProtocols.OpenAiChat,
            "vision");

        Assert.True(vision.Enabled);
        Assert.Equal(100, vision.MaxImageBytes);
        Assert.Equal(3, vision.MaxImagesPerTurn);
        Assert.False(text.Enabled);
        Assert.False(missing.Enabled);
    }

    [Fact]
    public void AcpCapabilityComesFromTheLastInitializeSnapshot()
    {
        using var document = JsonDocument.Parse("""
            {
              "_capabilities": { "image_input": true },
              "image_input": { "max_images_per_turn": 2 }
            }
            """);

        var policy = ImageInputCapability.Resolve(document.RootElement, ChatProtocols.Acp, "vendor-chosen");

        Assert.True(policy.Enabled);
        Assert.Equal(2, policy.MaxImagesPerTurn);
        Assert.False(ImageInputCapability.Resolve(
            JsonSerializer.SerializeToElement(new { _capabilities = new { image_input = false } }),
            ChatProtocols.Acp,
            "vendor-chosen").Enabled);
    }

    [Fact]
    public async Task DisabledImageInputProducesNoDataContent_AndSaysTheImageWasNotSeen()
    {
        var messageId = Guid.Parse("22222222-2222-2222-2222-222222222222");
        var attachment = Row(Guid.Parse("11111111-1111-1111-1111-111111111111"), "shot.png", "image/png", [1, 2, 3], messageId);
        var store = new FakeStore(attachment);

        var result = await AttachmentImageParts.BuildAsync(
            store,
            attachment.SessionId,
            messageId,
            new ChatResolution { IsAvailable = true, SupportsImageInput = false },
            CancellationToken.None);

        Assert.Empty(result.Parts.OfType<DataContent>());
        Assert.Contains("NOT delivered", result.PromptSuffix);
        Assert.Contains("does not accept image input", result.PromptSuffix);
    }

    [Fact]
    public async Task ImageBudgetDeliversTheAllowedImage_AndExplainsTheOversizedOne()
    {
        var messageId = Guid.Parse("22222222-2222-2222-2222-222222222222");
        var small = Row(Guid.NewGuid(), "small.png", "image/png", [1, 2, 3], messageId);
        var large = Row(Guid.NewGuid(), "large.jpg", "image/jpeg", [1, 2, 3, 4, 5, 6], messageId);
        var store = new FakeStore(small, large);

        var result = await AttachmentImageParts.BuildAsync(
            store,
            small.SessionId,
            messageId,
            new ChatResolution
            {
                IsAvailable = true,
                SupportsImageInput = true,
                MaxImageBytes = 5,
                MaxImagesPerTurn = 2
            },
            CancellationToken.None);

        var image = Assert.Single(result.Parts.OfType<DataContent>());
        Assert.Equal("image/png", image.MediaType);
        Assert.Equal(small.Id, Assert.Single(result.DeliveredAttachmentIds));
        Assert.Contains("large.jpg", result.PromptSuffix);
        Assert.Contains("per-image limit", result.PromptSuffix);
    }

    private static StoredAttachment Row(Guid id, string name, string mediaType, byte[] bytes, Guid? messageId = null) => new(
        id,
        Guid.Parse("33333333-3333-3333-3333-333333333333"),
        messageId,
        name,
        mediaType,
        Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(bytes)),
        bytes.Length,
        DateTimeOffset.UtcNow,
        null)
    {
        Origin = "composer",
        DeliveredToModel = false
    };

    private sealed class FakeStore(params StoredAttachment[] rows) : IMessageAttachmentStore
    {
        public Task<StoredAttachment?> StoreAsync(StoreAttachmentRequest request, CancellationToken cancellationToken = default) =>
            throw new NotSupportedException();

        public Task<IReadOnlyList<StoredAttachment>> ListAsync(Guid sessionId, CancellationToken cancellationToken = default) =>
            Task.FromResult<IReadOnlyList<StoredAttachment>>(rows.Where(row => row.SessionId == sessionId).ToArray());

        public Task<StoredAttachment?> FindAsync(Guid attachmentId, CancellationToken cancellationToken = default) =>
            Task.FromResult(rows.SingleOrDefault(row => row.Id == attachmentId));

        public Task<Stream?> OpenContentAsync(StoredAttachment attachment, CancellationToken cancellationToken = default)
        {
            var match = rows.Single(row => row.Id == attachment.Id);
            return Task.FromResult<Stream?>(new MemoryStream(Encoding.UTF8.GetBytes(new string('x', (int)match.ContentLength))));
        }

        public Task<bool> DeleteAsync(Guid attachmentId, CancellationToken cancellationToken = default) =>
            Task.FromResult(false);

        public Task<int> BindToMessageAsync(Guid sessionId, Guid messageId, IReadOnlyList<Guid> attachmentIds,
            CancellationToken cancellationToken = default) => throw new NotSupportedException();

        public Task MarkDeliveredAsync(IReadOnlyList<Guid> attachmentIds, Guid runId, DateTimeOffset deliveredAt,
            CancellationToken cancellationToken = default) => Task.CompletedTask;
    }
}
