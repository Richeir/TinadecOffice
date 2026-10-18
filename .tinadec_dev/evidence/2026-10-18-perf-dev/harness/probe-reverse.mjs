import { spawn } from 'node:child_process';
import http from 'node:http';
import { readFileSync } from 'node:fs';

const out = {};

// ---------- B: reverse test — does waitForVite reject fast when Vite dies at once? ----------
const src = readFileSync('apps/desktop/scripts/dev.mjs', 'utf8').replace(/\r\n/g, '\n');
const start = src.indexOf('function waitForVite()');
let depth = 0, end = -1;
for (let i = src.indexOf('{', start); i < src.length; i++) {
  if (src[i] === '{') depth++;
  else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
}
const fnSrc = src.slice(start, end).replace(/5173/g, '5297');
const dying = spawn(process.execPath, ['-e', 'process.exit(3)'], { stdio: 'ignore' });
const factory = new Function('viteProcess', 'http', fnSrc + '\nreturn waitForVite();');
const t2 = Date.now();
let rejected = null;
try {
  await Promise.race([factory(dying, http), new Promise((_, rej) => setTimeout(() => rej(new Error('TIMED OUT after 20s')), 20000))]);
} catch (e) { rejected = String(e.message); }
out.waitForViteEarlyExit = { msToReject: Date.now() - t2, error: rejected };

// ---------- C: what IS listening right now on the guarded ports ----------
const { execFileSync } = await import('node:child_process');
const ns = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8' });
out.liveListeners = ns.split(/\r?\n/).filter((l) => /:(48730|48731|5173|9222)\s/.test(l) && /LISTENING/.test(l)).map((l) => l.trim());

console.log(JSON.stringify(out, null, 2));
process.exit(0);
