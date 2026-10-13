using System.Text;
using System.Text.Json;
using System.ClientModel.Primitives;
using Microsoft.Extensions.AI;
using StreamingChatCompletionUpdate = OpenAI.Chat.StreamingChatCompletionUpdate;

namespace TinadecCore.DmaEA;

internal sealed record ModelOutputFrame(Guid ResponseId, string Kind, string? Channel = null, string? Delta = null);

/// <summary>
/// Streams a provider's public text/reasoning while still assembling the complete response
/// for the governed caller. Function calls, protected reasoning and provider metadata never
/// enter this projection. Every retry has its own response id, not a concatenated answer.
/// </summary>
internal static class ModelOutputStream
{
    public static async Task<ChatResponse> ReadAsync(
        IChatClient client, IEnumerable<ChatMessage> messages, ChatOptions? options,
        Guid responseId, Func<ModelOutputFrame, CancellationToken, Task> publish, CancellationToken ct)
    {
        await publish(new(responseId, "started"), ct).ConfigureAwait(false);
        var updates = new List<ChatResponseUpdate>();
        var splitter = new ModelTextSplitter();
        var pending = new StringBuilder();
        string? channel = null;
        var lastFlush = DateTimeOffset.MinValue;

        async Task FlushAsync()
        {
            if (pending.Length == 0) return;
            await publish(new(responseId, "delta", channel, pending.ToString()), ct).ConfigureAwait(false);
            pending.Clear();
            lastFlush = DateTimeOffset.UtcNow;
        }

        async Task AddAsync(string nextChannel, string text)
        {
            if (text.Length == 0) return;
            if (channel != nextChannel) await FlushAsync().ConfigureAwait(false);
            channel = nextChannel;
            pending.Append(text);
            // First text is immediate; thereafter coalesce fast token bursts rather than
            // producing a database write for every token. Always flush at phase/end boundaries.
            if (pending.Length >= 256 || DateTimeOffset.UtcNow - lastFlush >= TimeSpan.FromMilliseconds(100))
                await FlushAsync().ConfigureAwait(false);
        }

        try
        {
            await foreach (var update in client.GetStreamingResponseAsync(messages, options, ct).ConfigureAwait(false))
            {
                updates.Add(update);
                foreach (var content in update.Contents)
                {
                    if (content is TextReasoningContent reasoning)
                        await AddAsync("reasoning", reasoning.Text ?? string.Empty).ConfigureAwait(false);
                    else if (content is TextContent text)
                        foreach (var part in splitter.Push(text.Text))
                            await AddAsync(part.Channel, part.Text).ConfigureAwait(false);
                }
                if (!update.Contents.OfType<TextReasoningContent>().Any()
                    && CompatibleReasoning(update) is { Length: > 0 } compatible)
                    await AddAsync("reasoning", compatible).ConfigureAwait(false);
            }
            foreach (var part in splitter.Push(string.Empty, final: true))
                await AddAsync(part.Channel, part.Text).ConfigureAwait(false);
            await FlushAsync().ConfigureAwait(false);
            await publish(new(responseId, "completed"), ct).ConfigureAwait(false);
            return updates.ToChatResponse();
        }
        catch
        {
            // No raw exception text goes on this user-visible channel.
            await publish(new(responseId, "failed"), CancellationToken.None).ConfigureAwait(false);
            throw;
        }
    }

    // OpenAI-compatible providers send public reasoning outside the standard text channel,
    // under one of a few names. The SDK retains extension JSON in its raw update; read only
    // these allow-listed public fields, never serialize the raw object into an event:
    //   reasoning_content — DeepSeek, Qwen, vLLM (older);
    //   reasoning         — OpenRouter-style routers, newer vLLM;
    //   reasoning_details — OpenRouter's structured form (text/summary parts; encrypted
    //                       parts carry no public text and are skipped).
    // Only the first present form is read, so a provider that sends two never shows it twice.
    internal static string? CompatibleReasoning(ChatResponseUpdate update)
    {
        if (update.RawRepresentation is not StreamingChatCompletionUpdate raw) return null;
        try
        {
            using var json = JsonDocument.Parse(ModelReaderWriter.Write(raw));
            if (!json.RootElement.TryGetProperty("choices", out var choices) || choices.ValueKind != JsonValueKind.Array
                || choices.GetArrayLength() == 0 || !choices[0].TryGetProperty("delta", out var delta)
                || delta.ValueKind != JsonValueKind.Object)
                return null;
            foreach (var name in (string[])["reasoning_content", "reasoning"])
                if (delta.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String && value.GetString() is { Length: > 0 } text)
                    return text;
            if (delta.TryGetProperty("reasoning_details", out var details) && details.ValueKind == JsonValueKind.Array)
            {
                var parts = new StringBuilder();
                foreach (var detail in details.EnumerateArray())
                {
                    if (detail.ValueKind != JsonValueKind.Object) continue;
                    foreach (var key in (string[])["text", "summary"])
                        if (detail.TryGetProperty(key, out var part) && part.ValueKind == JsonValueKind.String) { parts.Append(part.GetString()); break; }
                }
                return parts.Length > 0 ? parts.ToString() : null;
            }
        }
        catch (Exception ex) when (ex is JsonException or InvalidOperationException or NotSupportedException) { }
        return null;
    }
}

/// <summary>Incremental think-tag demultiplexer; even a tag split across network frames stays out of the answer.</summary>
internal sealed class ModelTextSplitter
{
    private string _pending = string.Empty;
    private bool _reasoning;
    private static readonly string[] Tags = ["<think>", "</think>", "<thinking>", "</thinking>"];

    public IReadOnlyList<(string Channel, string Text)> Push(string? text, bool final = false)
    {
        _pending += text;
        var result = new List<(string, string)>();
        while (_pending.Length > 0)
        {
            var start = _pending.IndexOf('<');
            if (start < 0) { Emit(_pending); _pending = string.Empty; break; }
            if (start > 0) { Emit(_pending[..start]); _pending = _pending[start..]; }
            var tag = Tags.FirstOrDefault(tag => _pending.StartsWith(tag, StringComparison.OrdinalIgnoreCase));
            if (tag is null)
            {
                var end = _pending.IndexOf('>');
                if (end >= 0 && System.Text.RegularExpressions.Regex.IsMatch(_pending[..(end + 1)],
                        @"^</?(?:think|thinking)\s[^>]*>$", System.Text.RegularExpressions.RegexOptions.IgnoreCase))
                    tag = _pending[..(end + 1)];
            }
            if (tag is not null)
            {
                _reasoning = !tag.StartsWith("</", StringComparison.Ordinal);
                _pending = _pending[tag.Length..];
            }
            else if (Tags.Any(tag => tag.StartsWith(_pending, StringComparison.OrdinalIgnoreCase))
                || (_pending.Length < 1024 && !_pending.Contains('>') && Tags.Any(tag =>
                    _pending.StartsWith(tag[..^1], StringComparison.OrdinalIgnoreCase)
                    && _pending.Length > tag.Length - 1 && char.IsWhiteSpace(_pending[tag.Length - 1]))))
            {
                if (final) _pending = string.Empty; // incomplete control markup is not an answer
                break;
            }
            else { Emit("<"); _pending = _pending[1..]; }
        }
        return result;
        void Emit(string value) { if (value.Length > 0) result.Add((_reasoning ? "reasoning" : "text", value)); }
    }
}
