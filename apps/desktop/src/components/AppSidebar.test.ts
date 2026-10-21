// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import AppSidebar from './AppSidebar.vue'
import sidebarSource from './AppSidebar.vue?raw'
import type { ProjectDto, SessionDto } from '../api'
import { useDebugStudio } from '@/composables/useDebugStudio'
import { freeWorkspaceKey, workspaceListStorageKey } from '@/composables/useWorkspaceList'
import { setSelectedStorage } from '@/lib/storageScope'
import { setNickname } from '@/lib/userProfile'

vi.mock('vue-i18n', async (importOriginal) => ({ ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({ t: (key: string) => key, te: () => false, locale: { value: 'en' } }),
}))

const { confirmMock, listModelInvocationsMock } = vi.hoisted(() => ({
  confirmMock: vi.fn(async (..._args: unknown[]) => true),
  listModelInvocationsMock: vi.fn(async (..._params: unknown[]) => ({
    items: [] as unknown[],
    next_cursor: null as string | null,
  })),
}))

vi.mock('../api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api')>()
  return { ...actual, api: { ...actual.api, listModelInvocations: (...args: unknown[]) => listModelInvocationsMock(...args) } }
})

vi.mock('@/composables/useNotifications', () => ({
  useNotifications: () => ({
    confirm: (...args: unknown[]) => confirmMock(...args),
    notify: { error: vi.fn(), success: vi.fn() },
    banner: { error: vi.fn() },
    dismissByKey: vi.fn(),
  }),
}))

const project: ProjectDto = { id: 'p-1', name: 'Demo project', path: 'C:/demo', created_at: '2026-08-27T00:00:00Z' }
const session: SessionDto = {
  permission_mode: 'default', space_options: null, settings_revision: 0,
  id: 's-1',
  project_id: 'p-1',
  title: 'Demo session',
  status: 'ready',
  created_at: '2026-08-27T00:00:00Z',
  updated_at: '2026-08-27T00:00:00Z',
}

beforeEach(() => {
  listModelInvocationsMock.mockReset()
  listModelInvocationsMock.mockResolvedValue({ items: [], next_cursor: null })
})

function factory(overrides: Record<string, unknown> = {}, attachTo?: Element) {
  return mount(AppSidebar, {
    attachTo,
    global: {
      // RowContextMenu wraps its panel in <Transition>; test-utils stubs it by
      // default, which would render the menu as an empty stub and break every
      // menu assertion below.
      stubs: { BrandLogo: true, TinadecCalligraphy: true, transition: false },
    },
    props: {
      projects: [project],
      sessions: [session],
      selectedProjectId: 'p-1',
      selectedSessionId: 's-1',
      busy: false,
      ...overrides,
    },
  })
}

describe('Debug Studio opt-in navigation', () => {
  it('hides the entry by default and follows the host preference after an explicit save', async () => {
    const getAppConfig = vi.fn(async () => ({ debug_studio_enabled: false }))
    const saveDebugStudioEnabled = vi.fn(async (value: boolean) => ({ debug_studio_enabled: value }))
    const openDebugStudio = vi.fn(async () => true)
    const previousHost = window.tinadec
    Object.defineProperty(window, 'tinadec', { configurable: true, value: { getAppConfig, saveDebugStudioEnabled, openDebugStudio } })
    const wrapper = factory()
    try {
      await flushPromises()
      expect(wrapper.find('[title="sidebar.debugStudio"]').exists()).toBe(false)
      await useDebugStudio().saveEnabled(true)
      await flushPromises()
      await wrapper.get('[title="sidebar.debugStudio"]').trigger('click')
      expect(openDebugStudio).toHaveBeenCalledOnce()
      await useDebugStudio().saveEnabled(false)
      await flushPromises()
      expect(wrapper.find('[title="sidebar.debugStudio"]').exists()).toBe(false)
    } finally {
      wrapper.unmount()
      Object.defineProperty(window, 'tinadec', { configurable: true, value: previousHost })
    }
  })
})

function menuButtons(): HTMLButtonElement[] {
  return Array.from(document.body.querySelectorAll('.row-context-menu button'))
}

async function expandProject(wrapper: ReturnType<typeof factory>) {
  const trigger = wrapper.get('[data-workspace-key=\"p-1\"] .project-row-main')
  if (trigger.attributes('aria-expanded') !== 'true') await trigger.trigger('click')
}

// happy-dom does not implement native Popover/ToggleEvent. Exercise Vue's
// real state listener with the browser event's fields; Chromium acceptance
// separately verifies the native default action and rendered transitions.
function dispatchViewToggle(element: Element, newState: 'open' | 'closed') {
  const event = new Event('beforetoggle')
  Object.defineProperty(event, 'newState', { value: newState })
  element.dispatchEvent(event)
}

