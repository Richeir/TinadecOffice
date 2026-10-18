import { hostAccessState, onHostAccessChanged } from './hostAccess'

/**
 * Long enough to cover one interaction — open the command panel, switch a settings tab,
 * drop the mode menu — and short enough that a change made elsewhere shows up by itself.
 * Our own writes never wait for it: every completed mutation invalidates these projections.
 */
export const READ_CACHE_TTL_MS = 3000

interface CacheEntry {
  at: number
  hostState: string | null
  value: unknown
}

const entries = new Map<string, CacheEntry>()
const inFlight = new Map<string, Promise<unknown>>()
let generation = 0

/**
 * Writes change what these read-only projections describe, so nothing may outlive them —
 * not even the TTL. Bumping the generation also stops a read that started before the write
 * from caching its now-stale answer when it lands.
 */
export function invalidateReadCache(): void {
  generation++
  entries.clear()
  inFlight.clear()
}

/** A revoked host must never be served from memory; the gate state is part of a hit. */
function cachedValue<T>(key: string): T | undefined {
  const entry = entries.get(key)
  if (!entry) return undefined
  if (Date.now() - entry.at >= READ_CACHE_TTL_MS) return undefined
  if (entry.hostState !== hostAccessState()) return undefined
  return entry.value as T
}

/**
 * Single flight plus a short TTL for the catalogs several mounted surfaces read on the
 * same turn (composer, command panel, model center, agent center). One key is one request:
 * whoever mounts second joins the first instead of issuing its own.
 *
 * The shared read deliberately takes no caller signal — one caller leaving must not cancel
 * data another caller is waiting for — while that caller's own await still rejects on abort.
 */
export function cachedRead<T>(key: string, read: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const hit = cachedValue<T>(key)
  if (hit !== undefined) return Promise.resolve(hit)
  let request = inFlight.get(key) as Promise<T> | undefined
  if (!request) {
    const startedIn = generation
    const created = read().then((value) => {
      if (startedIn === generation) entries.set(key, { at: Date.now(), hostState: hostAccessState(), value })
      return value
    }).finally(() => {
      if (inFlight.get(key) === created) inFlight.delete(key)
    })
    request = created
    inFlight.set(key, created)
  }
  if (!signal) return request
  if (signal.aborted) return Promise.reject(signal.reason ?? abortError())
  return Promise.race([request, rejectionOnAbort(signal)])
}

function rejectionOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason ?? abortError()), { once: true })
  })
}

function abortError(): Error {
  const error = new Error('This operation was aborted')
  error.name = 'AbortError'
  return error
}

// A host gate change (revocation, restart requirement, preview) retires every projection.
onHostAccessChanged(() => invalidateReadCache())
