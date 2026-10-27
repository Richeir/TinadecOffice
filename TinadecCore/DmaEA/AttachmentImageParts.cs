using Microsoft.Extensions.AI;
using TinadecCore.Abstractions.Ports;

namespace TinadecCore.DmaEA;

/// <summary>
/// Reads only the images bound to the user message that triggered this run. The bytes are
/// the immutable attachment copy, not a live path. Every image omitted by capability or
/// budget leaves a model-visible sentence saying it was not seen.
/// </summary>
internal sealed record AttachmentImageInput(
    IReadOnlyList<AIContent> Parts,
    IReadOnlyList<Guid> DeliveredAttachmentIds,
    string PromptSuffix)
{
    public static AttachmentImageInput Empty { get; } = new([], [], string.Empty);
}

internal static class AttachmentImageParts
{
    internal const long MaxTotalBytesPerTurn = 32L * 1024 * 1024;
    private static readonly HashSet<string> SupportedMediaTypes = new(StringComparer.OrdinalIgnoreCase)
    {
        "image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp"
    };

    internal static async Task<AttachmentImageInput> BuildAsync(
        IMessageAttachmentStore store,
        Guid sessionId,
        Guid userMessageId,
        ChatResolution resolution,
        CancellationToken cancellationToken)
    {
        var rows = (await store.ListAsync(sessionId, cancellationToken).ConfigureAwait(false))
            .Where(row => row.MessageId == userMessageId && row.MediaType.StartsWith("image/", StringComparison.OrdinalIgnoreCase))
            .OrderBy(row => row.CreatedAt)
            .ToArray();
        if (rows.Length == 0) return AttachmentImageInput.Empty;

        var notes = new List<string>();
        if (!resolution.SupportsImageInput)
        {
            notes.AddRange(rows.Select(row => NotDelivered(row, "the resolved model does not accept image input")));
            return new([], [], NoteBlock(notes));
        }

        var parts = new List<AIContent>();
        var delivered = new List<Guid>();
        long total = 0;
        foreach (var row in rows)
        {
            if (!SupportedMediaTypes.Contains(row.MediaType))
            {
                notes.Add(NotDelivered(row, $"media type '{row.MediaType}' is not supported for image input"));
                continue;
            }
            if (parts.Count >= resolution.MaxImagesPerTurn)
            {
                notes.Add(NotDelivered(row, $"the per-turn limit of {resolution.MaxImagesPerTurn} images was reached"));
                continue;
            }
            if (row.ContentLength > resolution.MaxImageBytes)
            {
                notes.Add(NotDelivered(row, $"the image is {row.ContentLength} bytes; the per-image limit is {resolution.MaxImageBytes}"));
                continue;
            }
            if (total + row.ContentLength > MaxTotalBytesPerTurn)
            {
                notes.Add(NotDelivered(row, $"the turn image budget of {MaxTotalBytesPerTurn} bytes was reached"));
                continue;
            }

            await using var stream = await store.OpenContentAsync(row, cancellationToken).ConfigureAwait(false);
            if (stream is null)
            {
                notes.Add(NotDelivered(row, "the stored image bytes are unavailable"));
                continue;
            }
            var bytes = await ReadBoundedAsync(stream, Math.Min(resolution.MaxImageBytes, MaxTotalBytesPerTurn - total), cancellationToken)
                .ConfigureAwait(false);
            if (bytes is null)
            {
                notes.Add(NotDelivered(row, "the stored image exceeded the delivery budget"));
                continue;
            }
            total += bytes.Length;
            parts.Add(new DataContent(bytes, row.MediaType) { Name = row.FileName });
            delivered.Add(row.Id);
        }

        return new(parts, delivered, NoteBlock(notes));
    }

    private static string NotDelivered(StoredAttachment row, string reason) =>
        $"- Image '{row.FileName}' (attachment {row.Id}) was NOT delivered to the model: {reason}. Do not claim to have seen it.";

    private static string NoteBlock(IReadOnlyList<string> notes) => notes.Count == 0
        ? string.Empty
        : "\n\nAttachment delivery notes (authoritative):\n" + string.Join("\n", notes);

    private static async Task<byte[]?> ReadBoundedAsync(Stream stream, long maxBytes, CancellationToken cancellationToken)
    {
        if (maxBytes <= 0 || maxBytes > int.MaxValue) return null;
        using var buffer = new MemoryStream((int)Math.Min(maxBytes, int.MaxValue));
        var chunk = new byte[81920];
        while (true)
        {
            var read = await stream.ReadAsync(chunk, cancellationToken).ConfigureAwait(false);
            if (read == 0) return buffer.ToArray();
            if (buffer.Length + read > maxBytes) return null;
            buffer.Write(chunk, 0, read);
        }
    }
}
