// Drives a real Chromium over CDP: resizes the nav column and reports whether the
// nickname is up, then captures the footer at two widths.
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const harness = import.meta.dirname
const pageUrl = process.argv[2]
const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const profile = join(harness, 'chrome-profile')
mkdirSync(profile, { recursive: true })
const child = spawn(chrome, ['--headless=new', '--remote-debugging-port=9333', '--user-data-dir=' + profile, '--no-first-run', '--disable-gpu', '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' })

async function version() {
  for (let i = 0; i < 100; i++) {
    try { return await (await fetch('http://127.0.0.1:9333/json/version')).json() } catch { await sleep(200) }
  }
  throw new Error('chrome did not expose CDP')
}

let socket, nextId = 0
const pending = new Map()
function send(method, params = {}, sessionId) {
  const id = ++nextId
  socket.send(JSON.stringify({ id, method, params, sessionId }))
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}

const info = await version()
const target = await (await fetch('http://127.0.0.1:9333/json/new?about:blank', { method: 'PUT' })).json()
socket = new WebSocket(target.webSocketDebuggerUrl)
await new Promise(done => socket.addEventListener('open', done, { once: true }))
socket.addEventListener('message', event => {
  const message = JSON.parse(event.data)
  const entry = pending.get(message.id)
  if (!entry) return
  pending.delete(message.id)
  if (message.error) entry.reject(new Error(JSON.stringify(message.error)))
  else entry.resolve(message.result)
})

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 900, height: 780, deviceScaleFactor: 1, mobile: false })
await send('Page.navigate', { url: pageUrl })
for (let i = 0; i < 200; i++) {
  const { result } = await send('Runtime.evaluate', { expression: "!!document.querySelector('.sidebar-footer')", returnByValue: true })
  if (result.value) break
  await sleep(150)
}
await sleep(600)

async function evaluate(expression) {
  const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (exceptionDetails) throw new Error(JSON.stringify(exceptionDetails))
  return result.value
}

async function setWidth(width) {
  await evaluate(`document.getElementById('rail').style.width = '${width}px'`)
  await sleep(450)
  return evaluate(`(() => {
    const footer = document.querySelector('#rail .sidebar-footer')
    const button = document.querySelector('#rail .sidebar-profile')
    const name = document.querySelector('#rail .sidebar-profile-name')
    const actions = document.querySelector('#rail .sidebar-footer-actions')
    const avatar = document.querySelector('#rail .personal-avatar')
    const left = button.getBoundingClientRect()
    const right = actions.getBoundingClientRect()
    return {
      rail: Math.round(document.getElementById('rail').getBoundingClientRect().width),
      footer: Math.round(footer.getBoundingClientRect().width),
      named: button.classList.contains('sidebar-profile--named'),
      name: name ? name.textContent : null,
      gapBeforeActions: name ? Math.round(right.left - (left.left + 3 + 20 + 6 + name.getBoundingClientRect().width)) : null,
      avatar: Math.round(avatar.getBoundingClientRect().width),
      overflow: Math.round(left.width) > Math.round(footer.getBoundingClientRect().width),
    }
  })()`)
}

const rows = []
for (const width of [360, 320, 300, 280, 260, 240, 220, 200, 180]) rows.push(await setWidth(width))
console.log(JSON.stringify(rows, null, 1))

await setWidth(300)
let shot = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 460, height: 680, scale: 1 } })
const { writeFileSync } = await import('node:fs')
writeFileSync(join(harness, 'footer-wide.png'), Buffer.from(shot.data, 'base64'))
await setWidth(200)
shot = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 460, height: 680, scale: 1 } })
writeFileSync(join(harness, 'footer-narrow.png'), Buffer.from(shot.data, 'base64'))
// Close-up of the footer itself at both widths, plus the collapsed rail.
for (const [name, width] of [['footer-crop-wide', 300], ['footer-crop-narrow', 200]]) {
  await setWidth(width)
  const box = await evaluate(`(() => { const r = document.querySelector('#rail .sidebar-footer').getBoundingClientRect(); const c = document.querySelector('#collapsed-rail .sidebar-footer').getBoundingClientRect(); return { x: r.left, y: c.top - 8, width: r.width, height: (r.bottom - c.top) + 16 } })()`)
  shot = await send('Page.captureScreenshot', { format: 'png', clip: { ...box, scale: 2 } })
  writeFileSync(join(harness, name + '.png'), Buffer.from(shot.data, 'base64'))
}

// A long nickname in a wide column: the pill has to stay intact beside the actions.
await send('Page.navigate', { url: pageUrl + '?name=' + encodeURIComponent('风眠不吃香菜') })
for (let i = 0; i < 200; i++) {
  const { result } = await send('Runtime.evaluate', { expression: "!!document.querySelector('#rail .sidebar-footer')", returnByValue: true })
  if (result.value) break
  await sleep(150)
}
await sleep(600)
const longRow = await setWidth(360)
console.log('LONG', JSON.stringify(longRow))
const hoverBox = await evaluate(`(() => { const r = document.querySelector('#rail .sidebar-profile').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 } })()`)
await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: hoverBox.x, y: hoverBox.y, button: 'none' })
await sleep(300)
const footerBox = await evaluate(`(() => { const r = document.querySelector('#rail .sidebar-footer').getBoundingClientRect(); return { x: r.left - 4, y: r.top - 4, width: r.width + 8, height: r.height + 8 } })()`)
shot = await send('Page.captureScreenshot', { format: 'png', clip: { ...footerBox, scale: 2 } })
writeFileSync(join(harness, 'footer-long.png'), Buffer.from(shot.data, 'base64'))

socket.close()
child.kill()
console.log('screenshots written to', harness)
