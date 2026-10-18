// My measurement copy of tmp/perf/probe.mjs (kept separate so the shared probe is never edited).
// Differences: splash appearance and departure are timed separately, main-content/shell/banner/
// route-page are timed separately, and a --stub-host mode can simulate an Electron host whose
// status IPC has not answered yet (the state main.cjs used to block the window on).
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import WebSocket from 'ws'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const URL_TO_LOAD = process.argv[2] ?? 'http://127.0.0.1:5201/'
const STUB_HOST = process.argv.includes('--stub-host')
const LOCALE = process.argv.find((a) => a.startsWith('--locale='))?.slice('--locale='.length) ?? null
const PORT = Number(process.env.PERF_CDP_PORT ?? 9433)

const profile = mkdtempSync(join(tmpdir(), 'dsh-perf-boot-'))
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--disable-background-networking', '--disable-sync',
  '--remote-debugging-port=' + PORT, '--user-data-dir=' + profile,
  '--window-size=1400,900', 'about:blank',
], { stdio: 'ignore' })

function getJson(path) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path }, (res) => {
      let body = ''
      res.on('data', (d) => { body += d })
      res.on('end', () => { try { resolve(JSON.parse(body)) } catch (e) { reject(e) } })
    })
    req.on('error', reject)
    req.setTimeout(2000, () => { req.destroy(); reject(new Error('timeout')) })
  })
}
async function waitChrome() {
  for (let i = 0; i < 60; i++) {
    try { return await getJson('/json/version') } catch { await new Promise((r) => setTimeout(r, 250)) }
  }
  throw new Error('chrome did not start')
}

class CDP {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map()
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString())
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id); this.pending.delete(msg.id)
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
      } else if (msg.method) for (const h of this.handlers.get(msg.method) ?? []) h(msg.params)
    })
  }
  send(method, params = {}) {
    const id = ++this.id
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })) })
  }
  on(method, handler) { const l = this.handlers.get(method) ?? []; l.push(handler); this.handlers.set(method, l) }
}

await waitChrome()
const targets = await getJson('/json/list')
const page = targets.find((t) => t.type === 'page')
const ws = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 })
await new Promise((resolve, reject) => { ws.on('open', resolve); ws.on('error', reject) })
const cdp = new CDP(ws)

const requests = new Map()
let totalBytes = 0
cdp.on('Network.responseReceived', (p) => requests.set(p.requestId, { url: p.response.url, type: p.type, status: p.response.status, mime: p.response.mimeType }))
cdp.on('Network.loadingFinished', (p) => { const r = requests.get(p.requestId); if (r) { r.bytes = p.encodedDataLength; totalBytes += p.encodedDataLength } })
cdp.on('Network.loadingFailed', (p) => { const r = requests.get(p.requestId); if (r) r.failed = true })
const consoleErrors = []
cdp.on('Runtime.consoleAPICalled', (p) => { if (p.type === 'error') consoleErrors.push(p.args.map((a) => a.value ?? a.description ?? a.type).join(' ').slice(0, 300)) })
cdp.on('Runtime.exceptionThrown', (p) => consoleErrors.push('EXC: ' + (p.exceptionDetails.exception?.description ?? p.exceptionDetails.text).slice(0, 300)))

await Promise.all([cdp.send('Page.enable'), cdp.send('Network.enable'), cdp.send('Runtime.enable'), cdp.send('Performance.enable'), cdp.send('Log.enable')])

await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `
${LOCALE ? `try { localStorage.setItem('tinadec-locale', '${LOCALE}') } catch (e) {}` : ''}
window.__perf = { start: performance.now(), paint: {}, lcp: null, longTasks: [], errors: [] };
new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__perf.paint[e.name] = e.startTime; }).observe({ type: 'paint', buffered: true });
try { new PerformanceObserver((l) => { const es = l.getEntries(); const e = es[es.length - 1]; window.__perf.lcp = { t: e.startTime, size: e.size, el: e.element ? (e.element.tagName + '.' + (e.element.className || '').toString().slice(0, 60)) : null }; }).observe({ type: 'largest-contentful-paint', buffered: true }); } catch (e) {}
try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__perf.longTasks.push({ start: e.startTime, dur: e.duration }); }).observe({ type: 'longtask', buffered: true }); } catch (e) {}
window.addEventListener('error', (e) => window.__perf.errors.push(String(e.message).slice(0, 200)));
${STUB_HOST ? `
// Simulate the Electron preload of a main process whose host IPC has not answered yet: the status
// read stays pending (main.cjs used to await the whole backend before creating the window), the
// push channel never fires, and business HTTP would be refused.
(function () {
  var pending = new Promise(function () {});
  window.tinadec = {
    getHostStatus: function () { return pending; },
    onHostStatusChanged: function () { return function () {}; },
    retryHostConnection: function () { return pending; },
    gatewayUrl: function () { return 'http://127.0.0.1:48730'; },
    getAppConfig: function () { return pending; },
  };
})();
` : ''}` })

