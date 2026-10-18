import { readFileSync, readdirSync } from 'node:fs';
const d = 'tmp/perf/runs';
const rows = [];
for (const f of readdirSync(d).filter((x) => x.endsWith('.log')).sort()) {
  const s = readFileSync(d + '/' + f, 'utf8').replace(/\r\n/g, '\n');
  const i = s.indexOf('Crawling dependencies using entries:');
  let entryFiles = [];
  if (i >= 0) {
    const rest = s.slice(i + 'Crawling dependencies using entries:'.length);
    for (const line of rest.split('\n').slice(0, 4000)) {
      const t = line.trim();
      if (!t) { if (entryFiles.length) break; else continue; }
      if (/^\d{4}-\d\d-\d\dT/.test(t) || /^(➜|VITE|vite:)/.test(t)) break;
      entryFiles.push(t);
    }
  }
  const scan = (/Scan completed in ([\d.]+)ms/.exec(s) || [])[1];
  const ready = (/ready in (\d+) ?ms/.exec(s) || [])[1];
  rows.push({
    file: f,
    entries: entryFiles.length,
    scanMs: scan ? Math.round(Number(scan)) : null,
    readyMs: ready ? Number(ready) : null,
    mcp: /MCP:\s+Server is running/.test(s),
    htmlEntries: entryFiles.filter((p) => p.includes('release/') || p.includes('runtime/')).length,
    crash: /EBUSY/.test(s),
  });
}
console.log(JSON.stringify(rows, null, 1));
