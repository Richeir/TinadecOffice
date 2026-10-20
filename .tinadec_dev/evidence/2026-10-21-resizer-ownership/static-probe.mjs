// Maps the handle's hit area on the shipping CSS and on the same box with the clip removed.
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

const harness = import.meta.dirname
mkdirSync(join(harness, 'chrome-static'), { recursive: true })
const child = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', '--remote-debugging-port=9420', '--user-data-dir=' + join(harness, 'chrome-static'), '--no-first-run', '--disable-gpu', '--hide-scrollbars', '--allow-file-access-from-files', 'about:blank'], { stdio: 'ignore' })
for (let i = 0; i < 100; i++) { try { await (await fetch('http://127.0.0.1:9420/json/version')).json(); break } catch { await sleep(200) } }
const target = await (await fetch('http://127.0.0.1:9420/json/new?about:blank', { method: 'PUT' })).json()
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
await send('Emulation.setDeviceMetricsOverride', { width: 900, height: 420, deviceScaleFactor: 1, mobile: false })
await send('Page.navigate', { url: pathToFileURL(join(harness, 'static.html')).href })
await sleep(800)

const scan = `(panelId) => {
  const panel = document.getElementById(panelId)
  const resizer = panel.querySelector('.uie-column-resizer')
  const p = panel.getBoundingClientRect()
  const r = resizer.getBoundingClientRect()
  const y = p.top + p.height / 2
  const rows = []
  for (let x = Math.round(p.right) - 7; x <= Math.round(p.right) + 7; x++) {
    const el = document.elementFromPoint(x, y)
    rows.push({ dx: x - Math.round(p.right), hit: !!(el && el.closest('.uie-column-resizer')), el: el ? (el.id || el.className || el.tagName) : 'none' })
  }
  return { panelRight: p.right, resizer: { left: r.left, right: r.right, width: r.width }, rows }
}`

const clipped = await evaluate(`(${scan})('clipped')`)
const unclipped = await evaluate(`(${scan})('unclipped')`)
const hits = rows => rows.filter(r => r.hit).map(r => r.dx)

// Hover the seam of the shipping box and capture it at 6x.
const seam = await evaluate(`(() => { const p = document.getElementById('clipped').getBoundingClientRect(); return { x: p.right, y: p.top + p.height / 2 } })()`)
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: seam.x - 2, y: seam.y, button: 'none' })
await sleep(350)
const shot = await send('Page.captureScreenshot', { format: 'png', clip: { x: seam.x - 26, y: seam.y - 40, width: 60, height: 80, scale: 6 } })
writeFileSync(join(harness, 'handle-zoom.png'), Buffer.from(shot.data, 'base64'))

console.log(JSON.stringify({
  clipped: { resizer: clipped.resizer, hits: hits(clipped.rows) },
  unclipped: { resizer: unclipped.resizer, hits: hits(unclipped.rows) },
  clippedRows: clipped.rows,
}, null, 1))
socket.close()
child.kill()
