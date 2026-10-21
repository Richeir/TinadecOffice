import { onMounted, onUnmounted, ref, watch } from 'vue'
import type { SessionDto } from '@/api'
import { selectionKey } from '@/lib/storageScope'

export const freeWorkspaceKey = 'user::free'
export const workspaceListStorageKey = 'tinadec.sidebar.workspaces.v1'
const revealEvent = 'tinadec:workspace-reveal'
export function revealWorkspace(key: string) { window.dispatchEvent(new CustomEvent(revealEvent, { detail: key })) }
/**
 * The four blocks inside the workspace list: the two flat lists, the project groups and the
 * free conversation. They are siblings in one scrollport, so they share one order.
 */
export const sidebarSections = ['recent', 'activity', 'free', 'projects'] as const
export type SidebarSection = (typeof sidebarSections)[number]
interface ListState { collapsed: boolean; collapsedKeys: string[]; allKeys: string[]; order: string[]; sectionOrder: SidebarSection[]; recent: boolean; activity: boolean; projectConversations: boolean; freeConversation: boolean }
const defaults = (): ListState => ({ collapsed: false, collapsedKeys: [], allKeys: [], order: [], sectionOrder: [...sidebarSections], recent: false, activity: false, projectConversations: true, freeConversation: true })
/** A section shipped after this record was written still has to appear, so the missing ids are
 *  appended in their declared order rather than dropped off the end of the list. */
function readSectionOrder(value: unknown): SidebarSection[] {
  const stored = Array.isArray(value)
    ? value.filter((item): item is SidebarSection => typeof item === 'string' && (sidebarSections as readonly string[]).includes(item))
    : []
  return [...new Set(stored), ...sidebarSections.filter(section => !stored.includes(section))]
}
function read(): ListState {
  try {
    const value = JSON.parse(localStorage.getItem(workspaceListStorageKey) ?? 'null')
    if (!value || typeof value !== 'object') return defaults()
    return { collapsed: value.collapsed === true, recent: value.recent === true, activity: value.activity === true, projectConversations: value.projectConversations !== false, freeConversation: value.freeConversation !== false, sectionOrder: readSectionOrder(value.sectionOrder), ...Object.fromEntries(['collapsedKeys', 'allKeys', 'order'].map(key => [key, Array.isArray(value[key]) ? [...new Set(value[key].filter((item: unknown) => typeof item === 'string'))] : []])) } as ListState
  } catch { return defaults() }
}
const byRecency = (a: SessionDto, b: SessionDto) =>
  Date.parse(b.updated_at ?? b.created_at) - Date.parse(a.updated_at ?? a.created_at) || a.id.localeCompare(b.id)
export function recentWorkspaceSessions(rows: SessionDto[], selectedKey: string | null, all = false) {
  const sorted = [...rows].sort(byRecency)
  if (all) return sorted
  const visible = sorted.slice(0, 5)
  const active = sorted.find(row => selectionKey(row) === selectedKey)
  if (active && !visible.includes(active)) visible.push(active)
  return visible
}
/**
 * Newest first across every workspace, for the optional 最近对话 group: the point of that
 * list is not to belong to a project, so the caller collects the rows and this only ranks
 * and caps them.
 */
export function recentSessionRows(rows: SessionDto[], limit: number) {
  return [...rows].sort(byRecency).slice(0, limit)
}
export function useWorkspaceList() {
  const state = ref(read())
  const stop = watch(state, value => { try { localStorage.setItem(workspaceListStorageKey, JSON.stringify(value)) } catch { /* Host may refuse local state; interaction remains usable. */ } }, { deep: true, flush: 'sync' })
  function storage(event: StorageEvent) { if (event.key === workspaceListStorageKey) state.value = read() }
  function reveal(event: Event) { const key = (event as CustomEvent<string>).detail; state.value.collapsed = false; state.value.collapsedKeys = state.value.collapsedKeys.filter(value => value !== key) }
  onMounted(() => { window.addEventListener('storage', storage); window.addEventListener(revealEvent, reveal) })
  onUnmounted(() => { stop(); window.removeEventListener('storage', storage); window.removeEventListener(revealEvent, reveal) })
  function reconcile(keys: string[]) {
    if (keys.length === 0) return
    const previous = state.value.order.filter(key => keys.includes(key))
    const fresh = keys.filter(key => !previous.includes(key))
    if (fresh.length === 0) { state.value.order = previous; return }
    // New workspaces appear next to the free conversation anchor instead of jumping to the
    // top, so a refresh never reshuffles what the user dragged into place.
    const anchor = previous.indexOf(freeWorkspaceKey)
    const order = [...previous]
    order.splice(anchor >= 0 ? anchor + 1 : 0, 0, ...fresh)
    state.value.order = order
  }
  function toggle(key: string, field: 'collapsedKeys' | 'allKeys') {
    const values = state.value[field]
    state.value[field] = values.includes(key) ? values.filter(value => value !== key) : [...values, key]
  }
  /**
   * Moves one entry next to another. Dropping on the lower half of a row places the dragged
   * entry after it, so the first and last positions are both reachable.
   */
  function moveWithin(values: string[], key: string, target: string, after: boolean): string[] | null {
    if (key === target || !values.includes(target)) return null
    const order = values.filter(item => item !== key)
    const index = order.indexOf(target)
    order.splice(after ? index + 1 : index, 0, key)
    return order
  }
  function stepWithin(values: string[], key: string, direction: -1 | 1): string[] | null {
    const order = [...values], index = order.indexOf(key), target = index + direction
    if (index < 0 || target < 0 || target >= order.length) return null
    ;[order[index], order[target]] = [order[target]!, order[index]!]
    return order
  }
  function move(key: string, target: string, after = false) {
    const order = moveWithin(state.value.order, key, target, after)
    if (order) state.value.order = order
  }
  function step(key: string, direction: -1 | 1) {
    const order = stepWithin(state.value.order, key, direction)
    if (order) state.value.order = order
  }
  /** The same gesture one level up: the option blocks are siblings, so they take the same list. */
  function moveSection(key: SidebarSection, target: SidebarSection, after = false) {
    const order = moveWithin(state.value.sectionOrder, key, target, after)
    if (order) state.value.sectionOrder = order as SidebarSection[]
  }
  function stepSection(key: SidebarSection, direction: -1 | 1) {
    const order = stepWithin(state.value.sectionOrder, key, direction)
    if (order) state.value.sectionOrder = order as SidebarSection[]
  }
  /** Section-level options ride the same persisted record. */
  function setRecent(value: boolean) { state.value.recent = value }
  function setActivity(value: boolean) { state.value.activity = value }
  function setProjectConversations(value: boolean) { state.value.projectConversations = value }
  function setFreeConversation(value: boolean) { state.value.freeConversation = value }
  return { state, reconcile, toggle, move, step, moveSection, stepSection, setRecent, setActivity, setProjectConversations, setFreeConversation }
}
