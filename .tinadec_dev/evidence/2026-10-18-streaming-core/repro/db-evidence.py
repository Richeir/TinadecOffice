#!/usr/bin/env python3
"""Reproduce every database number in README.zh-CN.md against the real project store.

Read-only: opens SQLite with mode=ro, never writes.
    python .tinadec_dev/evidence/2026-10-18-streaming-core/repro/db-evidence.py
Override the scope with TINADEC_PROJECT_ROOT (default: C:/git/agent/RouterAPI/.tinadec).
"""
import glob
import json
import os
import sqlite3
import statistics
from collections import Counter, defaultdict
from datetime import datetime

BASE = os.environ.get("TINADEC_PROJECT_ROOT", r"C:/git/agent/RouterAPI/.tinadec")
con = sqlite3.connect("file:" + os.path.join(BASE, "data", "tinadec.db") + "?mode=ro", uri=True)
con.row_factory = sqlite3.Row

print("=" * 78)
print("A. run_stream kind census (whole history)")
print("=" * 78)
for row in con.execute("select kind, count(*) n, count(delta_length) with_delta from run_stream group by kind order by n desc"):
    print(f"  {row['kind']:<18} rows={row['n']:<5} with_delta={row['with_delta']}")
lens = [r[0] for r in con.execute("select delta_length from run_stream where kind='answer.delta'")]
if lens:
    s = sorted(lens)
    print(f"  answer.delta: n={len(s)} min={s[0]} p50={s[len(s) // 2]} mean={sum(s) / len(s):.0f} max={s[-1]}")
    print(f"  >=256: {sum(1 for x in s if x >= 256)}/{len(s)}    <64: {sum(1 for x in s if x < 64)}/{len(s)}")

print()
print("=" * 78)
print("B. per-run frame table")
print("=" * 78)
runs = {r["id"].lower(): dict(r) for r in con.execute("select id, status, turn_id from runs")}
turns = {r["id"].lower(): dict(r) for r in con.execute("select id, kind from turns")}
stream = defaultdict(list)
for r in con.execute("select run_id, kind, sequence, delta_length, created_at from run_stream order by run_id, sequence"):
    stream[r["run_id"].lower()].append(dict(r))
journal = defaultdict(Counter)
for f in glob.glob(os.path.join(BASE, "data", "events", "*.jsonl")):
    run = os.path.basename(f).split(".")[0].lower()
    for line in open(f, encoding="utf-8"):
        try:
            journal[run][json.loads(line).get("eventType") or ""] += 1
        except Exception:
            pass

hdr = f"{'run':9} {'status':12} {'turn':9} {'modelOut':>8} {'a.start':>7} {'a.delta':>7} {'finalD':>6} {'done':>4}  lens"
print(hdr); print("-" * len(hdr))
for run in sorted(runs):
    c = Counter(x["kind"] for x in stream.get(run, []))
    ls = [x["delta_length"] for x in stream.get(run, []) if x["kind"] == "answer.delta"]
    tk = turns.get((runs[run]["turn_id"] or "").lower(), {}).get("kind")
    print(f"{run[:8]:9} {runs[run]['status']:12} {str(tk):9} {journal[run].get('model.output.delta', 0):>8} "
          f"{c.get('answer.started', 0):>7} {c.get('answer.delta', 0):>7} {c.get('delta', 0):>6} {c.get('done', 0):>4}  {ls}")

print()
print("=" * 78)
print("C. journal delta census: the 3276 gate fingerprint (toplevel/text must be 0)")
print("=" * 78)
census = Counter()
for f in glob.glob(os.path.join(BASE, "data", "events", "*.jsonl")):
    for line in open(f, encoding="utf-8"):
        rec = json.loads(line)
        if rec.get("eventType") != "model.output.delta":
            continue
        p = rec.get("payload") or {}
        census[(("task" if p.get("task_id") else "toplevel"), p.get("channel"))] += 1
for k in sorted(census, key=lambda x: (str(x[0]), str(x[1]))):
    print(f"  model.output.delta  scope={k[0]:<9} channel={k[1]}: {census[k]}")

print()
print("=" * 78)
print("D. text frame size distribution (the 256 fingerprint)")
print("=" * 78)
text_frames, per_call = [], defaultdict(list)
for f in glob.glob(os.path.join(BASE, "data", "events", "*.jsonl")):
    for line in open(f, encoding="utf-8"):
        rec = json.loads(line)
        if rec.get("eventType") != "model.output.delta":
            continue
        p = rec.get("payload") or {}
        if p.get("channel") != "text":
            continue
        n = len(str(p.get("delta") or ""))
        text_frames.append(n)
        per_call[(p.get("response_id"), p.get("agent_name"), bool(p.get("task_id")))].append(n)
