import { spawn, execSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import net from 'node:net';
import http from 'node:http';

// Before/after verification on the REAL working tree config vs a saved snapshot.
//   node tmp/perf/final-ab.mjs <rounds> <warmRuns> [cells...]
// cells: before | after | afterMcp
const rounds = Number(process.argv[2] ?? '1');
const warmRuns = Number(process.argv[3] ?? '2');
const only = process.argv.slice(4);
const cells = only.length ? only : ['before', 'after'];
const port = 5296;
const outDir = 'tmp/perf/runs';
mkdirSync(outDir, { recursive: true });

const desktopDir = resolvePath('apps/desktop');
const perfConfigPath = join(desktopDir, 'vite.perf.config.ts');
const sources = {
  before: readFileSync('tmp/perf/vite.config.snapshot.ts', 'utf8'),
  after: readFileSync(join(desktopDir, 'vite.config.ts'), 'utf8'),
  afterMcp: readFileSync(join(desktopDir, 'vite.config.ts'), 'utf8'),
};

function makeConfig(cell, cacheDir) {
  let c = sources[cell];
  // Both cells get the identical measurement-only overrides: isolated cache + free port.
  c = c.replace(/export default defineConfig\(\{/, 'export default defineConfig({\n  cacheDir: ' + JSON.stringify(cacheDir) + ',');
  c = c.replace(/port: 5173,/, 'port: ' + port + ',');
  return c;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const portFree = (p) => new Promise((r) => { const s = net.createServer(); s.once('error', () => r(false)); s.once('listening', () => s.close(() => r(true))); s.listen(p, '127.0.0.1'); });
const tcpOnce = () => new Promise((resolve) => {
  const s = net.connect({ host: '127.0.0.1', port });
  const done = (ok) => { s.destroy(); resolve(ok); };
  s.once('connect', () => done(true)); s.once('error', () => done(false)); s.setTimeout(400, () => done(false));
});
function get(path) {
  const s = Date.now();
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path, timeout: 600000 }, (res) => { let b = 0; res.on('data', (c) => b += c.length); res.on('end', () => resolve({ path, status: res.statusCode, ms: Date.now() - s, bytes: b })); });
    req.on('timeout', () => { req.destroy(); resolve({ path, status: 0, ms: Date.now() - s, timeout: true }); });
    req.on('error', () => resolve({ path, status: 0, ms: Date.now() - s }));
  });
}
function launch(cell, cacheDir) {
  writeFileSync(perfConfigPath, makeConfig(cell, cacheDir));
  const t0 = Date.now();
  const proc = spawn(process.execPath, [resolvePath('node_modules/vite/bin/vite.js'), '--config', perfConfigPath, '--port', String(port), '--strictPort'], {
    cwd: desktopDir, env: { ...process.env, DEBUG: 'vite:deps' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const ctx = { proc, t0, log: '' };
  proc.stdout.on('data', (d) => { ctx.log += d.toString(); });
  proc.stderr.on('data', (d) => { ctx.log += d.toString(); });
  return ctx;
}
async function waitListen(ctx) {
  for (let i = 0; i < 12000; i++) {
    if (ctx.proc.exitCode !== null) return null;
    if (await tcpOnce()) return Date.now() - ctx.t0;
    await sleep(40);
  }
  return null;
}
const kill = (ctx) => { try { execSync('taskkill /PID ' + ctx.proc.pid + ' /T /F', { stdio: 'ignore' }); } catch {} };
const parse = (log) => ({
  readyLog: (() => { const m = log.match(/ready in (\d+) ?ms/); return m ? Number(m[1]) : null; })(),
  scanMs: (() => { const m = log.match(/Scan completed in ([\d.]+)ms/); return m ? Math.round(Number(m[1])) : null; })(),
  entryCount: (() => { const m = log.match(/Crawling dependencies using entries:([\s\S]*?)\n\d{4}-/); return m ? m[1].split('\n').map((s) => s.trim()).filter(Boolean).length : null; })(),
  optimized: [...log.matchAll(/new dependencies optimized: ([^\n]+)/g)].length,
  reloads: (log.match(/page reload/g) || []).length,
  mcpLine: /MCP:\s+Server is running/.test(log),
  errors: [...log.matchAll(/^\s*[✘X]\s*\[?\w*\]?\s*ERROR/gm)].length,
});

async function coldFill(cell, cacheDir) {
  if (!(await portFree(port))) throw new Error('port busy');
  rmSync(cacheDir, { recursive: true, force: true });
  const ctx = launch(cell, cacheDir);
  const listenAt = await waitListen(ctx);
  const meta = join(cacheDir, 'deps/_metadata.json');
  let metaAt = null;
  for (let i = 0; i < 15000; i++) { if (existsSync(meta)) { metaAt = Date.now() - ctx.t0; break; } if (ctx.proc.exitCode !== null) break; await sleep(50); }
  // also pay the first real page request, so the number is "server usable", not just "pid up"
  const root = listenAt === null ? null : await get('/');
  const parsed = parse(ctx.log);
  writeFileSync(join(outDir, 'final-' + cell + '-cold.log'), ctx.log);
  kill(ctx); rmSync(perfConfigPath, { force: true }); await sleep(900);
  return { cell, listenAt, metaAt, firstPageMs: root && root.ms, firstPageDoneAt: root && (listenAt + root.ms), ...parsed };
}
async function warmRun(cell, cacheDir, idx) {
  if (!(await portFree(port))) throw new Error('port busy');
  const ctx = launch(cell, cacheDir);
  const listenAt = await waitListen(ctx);
  const root = listenAt === null ? null : await get('/');
  const main = root ? await get('/src/main.ts') : null;
  const app = main ? await get('/src/App.vue') : null;
  const parsed = parse(ctx.log);
  writeFileSync(join(outDir, 'final-' + cell + '-warm' + idx + '.log'), ctx.log);
  kill(ctx); rmSync(perfConfigPath, { force: true }); await sleep(900);
  return { cell, listenAt, readyLog: parsed.readyLog, rootMs: root && root.ms, mainMs: main && main.ms, appMs: app && app.ms,
    totalToApp: (listenAt !== null && root && main && app) ? listenAt + root.ms + main.ms + app.ms : null,
    mcpLine: parsed.mcpLine, reloads: parsed.reloads, scanMs: parsed.scanMs, entryCount: parsed.entryCount };
}

const all = [];
for (let r = 0; r < rounds; r++) {
  for (const cell of cells) {
    const cacheDir = resolvePath('apps/desktop/node_modules/.vite-fin-' + cell);
    const cold = await coldFill(cell, cacheDir);
    all.push(cold);
    console.log('[cold] ' + JSON.stringify(cold));
    for (let i = 0; i < warmRuns; i++) {
      const w = await warmRun(cell, cacheDir, i);
      all.push(w);
      console.log('[warm] ' + JSON.stringify(w));
    }
    rmSync(cacheDir, { recursive: true, force: true });
  }
}
const med = (a) => { const s = a.filter((x) => typeof x === 'number').sort((x, y) => x - y); return s.length ? Math.round(s[Math.floor(s.length / 2)]) : null; };
const byCell = {};
for (const cell of cells) {
  const cold = all.filter((x) => x.cell === cell && x.metaAt !== undefined);
  const warm = all.filter((x) => x.cell === cell && x.readyLog !== undefined);
  byCell[cell] = {
    cold: cold.map((x) => ({ scan: x.scanMs, entries: x.entryCount, listen: x.listenAt, firstPageMs: x.firstPageMs, firstPageDoneAt: x.firstPageDoneAt, meta: x.metaAt, mcp: x.mcpLine })),
    warm: warm.map((x) => ({ listen: x.listenAt, ready: x.readyLog, root: x.rootMs, main: x.mainMs, app: x.appMs, totalToApp: x.totalToApp, mcp: x.mcpLine })),
    warmMedian: { listen: med(warm.map((x) => x.listenAt)), totalToApp: med(warm.map((x) => x.totalToApp)) },
    coldScan: cold.map((x) => x.scanMs),
  };
}
writeFileSync(join(outDir, 'final-summary.json'), JSON.stringify({ rounds, warmRuns, byCell, all }, null, 2));
console.log(JSON.stringify({ byCell }, null, 2));
process.exit(0);
