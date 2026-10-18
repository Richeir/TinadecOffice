import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'

const root = process.argv[2] ?? 'apps/desktop/dist'
const port = Number(process.argv[3] ?? 5199)
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.map': 'application/json' }

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  let file = normalize(join(root, decodeURIComponent(url.pathname)))
  if (!file.startsWith(normalize(root))) { res.statusCode = 403; return res.end('no') }
  try {
    const info = await stat(file).catch(() => null)
    if (!info || info.isDirectory()) file = join(root, 'index.html')
    const body = await readFile(file)
    res.setHeader('content-type', types[extname(file)] ?? 'application/octet-stream')
    res.setHeader('cache-control', 'no-store')
    res.end(body)
  } catch (error) {
    res.statusCode = 404
    res.end(String(error))
  }
}).listen(port, '127.0.0.1', () => console.log('serving', root, 'on', port))
