import { spawn } from 'node:child_process';
import net from 'node:net';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// Fully isolated guard verification: the shipped script with only its port numbers remapped to
// four free test ports, plus a real .cmd "powershell" on PATH that logs each invocation and echoes
// a JSON payload from FAKE_PS_JSON. Nothing touches 48730/48731/5173/9222 and nothing is killed.
const T = { gateway: 5301, core: 5302, vite: 5303, devtools: 5304 };
const src = readFileSync('scripts/dev-port-guard.mjs', 'utf8').replace(/\r\n/g, '\n');
const g = src
  .replace('const PORTS = [48730, 48731, 5173, 9222];', `const PORTS = [${T.gateway}, ${T.core}, ${T.vite}, ${T.devtools}];`)
  .replace('const BLOCKING_PORTS = [48730, 48731, 5173];', `const BLOCKING_PORTS = [${T.gateway}, ${T.core}, ${T.vite}];`)
  .replace(/const PORT_LABELS = \{[\s\S]*?\};/, `const PORT_LABELS = { ${T.gateway}: 'Gateway', ${T.core}: 'Core', ${T.vite}: 'Vite dev server', ${T.devtools}: 'Electron DevTools' };`)
  .replace('if (listener.port === 9222) {', `if (listener.port === ${T.devtools}) {`)
  .replace('if (listeningPorts.has(9222)) {', `if (listeningPorts.has(${T.devtools})) {`);
mkdirSync('tmp/perf/sim', { recursive: true });
writeFileSync('tmp/perf/sim/guard-isolated.mjs', g);

const bin = 'tmp/perf/sim/bin';
rmSync(bin, { recursive: true, force: true });
mkdirSync(bin, { recursive: true });
// A working fake: logs, then echoes whatever FAKE_PS_JSON says (default: nothing -> empty query result).
writeFileSync(join(bin, 'powershell.cmd'),
  '@echo off\r\n>>"%~dp0ps-called.log" echo called %*\r\nif defined FAKE_PS_JSON echo %FAKE_PS_JSON%\r\nexit /b 0\r\n');
writeFileSync(join(bin, 'powershell'), '#!/bin/sh\necho called >> "$(dirname "$0")/ps-called.log"\n[ -n "$FAKE_PS_JSON" ] && printf "%s" "$FAKE_PS_JSON"\nexit 0\n');
const psLog = join(bin, 'ps-called.log');

async function scenario(name, portsToBind, fakeJson) {
  rmSync(psLog, { force: true });
  const servers = [];
  for (const p of portsToBind) {
    const s = net.createServer((c) => c.destroy());
    await new Promise((r) => s.listen(p, '127.0.0.1', r));
    servers.push(s);
  }
  const env = { ...process.env, TINADEC_DEV_PORT_GUARD: 'report', PATH: join(process.cwd(), bin) + ';' + process.env.PATH };
  if (fakeJson) env.FAKE_PS_JSON = fakeJson; else delete env.FAKE_PS_JSON;
  const t0 = Date.now();
  const child = spawn(process.execPath, ['tmp/perf/sim/guard-isolated.mjs'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let o = '';
  child.stdout.on('data', (d) => { o += d.toString(); });
  child.stderr.on('data', (d) => { o += d.toString(); });
  const code = await new Promise((r) => child.on('exit', r));
  const ms = Date.now() - t0;
  for (const s of servers) await new Promise((r) => s.close(r));
  return { name, ms, exitCode: code, powershellCalled: existsSync(psLog), output: o.trim().split('\n').filter(Boolean) };
}

const results = [];
results.push(await scenario('A: no listeners -> fast path, no PowerShell', [], null));
results.push(await scenario('B: only DevTools port bound -> fast path + advisory, no PowerShell', [T.devtools], null));
results.push(await scenario('C: Vite port bound -> falls through to PowerShell', [T.vite], null));
results.push(await scenario('D: DevTools + Vite bound -> falls through', [T.devtools, T.vite], null));
// E: ownership decision must still work: fake says the Vite listener is a foreign process
results.push(await scenario('E: ownership still enforced (foreign process reported, start blocked)',
  [T.vite],
  JSON.stringify([{ port: T.vite, pid: 999999, name: 'node.exe', cmdline: 'C:\\somewhere-else\\vite' }])));
// F: our own process (cmdline contains repo root) is reclaimed in report mode -> exit 1 with 占用中
results.push(await scenario('F: own leftover process still recognised (report mode)',
  [T.vite],
  JSON.stringify([{ port: T.vite, pid: 999998, name: 'node.exe', cmdline: process.cwd().replace(/\\/g, '\\\\') + '\\node_modules\\vite' }])));
console.log(JSON.stringify(results, null, 2));
process.exit(0);
