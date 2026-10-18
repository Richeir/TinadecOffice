namespace TinadecCore.DmaEA;

/// <summary>
/// Where a model call's answer is allowed to become visible.
///
/// This replaced a `streamAnswer` boolean that only asked "may this call stream?". The boolean
/// conflated two genuinely different questions: whether output reaches the user at all, and
/// which layer of the conversation it belongs to. A worker's prose is user-visible work, but it
/// must not appear as the answer, so a boolean could only answer "no" and the work streamed
/// nowhere. Naming the layer makes each call site state its intent.
/// </summary>
internal enum AnswerStreaming
{
    /// <summary>
    /// Internal reasoning the user never sees: planning, supervision, and the governance
    /// dispatches that act on a run rather than speaking to the person.
    /// </summary>
    None,

    /// <summary>
    /// Work in progress — a task worker's prose. Visible as part of what the agent is doing,
    /// but never as the conversation's answer.
    /// </summary>
    WorkLayer,

    /// <summary>
    /// The answer itself: the meeting reply and a reply to an interaction. This is the text the
    /// conversation shows and later persists as the assistant message.
    /// </summary>
    AnswerLayer,
}
