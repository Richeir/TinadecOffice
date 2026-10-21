<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'
import { useWorkspaceList, freeWorkspaceKey, recentSessionRows, recentWorkspaceSessions } from '@/composables/useWorkspaceList'
import { workspaceIcons, type WorkspaceLoadState } from '@/lib/workspaces'
import { scopedApi, selectionKey, selectionIdentity, selectedStorage } from '@/lib/storageScope'
import { buildSidebarUsage, SIDEBAR_USAGE_DAYS, usageWindow, type SidebarUsage, type SidebarUsageBar } from '@/lib/sidebarUsage'
import { formatCompactCount } from '@/lib/shareCard'
import {
  Archive,
  ArrowRightLeft,
  Bug,
  ChevronRight,
  FolderOpen,
  MessageSquare,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Pencil,
  Plus,
  Settings,
  SlidersHorizontal,
  LayoutGrid,
  Waypoints,
  Sparkles,
  Store,
  Trash2,
  ArrowUp,
  ArrowDown,
} from '@lucide/vue'
import { useI18n } from 'vue-i18n'
import { api, type ModelInvocationDto, type ProjectDto, type SessionDto } from '../api'
import BrandLogo from '@/components/BrandLogo.vue'
import TinadecCalligraphy from '@/components/TinadecCalligraphy.vue'
import PersonalAvatar from '@/components/personal/PersonalAvatar.vue'
import InlineRenameInput from '@/components/InlineRenameInput.vue'
import RowContextMenu, { type RowMenuItem } from '@/components/RowContextMenu.vue'
import { UiButton, UiSelectField } from '@/components/ui'
import { useNotifications } from '@/composables/useNotifications'
import { useDebugStudio } from '@/composables/useDebugStudio'
import { errorCodeMessage } from '@/lib/apiError'
import { userProfile } from '@/lib/userProfile'
import { profileNameFits } from '@/lib/profileNameFit'

const { t, te, locale } = useI18n()
const { confirm } = useNotifications()
const { enabled: debugStudioEnabled, load: loadDebugStudio } = useDebugStudio()
onMounted(loadDebugStudio)

const props = defineProps<{
  projects: ProjectDto[]
  sessions: SessionDto[]
  selectedProjectId: string | null
  selectedSessionId: string | null
  busy: boolean
  collapsed?: boolean
  spaceActive?: boolean
  panelStyle?: Record<string, string>
  panelDataAttrs?: Record<string, string>
  workspaceLoadStates?: Record<string, WorkspaceLoadState>
}>()

const emit = defineEmits<{
  'select-project': [id: string]
  'select-session': [id: string]
  'create-session': [projectId: string | null]
  'open-project': []
  'go-settings': []
  'go-personal': []
  'go-market': []
  'change-view': [mode: 'flat' | 'space']
  'toggle-collapse': []
  'rename-project': [id: string, name: string]
  'rename-session': [id: string, title: string]
  'archive-project': [id: string]
  'archive-session': [id: string]
  'trash-project': [id: string]
  'trash-session': [id: string]
  'migrate-session': [id: string, targetProjectKey: string]
  'edit-workspace': [id: string]
  'retry-workspaces': [key: string]
  'unregister-workspace': [id: string]
}>()

