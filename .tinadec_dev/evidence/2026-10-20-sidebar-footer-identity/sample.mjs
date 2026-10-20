// Real-time sampling of the nickname fade (no animation pausing: pausing a
// transition inside its delay phase drops the held value and lies about the layout).
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const harness = import.meta.dirname
const pageUrl = process.argv[2]
mkdirSync(join(harness, 'chrome-profile'), { recursive: true })
const child = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', '--remote-debugging-port=9337', '--user-data-dir=' + join(harness, 'chrome-profile'), '--no-first-run', '--disable-gpu', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' })
for (let i = 0; i < 100; i++) { try { await (await fetch('http://127.0.0.1:9337/json/version')).json(); break } catch { await sleep(200) } }
const target = await (await fetch('http://127.0.0.1:9337/json/new?about:blank', { method: 'PUT' })).json()
const socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise(done => socket.addEventListener('open', done, { once: true }))
let nextId = 0
const pending = new Map()
function send(method, params = {}) {
  const id = ++nextId
  socket.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}
socket.addEventListener('message', event => {
  const message = JSON.parse(event.data)
  const entry = pending.get(message.id)
  if (!entry) return
  pending.delete(message.id)
  if (message.error) entry.reject(new Error(JSON.stringify(message.error)))
  else entry.resolve(message.result)
})
async function evaluate(expression) {
  const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (exceptionDetails) throw new Error(JSON.stringify(exceptionDetails))
  return result.value
}
await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 900, height: 780, deviceScaleFactor: 1, mobile: false })
await send('Page.navigate', { url: pageUrl })
for (let i = 0; i < 200; i++) {
  if (await evaluate("!!document.querySelector('#rail .sidebar-footer')")) break
  await sleep(150)
}
await sleep(700)
await evaluate("document.getElementById('rail').style.transition = 'none'")

// One in-page sampler: rAF loop, so the timeline is not limited by CDP round trips.
async function record(ms) {
  return evaluate(`new Promise(done => {
    const name = document.querySelector('#rail .sidebar-profile-name')
    const started = performance.now()
    const rows = []
    const tick = () => {
      const cs = getComputedStyle(name)
      const box = name.getBoundingClientRect()
      rows.push({
        t: Math.round(performance.now() - started),
        maxWidth: Math.round(parseFloat(cs.maxWidth) * 10) / 10,
        opacity: Number(cs.opacity).toFixed(2),
        width: Math.round(box.width * 10) / 10,
      })
      if (performance.now() - started < ${ms}) requestAnimationFrame(tick)
      else done(rows)
    }
    requestAnimationFrame(tick)
  })`)
}

async function resize(width) {
  await evaluate(`document.getElementById('rail').style.width = '${width}px'`)
}

await resize(150)
await sleep(400)
const reveal = await Promise.all([resize(300).then(() => record(420))]).then(rows => rows[0])
await sleep(200)

// A realistic drag: the splitter moves ~4px per frame, so the threshold is crossed by a
// few pixels at a time rather than in one 150px jump.
const drag = await evaluate(`new Promise(done => {
  const name = document.querySelector('#rail .sidebar-profile-name')
  const rail = document.getElementById('rail')
  rail.style.width = '300px'
  const rows = []
  const started = performance.now()
  let step = 0
  const walk = () => {
    const width = Math.max(150, 300 - step * 4)
    rail.style.width = width + 'px'
    step++
    const cs = getComputedStyle(name)
    const box = name.getBoundingClientRect()
    rows.push({ t: Math.round(performance.now() - started), rail: width, maxWidth: Math.round(parseFloat(cs.maxWidth) * 10) / 10, opacity: Number(cs.opacity).toFixed(2), width: Math.round(box.width * 10) / 10 })
    if (width > 150) requestAnimationFrame(walk)
    else setTimeout(() => done(rows), 400)
  }
  requestAnimationFrame(walk)
})`)
const hideRows = await Promise.all([resize(185).then(() => record(260))]).then(rows => rows[0])

const settle = await evaluate(`(() => {
  const name = document.querySelector('#rail .sidebar-profile-name')
  const cs = getComputedStyle(name)
  return { maxWidth: cs.maxWidth, opacity: cs.opacity, width: name.getBoundingClientRect().width, scrollWidth: name.scrollWidth }
})()`)

writeFileSync(join(harness, 'timeline.json'), JSON.stringify({ reveal, hide: hideRows, settle }, null, 1))
const sample = rows => rows.filter((_, i) => i % 2 === 0).map(r => `${r.t}ms w=${r.width} max=${r.maxWidth} op=${r.opacity}`)
console.log('REVEAL'); sample(reveal).forEach(line => console.log('  ' + line))
console.log('HIDE (300 -> 185, one step)'); sample(hideRows).forEach(line => console.log('  ' + line))
console.log('DRAG 300 -> 150 at 4px/frame')
drag.filter(r => r.rail <= 210 && r.rail >= 174).forEach(r => console.log('  ' + JSON.stringify(r)))
console.log('SETTLE', JSON.stringify(settle))
socket.close()
child.kill()
