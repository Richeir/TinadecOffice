import { readFileSync } from 'node:fs';
import path from 'node:path';
const { loadConfigFromFile } = await import('vite');
const r = await loadConfigFromFile({ command: 'serve', mode: 'development' }, path.resolve('apps/desktop/vite.config.ts'));
const names = [];
for (const p of r.config.plugins) {
  if (Array.isArray(p)) names.push('[array:' + p.length + '] ' + p.map((x) => x && x.name).join(','));
  else names.push((p && p.name) || String(p));
}
console.log('count:', r.config.plugins.length);
console.log(names.join('\n'));
console.log('has tailwind-ish:', names.some((n) => /tailwind/i.test(n)));
