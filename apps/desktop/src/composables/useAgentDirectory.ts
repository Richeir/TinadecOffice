import { computed, shallowRef } from 'vue'
import { api, type AgentDirectoryItemDto } from '@/api'
import i18n from '@/i18n'
import { pickLocalized } from '@/lib/packI18n'

/**
 * The agent directory, read once per window and localized on read. Names follow the active
 * interface locale because `nameFor` reads `i18n.global.locale` inside the caller's reactive
 * scope; switching the language re-renders names without a second request. A failed or slow
 * read leaves names as their slugs instead of blocking the feed, and the next caller after a
 * failure may try again.
 */
const items = shallowRef<readonly AgentDirectoryItemDto[]>([])
let loaded: Promise<void> | null = null

function ensureLoaded(): Promise<void> {
  if (!loaded) {
    loaded = api.listAgents()
      .then((agents) => {
        items.value = agents
      })
      .catch(() => {
        loaded = null
      })
  }
  return loaded
}

const byKey = computed(() => {
  const map = new Map<string, AgentDirectoryItemDto>()
  for (const row of items.value) {
    map.set(row.id, row)
    if (row.slug) map.set(row.slug, row)
  }
  return map
})

export function useAgentDirectory() {
  void ensureLoaded()

  /**
   * Localized name of a slug, a handle (`search#2`) or a definition id. Falls back to `fallback`
   * (or the input itself) when the directory has no row.
   */
  function nameFor(idOrHandle: string | null | undefined, fallback?: string | null): string {
    if (!idOrHandle) return ''
    const [key, ordinal] = idOrHandle.split('#')
    const row = byKey.value.get(key!)
    const name = row
      ? pickLocalized(row.i18n, i18n.global.locale.value, 'display_name', row.display_name) ?? row.display_name
      : fallback ?? key!
    return ordinal ? `${name} #${ordinal}` : name
  }

  function descriptionFor(idOrSlug: string | null | undefined, fallback?: string | null): string {
    if (!idOrSlug) return ''
    const row = byKey.value.get(idOrSlug)
    const localized = row ? pickLocalized(row.i18n, i18n.global.locale.value, 'description') : undefined
    return localized ?? fallback ?? ''
  }

  async function refresh(): Promise<void> {
    loaded = null
    await ensureLoaded()
  }

  return { items, nameFor, descriptionFor, refresh }
}

/** For tests. */
export function resetAgentDirectory(): void {
  items.value = []
  loaded = null
}
