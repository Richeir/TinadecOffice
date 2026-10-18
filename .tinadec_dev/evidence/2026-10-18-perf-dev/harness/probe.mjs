import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import WebSocket from 'ws';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const URL_TO_LOAD = process.argv[2] ?? 'http://127.0.0.1:5173/';
const PORT = 9333;

const profile = mkdtempSync(join(tmpdir(), 'dsh-perf-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--disable-background-networking', '--disable-sync',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--window-size=1400,900', 'about:blank',
], { stdio: 'ignore' });

function getJson(path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path }, (res) => {
      let body = ''; res.on('data', d => body += d); res.on('end', () => { try { resolve(JSON.parse(body)) } catch (e) { reject(e) } });
    });
    req.on('error', reject);
    req.setTimeout(2000, () => { req.destroy(); reject(new Error('timeout')) });
  });
}
async function waitChrome() {
  for (let i = 0; i < 60; i++) {
    try { const v = await getJson('/json/version'); return v; } catch { await new Promise(r => setTimeout(r, 250)); }
  }
  throw new Error('chrome did not start');
}

class CDP {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map();
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.id && this.pending.has(msg.id)) { const { resolve, reject } = this.pending.get(msg.id); this.pending.delete(msg.id); msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result); }
      else if (msg.method) { const list = this.handlers.get(msg.method) ?? []; for (const h of list) h(msg.params); }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  on(method, handler) { const l = this.handlers.get(method) ?? []; l.push(handler); this.handlers.set(method, l); }
}

const version = await waitChrome();
const targets = await getJson('/json/list');
const page = targets.find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject); });
const cdp = new CDP(ws);

const requests = new Map();
let totalBytes = 0;
cdp.on('Network.responseReceived', (p) => requests.set(p.requestId, { url: p.response.url, type: p.type, status: p.response.status, mime: p.response.mimeType, ts: p.response.responseTime }));
cdp.on('Network.loadingFinished', (p) => { const r = requests.get(p.requestId); if (r) { r.bytes = p.encodedDataLength; totalBytes += p.encodedDataLength; } });
cdp.on('Network.loadingFailed', (p) => { const r = requests.get(p.requestId); if (r) r.failed = true; });

const consoleErrors = [];
cdp.on('Runtime.consoleAPICalled', (p) => { if (p.type === 'error') consoleErrors.push(p.args.map(a => a.value ?? a.description ?? a.type).join(' ').slice(0, 300)); });
cdp.on('Runtime.exceptionThrown', (p) => consoleErrors.push('EXC: ' + (p.exceptionDetails.exception?.description ?? p.exceptionDetails.text).slice(0, 300)));

await Promise.all([cdp.send('Page.enable'), cdp.send('Network.enable'), cdp.send('Runtime.enable'), cdp.send('Performance.enable'), cdp.send('Log.enable')]);

await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `
  window.__perf = { start: performance.now(), paint: {}, lcp: null, longTasks: [], marks: [], errors: [] };
  new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__perf.paint[e.name] = e.startTime; }).observe({ type: 'paint', buffered: true });
  try { new PerformanceObserver((l) => { const es = l.getEntries(); const e = es[es.length-1]; window.__perf.lcp = { t: e.startTime, size: e.size, el: e.element ? (e.element.tagName + '.' + (e.element.className||'').toString().slice(0,60)) : null }; }).observe({ type: 'largest-contentful-paint', buffered: true }); } catch (e) {}
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__perf.longTasks.push({ start: e.startTime, dur: e.duration }); }).observe({ type: 'longtask', buffered: true }); } catch (e) {}
  window.addEventListener('error', (e) => window.__perf.errors.push(String(e.message).slice(0,200)));
`});

const t0 = Date.now();
await cdp.send('Page.navigate', { url: URL_TO_LOAD });

// Poll for readiness markers from inside the page.
const probe = `(async () => {
  const p = window.__perf;
  const waitFor = (fn, ms) => new Promise((res) => { const t = performance.now(); const tick = () => { const v = fn(); if (v) return res({ ok: true, at: performance.now(), value: v }); if (performance.now() - t > ms) return res({ ok: false, at: performance.now() }); setTimeout(tick, 20); }; tick(); });
  const splashGone = await waitFor(() => { const s = document.querySelector('.app-splash'); return !s || s.classList.contains('app-splash--leaving'); }, 60000);
  const main = await waitFor(() => document.querySelector('.main-content') , 60000);
  const shell = await waitFor(() => document.querySelector('[class*=uie], .uie-shell, .shell'), 60000);
  const nav = performance.getEntriesByType('navigation')[0];
  const res = performance.getEntriesByType('resource');
  const byType = {};
  for (const r of res) { const ext = (r.name.split('?')[0].match(/\\.(\\w+)$/)||[])[1] || 'other'; byType[ext] = byType[ext] || { n: 0, bytes: 0, dur: 0 }; byType[ext].n++; byType[ext].bytes += r.encodedBodySize || 0; byType[ext].dur += r.duration || 0; }
  return {
    splashGone, main, shell,
    domContentLoaded: nav.domContentLoadedEventEnd, loadEvent: nav.loadEventEnd,
    responseEnd: nav.responseEnd, domInteractive: nav.domInteractive,
    paint: p.paint, lcp: p.lcp,
    longTasks: p.longTasks, longTaskTotal: p.longTasks.reduce((s, e) => s + e.dur, 0),
    resourceCount: res.length, resourceBytes: res.reduce((s, r) => s + (r.encodedBodySize||0), 0),
    resourceByExt: byType, errors: p.errors,
    slowest: res.sort((a,b)=>b.duration-a.duration).slice(0,15).map(r=>({name:r.name.split('/src/')[1]?.split('?')[0]||r.name, type:r.initiatorType, dur:Math.round(r.duration), bytes:r.encodedBodySize})),
    now: performance.now(),
  };
})()`;
const evalRes = await cdp.send('Runtime.evaluate', { expression: probe, awaitPromise: true, returnByValue: true, timeout: 90000 });
const result = evalRes.result.value ?? { error: evalRes };

await new Promise(r => setTimeout(r, 1500));
const metrics = await cdp.send('Performance.getMetrics');

console.log(JSON.stringify({ url: URL_TO_LOAD, wallMs: Date.now() - t0, result, metrics: metrics.metrics.filter(m => /Task|Script|Layout|Style|Heap|Nodes|Documents|Frame|JSEvent/.test(m.name)), totalEncodedBytes: totalBytes, requestCount: requests.size, topRequests: [...requests.values()].filter(r => r.bytes).sort((a,b)=>b.bytes-a.bytes).slice(0,15).map(r=>({u:r.url.split('/').slice(-2).join('/'), t:r.type, b:r.bytes})), consoleErrors: consoleErrors.slice(0,10) }, null, 2));

ws.close();
chrome.kill();
try { rmSync(profile, { recursive: true, force: true }); } catch {}
process.exit(0);