const list = useWorkspaceList()
watch(() => [freeWorkspaceKey, ...props.projects.map(selectionKey)], keys => list.reconcile(keys), { immediate: true })
const draggedWorkspace = ref<string | null>(null)
const dragOverKey = ref<string | null>(null)
const dragOverAfter = ref(false)
function startDrag(event: DragEvent, key: string) {
  draggedWorkspace.value = key
  if (event.dataTransfer) { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/x-tinadec-workspace', key) }
}
function dragOverWorkspace(event: DragEvent, key: string) {
  if (!draggedWorkspace.value) return
  const row = (event.currentTarget as HTMLElement).getBoundingClientRect()
  dragOverKey.value = key
  dragOverAfter.value = event.clientY > row.top + row.height / 2
}
function dropWorkspace(event: DragEvent, key: string) {
  event.preventDefault()
  if (draggedWorkspace.value) list.move(draggedWorkspace.value, key, dragOverAfter.value)
  draggedWorkspace.value = null
  dragOverKey.value = null
}
// Drag is the primary gesture, but reordering must not require a pointer.
function reorderWithKeyboard(event: KeyboardEvent, key: string) {
  if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return
  event.preventDefault()
  list.step(key, event.key === 'ArrowUp' ? -1 : 1)
}
const viewMenu = ref<HTMLDivElement | null>(null)
const viewMenuId = `sidebar-view-${useId()}`
const viewMenuOpen = ref(false)
let viewMenuTrigger: HTMLButtonElement | null = null
const viewMenuStyle = ref({ left: '0px', top: '0px' })
function openViewMenu(event: MouseEvent) {
  viewMenuTrigger = event.currentTarget as HTMLButtonElement
  const rect = viewMenuTrigger.getBoundingClientRect()
  viewMenuStyle.value = { left: `${Math.max(8, Math.min(rect.left, window.innerWidth - 210))}px`, top: `${Math.max(8, rect.top - 116)}px` }
  // The native invoker performs the toggle after this positioning handler;
  // it also owns Escape/light-dismiss and restores focus when the menu closes.
}
function updateViewMenuState(event: Event) {
  viewMenuOpen.value = (event as ToggleEvent).newState === 'open'
}
function changeView(mode: 'flat' | 'space') {
  viewMenu.value?.hidePopover()
  viewMenuTrigger?.focus({ preventScroll: true })
  emit('change-view', mode)
}

// ---- Lifecycle management (context menu + inline rename) ----
interface MenuTarget {
  kind: 'project' | 'session' | 'free'
  id: string
  name: string
  x: number
  y: number
}

const menuTarget = ref<MenuTarget | null>(null)
const renaming = ref<{ kind: 'project' | 'session'; id: string } | null>(null)
const migrationDialog = ref<HTMLDialogElement | null>(null)
const migrationSession = ref<MenuTarget | null>(null)
const migrationProject = ref('')
const migrationProjects = computed(() => props.projects.filter(project => project.storage_id
  && project.availability !== 'error' && project.lifecycle_status === 'active'))
const migrationAllowed = computed(() => menuTarget.value?.kind === 'session' && props.sessions.some(session => selectionKey(session) === menuTarget.value?.id && !session.project_id) && migrationProjects.value.length > 0)

const menuProject = computed(() => menuTarget.value?.kind === 'project'
  ? props.projects.find(row => selectionKey(row) === menuTarget.value!.id || row.id === menuTarget.value!.id)
  : undefined)
// A registered workspace whose source folder disappeared can neither load nor be archived by
// content, so the menu offers retry plus an explicit unregister instead of dead actions.
const menuProjectUnavailable = computed(() => menuProject.value?.availability === 'error')
const menuItems = computed<RowMenuItem[]>(() => {
  const order: RowMenuItem[] = [
    { key: 'move-up', label: t('sidebar.moveUp'), icon: ArrowUp },
    { key: 'move-down', label: t('sidebar.moveDown'), icon: ArrowDown },
  ]
  // Conversations are listed chronologically inside a workspace and are not reorderable.
  if (menuTarget.value?.kind === 'session') return [
    { key: 'rename', label: t('sidebar.rename'), icon: Pencil },
    ...(migrationAllowed.value ? [{ key: 'migrate', label: t('sidebar.migrateSession'), icon: ArrowRightLeft }] : []),
    { key: 'archive', label: t('sidebar.archive'), icon: Archive },
    { key: 'trash', label: t('sidebar.moveToTrash'), icon: Trash2, danger: true },
  ]
  // The free conversation owns no project record, so it only gets reordering.
  if (menuTarget.value?.kind === 'free') return order
  if (menuProjectUnavailable.value) return [
    { key: 'retry-workspace', label: t('sidebar.retryLoad'), icon: RefreshCw },
    ...order,
    { key: 'unregister-workspace', label: t('sidebar.unregisterWorkspace'), icon: Trash2, danger: true },
  ]
  return [
    { key: 'edit-workspace', label: t('sidebar.editWorkspace'), icon: Pencil },
    ...order,
    { key: 'archive', label: t('sidebar.archive'), icon: Archive },
    { key: 'trash', label: t('sidebar.moveToTrash'), icon: Trash2, danger: true },
  ]
})

function openMenuAtCursor(event: MouseEvent, kind: 'project' | 'session' | 'free', id: string, name: string) {
  menuTarget.value = { kind, id, name, x: event.clientX, y: event.clientY }
}

function openMenuAtButton(event: MouseEvent, kind: 'project' | 'session' | 'free', id: string, name: string) {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  menuTarget.value = { kind, id, name, x: rect.left, y: rect.bottom + 4 }
}

function startRename(target: MenuTarget) {
  if (target.kind === 'free') return
  renaming.value = { kind: target.kind, id: target.id }
  if (target.kind === 'project' && !isExpanded(target.id)) toggleExpand(target.id)
}

function submitRename(value: string) {
  const current = renaming.value
  renaming.value = null
  if (!current) return
  if (current.kind === 'project') emit('rename-project', current.id, value)
  else emit('rename-session', current.id, value)
}

function cancelRename() {
  renaming.value = null
}

async function handleMenuSelect(key: string) {
  const target = menuTarget.value
  menuTarget.value = null
  if (!target) return
  if (key === 'edit-workspace') { emit('edit-workspace', target.id); return }
  if (key === 'retry-workspace') { emit('retry-workspaces', target.id); return }
  if (key === 'unregister-workspace') {
    const confirmed = await confirm({
      title: t('sidebar.unregisterWorkspaceConfirmTitle'),
      message: t('sidebar.unregisterWorkspaceConfirmMessage', { name: target.name }),
      confirmLabel: t('sidebar.unregisterWorkspace'),
      destructive: true,
    })
    if (confirmed) emit('unregister-workspace', target.id)
    return
  }
  if (key === 'move-up' || key === 'move-down') { list.step(target.id, key === 'move-up' ? -1 : 1); return }
  if (key === 'rename') {
    startRename(target)
    return
  }
  if (key === 'migrate') {
    migrationSession.value = target
    migrationProject.value = migrationProjects.value[0] ? selectionKey(migrationProjects.value[0]) : ''
    await nextTick()
    migrationDialog.value?.showModal()
    return
  }
  if (key === 'archive') {
    if (target.kind === 'project') emit('archive-project', target.id)
    else emit('archive-session', target.id)
    return
  }
  if (key === 'trash') {
    const isProject = target.kind === 'project'
    const confirmed = await confirm({
      title: isProject ? t('sidebar.trashProjectConfirmTitle') : t('sidebar.trashSessionConfirmTitle'),
      message: isProject
        ? t('sidebar.trashProjectConfirmMessage', { name: target.name })
        : t('sidebar.trashSessionConfirmMessage', { name: target.name }),
      confirmLabel: t('sidebar.moveToTrash'),
      destructive: true,
    })
    if (!confirmed) return
    if (isProject) emit('trash-project', target.id)
    else emit('trash-session', target.id)
  }
}
function submitMigration() {
  if (!migrationSession.value || !migrationProjects.value.some(project => selectionKey(project) === migrationProject.value)) return
  emit('migrate-session', migrationSession.value.id, migrationProject.value)
  migrationDialog.value?.close(); migrationSession.value = null
}

// Free conversation is an ordinary, draggable list item; it is only the default first entry
// when the user has not moved it. Order is the single source of truth for the whole group.
const workspaces = computed(() => {
  const candidates = [
    { key: freeWorkspaceKey, name: t('chat.freeConversation'), project: null as ProjectDto | null },
    ...props.projects.map(project => ({ key: selectionKey(project), name: project.name, project: project as ProjectDto | null })),
  ]
  const remaining = new Map(candidates.map(workspace => [workspace.key, workspace]))
  const ordered: typeof candidates = []
  for (const key of list.state.value.order) {
    const workspace = remaining.get(key)
    if (workspace) { ordered.push(workspace); remaining.delete(key) }
  }
  for (const workspace of candidates) if (remaining.has(workspace.key)) ordered.push(workspace)
  return ordered
})
function allSessions(key: string): SessionDto[] { return key === freeWorkspaceKey ? freeSessions.value : getProjectSessions(key) }
function shownSessions(key: string) {
  const active = props.sessions.find(isActiveSession)
  return recentWorkspaceSessions(allSessions(key), active ? selectionKey(active) : null, list.state.value.allKeys.includes(key))
}
function isActiveSession(session: SessionDto) { return session.id === props.selectedSessionId && (!session.storage_id || session.storage_id === selectedStorage.value) }

// ---- Section options (currently: 最近对话) ----
// The recents list is what Codex/WorkBuddy lead with: newest conversations across every
// workspace, so a chat is one click away without knowing which project it lives in. It is
// built from the same group rows the list renders, which keeps the workspace/scope filters
// (and the free conversation) as the single definition of "a conversation I can see".
const RECENT_CONVERSATION_LIMIT = 8
const recentConversations = computed(() => {
  const source = new Map<string, string>()
  const rows: SessionDto[] = []
  for (const workspace of workspaces.value) {
    for (const row of allSessions(workspace.key)) {
      const key = selectionKey(row)
      if (source.has(key)) continue
      source.set(key, workspace.name)
      rows.push(row)
    }
  }
  return recentSessionRows(rows, RECENT_CONVERSATION_LIMIT)
    .map(session => ({ session, workspace: source.get(selectionKey(session)) ?? '' }))
})
function toggleRecentConversations() {
  list.setRecent(!list.state.value.recent)
  // The panel sits exactly where the new rows appear, so it steps aside: the change is the
  // feedback, and the gear keeps focus the way the view chooser does.
  optionsMenu.value?.hidePopover()
  optionsMenuTrigger?.focus({ preventScroll: true })
}
const optionsMenu = ref<HTMLDivElement | null>(null)
let optionsMenuTrigger: HTMLButtonElement | null = null
const optionsMenuId = `sidebar-workspace-options-${useId()}`
const optionsMenuOpen = ref(false)
const optionsMenuStyle = ref({ left: '0px', top: '0px' })
/** Matches `.sidebar-workspace-options` width; the panel is display:none while closed, so it
 *  cannot be measured before it opens. Change both together. */
const OPTIONS_MENU_WIDTH = 236
function openOptionsMenu(event: MouseEvent) {
  // The native invoker performs the toggle; this only positions the panel under the gear.
  optionsMenuTrigger = event.currentTarget as HTMLButtonElement
  const rect = optionsMenuTrigger.getBoundingClientRect()
  optionsMenuStyle.value = {
    left: `${Math.max(8, Math.min(rect.right - OPTIONS_MENU_WIDTH, window.innerWidth - OPTIONS_MENU_WIDTH - 8))}px`,
    top: `${rect.bottom + 6}px`,
  }
}
function updateOptionsMenuState(event: Event) {
  optionsMenuOpen.value = (event as ToggleEvent).newState === 'open'
}

function getProjectSessions(projectKey: string): SessionDto[] {
  const { id, storageId } = selectionIdentity(projectKey)
  return props.sessions.filter((s) => (s.project_id ?? null) === id && (!storageId || s.storage_id === storageId) && s.title)
}

function isExpanded(projectId: string): boolean {
  return !list.state.value.collapsedKeys.includes(projectId)
}

function toggleExpand(projectId: string) {
  list.toggle(projectId, 'collapsedKeys')
}

function handleProjectClick(projectId: string) {
  toggleExpand(projectId)
}

function handleSessionClick(sessionId: string) {
  emit('select-session', sessionId)
}

function handleNewSession(projectId: string) {
  emit('create-session', projectId)
}

function handleNewThread() {
  const selected = props.projects.find(project => project.id === props.selectedProjectId && (!project.storage_id || project.storage_id === selectedStorage.value))
  emit('create-session', selected ? selectionKey(selected) : null)
}

// Sessions not bound to any project (Codex-style free conversations). The title is
// not a filter: a newly created conversation still carries the default
// 'Tinadec session' title until its first message generates one, so hiding that
// title made every fresh free conversation invisible.
const freeSessions = computed(() =>
  props.sessions.filter((s) => !s.project_id && s.title)
)

// ---- Token usage (current storage scope, last 7 days) ----
const USAGE_PAGE_LIMIT = 200
const USAGE_MAX_PAGES = 5
const tokenUsage = ref<SidebarUsage | null>(null)
let tokenUsageGeneration = 0

function formatTokenCount(value: number): string {
  return value.toLocaleString(locale.value)
}

function usageDayTitle(bar: SidebarUsageBar): string {
  const date = bar.date.toLocaleDateString(locale.value, { month: 'short', day: 'numeric' })
  return bar.tokens === null
    ? t('sidebar.tokenUsageDayEmpty', { date })
    : t('sidebar.tokenUsageDay', { date, tokens: formatTokenCount(bar.tokens) })
}

const tokenUsageTotal = computed(() => {
  const usage = tokenUsage.value
  if (!usage || usage.total === null) return ''
  return `${usage.truncated ? '≥ ' : ''}${formatCompactCount(usage.total, locale.value)}`
})

const tokenUsageSummary = computed(() => {
  const usage = tokenUsage.value
  if (!usage || usage.total === null) return ''
  const key = usage.truncated ? 'sidebar.tokenUsageSummaryTruncated' : 'sidebar.tokenUsageSummary'
  return t(key, { days: SIDEBAR_USAGE_DAYS, tokens: formatTokenCount(usage.total) })
})

async function loadTokenUsage(): Promise<void> {
  const generation = ++tokenUsageGeneration
  const storage = selectedStorage.value
  // Pin the scope across pages: a project switch mid-walk must not stitch two stores together.
  const usageApi = scopedApi(api, () => storage)
  const days = usageWindow()
  const rows: ModelInvocationDto[] = []
  let cursor: string | undefined
  try {
    for (let page = 0; page < USAGE_MAX_PAGES; page += 1) {
      const result = await usageApi.listModelInvocations({ from: days[0]!.toISOString(), limit: USAGE_PAGE_LIMIT, cursor })
      rows.push(...result.items)
      cursor = result.next_cursor ?? undefined
      if (!cursor || result.items.length === 0) break
    }
    if (generation !== tokenUsageGeneration || storage !== selectedStorage.value) return
    tokenUsage.value = buildSidebarUsage(rows, { truncated: Boolean(cursor) })
  } catch {
    // The chart is supplementary; the personal page owns the visible failure state.
    if (generation === tokenUsageGeneration) tokenUsage.value = null
  }
}

onMounted(() => { void loadTokenUsage() })
watch(() => props.busy, (busy, wasBusy) => { if (wasBusy && !busy) void loadTokenUsage() })
watch(selectedStorage, () => { void loadTokenUsage() })

function openDebugStudio() {
  if (!debugStudioEnabled.value) return
  ;(window as unknown as { tinadec?: { openDebugStudio?: () => Promise<boolean> } }).tinadec?.openDebugStudio?.()
}

// ---- Footer identity ----
// The portrait carries the nickname only while the footer row has room for it in
// full plus clear space before the shell actions. The geometry below mirrors
// `.sidebar-profile` in styles.css (button padding, the name's leading margin,
// the portrait size); the decision itself lives in a pure function so it can be
// exercised without a laid-out document.
const PROFILE_AVATAR_SIZE = 20
const PROFILE_BUTTON_PADDING = 3
const PROFILE_NAME_GAP = 6

const nickname = computed(() => userProfile.nickname.trim())
const footerEl = ref<HTMLElement | null>(null)
const footerActionsEl = ref<HTMLElement | null>(null)
const profileNameProbe = ref<HTMLElement | null>(null)
const profileNameShown = ref(false)
/** Natural name width, handed to CSS as the end of the reveal (see `.sidebar-profile-name`). */
const profileNameMax = ref(0)

function px(value: string | null | undefined): number {
  const parsed = Number.parseFloat(value ?? '')
  return Number.isFinite(parsed) ? parsed : 0
}

function measureProfileName() {
  const footer = footerEl.value
  const probe = profileNameProbe.value
  // The collapsed rail is one icon wide and animates; measuring mid-transition
  // would flash the name in and out, so it simply stays off there.
  if (!footer || !probe || props.collapsed) { profileNameShown.value = false; return }
  const styles = getComputedStyle(footer)
  const nameWidth = probe.getBoundingClientRect().width
  profileNameMax.value = Math.ceil(nameWidth)
  profileNameShown.value = profileNameFits({
    footerWidth: footer.clientWidth,
    padding: px(styles.paddingLeft) + px(styles.paddingRight),
    gap: px(styles.columnGap) || px(styles.gap),
    actionsWidth: footerActionsEl.value?.getBoundingClientRect().width ?? 0,
    avatarSize: PROFILE_AVATAR_SIZE,
    buttonPadding: PROFILE_BUTTON_PADDING,
    nameGap: PROFILE_NAME_GAP,
    nameWidth,
  })
}

// Hover keeps a hidden name discoverable: the tooltip names the person the
// portrait belongs to, and drops the redundant repetition once the name is up.
// The accessible name always carries the nickname — the visible text is
// aria-hidden, so a screen reader must not lose the identity when the row narrows.
const profileTitle = computed(() => (nickname.value && !profileNameShown.value
  ? `${nickname.value} · ${t('sidebar.personal')}`
  : t('sidebar.personal')))
const profileLabel = computed(() => (nickname.value
  ? `${nickname.value} · ${t('sidebar.personal')}`
  : t('sidebar.personal')))

let footerResizeObserver: ResizeObserver | null = null
onMounted(() => {
  measureProfileName()
  if (typeof ResizeObserver === 'undefined') return
  footerResizeObserver = new ResizeObserver(measureProfileName)
  // Resizing the nav column (or collapsing it) resizes the footer, which is the
  // signal the fit test waits for.
  if (footerEl.value) footerResizeObserver.observe(footerEl.value)
  // The probe measures in the face that is actually loaded: a late webfont swap
  // changes the name's width, and no resize follows it.
  document.fonts?.ready.then(measureProfileName, () => {})
})
onBeforeUnmount(() => {
  footerResizeObserver?.disconnect()
  footerResizeObserver = null
  tokenUsageGeneration += 1
})
watch([nickname, () => props.collapsed], async () => {
  await nextTick()
  measureProfileName()
})
</script>

<template>
  <aside class="sidebar" :class="{ 'sidebar-collapsed': collapsed }" :style="panelStyle" v-bind="panelDataAttrs">
    <div class="sidebar-topbar">
      <div class="brand">
        <BrandLogo :size="14" class="sidebar-icon brand-logo-icon" />
        <TinadecCalligraphy :size="14" class="sidebar-label brand-calligraphy" />
      </div>
    </div>

    <nav class="sidebar-nav">
      <UiButton
        variant="ghost"
        size="sm"
        class="sidebar-nav-item w-full justify-start"
        :disabled="busy"
        :title="t('sidebar.newChat')"
        @click="handleNewThread"
      >
        <MessageSquare :size="16" class="sidebar-icon" />
        <span class="sidebar-label">{{ t('sidebar.newChat') }}</span>
      </UiButton>
      <UiButton
        variant="ghost"
        size="sm"
        class="sidebar-nav-item w-full justify-start"
        :title="t('sidebar.market')"
        @click="emit('go-market')"
      >
        <Store :size="16" class="sidebar-icon" />
        <span class="sidebar-label">{{ t('sidebar.market') }}</span>
      </UiButton>
      <UiButton
        variant="ghost"
        size="sm"
        class="sidebar-nav-item w-full justify-start"
        v-if="debugStudioEnabled"
        :title="t('sidebar.debugStudio')"
        @click="openDebugStudio()"
      >
        <Bug :size="16" class="sidebar-icon" />
        <span class="sidebar-label">{{ t('sidebar.debugStudio') }}</span>
      </UiButton>
    </nav>

    <!-- The heading and the scrollport share one hover region: the "new workspace"
         action belongs to this block, not to the whole sidebar. -->
    <div class="workspace-section">
      <div class="workspace-section-heading">
        <button class="workspace-section-toggle" :aria-expanded="!list.state.value.collapsed" aria-controls="sidebar-workspaces" @click="list.state.value.collapsed = !list.state.value.collapsed">
          <span class="sidebar-label">{{ t('sidebar.workspaces') }}</span>
          <ChevronRight :size="13" class="workspace-section-chevron" :class="{ expanded: !list.state.value.collapsed }" />
        </button>
        <button
          type="button"
          class="workspace-section-action workspace-section-option sidebar-extra"
          :aria-label="t('sidebar.workspaceOptions')"
          :title="t('sidebar.workspaceOptions')"
          :aria-expanded="optionsMenuOpen"
          :aria-controls="optionsMenuId"
          aria-haspopup="dialog"
          :popovertarget="optionsMenuId"
          popovertargetaction="toggle"
          @click="openOptionsMenu"
        ><SlidersHorizontal :size="14" /></button>
        <button type="button" class="workspace-section-action workspace-section-add sidebar-extra" :aria-label="t('sidebar.newWorkspace')" :title="t('sidebar.newWorkspace')" @click.stop="emit('open-project')"><Plus :size="14" /></button>
      </div>
      <div id="sidebar-workspaces" class="sidebar-list" :class="{ 'sidebar-list--group-collapsed': list.state.value.collapsed }">
        <div v-if="list.state.value.recent && !list.state.value.collapsed" class="recent-conversations" role="group" :aria-label="t('sidebar.recentConversations')">
          <div class="recent-conversations-heading">{{ t('sidebar.recentConversations') }}</div>
          <div
            v-for="entry in recentConversations"
            :key="selectionKey(entry.session)"
            class="session-row recent-conversation-row"
            :class="{ active: isActiveSession(entry.session) }"
            @contextmenu.prevent="openMenuAtCursor($event, 'session', selectionKey(entry.session), entry.session.title)"
          >
            <button class="session-item" :aria-current="isActiveSession(entry.session) ? 'page' : undefined" :title="`${entry.session.title} · ${entry.workspace}`" @click="handleSessionClick(selectionKey(entry.session))">
              <MessageSquare :size="13" class="recent-conversation-icon" />
              <span class="session-title">{{ entry.session.title }}</span>
              <span class="recent-conversation-source">{{ entry.workspace }}</span>
            </button>
          </div>
          <div v-if="!recentConversations.length" class="session-empty">{{ t('sidebar.noSessions') }}</div>
        </div>
        <template v-if="!list.state.value.collapsed"><div v-for="workspace in workspaces" :key="workspace.key" class="project-group" :class="{ 'free-conversation-group': !workspace.project }" :data-workspace-key="workspace.key">
          <div class="project-row" :class="{
              active: workspace.project ? workspace.project.id === selectedProjectId && (!workspace.project.storage_id || workspace.project.storage_id === selectedStorage) : !selectedProjectId,
              'drag-source': draggedWorkspace === workspace.key,
              'drag-over-before': dragOverKey === workspace.key && !dragOverAfter,
              'drag-over-after': dragOverKey === workspace.key && dragOverAfter,
            }"
            draggable="true" @dragstart.stop="startDrag($event, workspace.key)" @dragend="draggedWorkspace = null; dragOverKey = null"
            @dragover.prevent="dragOverWorkspace($event, workspace.key)" @drop.stop="dropWorkspace($event, workspace.key)"
            @contextmenu.prevent="openMenuAtCursor($event, workspace.project ? 'project' : 'free', workspace.key, workspace.name)" @click="handleProjectClick(workspace.key)">
            <button class="project-row-main" :title="workspace.project?.path ?? workspace.name" :aria-expanded="isExpanded(workspace.key)" :aria-controls="`workspace-sessions-${workspace.key}`" :aria-keyshortcuts="'Alt+ArrowUp Alt+ArrowDown'" @keydown="reorderWithKeyboard($event, workspace.key)" @click.stop="handleProjectClick(workspace.key)">
              <component :is="workspace.project ? workspaceIcons[workspace.project.icon ?? 'folder'] ?? FolderOpen : Sparkles" :size="15" class="sidebar-list-item-icon sidebar-icon" :class="`workspace-color-${workspace.project?.color ?? 'default'}`" />
              <span class="sidebar-list-item-text sidebar-label">{{ workspace.name }}</span>
            </button>
            <button v-if="workspace.project" class="project-row-action sidebar-extra" :aria-label="`${workspace.name} · ${t('sidebar.moreActions')}`" :title="t('sidebar.moreActions')" @mousedown.stop @click.stop="openMenuAtButton($event, 'project', workspace.key, workspace.name)"><MoreHorizontal :size="14" /></button>
            <button class="project-row-action sidebar-extra" :disabled="busy || workspace.project?.availability === 'error'" :aria-label="`${workspace.name} · ${t('sidebar.newChat')}`" :title="t('sidebar.newChat')" @mousedown.stop @click.stop="emit('create-session', workspace.project ? workspace.key : null)"><Plus :size="14" /></button>
          </div>
          <div v-if="isExpanded(workspace.key)" :id="`workspace-sessions-${workspace.key}`" class="project-sessions sidebar-extra">
            <div v-if="workspaceLoadStates?.[workspace.key]?.status === 'loading'" class="session-empty" role="status">{{ t('common.loading') }}</div>
            <div v-else-if="workspaceLoadStates?.[workspace.key]?.status === 'error' || workspace.project?.availability === 'error'" class="workspace-load-error" role="status">
              <span :title="workspaceLoadStates?.[workspace.key]?.message ?? errorCodeMessage(workspace.project?.availability_code, undefined, { t, te }) ?? workspace.project?.availability_error">{{ t('home.loadFailed') }}</span><button @click="emit('retry-workspaces', workspace.key)">{{ t('common.retry') }}</button>
            </div>
            <div v-for="session in shownSessions(workspace.key)" :key="selectionKey(session)" class="session-row" :class="{ active: isActiveSession(session) }" @contextmenu.prevent="openMenuAtCursor($event, 'session', selectionKey(session), session.title)">
              <button class="session-item" :aria-current="isActiveSession(session) ? 'page' : undefined" :title="session.title" @click="handleSessionClick(selectionKey(session))" @dblclick.stop="renaming = { kind: 'session', id: selectionKey(session) }">
                <InlineRenameInput v-if="renaming?.kind === 'session' && renaming.id === selectionKey(session)" :model-value="session.title" class="session-title" @submit="submitRename" @cancel="cancelRename" /><span v-else class="session-title">{{ session.title }}</span>
              </button>
              <button class="session-more" :title="t('sidebar.moreActions')" @click.stop="openMenuAtButton($event, 'session', selectionKey(session), session.title)"><MoreHorizontal :size="13" /></button>
            </div>
            <div v-if="!allSessions(workspace.key).length && (!workspaceLoadStates?.[workspace.key] || workspaceLoadStates[workspace.key]?.status === 'ready') && workspace.project?.availability !== 'error'" class="session-empty">{{ t('sidebar.noSessions') }}</div>
            <button v-if="allSessions(workspace.key).length > shownSessions(workspace.key).length || list.state.value.allKeys.includes(workspace.key)" class="workspace-show-more" @click="list.toggle(workspace.key, 'allKeys')">{{ list.state.value.allKeys.includes(workspace.key) ? t('sidebar.showFewer') : t('sidebar.showAll') }}</button>
          </div>
        </div></template>
      </div>
    </div>

    <div v-if="tokenUsage && tokenUsage.calls > 0" class="token-usage-area">
      <div class="token-usage-heading">
        <span class="token-usage-label">{{ t('sidebar.tokenUsage', { days: SIDEBAR_USAGE_DAYS }) }}</span>
        <span
          v-if="tokenUsage.total !== null"
          class="token-usage-total"
          :title="tokenUsage.truncated ? t('sidebar.tokenUsageTruncated', { count: USAGE_PAGE_LIMIT * USAGE_MAX_PAGES }) : undefined"
        >{{ tokenUsageTotal }}</span>
      </div>
      <div v-if="tokenUsage.total === null" class="token-usage-unreported">{{ t('sidebar.tokenUsageUnreported') }}</div>
      <div v-else class="token-usage-chart" role="img" :aria-label="tokenUsageSummary">
        <div
          v-for="bar in tokenUsage.bars"
          :key="bar.dayKey"
          class="token-usage-bar"
          :class="bar.level"
          :style="{ height: bar.tokens === null || bar.tokens === 0 ? '2px' : `${bar.height}%` }"
          :title="usageDayTitle(bar)"
        />
      </div>
    </div>

    <div ref="footerEl" class="sidebar-footer">
      <!-- Identity sits at the far left; the three shell actions stay right-aligned.
           The nickname rides beside the portrait only while the row can hold it whole. -->
      <button
        type="button"
        class="sidebar-profile"
        :class="{ 'sidebar-profile--named': profileNameShown }"
        :title="profileTitle"
        :aria-label="profileLabel"
        @click="emit('go-personal')"
      >
        <PersonalAvatar :size="PROFILE_AVATAR_SIZE" />
        <!-- Rendered whenever there is a name to carry, and animated by width + opacity:
             collapsing it to zero width is what makes the fade reversible mid-resize.
             The cap is the measured natural width, so the reveal never shows a clipped word. -->
        <span
          v-if="nickname"
          class="sidebar-profile-name"
          :class="{ 'sidebar-profile-name--shown': profileNameShown }"
          :style="{ '--profile-name-max': `${profileNameMax}px` }"
          aria-hidden="true"
        >{{ nickname }}</span>
        <!-- Measured, never painted: the fit test needs the name's natural width, which
             a clamped or hidden label cannot report. -->
        <span ref="profileNameProbe" class="sidebar-profile-name-probe" aria-hidden="true">{{ nickname }}</span>
      </button>
      <div ref="footerActionsEl" class="sidebar-footer-actions" :class="{ 'sidebar-footer-actions-collapsed': collapsed }">
        <UiButton
          variant="ghost"
          size="icon"
          class="sidebar-footer-action"
          :title="t('space.switchView')"
          :aria-label="t('space.switchView')"
          :aria-expanded="viewMenuOpen"
          :aria-controls="viewMenuId"
          aria-haspopup="dialog"
          :popovertarget="viewMenuId"
          popovertargetaction="toggle"
          @click="openViewMenu"
        >
          <Waypoints v-if="spaceActive" :size="16" /><LayoutGrid v-else :size="16" />
        </UiButton>
        <UiButton
          variant="ghost"
          size="icon"
          class="sidebar-footer-action"
          :title="t('sidebar.settings')"
          @click="emit('go-settings')"
        >
          <Settings :size="16" />
        </UiButton>
        <UiButton
          variant="ghost"
          size="icon"
          class="sidebar-footer-action"
          :title="collapsed ? t('sidebar.expand') : t('sidebar.collapse')"
          @click="emit('toggle-collapse')"
        >
          <component :is="collapsed ? PanelLeftOpen : PanelLeftClose" :size="16" />
        </UiButton>
      </div>
    </div>

    <RowContextMenu
      :visible="menuTarget !== null"
      :x="menuTarget?.x ?? 0"
      :y="menuTarget?.y ?? 0"
      :items="menuItems"
      @select="handleMenuSelect"
      @close="menuTarget = null"
    />
    <div :id="viewMenuId" ref="viewMenu" popover class="sidebar-view-menu" :style="viewMenuStyle" role="dialog" :aria-label="t('space.switchView')" @beforetoggle="updateViewMenuState">
      <button :aria-pressed="!spaceActive" :autofocus="!spaceActive" @click="changeView('flat')"><LayoutGrid :size="18" />{{ t('space.flat') }}</button>
      <button :aria-pressed="!!spaceActive" :autofocus="!!spaceActive" @click="changeView('space')"><Waypoints :size="18" />{{ t('space.title') }}</button>
    </div>
    <div
      :id="optionsMenuId"
      ref="optionsMenu"
      popover
      class="sidebar-workspace-options"
      :style="optionsMenuStyle"
      role="dialog"
      :aria-label="t('sidebar.workspaceOptions')"
      @beforetoggle="updateOptionsMenuState"
    >
      <p class="sidebar-workspace-options-title">{{ t('sidebar.workspaceOptions') }}</p>
      <button
        type="button"
        class="sidebar-option"
        role="switch"
        :aria-checked="list.state.value.recent"
        @click="toggleRecentConversations"
      >
        <span class="sidebar-option-copy">
          <span class="sidebar-option-label">{{ t('sidebar.recentConversations') }}</span>
          <span class="sidebar-option-hint">{{ t('sidebar.recentConversationsHint') }}</span>
        </span>
        <span class="sidebar-option-switch" aria-hidden="true"></span>
      </button>
    </div>
    <dialog ref="migrationDialog" class="sidebar-migration-dialog" aria-labelledby="migration-title" @close="migrationSession = null">
      <form @submit.prevent="submitMigration">
        <h2 id="migration-title">{{ t('sidebar.migrateSession') }}</h2>
        <p>{{ migrationSession?.name }}</p>
        <label>{{ t('sidebar.migrationTarget') }}<UiSelectField v-model="migrationProject" :aria-label="t('sidebar.migrationTarget')" :options="migrationProjects.map((project) => ({ value: selectionKey(project), label: `${project.name} · ${project.path}` }))" /></label>
        <p class="quiet">{{ t('sidebar.migrationExplanation') }}</p>
        <div><UiButton type="button" variant="ghost" @click="migrationDialog?.close()">{{ t('common.cancel') }}</UiButton><UiButton type="submit" :disabled="!migrationProject || busy">{{ t('sidebar.migrateSession') }}</UiButton></div>
      </form>
    </dialog>
  </aside>
