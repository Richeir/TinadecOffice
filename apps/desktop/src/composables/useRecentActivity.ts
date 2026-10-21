import { onMounted, onUnmounted, ref, watch } from 'vue'
import { api, type OrchestrationRunDto, type SessionDto } from '@/api'
import { scopedApi, selectedStorage, selectionKey } from '@/lib/storageScope'

export interface ActivityCandidate {
  session: SessionDto
  /** Workspace the conversation lives in: the card names it instead of drawing an icon. */
  projectName: string
}

/** The sidebar shows a handful of recent activities; older ones are not worth a request each. */
export const ACTIVITY_LIMIT = 5
/** A move in the session list (rename, reorder, a run landing) should not fire a burst of reads. */
export const ACTIVITY_DEBOUNCE_MS = 300
/** Safety net for clock skew and long live runs: a read older than this is refreshed anyway. */
export const ACTIVITY_TTL_MS = 60_000

/** Newest run of a roster; the roster order is Core's, so it is ranked here rather than trusted. */
export function latestRun(runs: OrchestrationRunDto[]): OrchestrationRunDto | null {
  let latest: OrchestrationRunDto | null = null
  for (const run of runs) {
    if (!latest || Date.parse(run.created_at) >= Date.parse(latest.created_at)) latest = run
  }
  return latest
}

interface Reading {
  readAt: number
  /** The `updated_at` this read answered for; a different one means the session moved. */
  updatedAt: string
}

/**
 * The latest run of each recent conversation, keyed by `selectionKey`.
 *
 * There is no cross-session activity endpoint, so this walks `sessions/{id}/runs` for the few
 * conversations the activity view actually renders. Three rules keep that cheap: the option being
 * off means no request at all, a read is reused until the session's `updated_at` moves, and a TTL
 * covers the cases where the clock and the server disagree.
 */
export function useRecentActivity(candidates: () => ActivityCandidate[], options: {
  enabled: () => boolean
  limit?: number
}) {
  const runs = ref<Record<string, OrchestrationRunDto | null>>({})
  const readings = ref<Record<string, Reading>>({})
  let generation = 0
  let controller: AbortController | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  function targets(): ActivityCandidate[] {
    return options.enabled() ? candidates().slice(0, options.limit ?? ACTIVITY_LIMIT) : []
  }

  function stale(candidate: ActivityCandidate): boolean {
    const key = selectionKey(candidate.session)
    if (!(key in runs.value)) return true
    const reading = readings.value[key]
    if (!reading) return true
    if (reading.updatedAt !== candidate.session.updated_at) return true
    return Date.now() - reading.readAt > ACTIVITY_TTL_MS
  }

  async function refresh(): Promise<void> {
    const wanted = targets().filter(stale)
    if (wanted.length === 0) return
    const current = ++generation
    controller?.abort()
    controller = new AbortController()
    const { signal } = controller
    // Pin the scope for the whole fan-out: a storage switch mid-read must not stitch two stores.
    const storage = selectedStorage.value
    const scoped = scopedApi(api, () => storage)
    const results = await Promise.allSettled(wanted.map(row => scoped.listRuns(row.session.id, signal)
      .then(list => ({ key: selectionKey(row.session), updatedAt: row.session.updated_at, list }))))
    if (current !== generation || storage !== selectedStorage.value) return
    const nextRuns = { ...runs.value }
    const nextReadings = { ...readings.value }
    const readAt = Date.now()
    for (const result of results) {
      // One unreadable roster must not blank the others; that session keeps its previous read.
      if (result.status !== 'fulfilled') continue
      const { key, updatedAt, list } = result.value
      nextRuns[key] = latestRun(list)
      nextReadings[key] = { readAt, updatedAt }
    }
    runs.value = nextRuns
    readings.value = nextReadings
  }

  function schedule(): void {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => { timer = null; void refresh() }, ACTIVITY_DEBOUNCE_MS)
  }

  // Registered on mount, not in setup: the candidate getter walks the owner's computeds, and
  // reading them before the component is on screen is how a setup-order bug turns into a crash.
  onMounted(() => {
    watch(
      () => targets().map(row => `${selectionKey(row.session)}@${row.session.updated_at}`).join('|'),
      schedule,
    )
  })

  onUnmounted(() => {
    if (timer) clearTimeout(timer)
    controller?.abort()
    generation += 1
  })

  return { runs, refresh, schedule }
}