s = sorted(text_frames)
print(f"  n={len(s)} min={s[0]} p50={s[len(s) // 2]} p90={s[int(len(s) * 0.9)]} max={s[-1]} sum={sum(s)}")
buckets = Counter()
for x in text_frames:
    buckets["1-31" if x < 32 else "32-127" if x < 128 else "128-255" if x < 256 else "256-260" if x <= 260 else ">260"] += 1
for k in ["1-31", "32-127", "128-255", "256-260", ">260"]:
    print(f"  {k:<9} {buckets[k]:>4}  {'#' * min(60, buckets[k])}")
ge = [x for x in text_frames if x >= 256]
print(f"  >=256 total: {len(ge)}   overshoot<=4: {sum(1 for x in ge if x - 256 <= 4)}")

print()
print("=" * 78)
print("E. RIGOROUS lower bound: how many >=100ms pauses the provider's text stream had")
print("=" * 78)
print("  A frame <256 that is neither a channel's first frame nor the end-of-stream")
print("  flush can only come from the 100ms window branch, i.e. a real >=100ms pause.")
print(f"  {'call':9} {'agent':9} {'frames':>6} {'thresh':>6} {'<256':>5} {'min gaps':>9}")
total_gaps = 0
for k, v in sorted(per_call.items(), key=lambda x: -len(x[1])):
    thresh = sum(1 for x in v if x >= 256)
    small = len(v) - thresh
    gaps = max(0, small - 2)
    total_gaps += gaps
    print(f"  {str(k[0])[:8]:9} {str(k[1]):9} {len(v):>6} {thresh:>6} {small:>5} {gaps:>9}")
print(f"  TOTAL minimum >=100ms pauses = {total_gaps}")
print(f"  'single blob per call' allows at most 2 frames/call; observed max = {max(len(v) for v in per_call.values())}")

print()
print("=" * 78)
print("F. the 26 answer.delta frames the chat bubble actually received")
print("=" * 78)
rows = list(con.execute("select run_id, sequence, delta_length, created_at from run_stream "
                        "where kind='answer.delta' order by run_id, sequence"))
cur, prev, prevrun, gaps = None, None, None, []
for r in rows:
    if r["run_id"] != cur:
        cur = r["run_id"]; print(f"--- {cur[:8]}"); prevrun = r["run_id"]
    print(f"    seq={r['sequence']:<3} len={r['delta_length']:<5}")
    if r["run_id"] == prevrun and prev is not None:
        d1 = datetime.fromisoformat(prev.replace("Z", "+00:00"))
        d2 = datetime.fromisoformat(r["created_at"].replace("Z", "+00:00"))
        gaps.append((d2 - d1).total_seconds() * 1000)
    prev = r["created_at"]
if gaps:
    print(f"  gaps: n={len(gaps)} min={min(gaps):.0f}ms p50={statistics.median(gaps):.0f}ms max={max(gaps):.0f}ms")
    print(f"  <150ms: {sum(1 for g in gaps if g < 150)}/{len(gaps)}   "
          f"150-500ms: {sum(1 for g in gaps if 150 <= g < 500)}/{len(gaps)}   "
          f">=500ms: {sum(1 for g in gaps if g >= 500)}/{len(gaps)}")

print()
print("=" * 78)
print("G. preview completeness: sum(answer.delta) == authoritative delta ?")
print("=" * 78)
byrun = defaultdict(dict)
for rid, kind, sm, n in con.execute("select run_id, kind, sum(delta_length), count(*) from run_stream group by run_id, kind"):
    byrun[rid.lower()][kind] = (sm, n)
for rid in sorted(byrun):
    d = byrun[rid]
    if "answer.delta" in d:
        pv, fin = d["answer.delta"], d.get("delta", (None, 0))
        print(f"  {rid[:8]}  preview {pv[1]:>2} frames sum={pv[0]:<5} final={fin[0]:<5} "
              f"{'EQUAL' if pv[0] == fin[0] else 'DIFF'}")

print()
print("=" * 78)
print("H. frame-by-frame timeline of the runs that stream a preview")
print("=" * 78)
for run in sorted(runs):
    rows = stream.get(run, [])
    if not any(r["kind"] == "answer.delta" for r in rows):
        continue
    print(f"--- run {run[:8]} ({runs[run]['status']})")
    prev = None
    for r in rows:
        gap = ""
        if prev is not None:
            d1 = datetime.fromisoformat(prev.replace("Z", "+00:00"))
            d2 = datetime.fromisoformat(r["created_at"].replace("Z", "+00:00"))
            gap = f"  +{(d2 - d1).total_seconds() * 1000:9.1f} ms"
        print(f"    seq={r['sequence']:<3} {r['kind']:<15} len={str(r['delta_length']):>5}{gap}")
        prev = r["created_at"]
    print()