</template>

<style scoped>
.sidebar-view-menu { position: fixed; inset: auto; margin: 0; width: 200px; padding: 6px; border: 1px solid var(--border-muted); border-radius: 12px; background: var(--surface-raised); color: var(--text-primary); box-shadow: var(--shadow-card-subtle); opacity: 0; transform: translateY(6px) scale(0.98); transform-origin: bottom left; pointer-events: none; transition: opacity 160ms ease-out, transform 160ms ease-out, display 160ms allow-discrete, overlay 160ms allow-discrete; }
.sidebar-view-menu:popover-open { opacity: 1; transform: translateY(0) scale(1); pointer-events: auto; }
@starting-style {
  .sidebar-view-menu:popover-open { opacity: 0; transform: translateY(6px) scale(0.98); }
}
@media (prefers-reduced-motion: reduce) {
  .sidebar-view-menu { transition: none; transform: none; }
}
.sidebar-view-menu button { display: flex; align-items: center; gap: 10px; width: 100%; padding: 12px; border: 0; border-radius: 8px; background: transparent; color: inherit; cursor: pointer; }
.sidebar-view-menu button:hover, .sidebar-view-menu button[aria-pressed="true"] { background: var(--surface-selected); }
/* Section options mirror the view chooser: a native popover anchored by the invoker, so
   Escape, light dismiss and focus restore stay browser behaviour instead of hand-rolled. */
