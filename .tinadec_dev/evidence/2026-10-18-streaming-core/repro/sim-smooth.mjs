// Reproduces the useSmoothText reveal-timing table in README.zh-CN.md section 9.
// Logic mirrors apps/desktop/src/composables/useSmoothText.ts (90 c/s, 0.3s catchUp, 60fps).
//   node .tinadec_dev/evidence/2026-10-18-streaming-core/repro/sim-smooth.mjs
const rate = 90, catchUp = 0.3;

function simulate(frames, gapMs) {
  const dt = 1000 / 60;
  let target = 0, revealed = 0, pace = rate, last = null;
  const seen = { maxBacklog: 0 };
  let t = 0, next = 0;
  while (t < 20000 && (next < frames.length || revealed < target)) {
    if (next < frames.length && t >= next * gapMs) { target += frames[next]; next++; }
    const backlog = target - revealed;
    seen.maxBacklog = Math.max(seen.maxBacklog, backlog);
    if (backlog <= 0) { revealed = target; pace = rate; last = null; }
    else {
      const elapsed = last === null ? 1 / 60 : dt / 1000;
      last = t;
      if (backlog / pace > catchUp) pace = backlog / catchUp;
      revealed = Math.min(target, revealed + Math.max(1, Math.ceil(pace * elapsed)));
    }
    t += dt;
  }
  return { maxBacklog: seen.maxBacklog, totalMs: t };
}

console.log("== single frame, nothing else arriving ==");
for (const n of [100, 216, 256, 489]) {
  const r = simulate([n], 10000);
  console.log("  N=" + String(n).padEnd(4) + " reveal=" + (r.totalMs / 1000).toFixed(2) + "s" +
    "  rate=" + (n / (r.totalMs / 1000)).toFixed(0) + " chars/s");
}

console.log();
console.log("== real measured frame sequences (from run_stream answer.delta) ==");
const cases = [
  ["1AD5BA8C 4 frames @3350ms", [268, 201, 34, 22], 3350],
  ["94FC4AD7 15 frames @240ms", [152, 268, 150, 213, 153, 195, 219, 205, 292, 158, 216, 183, 6, 299, 157], 240],
  ["6E36E2E4 2 frames @3318ms", [489, 328], 3318],
  ["synthetic 216 chars @265ms x10", Array(10).fill(216), 265],
];
for (const [name, frames, gap] of cases) {
  const r = simulate(frames, gap);
  const chars = frames.reduce((a, b) => a + b, 0);
  console.log("  " + name.padEnd(32) + " chars=" + String(chars).padEnd(5) +
    " maxBacklog=" + String(r.maxBacklog).padEnd(5) +
    " revealDone=" + (r.totalMs / 1000).toFixed(2) + "s");
}
console.log();
console.log("Conclusion: the catch-up rule (pace = backlog / 0.3) lifts any frame >27 chars");
console.log("to a 0.3s reveal, so the smooth layer adds ~0.3s, not seconds. The coarse");
console.log("granularity the user sees is Core's, not the renderer's.");
