import { computed, ref } from 'vue'
import {
  resolveAvatarSlug,
  type AvatarPet,
  type AvatarPreference,
} from '@/lib/avatarAssignment'

/**
 * The one place that knows which face an agent wears.
 *
 * Two facts live here and nowhere else:
 * - the pool (installed pets + the bundled baseline), fetched once and refreshed when the main
 *   process says the pool changed;
 * - the decision per instance. It is written through to disk immediately, because an avatar that
 *   changes on reload destroys the only thing it is good for: recognising who is who.
 *
 * Picking happens in the renderer (pure function, unit-tested). The main process only stores.
 */
const pool = ref<AvatarPet[]>([])
const urlBySlug = ref<Record<string, string>>({})
const preferences = ref<Record<string, AvatarPreference>>({})
const instances = ref<Record<string, AgentAvatarInstanceRecord>>({})
const ready = ref(false)
/** Bumped whenever the pool changes, so views holding a resolved slug re-resolve. */
const revision = ref(0)

let loadPromise: Promise<void> | null = null
let subscribed = false

function petsApi() {
  return window.tinadec?.pets
}

async function refreshPool(): Promise<void> {
  const api = petsApi()
  if (!api?.listAvatars) return
  const records = await api.listAvatars()
  const nextPool: AvatarPet[] = []
  const nextUrls: Record<string, string> = {}
  for (const record of records) {
    if (!record?.slug) continue
    nextPool.push({ slug: record.slug, displayName: record.displayName, builtin: Boolean(record.builtin) })
    nextUrls[record.slug] = record.url
  }
  pool.value = nextPool
  urlBySlug.value = nextUrls
  revision.value += 1
}

/**
 * Re-reads what another window changed (a newly downloaded pet, a pinned face). Local instance
 * decisions win over the disk copy: this window may have just assigned one whose write has not
 * landed yet.
 */
async function reloadFromDisk(): Promise<void> {
  const api = petsApi()
  if (api?.loadAvatarState) {
    try {
      const state = await api.loadAvatarState()
      preferences.value = state?.preferences ?? {}
      instances.value = { ...(state?.instances ?? {}), ...instances.value }
    } catch {
      // Keep what we already show; the next event tries again.
    }
  }
  await refreshPool()
}

async function ensureLoaded(): Promise<void> {
  if (ready.value) return
  if (!loadPromise) {
    const api = petsApi()
    loadPromise = (async () => {
      if (!api?.loadAvatarState) {
        ready.value = true
        return
      }
      const [state] = await Promise.all([api.loadAvatarState(), refreshPool()])
      preferences.value = state?.preferences ?? {}
      instances.value = state?.instances ?? {}
      if (!subscribed && api.onAvatarsChanged) {
        subscribed = true
        api.onAvatarsChanged(() => {
          void reloadFromDisk()
        })
      }
      ready.value = true
    })().catch(() => {
      loadPromise = null
    })
  }
  await loadPromise
}

const builtinSlug = computed(() => pool.value.find((pet) => pet.builtin)?.slug ?? '')

/** A URL for a slug, degrading to the bundled pet when the pet is gone. */
function urlForSlug(slug: string | null | undefined): string {
  const direct = slug ? urlBySlug.value[slug] : ''
  if (direct) return direct
  return builtinSlug.value ? urlBySlug.value[builtinSlug.value] ?? '' : ''
}

function activePetSlugs(): Set<string> {
  return new Set(Object.values(instances.value).map((instance) => instance.petSlug))
}

function preferenceFor(agentId: string | null | undefined): AvatarPreference {
  if (!agentId) return { mode: 'random' }
  return preferences.value[agentId] ?? { mode: 'random' }
}

/**
 * The face for one spawned agent. Assigns on first call and persists, so a reload — or a second
 * component rendering the same instance — keeps the same pet.
 */
async function resolveInstanceAvatar(
  instanceKey: string,
  agentId?: string | null,
): Promise<string | null> {
  if (!instanceKey) return null
  await ensureLoaded()
  const existing = instances.value[instanceKey]
  if (existing) return existing.petSlug

  const preference = preferenceFor(agentId)
  const slug = resolveAvatarSlug(pool.value, preference, activePetSlugs(), instanceKey)
  if (!slug) return null

  const source: 'random' | 'fixed' = preference.mode === 'fixed' ? 'fixed' : 'random'
  instances.value = {
    ...instances.value,
    [instanceKey]: { petSlug: slug, agentId: agentId ?? '', assignedAt: Date.now(), source },
  }
  void petsApi()?.saveInstanceAvatar?.({ instanceKey, petSlug: slug, agentId: agentId ?? '', source })
    .catch(() => { /* the visual decision stands even if persistence failed */ })
  return slug
}

/** What the agent's own card shows before any run: pinned pet, else its latest instance. */
function agentPreviewSlug(agentId: string | null | undefined): string {
  if (!agentId) return builtinSlug.value
  const preference = preferences.value[agentId]
  if (preference?.mode === 'fixed' && pool.value.some((pet) => pet.slug === preference.petSlug)) {
    return preference.petSlug
  }
  let latest: AgentAvatarInstanceRecord | null = null
  for (const instance of Object.values(instances.value)) {
    if (instance.agentId !== agentId) continue
    if (!latest || instance.assignedAt > latest.assignedAt) latest = instance
  }
  if (latest && pool.value.some((pet) => pet.slug === latest!.petSlug)) return latest.petSlug
  return builtinSlug.value
}

async function setAgentPreference(agentId: string, preference: AvatarPreference): Promise<void> {
  const normalized: AvatarPreference = preference.mode === 'fixed'
    ? { mode: 'fixed', petSlug: preference.petSlug }
    : { mode: 'random' }
  preferences.value = { ...preferences.value, [agentId]: normalized }
  revision.value += 1
  await petsApi()?.setAgentAvatar?.(agentId, normalized)
}

export function useAgentAvatars() {
  void ensureLoaded()
  return {
    pool: computed(() => pool.value),
    ready: computed(() => ready.value),
    revision: computed(() => revision.value),
    builtinSlug,
    urlForSlug,
    preferenceFor,
    agentPreviewSlug,
    resolveInstanceAvatar,
    setAgentPreference,
  }
}

/** For tests. */
export function resetAgentAvatars(): void {
  pool.value = []
  urlBySlug.value = {}
  preferences.value = {}
  instances.value = {}
  ready.value = false
  loadPromise = null
  revision.value = 0
}
