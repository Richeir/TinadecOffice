/**
 * Client-side round-trip observation for the desktop read path.
 *
 * The Gateway publishes Server-Timing for what it did; this measures what the user actually
 * waited for, including the host gate, the IPC hop and the loopback socket. Off by default:
 * measuring must not become the cost it measures. Turn it on at build time with
 * `VITE_TINADEC_DESKTOP_TIMING=1` — Vite only exposes `VITE_`-prefixed variables to the
 * renderer, so a bare `TINADEC_DESKTOP_TIMING` would never be readable here.
 */
const ENABLED = (() => {
  const raw = (import.meta.env?.VITE_TINADEC_DESKTOP_TIMING ?? '')
  return raw !== '' && raw !== '0'
})()

export interface RoundTripSample {
  path: string
  status: number
  durationMs: number
  /** Total Gateway time for the request, when the server published it. */
  serverMs?: number
  /** Sum of the Gateway's named segments, when it published any. */
  serverSegments?: Array<{ name: string; durMs: number }>
}

function parseServerTiming(header: string | null): Pick<RoundTripSample, 'serverMs' | 'serverSegments'> {
  // A sample always carries a segments array: "no segments" and "no header" are the same
  // fact for a caller, and a missing field would force every reader to guard it.
  if (!header) return { serverSegments: [] }
  const segments: Array<{ name: string; durMs: number }> = []
  for (const member of header.split(',')) {
    const [name, ...params] = member.trim().split(';')
    if (!name) continue
    const duration = params
      .map((param) => param.trim())
      .find((param) => param.startsWith('dur='))
    const durMs = duration ? Number(duration.slice(4)) : NaN
    if (Number.isFinite(durMs)) segments.push({ name: name.trim(), durMs })
  }
  const total = segments.find((segment) => segment.name === 'total')
  return {
    serverMs: total?.durMs,
    serverSegments: segments.filter((segment) => segment.name !== 'total'),
  }
}

/**
 * Record one read. Returns the sample so a caller (or a test) can assert on it without
 * reading the console. A missing header is not an error: a Gateway that predates the
 * instrumentation simply reports no server time.
 *
 * The hot path guards on {@link roundTripTimingEnabled} and never calls this when the
 * switch is off — otherwise every read would pay for building a sample nobody reads.
 */
export function observeRoundTrip(path: string, response: Response, startedAt: number): RoundTripSample {
  const durationMs = performance.now() - startedAt
  const sample: RoundTripSample = {
    path,
    status: response.status,
    durationMs: Math.round(durationMs * 10) / 10,
    ...parseServerTiming(response.headers.get('server-timing')),
  }
  const server = sample.serverMs === undefined ? 'server=?' : `server=${sample.serverMs}ms`
  console.debug(`[desktop-timing] ${path} ${sample.status} total=${sample.durationMs}ms ${server}`)
  return sample
}

export const roundTripTimingEnabled = ENABLED