const t0 = Date.now()
await cdp.send('Page.navigate', { url: URL_TO_LOAD })

const probe = `(async () => {
  const p = window.__perf;
  const waitFor = (fn, ms) => new Promise((res) => {
    const t = performance.now();
    const tick = () => { const v = fn(); if (v) return res({ ok: true, at: Math.round(performance.now()) }); if (performance.now() - t > ms) return res({ ok: false, at: Math.round(performance.now()) }); setTimeout(tick, 10); };
    tick();
  });
  // A splash node exists in index.html before Vue boots (.splash-placeholder), then AppSplash replaces it.
  const splashAppeared = await waitFor(() => document.querySelector('.app-splash, .splash-placeholder'), 60000);
  const mainContent = await waitFor(() => document.querySelector('.main-content'), 60000);
  const banner = await waitFor(() => document.querySelector('.host-availability-banner'), 5000);
  const shell = await waitFor(() => document.querySelector('.main-content [class*=uie], .main-content .uie-shell, .main-content .shell'), 60000);
  const routePage = await waitFor(() => document.querySelector('.main-content > *'), 60000);
  // Departure: the Vue splash is leaving (class) or gone entirely — never "absent because not created yet".
  const splashGone = splashAppeared.ok ? await waitFor(() => {
    const s = document.querySelector('.app-splash');
    return !s || s.classList.contains('app-splash--leaving');
  }, 60000) : { ok: false, at: null };
  const nav = performance.getEntriesByType('navigation')[0];
  const res = performance.getEntriesByType('resource');
  const byExt = {};
  for (const r of res) { const ext = (r.name.split('?')[0].match(/\\.(\\w+)$/) || [])[1] || 'other'; byExt[ext] = byExt[ext] || { n: 0, bytes: 0 }; byExt[ext].n++; byExt[ext].bytes += r.encodedBodySize || 0; }
  return {
    splashAppearedMs: splashAppeared.ok ? splashAppeared.at : null,
    splashGoneMs: splashGone.ok ? splashGone.at : null,
    mainContentMs: mainContent.ok ? mainContent.at : null,
    shellVisibleMs: shell.ok ? shell.at : null,
    routePageMs: routePage.ok ? routePage.at : null,
    bannerVisibleMs: banner.ok ? banner.at : null,
    domContentLoaded: Math.round(nav.domContentLoadedEventEnd), loadEvent: Math.round(nav.loadEventEnd),
    responseEnd: Math.round(nav.responseEnd), domInteractive: Math.round(nav.domInteractive),
    paint: p.paint, lcp: p.lcp ? { t: Math.round(p.lcp.t), size: p.lcp.size, el: p.lcp.el } : null,
    longTasks: p.longTasks, longTaskTotal: Math.round(p.longTasks.reduce((s, e) => s + e.dur, 0)),
    resourceCount: res.length, resourceBytes: res.reduce((s, r) => s + (r.encodedBodySize || 0), 0), resourceByExt: byExt,
    slowest: res.sort((a, b) => b.duration - a.duration).slice(0, 12).map((r) => ({ name: r.name.split('/assets/')[1] ?? r.name, type: r.initiatorType, dur: Math.round(r.duration), bytes: r.encodedBodySize })),
    errors: p.errors,
  };
})()`
const evalRes = await cdp.send('Runtime.evaluate', { expression: probe, awaitPromise: true, returnByValue: true, timeout: 90000 })
const result = evalRes.result.value ?? { error: String(evalRes.result.description ?? 'no value') }
await new Promise((r) => setTimeout(r, 1200))
const metrics = await cdp.send('Performance.getMetrics')

console.log(JSON.stringify({
  url: URL_TO_LOAD, stubHost: STUB_HOST, locale: LOCALE, wallMs: Date.now() - t0, result,
  metrics: metrics.metrics.filter((m) => /TaskDuration|ScriptDuration|LayoutDuration|RecalcStyleDuration|JSHeapUsedSize|Nodes/.test(m.name)).reduce((a, m) => ({ ...a, [m.name]: Math.round(m.value * 1000) / 1000 }), {}),
  totalEncodedBytes: totalBytes, requestCount: requests.size,
  topRequests: [...requests.values()].filter((r) => r.bytes).sort((a, b) => b.bytes - a.bytes).slice(0, 12).map((r) => ({ u: r.url.split('/').slice(-2).join('/'), t: r.type, b: r.bytes })),
  consoleErrors: consoleErrors.slice(0, 10),
}, null, 2))

ws.close()
chrome.kill()
try { rmSync(profile, { recursive: true, force: true }) } catch {}
process.exit(0)
