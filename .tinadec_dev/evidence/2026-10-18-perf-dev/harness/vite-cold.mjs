import { spawn, execSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import net from 'node:net';
import http from 'node:http';

// Cold dev-server measurement harness.
//   node tmp/perf/vite-cold.mjs <label> <cacheDir> <port> [--no-mcp] [--entries] [--ignore-watch] [--includes]
// Patches a COPY of the real vite.config.ts (never the tracked file), runs a fresh dep cache,
// then loads the page twice through the CDP probe.
const args = process.argv.slice(2);
const [label, cacheDir, portArg = '5288'] = args;
const flags = new Set(args.slice(3).filter((a) => a.startsWith('--')));
const port = Number(portArg);
const outDir = 'tmp/perf/runs';
mkdirSync(outDir, { recursive: true });

function portFree(p) {
  return new Promise((r) => { const s = net.createServer(); s.once('error', () => r(false)); s.once('listening', () => s.close(() => r(true))); s.listen(p, '127.0.0.1'); });
}
if (!(await portFree(port))) { console.error('port ' + port + ' busy; abort'); process.exit(2); }

const desktopDir = resolvePath('apps/desktop');
const perfConfigPath = join(desktopDir, 'vite.perf.config.ts');
let config = readFileSync(join(desktopDir, 'vite.config.ts'), 'utf8');
config = config.replace('export default defineConfig({', 'export default defineConfig({\n  cacheDir: process.env.PERF_CACHE_DIR,');
config = config.replace(/port: 5173,/, 'port: Number(process.env.PERF_PORT ?? ' + port + '),');
if (flags.has('--no-mcp')) {
  config = config.replace('plugins: [vue(), tailwindcss(), VueMcp()]', 'plugins: [vue(), tailwindcss()]');
  config = config.replace("import { VueMcp } from 'vite-plugin-vue-mcp';", '');
}
if (flags.has('--entries')) {
  config = config.replace('optimizeDeps: {', "optimizeDeps: {\n    entries: ['index.html'],");
}
if (flags.has('--ignore-watch')) {
  config = config.replace('server: {', "server: {\n    watch: { ignored: ['**/release/**', '**/runtime/**', '**/dist/**'] },");
}
if (flags.has('--includes')) {
  config = config.replace(/include: \[\s*'@xterm\/xterm',\s*'@xterm\/addon-fit',\s*'@xterm\/addon-web-links',\s*\],/,
    `include: [
      '@xterm/xterm',
      '@xterm/addon-fit',
      '@xterm/addon-web-links',
      'vue',
      'vue-router',
      'pinia',
      'vue-i18n',
      'reka-ui',
      '@lucide/vue',
      '@vueuse/core',
      'marked',
      'marked-footnote',
      'marked-katex-extension',
      'dompurify',
      'highlight.js/lib/core',
      'date-fns',
      '@vue-flow/core',
      'monaco-editor',
      'mermaid',
    ],`);
}
writeFileSync(perfConfigPath, config);

const absCache = resolvePath(cacheDir);
rmSync(absCache, { recursive: true, force: true });
const logPath = join(outDir, label + '.vite.log');
const t0 = Date.now();
const entry = resolvePath('node_modules/vite/bin/vite.js');
const vite = spawn(process.execPath, [entry, '--config', perfConfigPath, '--port', String(port), '--strictPort'], {
  cwd: desktopDir,
  env: { ...process.env, PERF_CACHE_DIR: absCache, PERF_PORT: String(port), DEBUG: 'vite:deps' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
vite.stdout.on('data', (d) => { log += d.toString(); });
vite.stderr.on('data', (d) => { log += d.toString(); });
function killTree() { try { execSync('taskkill /PID ' + vite.pid + ' /T /F', { stdio: 'ignore' }); } catch {} }

function get(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: 2000 }, (res) => { res.resume(); resolve(res.statusCode); });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}
let readyAt = null;
for (let i = 0; i < 1800; i++) {
  if (vite.exitCode !== null) break;
  try { const s = await get('http://127.0.0.1:' + port + '/'); if (s) { readyAt = Date.now() - t0; break; } } catch {}
  await new Promise((r) => setTimeout(r, 100));
}
const readyLogMs = (() => { const m = log.match(/ready in (\d+) ?ms/); return m ? Number(m[1]) : null; })();
const scanMs = (() => { const m = log.match(/Scan completed in ([\d.]+)ms/); return m ? Math.round(Number(m[1])) : null; })();
const scanEntries = (() => { const m = log.match(/Crawling dependencies using entries:([\s\S]*?)\n\d{4}-/); return m ? m[1].split('\n').map((s) => s.trim()).filter(Boolean) : []; })();

if (readyAt === null) {
  writeFileSync(logPath, log);
  rmSync(perfConfigPath, { force: true });
  console.log(JSON.stringify({ label, ok: false, log: log.slice(-3000) }, null, 2));
  killTree();
  process.exit(1);
}

const probeOnce = async (suffix) => {
  const probe = spawn(process.execPath, ['tmp/perf/probe.mjs', 'http://127.0.0.1:' + port + '/'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  probe.stdout.on('data', (d) => { out += d.toString(); });
  probe.stderr.on('data', (d) => { out += d.toString(); });
  const code = await new Promise((resolve) => probe.on('exit', resolve));
  writeFileSync(join(outDir, label + suffix + '.probe.json'), out);
  let pj = null;
  try { pj = JSON.parse(out); } catch {}
  if (!pj || !pj.result) return { probeExit: code, failed: true };
  const r = pj.result;
  return {
    probeExit: code,
    wallMs: pj.wallMs,
    fcp: r.paint ? r.paint['first-contentful-paint'] : null,
    mainAt: r.main && r.main.at ? Math.round(r.main.at) : null,
    shellAt: r.shell && r.shell.at ? Math.round(r.shell.at) : null,
    loadEvent: Math.round(r.loadEvent),
    longTaskTotal: Math.round(r.longTaskTotal),
    resourceCount: r.resourceCount,
    resourceBytes: r.resourceBytes,
    requestCount: pj.requestCount,
    totalEncodedBytes: pj.totalEncodedBytes,
    errors: r.errors,
  };
};
const firstLoad = await probeOnce('.probe1');
const secondLoad = await probeOnce('.probe2');
await new Promise((r) => setTimeout(r, 1500));

const optimizes = [...log.matchAll(/new dependencies optimized: ([^\n]+)/g)].map((m) => m[1].trim());
const result = {
  label, port, flags: [...flags],
  coldListenMs: readyAt,
  readyLogMs,
  depScanMs: scanMs,
  depScanEntryCount: scanEntries.length,
  depScanEntries: scanEntries.slice(0, 12),
  depsCacheCreated: (() => { try { readFileSync(join(absCache, 'deps/_metadata.json')); return true; } catch { return false; } })(),
  optimizeWaves: optimizes.length,
  optimizedModules: optimizes.slice(0, 20),
  pageReloads: (log.match(/page reload/g) || []).length,
  firstLoad,
  secondLoad,
};
writeFileSync(logPath, log);
writeFileSync(join(outDir, label + '.summary.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
killTree();
rmSync(perfConfigPath, { force: true });
process.exit(0);
