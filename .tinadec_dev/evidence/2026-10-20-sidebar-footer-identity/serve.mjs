// Minimal vite server for the sidebar footer harness: serves one html page that
// mounts AppSidebar with fixture props. No Core/Gateway: the footer is a local
// component and the fit test is pure geometry.
import { createServer as createViteServer, loadConfigFromFile } from '../../../node_modules/vite/dist/node/index.js'
import { join, resolve } from 'node:path'
import { createServer } from 'node:http'

const repo = resolve(import.meta.dirname, '../../..')
const harness = import.meta.dirname

async function freePort() {
  const server = createServer()
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const port = server.address().port
  await new Promise(done => server.close(done))
  return port
}

const url = 'http://127.0.0.1:' + await freePort()
const config = await loadConfigFromFile({ command: 'serve', mode: 'development' }, join(repo, 'apps/desktop/vite.config.ts'))
const vite = await createViteServer({
  ...config.config,
  root: join(repo, 'apps/desktop'),
  configFile: false,
  // Own cache: reusing the app's node_modules/.vite makes vite delete it first.
  cacheDir: join(harness, 'vite-cache'),
  optimizeDeps: { entries: [], noDiscovery: true, include: ['vue-i18n', '@vue/runtime-dom', '@vue/runtime-vapor', '@lucide/vue', 'reka-ui', 'class-variance-authority', 'clsx', 'tailwind-merge'] },
  plugins: [...config.config.plugins.flat(Infinity).filter(plugin => !plugin?.name?.includes('mcp')), {
    name: 'sidebar-harness',
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = new URL(request.url, 'http://127.0.0.1').pathname
        if (path !== '/' && path !== '/index.html') { next(); return }
        response.setHeader('content-type', 'text/html')
        response.end(`<!doctype html><html data-theme="dark"><head><meta charset="utf-8"><title>侧边栏页脚验收</title></head><body><div id="app"></div><script type="module" src="/@fs/${join(harness, 'renderer.mjs').replaceAll('\\', '/')}"></script></body></html>`)
      })
    },
  }],
  server: { host: '127.0.0.1', port: Number(new URL(url).port), strictPort: true, fs: { allow: [repo] } },
})
await vite.listen()
console.log(url)
