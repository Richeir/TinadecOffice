// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from './api'
import { READ_CACHE_TTL_MS, CATALOG_READ_CACHE_TTL_MS, invalidateReadCache } from './lib/readCache'
import { setHostAccessStatus } from './lib/hostAccess'
import { setSelectedStorage } from './lib/storageScope'

const ready = { state: 'ready', managed: true } as const
const fetchMock = vi.fn()
const getHostStatus = vi.fn()

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
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
    if (path === '/api/v1/model-providers') return json([{ id: 'provider-1' }])
    if (path === '/api/v1/model-routes') return json([{ purpose: 'chat', candidates: [] }])
    if (path === '/api/v1/agents') return json([{ id: 'agent-1' }])
    if (path === '/api/v1/agent-modes') return json([{ id: 'mode-1' }])
    if (path === '/api/v1/agent-candidates') return json([{ id: 'candidate-1' }])
    if (path === '/api/v1/model-readiness') return json({ ready: true })
    return json({ ok: true })
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

function callsFor(path: string) {
  return fetchMock.mock.calls.filter(([input]) => new URL(String(input)).pathname === path).length
}

describe('shared read cache', () => {
  it('shares one request between callers that read the same projection', async () => {
    const [first, second] = await Promise.all([api.listModelProviders(), api.listModelProviders()])
    expect(callsFor('/api/v1/model-providers')).toBe(1)
    expect(first).toEqual([{ id: 'provider-1' }])
    expect(second).toEqual(first)
  })

  it('serves a repeat read from the short TTL window', async () => {
    await api.listAgentModeTopologies()
    await api.listAgentModeTopologies()
    expect(callsFor('/api/v1/agent-modes')).toBe(1)
  })

  it('reads again once the TTL has passed', async () => {
    await api.listAgentCandidates()
    const realNow = Date.now
    Date.now = () => realNow() + READ_CACHE_TTL_MS + 1
    try {
      await api.listAgentCandidates()
    } finally {
      Date.now = realNow
    }
    expect(callsFor('/api/v1/agent-candidates')).toBe(2)
  })

  it('invalidates the projections after a write', async () => {
    await api.listModelRoutes()
    await api.saveModelRoute('chat', { candidates: [{ provider_instance_id: 'provider-1', model: 'gpt-5' }] })
    await api.listModelRoutes()
    expect(callsFor('/api/v1/model-routes')).toBe(2)
  })

  // Readiness is a live health receipt: the seconds tier, not the catalog window. Caching it
  // at all is what stops the settings cold start from asking three times for one answer.
  it('keeps the readiness receipts on the short tier', async () => {
    await api.getModelReadiness()
    await api.getModelReadiness()
    expect(callsFor('/api/v1/model-readiness')).toBe(1)
    const realNow = Date.now
    Date.now = () => realNow() + READ_CACHE_TTL_MS + 1
    try {
      await api.getModelReadiness()
    } finally {
      Date.now = realNow
    }
    expect(callsFor('/api/v1/model-readiness')).toBe(2)
  })

  // The cold-start surface: templates, adapters and the catalog receipt are configuration
  // directories, so a second mount inside one interaction must not re-ask Core.
  it('serves the catalog endpoints from the long tier', async () => {
    await api.listModelProviderTemplates()
    await api.listAcpAdapters()
    await api.getModelCatalogReadiness()
    const realNow = Date.now
    // Well past the short tier, well inside the catalog window: asserting at window-1 ms
    // would race the few milliseconds the awaits themselves take.
    Date.now = () => realNow() + CATALOG_READ_CACHE_TTL_MS / 2
    try {
      await api.listModelProviderTemplates()
      await api.listAcpAdapters()
      await api.getModelCatalogReadiness()
    } finally {
      Date.now = realNow
    }
    expect(callsFor('/api/v1/model-provider-templates')).toBe(1)
    expect(callsFor('/api/v1/acp/adapters')).toBe(1)
    expect(callsFor('/api/v1/model-catalog-readiness')).toBe(1)
  })

  it('still drops the catalog tier as soon as a write lands', async () => {
    await api.listModelProviderTemplates()
    await api.saveModelRoute('chat', { candidates: [{ provider_instance_id: 'provider-1', model: 'gpt-5' }] })
    await api.listModelProviderTemplates()
    expect(callsFor('/api/v1/model-provider-templates')).toBe(2)
  })

  it('reads the model center cold-start snapshot once and shares it', async () => {
    const [first, second] = await Promise.all([api.getModelCenterSnapshot(), api.getModelCenterSnapshot()])
    expect(callsFor('/api/v1/model-center/snapshot')).toBe(1)
    expect(second).toEqual(first)
  })

  // The cache never re-validates per request on a hit; the host event is what retires it.
  // That is the whole fail-closed contract here: revocation arrives as a published state
  // change (useConnection -> setHostAccessStatus) and drops every projection at once,
  // instead of waiting out the TTL.
  it('drops every projection the moment the host gate revokes access', async () => {
    await api.listModelProviders()
    getHostStatus.mockResolvedValue({ state: 'unavailable', managed: true, error: { code: 'host_identity_unavailable', message: 'offline' } })
    setHostAccessStatus({ state: 'unavailable', managed: true, error: { code: 'host_identity_unavailable', message: 'offline' } })
    await expect(api.listModelProviders()).rejects.toMatchObject({ status: 503 })
    expect(callsFor('/api/v1/model-providers')).toBe(1)
  })

  it('drops every projection when the host needs a restart', async () => {
    await api.listAgentModeTopologies()
    setHostAccessStatus({ state: 'restart_required', managed: true, error: { code: 'desktop_restart_required', message: 'restart' } })
    await expect(api.listAgentModeTopologies()).rejects.toMatchObject({ status: 503, code: 'desktop_restart_required' })
    expect(callsFor('/api/v1/agent-modes')).toBe(1)
  })

  // Revalidation publishes the same state on every request; that is not a reason to
  // throw away what was just read.
  it('keeps the projections when the gate republishes the same state', async () => {
    await api.listAgents()
    setHostAccessStatus({ state: 'ready', managed: true })
    await api.listAgents()
    expect(callsFor('/api/v1/agents')).toBe(1)
  })

  it('does not cache a failed read', async () => {
    fetchMock.mockImplementationOnce(async () => json({ code: 'backend_network_unavailable' }, 500))
    await expect(api.listModelProviders()).rejects.toBeTruthy()
    await api.listModelProviders()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('keeps the shared read alive when one caller aborts', async () => {
    const controller = new AbortController()
    const leaving = api.listAgents({ signal: controller.signal })
    const staying = api.listAgents({ signal: undefined })
    controller.abort()
    await expect(leaving).rejects.toMatchObject({ name: 'AbortError' })
    await expect(staying).resolves.toEqual([{ id: 'agent-1' }])
    expect(callsFor('/api/v1/agents')).toBe(1)
  })

  it('keys the projections by storage scope', async () => {
    await api.listAgentCandidates()
    setSelectedStorage('project-a')
    await api.listAgentCandidates()
    expect(callsFor('/api/v1/agent-candidates')).toBe(2)
  })
})