describe('AppSidebar lifecycle management', () => {
  it('reorders workspaces, including the free conversation, and persists the new order', async () => {
    localStorage.clear()
    const second = { ...project, id: 'p-2', name: 'Second' }
    const wrapper = factory({ projects: [project, second] })
    const keys = () => wrapper.findAll('.project-group').map(node => node.attributes('data-workspace-key'))
    expect(keys()).toEqual([freeWorkspaceKey, 'p-1', 'p-2'])

    // Move the free conversation below the first project: it is no longer pinned to the top.
    await wrapper.get('[data-workspace-key="user::free"] .project-row-main').trigger('keydown', { key: 'ArrowDown', altKey: true })
    expect(keys()).toEqual(['p-1', freeWorkspaceKey, 'p-2'])

    await wrapper.get('[data-workspace-key="p-2"] .project-row-main').trigger('keydown', { key: 'ArrowUp', altKey: true })
    expect(keys()).toEqual(['p-1', 'p-2', freeWorkspaceKey])

    expect(JSON.parse(localStorage.getItem(workspaceListStorageKey)!).order).toEqual(['p-1', 'p-2', freeWorkspaceKey])

    // A plain arrow press must not reorder; it stays available to the row's own behaviour.
    await wrapper.get('[data-workspace-key="p-1"] .project-row-main').trigger('keydown', { key: 'ArrowDown' })
    expect(keys()).toEqual(['p-1', 'p-2', freeWorkspaceKey])
    wrapper.unmount()
  })

  it('shows only reordering actions for the free conversation', async () => {
    localStorage.clear()
    const wrapper = factory()
    await wrapper.get('[data-workspace-key="user::free"] .project-row').trigger('contextmenu')
    expect(menuButtons().map(node => node.textContent?.trim())).toEqual(['sidebar.moveUp', 'sidebar.moveDown'])
    wrapper.unmount()
  })

  it('folds without navigating, and isolates plus and section actions', async () => {
    localStorage.clear()
    const wrapper = factory()
    const row = wrapper.get('[data-workspace-key="p-1"] .project-row-main')
    await row.trigger('click')
    expect(row.attributes('aria-expanded')).toBe('false')
    expect(wrapper.emitted('select-project')).toBeUndefined()
    await wrapper.get('[data-workspace-key="p-1"] button[title="sidebar.newChat"]').trigger('click')
    expect(wrapper.emitted('create-session')).toEqual([['p-1']])
    expect(row.attributes('aria-expanded')).toBe('false')
    await wrapper.get('.workspace-section-add').trigger('click')
    expect(wrapper.emitted('open-project')).toHaveLength(1)
    expect(wrapper.get('.workspace-section-toggle').attributes('aria-expanded')).toBe('true')
    await wrapper.get('.workspace-section-toggle').trigger('keydown', { key: 'Enter' })
    await wrapper.get('.workspace-section-toggle').trigger('click')
    expect(wrapper.get('.workspace-section-toggle').attributes('aria-expanded')).toBe('false')
    wrapper.unmount()
  })

  it('keeps the section action inside the same hover region as the workspace list', () => {
    // The reveal is pure CSS (`.workspace-section:hover`), which happy-dom cannot evaluate.
    // What a DOM test can pin is the region itself: the "new workspace" action and the
    // scrollport must share one ancestor, otherwise hovering a workspace stops surfacing
    // the button and it falls back to being permanently visible.
    const wrapper = factory()
    const section = wrapper.get('.workspace-section')
    expect(section.find('.workspace-section-add').exists()).toBe(true)
    expect(section.find('#sidebar-workspaces').exists()).toBe(true)
    expect(section.element.contains(wrapper.get('[data-workspace-key="p-1"]').element)).toBe(true)
    wrapper.unmount()
  })

  it('turns the cross-workspace recent list on from the workspace options picker', async () => {
    localStorage.clear()
    const second = { ...project, id: 'p-2', name: 'Second' }
    const free: SessionDto = { ...session, id: 's-free', project_id: null, title: 'Older free chat', updated_at: '2026-08-01T00:00:00Z' }
    const newest: SessionDto = { ...session, id: 's-new', project_id: 'p-2', title: 'Newest work', updated_at: '2026-09-05T00:00:00Z' }
    const wrapper = factory({ projects: [project, second], sessions: [session, free, newest], selectedSessionId: 's-new' }, document.body)

    // Off by default: the workspace rows stay the only navigation surface until it is asked for.
    expect(wrapper.find('.recent-conversations').exists()).toBe(false)
    const trigger = wrapper.get<HTMLButtonElement>('.workspace-section-option')
    const menu = wrapper.get<HTMLDivElement>('.sidebar-workspace-options')
    expect(trigger.attributes('popovertarget')).toBe(menu.attributes('id'))
    expect(trigger.attributes('aria-controls')).toBe(menu.attributes('id'))
    expect(trigger.attributes('aria-expanded')).toBe('false')

    await trigger.trigger('click')
    dispatchViewToggle(menu.element, 'open')
    await flushPromises()
    expect(trigger.attributes('aria-expanded')).toBe('true')

    const option = wrapper.get('.sidebar-option')
    const checkbox = option.get('[role="checkbox"]')
    expect(checkbox.attributes('aria-checked')).toBe('false')
    await option.trigger('click')
    expect(checkbox.attributes('aria-checked')).toBe('true')

    // Every workspace contributes — the free conversation included — newest first, and each row
    // names the workspace it came from so a flat list never loses "where am I".
    const rows = wrapper.findAll('.recent-conversation-row')
    expect(rows.map(row => row.get('.session-title').text())).toEqual(['Newest work', 'Demo session', 'Older free chat'])
    expect(rows.map(row => row.get('.recent-conversation-source').text())).toEqual(['Second', 'Demo project', 'chat.freeConversation'])
    expect(rows[0]!.classes()).toContain('active')

    // A checkbox list stays open so more options can be toggled.
    expect(trigger.attributes('aria-expanded')).toBe('true')
    expect(JSON.parse(localStorage.getItem(workspaceListStorageKey)!).recent).toBe(true)

    // A recents row opens that conversation without expanding its workspace first.
    await rows[2]!.get('.session-item').trigger('click')
    expect(wrapper.emitted('select-session')?.at(-1)).toEqual(['s-free'])

    await option.trigger('click')
    expect(wrapper.find('.recent-conversations').exists()).toBe(false)
    expect(JSON.parse(localStorage.getItem(workspaceListStorageKey)!).recent).toBe(false)
    wrapper.unmount()
  })

  it('hides project conversation groups without disabling projects or the recent shortcut', async () => {
    localStorage.setItem(workspaceListStorageKey, JSON.stringify({ collapsed: false, collapsedKeys: [], allKeys: [], order: [], recent: true, projectConversations: true }))
    const second = { ...project, id: 'p-2', name: 'Second' }
    const free: SessionDto = { ...session, id: 's-free', project_id: null, title: 'Free chat', updated_at: '2026-09-05T00:00:00Z' }
    const projectSession: SessionDto = { ...session, id: 's-p2', project_id: 'p-2', title: 'Project chat', updated_at: '2026-09-04T00:00:00Z' }
    const wrapper = factory({ projects: [project, second], sessions: [session, free, projectSession] })

    const projectOption = () => wrapper.get('[aria-label="sidebar.projectConversations"]')
    expect(projectOption().attributes('aria-checked')).toBe('true')
    expect(wrapper.find('[data-workspace-key="p-2"]').exists()).toBe(true)

    await projectOption().trigger('click')
    expect(projectOption().attributes('aria-checked')).toBe('false')
    expect(wrapper.find('[data-workspace-key="p-1"]').exists()).toBe(false)
    expect(wrapper.find('[data-workspace-key="p-2"]').exists()).toBe(false)
    expect(wrapper.find('[data-workspace-key="user::free"]').exists()).toBe(true)

    // Only the grouped list is hidden: the flat recent list still reaches project chats,
    // and the project feature itself stays registered (no unregister/trash action).
    expect(wrapper.findAll('.recent-conversation-row .session-title').map(node => node.text())).toContain('Project chat')
    expect(JSON.parse(localStorage.getItem(workspaceListStorageKey)!).projectConversations).toBe(false)
    expect(wrapper.emitted('unregister-workspace')).toBeUndefined()
    expect(wrapper.emitted('trash-project')).toBeUndefined()

    await projectOption().trigger('click')
    expect(wrapper.find('[data-workspace-key="p-2"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('hides the free conversation row independently', async () => {
    localStorage.setItem(workspaceListStorageKey, JSON.stringify({ collapsed: false, collapsedKeys: [], allKeys: [], order: [], recent: false, projectConversations: true, freeConversation: true }))
    const second = { ...project, id: 'p-2', name: 'Second' }
    const wrapper = factory({ projects: [project, second] })

    const freeOption = () => wrapper.get('[aria-label="chat.freeConversation"]')
    expect(freeOption().attributes('aria-checked')).toBe('true')
    await freeOption().trigger('click')
    expect(freeOption().attributes('aria-checked')).toBe('false')
    expect(wrapper.find('[data-workspace-key="user::free"]').exists()).toBe(false)
    expect(wrapper.find('[data-workspace-key="p-1"]').exists()).toBe(true)
    expect(JSON.parse(localStorage.getItem(workspaceListStorageKey)!).freeConversation).toBe(false)

    await freeOption().trigger('click')
    expect(wrapper.find('[data-workspace-key="user::free"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('comes back with the recent list already on after a remount', () => {
    localStorage.setItem(workspaceListStorageKey, JSON.stringify({ collapsed: false, collapsedKeys: [], allKeys: [], order: [], recent: true }))
    const wrapper = factory()
    expect(wrapper.get('.sidebar-option [role="checkbox"]').attributes('aria-checked')).toBe('true')
    expect(wrapper.findAll('.recent-conversation-row')).toHaveLength(1)
    wrapper.unmount()
  })

  it('keeps five recent conversations and the selected older one, then shows all', async () => {
    localStorage.clear()
    const sessions = Array.from({ length: 9 }, (_, index) => ({ ...session, id: `s-${index}`, updated_at: new Date(index * 1000).toISOString() }))
    const wrapper = factory({ sessions, selectedSessionId: 's-0' })
    expect(wrapper.findAll('.session-row')).toHaveLength(6)
    await wrapper.get('.workspace-show-more').trigger('click')
    expect(wrapper.findAll('.session-row')).toHaveLength(9)
    expect(wrapper.get('.workspace-show-more').text()).toBe('sidebar.showFewer')
    await wrapper.get('.workspace-show-more').trigger('click')
    expect(wrapper.findAll('.session-row')).toHaveLength(6)
    wrapper.unmount()
  })

  it('retains manual order when project activity refreshes and inserts new workspaces after free', async () => {
    localStorage.clear()
    const second = { ...project, id: 'p-2', name: 'Second' }
    const wrapper = factory({ projects: [project, second] })
    await wrapper.get('[data-workspace-key="p-2"] .project-row').trigger('contextmenu')
    menuButtons()[1].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()
    expect(wrapper.findAll('.project-group').slice(1).map(node => node.attributes('data-workspace-key'))).toEqual(['p-2', 'p-1'])
    const refreshed = { ...project, updated_at: '2099-01-01' }
    await wrapper.setProps({ projects: [refreshed, second, { ...project, id: 'p-3' }] })
    expect(wrapper.findAll('.project-group').slice(1).map(node => node.attributes('data-workspace-key'))).toEqual(['p-3', 'p-2', 'p-1'])
    expect(JSON.parse(localStorage.getItem(workspaceListStorageKey)!).order).toEqual([freeWorkspaceKey, 'p-3', 'p-2', 'p-1'])
    wrapper.unmount()
  })
  it('opens the native view chooser without changing the actual session view', async () => {
    const wrapper = factory()
    const trigger = wrapper.get<HTMLButtonElement>('[title="space.switchView"]')
    const menu = wrapper.get('.sidebar-view-menu')
    expect(trigger.attributes('popovertarget')).toBe(menu.attributes('id'))
    expect(trigger.attributes('popovertargetaction')).toBe('toggle')
    expect(trigger.attributes('aria-controls')).toBe(menu.attributes('id'))
    expect(trigger.attributes('aria-expanded')).toBe('false')
    await trigger.trigger('click')
    dispatchViewToggle(menu.element, 'open')
    await flushPromises()
    expect(trigger.attributes('aria-expanded')).toBe('true')
    expect(wrapper.emitted('change-view')).toBeUndefined()
    expect(menu.get('button[aria-pressed="true"]').text()).toBe('space.flat')
    dispatchViewToggle(menu.element, 'closed')
    await flushPromises()
    expect(trigger.attributes('aria-expanded')).toBe('false')
    wrapper.unmount()
  })

  it('switches immediately on each choice and returns focus without waiting for animation', async () => {
    const wrapper = factory({}, document.body)
    const trigger = wrapper.get<HTMLButtonElement>('[title="space.switchView"]')
    const menu = wrapper.get<HTMLDivElement>('.sidebar-view-menu')
    const hide = vi.fn(() => dispatchViewToggle(menu.element, 'closed'))
    Object.defineProperty(menu.element, 'hidePopover', { configurable: true, value: hide })
    await trigger.trigger('click')
    dispatchViewToggle(menu.element, 'open')
    const choices = menu.findAll<HTMLButtonElement>('button')
    choices[1]!.element.focus()
    await choices[1]!.trigger('click')
    expect(wrapper.emitted('change-view')).toEqual([['space']])
    expect(hide).toHaveBeenCalledTimes(1)
    expect(document.activeElement).toBe(trigger.element)
    await wrapper.setProps({ spaceActive: true })
    await trigger.trigger('click')
    choices[0]!.element.focus()
    await choices[0]!.trigger('click')
    expect(wrapper.emitted('change-view')).toEqual([['space'], ['flat']])
    expect(document.activeElement).toBe(trigger.element)
    expect(trigger.attributes('aria-expanded')).toBe('false')
    wrapper.unmount()
  })

  it('gives separate sidebars unique native popover targets', () => {
    // Vue useId is scoped to one app; two separately mounted test apps both
    // begin at v-0. Real UIE sidebars share a single renderer app.
    const wrapper = mount(defineComponent({
      components: { AppSidebar },
      template: '<div><AppSidebar :projects="[]" :sessions="[]" :selected-project-id="null" :selected-session-id="null" :busy="false" /><AppSidebar :projects="[]" :sessions="[]" :selected-project-id="null" :selected-session-id="null" :busy="false" space-active /></div>',
    }), { global: { stubs: { BrandLogo: true, TinadecCalligraphy: true } } })
    const menus = wrapper.findAll('.sidebar-view-menu')
    expect(menus[0]!.attributes('id')).not.toBe(menus[1]!.attributes('id'))
    expect(menus[1]!.get('button[aria-pressed="true"]').text()).toBe('space.title')
    wrapper.unmount()
  })

  it('keeps the observer-side navigation clickable while a run is busy', async () => {
    // 这条原本是聊天室的用例（它是唯一刻意不接 :disabled="busy" 的按钮）；聊天室界面删除后，
    // 同一个保证落在市场按钮上——busy 期间挡住导航就是运行中连页面都切不了。
    const wrapper = factory({ busy: true, collapsed: true })
    expect(wrapper.find('[title="sidebar.commandCenter"]').exists()).toBe(false)
    expect(wrapper.find('[title="space.switchView"]').exists()).toBe(true)
    const button = wrapper.get('[title="sidebar.market"]')
    expect(button.attributes('disabled')).toBeUndefined()
    await button.trigger('click')
    expect(wrapper.emitted('go-market')).toHaveLength(1)
    wrapper.unmount()
  })

  beforeEach(() => {
    localStorage.clear()
    confirmMock.mockClear()
    document.body.querySelectorAll('.row-context-menu').forEach((node) => node.remove())
  })

  it('opens the context menu on project right-click and archives via the menu', async () => {
    const wrapper = factory()
    await wrapper.find('[data-workspace-key=\"p-1\"] .project-row').trigger('contextmenu')
    expect(menuButtons().map((b) => b.textContent?.trim())).toEqual([
      'sidebar.editWorkspace',
      'sidebar.moveUp',
      'sidebar.moveDown',
      'sidebar.archive',
      'sidebar.moveToTrash',
    ])
    menuButtons()[3].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()
    expect(wrapper.emitted('archive-project')?.[0]).toEqual(['p-1'])
  })

  it('moves a session to the trash only after confirmation', async () => {
    const wrapper = factory()
    await expandProject(wrapper)
    await wrapper.find('.session-row').trigger('contextmenu')
    menuButtons()[2].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()
    expect(confirmMock).toHaveBeenCalledTimes(1)
    expect(wrapper.emitted('trash-session')?.[0]).toEqual(['s-1'])
  })

  it('does not trash the session when the confirmation is rejected', async () => {
    confirmMock.mockResolvedValueOnce(false)
    const wrapper = factory()
    await expandProject(wrapper)
    await wrapper.find('.session-row').trigger('contextmenu')
    menuButtons()[2].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()
    expect(wrapper.emitted('trash-session')).toBeUndefined()
  })

  it('edits a workspace from its menu without selecting or folding', async () => {
    const wrapper = factory()
    await wrapper.get('[data-workspace-key="p-1"] .project-row').trigger('contextmenu')
    menuButtons()[0].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()
    expect(wrapper.emitted('edit-workspace')?.[0]).toEqual(['p-1'])
    expect(wrapper.emitted('select-project')).toBeUndefined()
    expect(wrapper.get('[data-workspace-key="p-1"] .project-row-main').attributes('aria-expanded')).toBe('true')
    wrapper.unmount()
  })

  it('renames a session through the inline input', async () => {
    const wrapper = factory()
    await expandProject(wrapper)
    await wrapper.find('.session-item').trigger('dblclick')
    const input = wrapper.find('.inline-rename-input')
    expect(input.exists()).toBe(true)
    await input.setValue('Renamed session')
    await input.trigger('keydown', { key: 'Enter' })
    await input.trigger('blur')
    expect(wrapper.emitted('rename-session')?.[0]).toEqual(['s-1', 'Renamed session'])
  })

  it('opens the same menu from the hover more button', async () => {
    const wrapper = factory()
    await expandProject(wrapper)
    await wrapper.find('.session-more').trigger('click')
    expect(menuButtons()).toHaveLength(3)
  })

  it('renames a free conversation through the inline input', async () => {
    const free: SessionDto = {
      permission_mode: 'default', space_options: null, settings_revision: 0,
      id: 's-free', project_id: null, title: 'Free chat', status: 'ready',
      created_at: '2026-09-10T00:00:00Z', updated_at: '2026-09-10T00:00:00Z',
    }
    const wrapper = factory({ sessions: [free], selectedProjectId: null, selectedSessionId: null })
    await wrapper.find('.free-conversation-group .session-item').trigger('dblclick')
    const input = wrapper.find('.free-conversation-group .inline-rename-input')
    expect(input.exists()).toBe(true)
    await input.setValue('Renamed free chat')
    await input.trigger('keydown', { key: 'Enter' })
    await input.trigger('blur')
    expect(wrapper.emitted('rename-session')?.[0]).toEqual(['s-free', 'Renamed free chat'])
    wrapper.unmount()
  })

  it('offers only available active workspaces as migration targets and rejects a target that becomes unavailable', async () => {
    const free = { ...session, id: 's-free', project_id: null, storage_id: 'user' }
    const eligible = { ...project, storage_id: 'scope-active', lifecycle_status: 'active' as const, availability: 'ready' as const }
    const invalid: ProjectDto[] = [
      { ...project, id: 'broken', storage_id: 'scope-broken', lifecycle_status: 'active', availability: 'error' },
      { ...project, id: 'unknown', storage_id: 'scope-unknown', lifecycle_status: null },
      { ...project, id: 'unread', storage_id: 'scope-unread' },
      { ...project, id: 'archived', storage_id: 'scope-archived', lifecycle_status: 'archived' },
      { ...project, id: 'trashed', storage_id: 'scope-trashed', lifecycle_status: 'trashed' },
    ]
    const wrapper = factory({ projects: [eligible, ...invalid], sessions: [free], selectedProjectId: null, selectedSessionId: null })
    const dialog = wrapper.get<HTMLDialogElement>('.sidebar-migration-dialog')
    Object.defineProperty(dialog.element, 'showModal', { configurable: true, value: vi.fn() })
    Object.defineProperty(dialog.element, 'close', { configurable: true, value: vi.fn() })
    await wrapper.get('.free-conversation-group .session-row').trigger('contextmenu')
    menuButtons().find(button => button.textContent?.trim() === 'sidebar.migrateSession')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await flushPromises()
    const select = dialog.get('.ui-select-trigger')
    await select.trigger('click')
    expect(Array.from(document.body.querySelectorAll('.ui-select-option')).map(option => option.getAttribute('data-value'))).toEqual(['scope-active::p-1'])
    await select.trigger('keydown', { key: 'Escape' })

    await wrapper.setProps({ projects: [{ ...eligible, availability: 'error' }, ...invalid] })
    await dialog.get('form').trigger('submit')
    expect(wrapper.emitted('migrate-session')).toBeUndefined()
    wrapper.unmount()
  })

  it('lists a freshly created free conversation before its first message', () => {
    // A new conversation carries the default title until its first message
    // generates one; hiding that title made every fresh free conversation
    // invisible in the sidebar.
    const fresh: SessionDto = {
      permission_mode: 'default', space_options: null, settings_revision: 0,
      id: 's-free',
      project_id: null,
      title: 'Tinadec session',
      status: 'ready',
      created_at: '2026-09-10T00:00:00Z',
      updated_at: '2026-09-10T00:00:00Z',
    }

    const wrapper = factory({
      sessions: [session, fresh],
      selectedProjectId: null,
      selectedSessionId: null,
    })

    const freeRows = wrapper.findAll('.free-conversation-group .session-item')
    expect(freeRows).toHaveLength(1)
    expect(freeRows[0]!.text()).toContain('Tinadec session')
  })
})

describe('AppSidebar footer identity', () => {
  beforeEach(() => { setNickname('') })
  afterEach(() => { setNickname('') })

  it('keeps the profile portrait left of the shell actions and opens the personal module', async () => {
    const wrapper = factory()
    const children = Array.from(wrapper.get('.sidebar-footer').element.children)
    expect(children.map((node) => node.className.split(' ')[0])).toEqual([
      'sidebar-profile',
      'sidebar-footer-actions',
    ])

    const profile = wrapper.get('[title="sidebar.personal"]')
    expect(profile.find('.personal-avatar').exists()).toBe(true)
    await profile.trigger('click')
    expect(wrapper.emitted('go-personal')).toHaveLength(1)
    wrapper.unmount()
  })

  // happy-dom runs no layout engine: clientWidth is 0 and every rect is empty, so the
  // measurement is fed the numbers a real footer row reports before each assertion.
  function stubRow(footer: HTMLElement, actions: HTMLElement, probe: HTMLElement, footerWidth: number, nameWidth: number) {
    const rect = (width: number) => () => ({ width, height: 14, top: 0, left: 0, right: width, bottom: 14, x: 0, y: 0, toJSON: () => ({}) })
    footer.style.paddingLeft = '12px'
    footer.style.paddingRight = '12px'
    footer.style.columnGap = '8px'
    Object.defineProperty(footer, 'clientWidth', { configurable: true, value: footerWidth })
    Object.defineProperty(actions, 'getBoundingClientRect', { configurable: true, value: rect(88) })
    Object.defineProperty(probe, 'getBoundingClientRect', { configurable: true, value: rect(nameWidth) })
  }

  async function settle(wrapper: ReturnType<typeof factory>) {
    await nextTick()
    await nextTick()
    await wrapper.vm.$nextTick()
  }

  it('fades the nickname in beside the portrait once the footer can hold it whole', async () => {
    // Attached: happy-dom only resolves computed style (inline padding/gap here) for
    // elements that are actually in the document.
    const wrapper = factory({}, document.body)
    const footer = wrapper.get<HTMLElement>('.sidebar-footer').element
    const actions = wrapper.get<HTMLElement>('.sidebar-footer-actions').element
    const probe = wrapper.get<HTMLElement>('.sidebar-profile-name-probe').element
    const named = () => wrapper.get('.sidebar-profile').classes().includes('sidebar-profile--named')
    const name = () => wrapper.get('.sidebar-profile-name')

    // No layout yet: the name must not be claimed on a 0px row. It is rendered (so the
    // fade has something to animate) but collapsed to zero width by the style below.
    setNickname('风眠')
    await settle(wrapper)
    expect(named()).toBe(false)
    expect(name().classes()).not.toContain('sidebar-profile-name--shown')
    expect(name().text()).toBe('风眠')
    expect(probe.textContent).toBe('风眠')

    // 24 padding + 6+20+6 portrait row + 48 name + 10 clear space + 8 gap + 88 actions = 210.
    stubRow(footer, actions, probe, 260, 48)
    setNickname('风眠鸣')
    await settle(wrapper)
    expect(named()).toBe(true)
    expect(name().classes()).toContain('sidebar-profile-name--shown')
    // The reveal is capped at the measured width, so the fade cannot stop mid-word.
    expect(name().attributes('style')).toContain('--profile-name-max: 48px')
    expect(name().text()).toBe('风眠鸣')
    // The name is up, so the tooltip goes back to naming the destination only.
    expect(wrapper.get('.sidebar-profile').attributes('title')).toBe('sidebar.personal')

    // The same name stops fitting once the column is dragged narrower than 210px.
    stubRow(footer, actions, probe, 200, 48)
    setNickname('风眠鸣语')
    await settle(wrapper)
    expect(named()).toBe(false)
    expect(name().classes()).not.toContain('sidebar-profile-name--shown')
    // Hidden, but still discoverable: the tooltip names the person the portrait belongs to.
    expect(wrapper.get('.sidebar-profile').attributes('title')).toBe('风眠鸣语 · sidebar.personal')
    // The visible label is aria-hidden, so the control's own name carries the identity.
    expect(wrapper.get('.sidebar-profile').attributes('aria-label')).toBe('风眠鸣语 · sidebar.personal')
    wrapper.unmount()
  })

  it('renders no name at all when the profile has no nickname', async () => {
    const wrapper = factory()
    await settle(wrapper)
    expect(wrapper.find('.sidebar-profile-name').exists()).toBe(false)
    wrapper.unmount()
  })

  it('keeps the portrait visible above the stacked actions on the collapsed rail', () => {
    const wrapper = factory({ collapsed: true })
    const footer = wrapper.get('.sidebar-footer')
    expect(footer.find('.sidebar-profile').exists()).toBe(true)
    expect(footer.find('.sidebar-footer-actions-collapsed').exists()).toBe(true)
    wrapper.unmount()
  })

  it('never shows the nickname on the collapsed rail, however wide the row reports itself', async () => {
    setNickname('风眠')
    const wrapper = factory({ collapsed: true }, document.body)
    const footer = wrapper.get<HTMLElement>('.sidebar-footer').element
    const actions = wrapper.get<HTMLElement>('.sidebar-footer-actions').element
    const probe = wrapper.get<HTMLElement>('.sidebar-profile-name-probe').element
    // A rail that would otherwise pass the width test: only the collapsed guard hides the name.
    stubRow(footer, actions, probe, 900, 24)
    setNickname('风眠鸣')
    await settle(wrapper)
    expect(wrapper.get('.sidebar-profile').classes()).not.toContain('sidebar-profile--named')
    wrapper.unmount()
  })
})

describe('AppSidebar material surfaces', () => {
  it('applies the raised material filter to its top-layer surfaces', () => {
    // The panel root's backdrop-filter cannot reach native popovers/dialogs in the top layer.
    expect(sidebarSource).toMatch(/\.sidebar-view-menu, \.sidebar-workspace-options, \.sidebar-migration-dialog \{[^}]*backdrop-filter: var\(--material-filter-raised, none\);[^}]*\}/)
  })
})

describe('AppSidebar token usage', () => {
  function invocation(
    startedAt: Date,
    tokens: { total?: number | null; input?: number | null; output?: number | null } = {},
  ) {
    return {
      started_at: startedAt.toISOString(),
      total_tokens: tokens.total ?? null,
      input_tokens: tokens.input ?? null,
      output_tokens: tokens.output ?? null,
    }
  }

  function today(hour = 10): Date {
    const now = new Date()
    return new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour)
  }

  it('draws the last seven days and totals only reported usage', async () => {
    const day = today()
    const yesterday = new Date(day)
    yesterday.setDate(day.getDate() - 1)
    listModelInvocationsMock.mockResolvedValue({
      items: [
        invocation(day, { total: 120 }),
        invocation(new Date(day.getTime() + 3_600_000), { input: 30, output: 10 }),
        invocation(yesterday),
      ],
      next_cursor: null,
    })
    const wrapper = factory()
    await flushPromises()

    const bars = wrapper.findAll('.token-usage-bar')
    expect(bars).toHaveLength(7)
    expect(bars[6]!.classes()).toContain('high')
    expect(bars[6]!.attributes('style')).toContain('height: 100%')
    expect(bars[5]!.classes()).toContain('empty')
    expect(bars[5]!.attributes('style')).toContain('height: 2px')
    expect(wrapper.get('.token-usage-total').text()).toBe('160')
    expect(wrapper.get('.token-usage-chart').attributes('role')).toBe('img')
    expect(wrapper.get('.token-usage-chart').attributes('aria-label')).toBe('sidebar.tokenUsageSummary')
    expect(wrapper.get('.token-usage-area').text()).toContain('sidebar.tokenUsage')
    expect(listModelInvocationsMock).toHaveBeenCalledWith(expect.objectContaining({ limit: 200 }))
    wrapper.unmount()
  })

  it('stays out of the way when nothing was measured', async () => {
    const wrapper = factory()
    await flushPromises()
    expect(wrapper.find('.token-usage-area').exists()).toBe(false)
    wrapper.unmount()
  })

  it('says calls reported no usage instead of drawing zero bars', async () => {
    listModelInvocationsMock.mockResolvedValue({
      items: [invocation(today())],
      next_cursor: null,
    })
    const wrapper = factory()
    await flushPromises()

    expect(wrapper.get('.token-usage-unreported').text()).toBe('sidebar.tokenUsageUnreported')
    expect(wrapper.find('.token-usage-chart').exists()).toBe(false)
    expect(wrapper.find('.token-usage-total').exists()).toBe(false)
    wrapper.unmount()
  })

  it('refreshes when a run finishes', async () => {
    const wrapper = factory()
    await flushPromises()
    expect(listModelInvocationsMock).toHaveBeenCalledTimes(1)

    await wrapper.setProps({ busy: true })
    await wrapper.setProps({ busy: false })
    await flushPromises()
    expect(listModelInvocationsMock).toHaveBeenCalledTimes(2)
    wrapper.unmount()
  })

  it('drops a slow read when the storage scope changes mid-flight', async () => {
    let resolveFirst: (value: { items: unknown[]; next_cursor: null }) => void = () => {}
    listModelInvocationsMock.mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve }))
    const wrapper = factory()
    try {
      setSelectedStorage('project-2')
      await flushPromises()
      resolveFirst({ items: [invocation(today(), { total: 999 })], next_cursor: null })
      await flushPromises()
      expect(wrapper.find('.token-usage-area').exists()).toBe(false)
    } finally {
      wrapper.unmount()
      setSelectedStorage('user')
    }
  })
})
