#!/usr/bin/env bash
# Runs every streaming-granularity scenario against the fake provider and records raw output.
set -u
cd "$(dirname "$0")/../../.." || exit 1
OUT=.tinadec_dev/tmp/stream-core/results
BIN=.tinadec_dev/tmp/stream-core/artifacts/bin/StreamProbe/release/TinadecCore.AgentFramework.Tests.exe
mkdir -p "$OUT"

run() { # run <label> <plan> <protocol>
  local label="$1" plan="$2" proto="$3"
  echo "=== $label (plan=$plan protocol=$proto) ==="
  PROBE_LABEL="$label" PROBE_PLAN="$plan" PROBE_PROTOCOL="$proto" "$BIN" 2>&1 | tee "$OUT/$label.log" | grep -E '^\[probe\] (RAW count|PROD|REPLAY_MATCHES|CF |SUMMARY)'
}

run t01-chat-burst    burst    openai-chat
run t02-chat-dense    dense    openai-chat
run t03-chat-tok15    tok15    openai-chat
run t04-chat-tok40    tok40    openai-chat
run t05-chat-block200 block200 openai-chat
run t06-chat-block300 block300 openai-chat
run t07-chat-bulk     bulk     openai-chat
run t08-chat-realrun  realrun  openai-chat
run t09-resp-dense    dense    openai-responses
run t10-resp-tok15    tok15    openai-responses
run t11-resp-block200 block200 openai-responses
run t12-resp-bulk     bulk     openai-responses
echo "=== done ==="
