import { readFileSync } from 'node:fs';
// Extract isOwnDevProcess() from the shipped guard and table-test it. No ports touched.
const src = readFileSync('scripts/dev-port-guard.mjs', 'utf8').replace(/\r\n/g, '\n');
const start = src.indexOf('function isOwnDevProcess');
let depth = 0, end = -1;
for (let i = src.indexOf('{', start); i < src.length; i++) {
  if (src[i] === '{') depth++;
  else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
}
const fnSrc = src.slice(start, end);
const repoRoot = process.cwd();
const normalizedRoot = repoRoot.toLowerCase().replace(/\//g, '\\');
const isOwnDevProcess = new Function('normalizedRoot', fnSrc + '\nreturn isOwnDevProcess;')(normalizedRoot);

const cases = [
  ['own Core exe', { name: 'TinadecCore.Api.exe', cmdline: 'X:\\elsewhere\\TinadecCore.Api.exe' }, true],
  ['own gateway bun --watch', { name: 'bun.exe', cmdline: 'bun --watch src/index.ts' }, true],
  ['bun --watch with backslash path', { name: 'bun.exe', cmdline: 'bun --watch src\\index.ts' }, true],
  ['vite inside repo', { name: 'node.exe', cmdline: normalizedRoot + '\\node_modules\\vite' }, true],
  ['electron inside repo', { name: 'electron.exe', cmdline: normalizedRoot + '\\apps\\desktop' }, true],
  ['foreign node', { name: 'node.exe', cmdline: 'C:\\other\\app\\server.js' }, false],
  ['bun without --watch', { name: 'bun.exe', cmdline: 'bun run src/index.ts' }, false],
  ['sibling dir with same prefix', { name: 'node.exe', cmdline: normalizedRoot + '-copy\\x.js' }, true],
];
const results = cases.map(([label, input, expected]) => {
  const actual = isOwnDevProcess(input);
  return { label, expected, actual, pass: actual === expected };
});
console.log(JSON.stringify({ allPass: results.every((r) => r.pass), results }, null, 1));
