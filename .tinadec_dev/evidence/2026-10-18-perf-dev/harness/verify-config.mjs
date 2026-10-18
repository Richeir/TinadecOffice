import { readFileSync } from 'node:fs';
import path from 'node:path';

const src = readFileSync('apps/desktop/vite.config.ts', 'utf8');
console.log('has watch.ignored:', /ignored:\s*\['\*\*\/release\/\*\*'/.test(src));
console.log('has optimizeDeps.entries:', /entries:\s*\['index\.html'\]/.test(src));
console.log('VueMcp conditional:', /vueMcpEnabled \? \[VueMcp\(\)\] : \[\]/.test(src));
console.log('old unconditional VueMcp gone:', !/plugins: \[vue\(\), tailwindcss\(\), VueMcp\(\)\]/.test(src));

// Load it for real through Vite's config loader so a syntax/type error would surface.
const { loadConfigFromFile } = await import('vite');
const r = await loadConfigFromFile({ command: 'serve', mode: 'development' }, path.resolve('apps/desktop/vite.config.ts'));
const c = r.config;
console.log('--- resolved config ---');
console.log('optimizeDeps.entries =', JSON.stringify(c.optimizeDeps.entries));
console.log('server.watch.ignored =', JSON.stringify(c.server.watch.ignored));
console.log('plugins =', c.plugins.map((p) => p && p.name).filter(Boolean).join(', '));
console.log('mcp enabled by default =', c.plugins.some((p) => p && /mcp/i.test(p.name || '')));
