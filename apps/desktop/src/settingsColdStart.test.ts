// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from './api'
import { invalidateReadCache } from './lib/readCache'
import { setHostAccessStatus } from './lib/hostAccess'
import { setSelectedStorage } from './lib/storageScope'

/**
 * The settings cold start is measured as HTTP calls, not as milliseconds: the call count is
 * the mechanism behind the wait (seven loopback round trips versus one), and it does not
 * depend on how fast the machine running this test happens to be.
 */
const ready = { state: 'ready', managed: true } as const
const fetchMock = vi.fn()
const getHostStatus = vi.fn()

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

const snapshotParts = {
  providers: { ok: true, status: 200, data: [{ id: 'provider-1' }] },
  templates: { ok: true, status: 200, data: [{ driver: 'openai' }] },
  routes: { ok: true, status: 200, data: [{ purpose: 'chat', candidates: [] }] },
  acp_adapters: { ok: true, status: 200, data: [{ id: 'adapter-1' }] },
  model_readiness: { ok: true, status: 200, data: { ready: true } },
  catalog_readiness: { ok: true, status: 200, data: { ready: true } },
  readiness: { ok: true, status: 200, data: { items: [] } },
}

beforeEach(() => {
  invalidateReadCache()
  setHostAccessStatus(ready)
  setSelectedStorage('user')
  getHostStatus.mockReset().mockResolvedValue(ready)
  Object.defineProperty(window, 'tinadec', {
    configurable: true,
    value: { gatewayUrl: () => 'http://127.0.0.1:48730', getHostStatus, onHostStatusChanged: () => () => {} },
  })
  fetchMock.mockReset().mockImplementation(async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname
    if (path === '/api/v1/model-center/snapshot') return json({ parts: snapshotParts })
    return json([])
  })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  invalidateReadCache()
  setHostAccessStatus(ready)
  setSelectedStorage('user')
  vi.unstubAllGlobals()
  delete (window as unknown as { tinadec?: unknown }).tinadec
})

function calls() {
  return fetchMock.mock.calls.filter(([input]) => new URL(String(input)).pathname.startsWith('/api/v1/')).length
}

describe('settings cold start request count', () => {
  it('answers the whole model center from one request', async () => {
    const snapshot = await api.getModelCenterSnapshot()
    expect(snapshot.parts.providers.data).toEqual([{ id: 'provider-1' }])
    expect(calls()).toBe(1)
  })

  // A repeat mount *at the same time* (a second surface reading in one interaction) joins
  // the first read instead of issuing its own — that is what the single-flight buys. The
  // second call here is issued while the first is still in flight, so it costs no request.
  it('shares an in-flight snapshot read with a second caller', async () => {
    const [first, second] = await Promise.all([api.getModelCenterSnapshot(), api.getModelCenterSnapshot()])
    expect(calls()).toBe(1)
    expect(second).toEqual(first)
  })

  // The fallback for a Gateway that predates the snapshot: seven reads, one per section.
  it('reads the per-endpoint fallback once', async () => {
    await Promise.all([
      api.listModelProviders(),
      api.listModelProviderTemplates(),
      api.listModelRoutes(),
      api.listAcpAdapters(),
      api.getModelReadiness(),
      api.getModelCatalogReadiness(),
      api.readiness(),
    ])
    expect(calls()).toBe(7)
  })
})
