import { readFileSync } from 'node:fs';
const s = readFileSync('.tinadec_dev/evidence/2026-10-18-perf-dev/README.zh-CN.md', 'utf8');
const fences = (s.match(/^```/gm) || []).length;
console.log('code fences (line-start):', fences, 'even=' + (fences % 2 === 0));
const lines = s.split('\n');
console.log('total lines:', lines.length);
// table rows should all have same pipe count per contiguous block
let block = [];
const bad = [];
const flush = () => {
  if (block.length >= 2) {
    const counts = new Set(block.map((b) => b.pipes));
    if (counts.size > 1) bad.push(block.map((b) => b.line + ' pipes=' + b.pipes).join(' | '));
  }
  block = [];
};
lines.forEach((l, i) => {
  if (l.trim().startsWith('|')) block.push({ line: i + 1, pipes: (l.match(/\|/g) || []).length });
  else flush();
});
flush();
console.log('inconsistent table blocks:', bad.length);
bad.forEach((b) => console.log('  ' + b));
// heading list
console.log('headings:');
lines.filter((l) => /^#{2,3} /.test(l)).forEach((l) => console.log('  ' + l));