.sidebar-workspace-options { position: fixed; inset: auto; margin: 0; width: 236px; padding: 6px; border: 1px solid var(--border-muted); border-radius: 12px; background: var(--surface-raised); color: var(--text-primary); box-shadow: var(--shadow-card-subtle); opacity: 0; transform: translateY(-6px) scale(0.98); transform-origin: top right; pointer-events: none; transition: opacity 160ms ease-out, transform 160ms ease-out, display 160ms allow-discrete, overlay 160ms allow-discrete; }
.sidebar-workspace-options:popover-open { opacity: 1; transform: translateY(0) scale(1); pointer-events: auto; }
@starting-style { .sidebar-workspace-options:popover-open { opacity: 0; transform: translateY(-6px) scale(0.98); } }
@media (prefers-reduced-motion: reduce) { .sidebar-workspace-options { transition: none; transform: none; } }
.sidebar-workspace-options-title { margin: 4px 8px 6px; font-size: 11px; font-weight: 500; letter-spacing: 0.02em; color: var(--text-muted); }
.sidebar-option { display: flex; align-items: flex-start; gap: 10px; width: 100%; padding: 9px 8px; border: 0; border-radius: 8px; background: transparent; color: inherit; text-align: left; cursor: pointer; }
.sidebar-option:hover { background: var(--surface-hover); }
.sidebar-option:focus-visible { outline: 2px solid var(--accent-primary); outline-offset: -2px; }
.sidebar-option-copy { display: grid; gap: 2px; flex: 1; min-width: 0; }
.sidebar-option-label { font-size: 12px; color: var(--text-primary); }
.sidebar-option-hint { font-size: 11px; line-height: 1.35; color: var(--text-muted); }
.sidebar-option-switch { position: relative; flex: 0 0 auto; width: 26px; height: 15px; margin-top: 2px; border-radius: 999px; background: color-mix(in srgb, var(--text-muted) 40%, transparent); transition: background 140ms ease; }
.sidebar-option-switch::after { content: ''; position: absolute; top: 2px; left: 2px; width: 11px; height: 11px; border-radius: 50%; background: var(--text-secondary); transition: transform 140ms ease, background 140ms ease; }
.sidebar-option[aria-checked="true"] .sidebar-option-switch { background: var(--accent-primary); }
.sidebar-option[aria-checked="true"] .sidebar-option-switch::after { transform: translateX(11px); background: rgb(255 255 255 / 0.94); }
.sidebar-migration-dialog { width: min(560px, calc(100vw - 32px)); border: 1px solid var(--border-muted); border-radius: 12px; padding: 24px; background: var(--surface-raised); color: var(--text-primary); box-shadow: var(--shadow-card-subtle); }
.sidebar-migration-dialog::backdrop { background: color-mix(in srgb, var(--bg-overlay) 65%, transparent); }
.sidebar-migration-dialog form, .sidebar-migration-dialog label { display: grid; gap: 12px; }
.sidebar-migration-dialog form > div { display: flex; justify-content: flex-end; gap: 12px; }
.sidebar-migration-dialog h2 { font-size: 18px; margin: 0; }
.sidebar-migration-dialog select:focus-visible { outline: 2px solid var(--accent-primary); outline-offset: 2px; }
</style>
