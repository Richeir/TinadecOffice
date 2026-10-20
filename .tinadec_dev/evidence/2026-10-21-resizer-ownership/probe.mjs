// Hit-maps the generated probe: which x positions reach the drag handle, and where the
// pill is drawn relative to the panel edge.
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

const harness = import.meta.dirname
mkdirSync(join(harness, 'chrome'), { recursive: true })
const child = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', '--remote-debugging-port=9421', '--user-data-dir=' + join(harness, 'chrome'), '--no-first-run', '--disable-gpu', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' })
for (let i = 0; i < 100; i++) { try { await (await fetch('http://127.0.0.1:9421/json/version')).json(); break } catch { await sleep(200) } }
const target = await (await fetch('http://127.0.0.1:9421/json/new?about:blank', { method: 'PUT' })).json()
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
await send('Emulation.setDeviceMetricsOverride', { width: 900, height: 400, deviceScaleFactor: 1, mobile: false })
await send('Page.navigate', { url: pathToFileURL(join(harness, 'generated.html')).href })
await sleep(900)

const result = await evaluate(`(() => {
  const panel = document.getElementById('a')
  const resizer = panel.querySelector('.uie-column-resizer')
  const p = panel.getBoundingClientRect()
  const r = resizer.getBoundingClientRect()
  const y = p.top + p.height / 2
  const rows = []
  for (let x = Math.round(p.right) - 12; x <= Math.round(p.right) + 12; x++) {
    const el = document.elementFromPoint(x, y)
    rows.push({ dx: x - Math.round(p.right), hit: !!(el && el.closest('.uie-column-resizer')), el: el ? (el.id || el.className || el.tagName) : 'none' })
  }
  return {
    panelRight: p.right,
    resizer: { left: r.left, right: r.right, width: r.width },
    clipOverflow: getComputedStyle(panel.querySelector('.uie-column-clip')).overflow,
    columnOverflow: getComputedStyle(panel).overflow,
    rows,
  }
})()`)

const hotspot = await evaluate(`(() => { const p = document.getElementById('a').getBoundingClientRect(); return { x: p.right, y: p.top + p.height / 2 } })()`)
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hotspot.x, y: hotspot.y, button: 'none' })
await sleep(350)
const clip = { x: hotspot.x - 26, y: hotspot.y - 40, width: 60, height: 80, scale: 6 }
const hover = await send('Page.captureScreenshot', { format: 'png', clip })
writeFileSync(join(harness, 'handle-hover.png'), Buffer.from(hover.data, 'base64'))

// Dragging: the pill has to stay visible after the pointer leaves the 12px strip.
await evaluate("document.getElementById('a').classList.add('is-resizing')")
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hotspot.x + 60, y: hotspot.y, button: 'none' })
await sleep(350)
const drag = await send('Page.captureScreenshot', { format: 'png', clip })
writeFileSync(join(harness, 'handle-drag.png'), Buffer.from(drag.data, 'base64'))

const hits = result.rows.filter(row => row.hit).map(row => row.dx)
console.log(JSON.stringify({
  columnOverflow: result.columnOverflow,
  clipOverflow: result.clipOverflow,
  resizer: result.resizer,
  panelRight: result.panelRight,
  hitRange: hits.length ? { from: Math.min(...hits), to: Math.max(...hits), count: hits.length } : null,
  rows: result.rows.map(row => `${row.dx}:${row.hit ? 'HIT' : row.el}`).join(' '),
}, null, 1))
socket.close()
child.kill()
