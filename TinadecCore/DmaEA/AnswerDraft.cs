using System.Text;

namespace TinadecCore.DmaEA;

/// <summary>
/// The one draft of a run's user-visible answer.
///
/// Before this type the answer reached the client through two unrelated kinds: `answer.delta`
/// frames while the meeting call streamed, and one authoritative `delta` frame carrying the
/// whole text at finalization. The second existed only because the first is absent on paths
/// that never call a model (evidence fallbacks, status queries), so the same answer was stored
/// three times — messages, `delta`, and the accumulated `answer.delta` frames — and the client
/// needed a provisional/replace state machine to pick between them.
///
/// A draft makes the answer a single accumulating value: streaming appends to it, a path that
/// answers without a model sets it whole, and finalization publishes whatever is left. The
/// client then only ever appends, and `delta` stops existing.
/// </summary>
internal sealed class AnswerDraft
{
    private readonly StringBuilder _text = new();
    private bool _publishedAnyFrame;

    /// <summary>Text accumulated so far, whether streamed or set whole.</summary>
    public string Text => _text.ToString();

    /// <summary>True when the draft holds nothing the user should see.</summary>
    public bool IsEmpty => _text.Length == 0;

    /// <summary>
    /// True once a frame reached the run stream, i.e. the client is already rendering this
    /// draft. A path that sets the text afterwards must not republish it whole.
    /// </summary>
    public bool PublishedAnyFrame => _publishedAnyFrame;

    /// <summary>
    /// Appends one streamed increment. Returns the increment so the caller publishes exactly
    /// what this draft accepted.
    /// </summary>
    public string Append(string delta)
    {
        if (string.IsNullOrEmpty(delta)) return string.Empty;
        _text.Append(delta);
        return delta;
    }

    /// <summary>Records that a frame for this draft reached the client.</summary>
    public void MarkPublished() => _publishedAnyFrame = true;

    /// <summary>
    /// Sets the whole answer for a path that did not stream (a fallback or a status query).
    /// Any streamed prefix is discarded: the caller's text is authoritative for the run.
    /// </summary>
    public void SetWhole(string text)
    {
        _text.Clear();
        if (!string.IsNullOrEmpty(text)) _text.Append(text);
    }
}
