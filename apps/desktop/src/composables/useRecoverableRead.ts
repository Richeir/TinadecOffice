import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useHostAccess } from '@/lib/hostAccess'
import { isAbortError } from '@/lib/isAbortError'
import { useErrorState } from './useErrorState'

export interface ReadContext {
  signal: AbortSignal
  isCurrent: () => boolean
}

export interface RecoverableReadOptions {
  onFailure?: (error: unknown) => void
  onSuccess?: () => void
  /**
   * Read only once something actually asks for it. Use this for a screen that is mounted as
   * part of a larger page but is not the section the user is looking at: mounting it must not
   * spend the round trips, and the caller drives the first read with `refresh()`.
   */
  lazy?: boolean
}

/**
 * A mounted screen owns its read, cancellation and host-recovery subscription.
 *
 * Read on mount by default. `lazy` moves the first read to whoever calls `refresh()` — that
 * is the difference between "the page is open" and "the user is looking at this".
 */
export function useRecoverableRead(
  read: (context: ReadContext) => Promise<void>,
  options: RecoverableReadOptions = {},
) {
  const { canAccessBackend } = useHostAccess()
  const loading = ref(false)
  const loaded = ref(false)
  const failure = useErrorState()
  let generation = 0
  let disposed = false
  let controller: AbortController | null = null
  let pending: Promise<void> | null = null
  /**
   * Set by the first `refresh()`, including one that could not run because the host was not
   * verified yet. A lazy read must not wake on mount, but it must still recover a first read
   * that was asked for while the host was down.
   */
  let requested = false

  function cancel() {
    ++generation
    controller?.abort()
    controller = null
    pending = null
    loading.value = false
  }

  function refresh(): Promise<void> {
    requested = true
    if (disposed || !canAccessBackend.value) return Promise.resolve()
    if (pending) return pending
    const current = ++generation
    const request = new AbortController()
    controller = request
    loading.value = true
    const isCurrent = () => !disposed && current === generation && !request.signal.aborted && canAccessBackend.value
    pending = Promise.resolve().then(() => { if (isCurrent()) return read({ signal: request.signal, isCurrent }) }).then(() => {
      if (!isCurrent()) return
      loaded.value = true
      failure.clear()
      options.onSuccess?.()
    }).catch(error => {
      if (!isCurrent() || isAbortError(error)) return
      failure.set(error)
      options.onFailure?.(error)
    }).finally(() => {
      if (current === generation) { pending = null; controller = null; loading.value = false }
    })
    return pending
  }

  // A lazy read still has to survive a reconnection *after* it was first asked for; before
  // that, host recovery has nothing to recover and must not wake it.
  watch(canAccessBackend, ready => {
    if (!ready) { cancel(); return }
    if (requested || !options.lazy) void refresh()
  }, { flush: 'sync' })
  if (!options.lazy) onMounted(() => { void refresh() })
  onBeforeUnmount(() => { disposed = true; cancel() })
  return { refresh, loading, loaded, failure }
}
