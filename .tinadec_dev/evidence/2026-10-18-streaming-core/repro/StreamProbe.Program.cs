using System.Diagnostics;
using System.Text;
using Microsoft.Extensions.AI;
using TinadecCore.Abstractions.Ports;
using TinadecCore.DmaEA;
using TinadecCore.Models.Harness;

// Measurement harness for the Core streaming emitter.
// Drives the REAL production path: ModelOutputStream.ReadAsync -> provider client -> fake SSE.
// The fake server fixes provider chunk granularity and pace, so the only remaining variable
// is ModelOutputStream's coalescing rule.

var baseUrl = Environment.GetEnvironmentVariable("PROBE_BASE_URL") ?? "http://127.0.0.1:48741/v1";
var plan = Environment.GetEnvironmentVariable("PROBE_PLAN") ?? "dense";
var protocol = Environment.GetEnvironmentVariable("PROBE_PROTOCOL") ?? ChatProtocols.OpenAiChat;
var label = Environment.GetEnvironmentVariable("PROBE_LABEL") ?? plan;

using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(180) };
var control = await http.PostAsync(baseUrl.Replace("/v1", "/control"),
    new StringContent("{\"plan\":\"" + plan + "\",\"reset\":true}", Encoding.UTF8, "application/json"));
Console.WriteLine("[probe] label=" + label + " plan=" + plan + " protocol=" + protocol + " base=" + baseUrl
    + " control=" + await control.Content.ReadAsStringAsync());

var resolution = new ChatResolution
{
    IsAvailable = true,
    Model = "probe-model",
    ModelId = "probe-model",
    Protocol = protocol,
    BaseUrl = baseUrl,
    ApiKey = "probe-key",
    ProviderInstanceId = Guid.NewGuid(),
    ProviderVersionId = Guid.NewGuid(),
    CandidatePosition = 0,
    StrategySource = "probe",
};

IChatClient client = protocol == ChatProtocols.OpenAiResponses
    ? AgentChatClientFactory.CreateResponsesClient(resolution)
    : AgentChatClientFactory.CreateOpenAiChatClient(resolution);

// ---- 1. RAW provider updates: what the provider hands Core, no coalescing ------------
var rawText = new List<(string Text, double AtMs)>();
var rawClock = Stopwatch.StartNew();
await foreach (var update in client.GetStreamingResponseAsync([new ChatMessage(ChatRole.User, "probe")]))
{
    var at = rawClock.Elapsed.TotalMilliseconds;
    foreach (var content in update.Contents)
    {
        if (content is TextContent t && t.Text is { Length: > 0 } v) rawText.Add((v, at));
        else if (content is TextReasoningContent r && r.Text is { Length: > 0 } rv) rawText.Add(("R:" + rv, at));
    }
}
rawClock.Stop();
Console.WriteLine("[probe] RAW count=" + rawText.Count + " span_ms=" + rawClock.ElapsedMilliseconds.ToString("F0"));
Console.WriteLine("[probe] RAW lens=[" + string.Join(",", rawText.Select(r => r.Text.Length)) + "]");
Console.WriteLine("[probe] RAW at_ms=[" + string.Join(",", rawText.Select(r => r.AtMs.ToString("F1"))) + "]");

// ---- 2. Production emitter ----------------------------------------------------------
var frames = new List<(string Kind, string? Channel, int Length, double AtMs)>();
var clock = Stopwatch.StartNew();
var response = await ModelOutputStream.ReadAsync(
    client,
    [new ChatMessage(ChatRole.User, "probe")],
    null,
    Guid.NewGuid(),
    (frame, _) => { frames.Add((frame.Kind, frame.Channel, frame.Delta?.Length ?? 0, clock.Elapsed.TotalMilliseconds)); return Task.CompletedTask; },
    CancellationToken.None);
clock.Stop();

var prodText = frames.Where(f => f.Kind == "delta" && f.Channel == "text").ToArray();
Console.WriteLine("[probe] PROD answer_chars=" + (response.Text?.Length ?? 0) + " total_ms=" + clock.Elapsed.TotalMilliseconds.ToString("F0"));
Console.WriteLine("[probe] PROD text_frames=" + prodText.Length + " lens=[" + string.Join(",", prodText.Select(f => f.Length)) + "]");
Console.WriteLine("[probe] PROD gaps_ms=[" + string.Join(",", prodText.Skip(1).Select((f, i) => (f.AtMs - prodText[i].AtMs).ToString("F0"))) + "]");

// ---- 3. Offline replay of the documented rule, then counterfactuals -----------------
// The production rule as written: append the text; flush when pending.Length >= threshold,
// or when (now - lastFlush) >= window. Crucially the window is only EVALUATED when an update
// arrives, so a burst denser than the window can never trip it. Replay reproduces the
// production frame list before any counterfactual is trusted.
static List<int> Replay(IReadOnlyList<(string Text, double AtMs)> arrivals, int threshold, double windowMs)
{
    var lens = new List<int>();
    var pending = new StringBuilder();
    double lastFlush = double.NegativeInfinity;
    foreach (var (text, at) in arrivals)
    {
        pending.Append(text);
        if (at - lastFlush >= windowMs || pending.Length >= threshold)
        {
            lens.Add(pending.Length);
            pending.Clear();
            lastFlush = at;
        }
    }
    if (pending.Length > 0) lens.Add(pending.Length);
    return lens;
}

var replayLens = Replay(rawText, 256, 100);
var prodLens = prodText.Select(f => f.Length).ToArray();
var matches = replayLens.Count == prodLens.Length && !replayLens.Where((x, i) => x != prodLens[i]).Any();
Console.WriteLine("[probe] REPLAY(256,100) frames=" + replayLens.Count + " lens=[" + string.Join(",", replayLens) + "]");
Console.WriteLine("[probe] REPLAY_MATCHES_PRODUCTION=" + matches);

var scenarios = new (string Name, int Threshold, double Window)[]
{
    ("production-256-100", 256, 100),
    ("threshold-64-100", 64, 100),
    ("threshold-16-100", 16, 100),
    ("window-80-no-char-cap-8192", 8192, 80),
    ("window-60-no-char-cap-8192", 8192, 60),
    ("window-40-no-char-cap-8192", 8192, 40),
    ("window-80-cap-256", 256, 80),
};

foreach (var s in scenarios)
{
    var lens = Replay(rawText, s.Threshold, s.Window);
    var total = lens.Sum();
    var visiblePer1000 = lens.Count == 0 ? 0 : total * 1000.0 / lens.Count;
    Console.WriteLine("[probe] CF name=" + s.Name + " frames=" + lens.Count
        + " chars_per_visible_step=" + visiblePer1000.ToString("F0")
        + " lens=[" + string.Join(",", lens) + "]");
}

// The user-visible metric: how many times does the answer change on screen?
Console.WriteLine("[probe] SUMMARY label=" + label + " plan=" + plan
    + " raw_updates=" + rawText.Count
    + " raw_chars=" + rawText.Sum(r => r.Text.Length)
    + " prod_frames=" + prodLens.Length
    + " prod_chars_per_step=" + (prodLens.Length == 0 ? 0 : rawText.Sum(r => r.Text.Length) / (double)prodLens.Length).ToString("F0"));
return 0;
