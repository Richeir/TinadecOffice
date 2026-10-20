// Visual proof of the fade: a small (realistic) width step holds the name's box while it
// fades, so a burst of screenshots lands inside the transition.
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const harness = import.meta.dirname
const pageUrl = process.argv[2]
const name = process.argv[3] ?? ''
mkdirSync(join(harness, 'chrome-profile'), { recursive: true })
const child = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', '--remote-debugging-port=9338', '--user-data-dir=' + join(harness, 'chrome-profile'), '--no-first-run', '--disable-gpu', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' })
for (let i = 0; i < 100; i++) { try { await (await fetch('http://127.0.0.1:9338/json/version')).json(); break } catch { await sleep(200) } }
const target = await (await fetch('http://127.0.0.1:9338/json/new?about:blank', { method: 'PUT' })).json()
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
await send('Page.navigate', { url: pageUrl + (name ? '?name=' + encodeURIComponent(name) : '') })
for (let i = 0; i < 200; i++) {
  if (await evaluate("!!document.querySelector('#rail .sidebar-footer')")) break
  await sleep(150)
}
await sleep(700)
await evaluate("document.getElementById('rail').style.transition = 'none'")

async function state() {
  return evaluate(`(() => {
    const el = document.querySelector('#rail .sidebar-profile-name')
    const cs = getComputedStyle(el)
    const box = el.getBoundingClientRect()
    return { opacity: Number(cs.opacity).toFixed(2), width: Math.round(box.width * 10) / 10,
      clientHeight: el.clientHeight, scrollHeight: el.scrollHeight, clientWidth: el.clientWidth, scrollWidth: el.scrollWidth }
  })()`)
}

// Vertical clipping check at full size (line-height vs descenders).
await evaluate("document.getElementById('rail').style.width = '320px'")
await sleep(400)
const settled = await state()

// Cross the threshold by 2px: the box is still held, so the fade is visible.
await evaluate("document.getElementById('rail').style.width = '188px'")
await sleep(300)
const before = await state()
await evaluate("document.getElementById('rail').style.width = '184px'")
const frames = []
for (let i = 0; i < 3; i++) {
  const snapshot = await state()
  const box = await evaluate(`(() => { const r = document.querySelector('#rail .sidebar-footer').getBoundingClientRect(); return { x: r.left - 2, y: r.top - 2, width: r.width + 4, height: r.height + 4 } })()`)
  const shot = await send('Page.captureScreenshot', { format: 'png', clip: { ...box, scale: 2 } })
  writeFileSync(join(harness, `fade-step-${i}.png`), Buffer.from(shot.data, 'base64'))
  frames.push(snapshot)
}
await sleep(400)
const after = await state()

// Same burst on the way in: the box appears at full width at once, so the mid-frame is a
// dimmed but complete name (no half glyph).
await evaluate("document.getElementById('rail').style.width = '150px'")
await sleep(400)
await evaluate("document.getElementById('rail').style.width = '320px'")
const revealFrames = []
for (let i = 0; i < 3; i++) {
  const snapshot = await state()
  const box = await evaluate(`(() => { const r = document.querySelector('#rail .sidebar-footer').getBoundingClientRect(); return { x: r.left - 2, y: r.top - 2, width: r.width + 4, height: r.height + 4 } })()`)
  const shot = await send('Page.captureScreenshot', { format: 'png', clip: { ...box, scale: 2 } })
  writeFileSync(join(harness, `reveal-step-${i}.png`), Buffer.from(shot.data, 'base64'))
  revealFrames.push(snapshot)
}
console.log(JSON.stringify({ settled, before, frames, after, revealFrames }, null, 1))
socket.close()
child.kill()
