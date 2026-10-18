// @vitest-environment happy-dom
// A preload that pushes host status is not asked per request; one that cannot push still is.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { assertHostAccess, setHostAccessStatus } from './hostAccess'
import type { HostConnectionStatus } from './hostConnection'

const ready: HostConnectionStatus = { state: 'ready', managed: true } as HostConnectionStatus
const getHostStatus = vi.fn()

function bridge(extra: Record<string, unknown> = {}) {
  Object.defineProperty(window, 'tinadec', {
    configurable: true,
    value: { gatewayUrl: () => 'http://127.0.0.1:48730', getHostStatus, onHostStatusChanged: () => () => {}, ...extra },
  })
}

beforeEach(() => {
  getHostStatus.mockReset().mockResolvedValue(ready)
  setHostAccessStatus(ready)
})

afterEach(() => {
  delete (window as unknown as { tinadec?: unknown }).tinadec
  setHostAccessStatus(ready)
  vi.restoreAllMocks()
})

describe('host gate revalidation', () => {
  it('asks IPC only once for a bridge that cannot push status', async () => {
    bridge({ onHostStatusChanged: undefined })
    await assertHostAccess('/api/v1/agents')
    await assertHostAccess('/api/v1/model-routes')
    expect(getHostStatus).toHaveBeenCalledTimes(2)
  })

  it('does not spend the IPC round trip when the preload pushes status', async () => {
    bridge()
    await assertHostAccess('/api/v1/agents')
    await assertHostAccess('/api/v1/model-routes')
    await assertHostAccess('/api/v1/agent-modes')
    expect(getHostStatus).not.toHaveBeenCalled()
  })

  it('refuses the request as soon as the pushed state revokes access', async () => {
    bridge()
    await assertHostAccess('/api/v1/agents')
    setHostAccessStatus({ state: 'unavailable', managed: true, error: { code: 'host_identity_unavailable', message: 'offline' } } as HostConnectionStatus)
    await expect(assertHostAccess('/api/v1/agents')).rejects.toMatchObject({ status: 503, code: 'host_identity_unavailable' })
    expect(getHostStatus).not.toHaveBeenCalled()
  })

  it('refuses a restart requirement immediately, pushed or polled', async () => {
    bridge()
    setHostAccessStatus({ state: 'restart_required', managed: true, error: { code: 'desktop_restart_required', message: 'restart' } } as HostConnectionStatus)
    await expect(assertHostAccess('/api/v1/agents')).rejects.toMatchObject({ status: 503, code: 'desktop_restart_required' })
    expect(getHostStatus).not.toHaveBeenCalled()
  })

  it('refuses a preview renderer instead of falling through to the backend', async () => {
    bridge()
    setHostAccessStatus({ state: 'preview', managed: false } as HostConnectionStatus)
    await expect(assertHostAccess('/api/v1/agents')).rejects.toMatchObject({ status: 403, code: 'desktop_host_required' })
    expect(getHostStatus).not.toHaveBeenCalled()
  })

  it('keeps the request abortable while the gate is read', async () => {
    bridge({ onHostStatusChanged: undefined })
    const controller = new AbortController()
    controller.abort()
    await expect(assertHostAccess('/api/v1/agents', controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })
})
