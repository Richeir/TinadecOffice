// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { observeRoundTrip } from './requestTiming'

function responseWith(timing?: string, status = 200) {
  const headers = new Headers()
  if (timing) headers.set('server-timing', timing)
  return new Response('{}', { status, headers })
}

describe('desktop round-trip timing', () => {
  it('reports the client wait and the gateway total', () => {
    const sample = observeRoundTrip('/api/v1/model-providers', responseWith('snapshot.providers;dur=12.5, total;dur=40.2'), performance.now() - 55)
    expect(sample.status).toBe(200)
    expect(sample.serverMs).toBe(40.2)
    expect(sample.serverSegments).toEqual([{ name: 'snapshot.providers', durMs: 12.5 }])
    expect(sample.durationMs).toBeGreaterThan(0)
  })

  it('still reports the client wait when the gateway published no timing', () => {
    const sample = observeRoundTrip('/api/v1/health', responseWith(), performance.now() - 5)
    expect(sample.serverMs).toBeUndefined()
    expect(sample.serverSegments).toEqual([])
  })

  it('keeps a failing status and its timing', () => {
    const sample = observeRoundTrip('/api/v1/model-readiness', responseWith('total;dur=8', 503), performance.now())
    expect(sample.status).toBe(503)
    expect(sample.serverMs).toBe(8)
  })
})
