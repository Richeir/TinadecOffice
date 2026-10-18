// 用真实 OpenAI 兼容 SSE 节奏（多 chunk + 真实间隔）验证 Core 的合并行为
// 目的：区分「provider 一次给一大块」vs「provider 给细粒度但被合并」
import { strict as assert } from 'node:assert'

// 复刻 ModelOutputStream.AddAsync 的合并逻辑（逐字对照 C#）
function simulate(updates, { threshold = 256, windowMs = 100 } = {}) {
  const frames = []
  let pending = '', channel = null
  let lastFlush = Number.NEGATIVE_INFINITY  // DateTimeOffset.MinValue
  const now = () => Date.now()
  function flush() {
    if (!pending) return
    frames.push({ channel, len: pending.length, text: pending })
    pending = ''
    lastFlush = now()
  }
  for (const u of updates) {
    if (channel !== u.channel) flush()
    channel = u.channel
    pending += u.text
    if (pending.length >= threshold || now() - lastFlush >= windowMs) flush()
  }
  flush()
  return frames
}

// 真实的 LLM token 节奏：每 15-40ms 一个 token，每个 token 1-4 个字符
function realisticAnswer(charCount, { minGap = 15, maxGap = 40 } = {}) {
  const updates = []
  let produced = 0
  let i = 0
  while (produced < charCount) {
    const size = 1 + (i % 4)
    const text = '字'.repeat(Math.min(size, charCount - produced))
    updates.push({ channel: 'text', text, at: i * 20 })
    produced += text.length
    i++
  }
  return updates
}

function simulateWithClock(updates) {
  const frames = []
  let pending = '', channel = null
  let lastFlush = Number.NEGATIVE_INFINITY
  let virtualNow = 0
  function flush() {
    if (!pending) return
    frames.push({ len: pending.length })
    pending = ''
    lastFlush = virtualNow
  }
  for (const u of updates) {
    virtualNow = u.at
    if (channel !== u.channel) flush()
    channel = u.channel
    pending += u.text
    if (pending.length >= 256 || virtualNow - lastFlush >= 100) flush()
  }
  flush()
  return frames
}

const CASES = [200, 400, 800, 2000]
console.log('=== 真实 token 节奏 (每 20ms 一个 token, 1-4 字符) 下的可见帧数 ===')
console.log('charCount | 可见帧数 | 每帧字符数')
for (const n of CASES) {
  const updates = realisticAnswer(n)
  const frames = simulateWithClock(updates)
  console.log(String(n).padStart(9) + ' | ' + String(frames.length).padStart(8) + ' | ' + frames.map(f => f.len).join(','))
}

console.log('')
console.log('=== 若改成纯时间驱动 (每 60ms 强制 flush) ===')
function simulateTimeDriven(updates, windowMs = 60) {
  const frames = []
  let pending = '', channel = null
  let lastFlush = Number.NEGATIVE_INFINITY
  let virtualNow = 0
  function flush() {
    if (!pending) return
    frames.push({ len: pending.length })
    pending = ''
    lastFlush = virtualNow
  }
  for (const u of updates) {
    virtualNow = u.at
    if (channel !== u.channel) flush()
    channel = u.channel
    pending += u.text
    // 时间优先，字符数只作为防爆兜底（1200 上限，避免极慢消费者堆积）
    if (virtualNow - lastFlush >= windowMs || pending.length >= 1200) flush()
  }
  flush()
  return frames
}
for (const n of CASES) {
  const updates = realisticAnswer(n)
  const frames = simulateTimeDriven(updates)
  console.log(String(n).padStart(9) + ' | ' + String(frames.length).padStart(8) + ' | avg ' + Math.round(n / frames.length) + ' chars/frame')
}
