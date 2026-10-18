#!/usr/bin/env node
// Fake OpenAI-compatible SSE server with EXACTLY known chunk granularity.
// Serves /v1/chat/completions and /v1/responses. Plans control size + pace of the
// provider-side chunks, which is the only variable in the streaming measurement.
//
// Windows Node timers have ~15.6 ms granularity, so any delay below that is done with
// a busy-wait; otherwise "2 ms" would silently become "16 ms" and change the result.
import http from "node:http";

const busySleep = (ms) => {
  if (ms <= 0) return;
  const until = process.hrtime.bigint() + BigInt(Math.round(ms * 1e6));
  while (process.hrtime.bigint() < until) { /* spin */ }
};
const sleep = (ms) => (ms < 15 ? (busySleep(ms), Promise.resolve()) : new Promise((r) => setTimeout(r, ms)));
const immediate = () => new Promise((r) => setImmediate(r));

const PLANS = {
  // as fast as the event loop allows: an unrealistically fast token stream
  burst: () => Array.from({ length: 200 }, () => ({ text: "\u5b57", mode: "immediate" })),
  // 1 char every 2 ms -> ~500 chars/s, a genuinely dense token stream
  dense: () => Array.from({ length: 200 }, () => ({ text: "\u5b57", delay: 2 })),
  // 1 char every 15 ms -> ~66 chars/s, a typical fast local model over the network
  tok15: () => Array.from({ length: 200 }, () => ({ text: "\u5b57", delay: 15 })),
  // 1 char every 40 ms -> ~25 chars/s, a typical online model
  tok40: () => Array.from({ length: 200 }, () => ({ text: "\u5b57", delay: 40 })),
  // 200-char block every 500 ms: what a proxy that batches upstream tokens looks like
  block200: () => Array.from({ length: 5 }, () => ({ text: "\u5b57".repeat(200), delay: 500 })),
  // 300-char block every 400 ms
  block300: () => Array.from({ length: 4 }, () => ({ text: "\u5b57".repeat(300), delay: 400 })),
  // one single 800-char block: the provider gives nothing to stream
  bulk: () => [{ text: "\u5757".repeat(800), delay: 0 }],
  // measured real-world answer shape: 489-char block, 300 ms, 328-char block
  realrun: () => [
    { text: "\u5b57".repeat(489), delay: 0 },
    { text: "\u5b57".repeat(328), delay: 300 },
  ],
};

let planName = "dense";
let requests = [];

function sse(res, event, data) {
  if (event) res.write("event: " + event + "\n");
  res.write("data: " + JSON.stringify(data) + "\n\n");
}

const readBody = async (req) => { const c = []; for await (const chunk of req) c.push(chunk); return Buffer.concat(c).toString("utf8"); };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  try {
    if (url.pathname === "/control" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)) || "{}");
      if (body.plan) planName = body.plan;
      if (body.reset) requests = [];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, plan: planName }));
      return;
    }
    if (url.pathname === "/stats") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ plan: planName, requests }));
      return;
    }
    const isChat = url.pathname.endsWith("/chat/completions");
    const isResponses = url.pathname.endsWith("/responses");
    if (!isChat && !isResponses) { res.writeHead(404).end("no route " + url.pathname); return; }

    const body = await readBody(req);
    let stream = true;
    try { stream = JSON.parse(body).stream !== false; } catch { /* not json */ }
    const plan = PLANS[planName]();
    const startedAt = Date.now();
    requests.push({ path: url.pathname, plan: planName, at: new Date().toISOString(), stream });

    const fullText = plan.map((p) => p.text).join("");
    if (!stream) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(isChat
        ? { id: "c", object: "chat.completion", created: 1, model: "probe-model",
            choices: [{ index: 0, message: { role: "assistant", content: fullText }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }
        : { id: "r", object: "response", created_at: 1, model: "probe-model", status: "completed",
            output: [{ type: "message", id: "m1", role: "assistant", status: "completed",
                       content: [{ type: "output_text", text: fullText, annotations: [] }] }],
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }));
      return;
    }

    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", "x-probe-plan": planName });
    const sent = [];
    if (isChat) {
      sse(res, null, { id: "chunk", object: "chat.completion.chunk", created: 1, model: "probe-model",
        choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] });
      for (const piece of plan) {
        if (piece.delay) await sleep(piece.delay);
        if (piece.mode === "immediate") await immediate();
        sse(res, null, { id: "chunk", object: "chat.completion.chunk", created: 1, model: "probe-model",
          choices: [{ index: 0, delta: { content: piece.text }, finish_reason: null }] });
        sent.push({ at: Date.now() - startedAt, len: piece.text.length });
      }
      sse(res, null, { id: "chunk", object: "chat.completion.chunk", created: 1, model: "probe-model",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
    } else {
      sse(res, "response.created", { type: "response.created", response: { id: "resp_probe", object: "response", created_at: 1, model: "probe-model", status: "in_progress", output: [] } });
      for (const piece of plan) {
        if (piece.delay) await sleep(piece.delay);
        if (piece.mode === "immediate") await immediate();
        sse(res, "response.output_text.delta", { type: "response.output_text.delta", item_id: "item_1", output_index: 0, content_index: 0, delta: piece.text });
        sent.push({ at: Date.now() - startedAt, len: piece.text.length });
      }
      sse(res, "response.output_text.done", { type: "response.output_text.done", item_id: "item_1", output_index: 0, content_index: 0, text: fullText });
      sse(res, "response.completed", { type: "response.completed", response: { id: "resp_probe", object: "response", created_at: 1, model: "probe-model", status: "completed",
        output: [{ type: "message", id: "item_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: fullText, annotations: [] }] }],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
    }
    res.write("data: [DONE]\n\n");
    res.end();
  } catch (error) {
    try { res.writeHead(500).end(String((error && error.stack) || error)); } catch { /* closed */ }
  }
});

const port = Number(process.env.PROBE_PORT || 48741);
server.listen(port, "127.0.0.1", () => console.log("fake-openai-sse listening on http://127.0.0.1:" + port + "/v1"));
