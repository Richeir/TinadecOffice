// @vitest-environment happy-dom
import { createI18n } from 'vue-i18n'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import zh from '@/locales/zh-CN'
import type { PermissionLevel } from '@/types/mode'

/**
 * The workspace card's body: the source-folder list, the dropped-file copy and the access block.
 *
 * The controller is replaced by refs and spies so these cases grade *this* component: which
 * controller method a gesture reaches, what a refusal reads like, and — most of all — that a
 * dropped folder and a dropped file take two different paths. Whether the controller's guards
 * agree with Core is graded in `HomeController.test.ts`.
 */

/** Real refs, not `{ value }` literals: a plain object would freeze the panel's computeds on first read. */
const h = vi.hoisted(() => ({
  spies: {
    addWorkspaceFolderPaths: vi.fn(async (_paths: string[]) => {}),
    addWorkspaceFilePaths: vi.fn(async (_paths: string[]) => {}),
    setPrimaryWorkspaceRoot: vi.fn(async (_id: string) => {}),
    removeWorkspaceRoot: vi.fn(async (_id: string) => {}),
    removeWorkspaceFile: vi.fn(async (_id: string) => {}),
    importWorkspaceFiles: vi.fn(async (_paths: string[]) => ({
      imported: [] as Array<{ name: string; path: string; bytes: number }>,
      skipped: [] as Array<{ path: string; reason: string }>,
    })),
    refreshProjectsAndSessions: vi.fn(async () => {}),
    prefillWorkspaceAttachments: vi.fn(async (_files: unknown[]) => {}),
    openProject: vi.fn(),
  },
  setProject: (_value: Record<string, unknown> | null) => {},
  setBusy: (_value: boolean) => {},
  setPermission: (_value: PermissionLevel) => {},
}))

vi.mock('@/controllers/HomeController', async () => {
  const { ref, computed } = await import('vue')
  const project = ref<Record<string, unknown> | null>(null)
  const busy = ref(false)
  const permission = ref<PermissionLevel>('default')
  h.setProject = (value) => { project.value = value }
  h.setBusy = (value) => { busy.value = value }
  h.setPermission = (value) => { permission.value = value }
  return {
    homeController: {
      currentProject: project,
      busy,
      currentPermission: computed(() => permission.value),
      ...h.spies,
    },
  }
})

vi.mock('@/api', () => ({
  api: {
    listProjectExposures: vi.fn(async () => []),
    attachmentContentUrl: (id: string) => `/api/v1/attachments/${id}/content`,
  },
}))

import WorkspaceRootsPanel from './WorkspaceRootsPanel.vue'

const i18n = createI18n({ legacy: false, locale: 'zh-CN', messages: { 'zh-CN': zh } })
const t = i18n.global.t

const PRIMARY = { id: 'root-primary', path: '/work/app' }
const SECOND = { id: 'root-second', path: '/work/library' }

function project(overrides: Record<string, unknown> = {}) {
  return { id: 'p1', name: 'demo', path: '/work/app', roots: [PRIMARY], primary_root_id: PRIMARY.id, ...overrides }
}

function render(): VueWrapper {
  return mount(WorkspaceRootsPanel, { attachTo: document.body, global: { plugins: [i18n] } })
}

/**
 * A dropped item. `isDirectory` is what the panel reads off `webkitGetAsEntry`, and it is the
 * only signal distinguishing "authorize this folder" from "copy this file in".
 */
function dropItem(path: string, isDirectory: boolean) {
  const file = { name: path.split('/').pop(), path } as unknown as File
  return { kind: 'file', getAsFile: () => file, webkitGetAsEntry: () => ({ isDirectory }) }
}

function dropPayload(items: ReturnType<typeof dropItem>[]) {
  return { items, files: items.map(item => item.getAsFile()).filter(Boolean) }
}

async function drop(wrapper: VueWrapper, selector: string, items: ReturnType<typeof dropItem>[]) {
  await wrapper.find(selector).trigger('drop', { dataTransfer: dropPayload(items) })
  await flushPromises()
}

/** The buttons carrying a given label, in document order. */
function buttonsByText(wrapper: VueWrapper, label: string) {
  return wrapper.findAll('button').filter(button => button.text() === label)
}

async function pickFiles(wrapper: VueWrapper, buttonLabel: string, files: Array<{ name: string; path: string; type?: string; size?: number }>) {
  await buttonsByText(wrapper, buttonLabel)[0]!.trigger('click')
  const input = wrapper.find('input[type="file"]')
  Object.defineProperty(input.element, 'files', {
    configurable: true,
    value: files.map(file => ({
      name: file.name,
      type: file.type ?? 'text/plain',
      size: file.size ?? 4,
      path: file.path,
      arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
    })),
  })
  await input.trigger('change')
  await flushPromises()
}

let previousHost: unknown

beforeEach(() => {
  for (const spy of Object.values(h.spies)) spy.mockClear()
  h.setProject(null)
  h.setBusy(false)
  h.setPermission('default')
  previousHost = (window as unknown as { tinadec?: unknown }).tinadec
  // `pathForFile` is the only way the renderer learns a dropped item's real path; the fake host
  // reads the path off the `File` itself, which is what the real `webUtils` call resolves.
  Object.defineProperty(window, 'tinadec', {
    configurable: true,
    value: {
      selectWorkspaceFolders: vi.fn(async () => [] as string[]),
      pathForFile: (file: File) => (file as unknown as { path?: string }).path ?? '',
      importWorkspaceFiles: vi.fn(async () => ({ imported: [], skipped: [] })),
    },
  })
})

afterEach(() => {
  Object.defineProperty(window, 'tinadec', { configurable: true, value: previousHost })
  document.body.innerHTML = ''
})

describe('workspace card · empty state', () => {
  it('offers to choose a project instead of showing an empty folder list', async () => {
    const wrapper = render()
    expect(wrapper.text()).toContain(t('workspaceRoots.noWorkspaceTitle'))
    expect(wrapper.text()).toContain(t('workspaceRoots.noWorkspaceBody'))
    // No list and no drop zone: neither means anything before a workspace exists.
    expect(wrapper.find('.ws-roots').exists()).toBe(false)
    expect(wrapper.find('.ws-drop').exists()).toBe(false)
    await wrapper.find('.ws-button').trigger('click')
    expect(h.spies.openProject).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })
})

describe('workspace card · source folder list', () => {
  beforeEach(() => { h.setProject(project({ roots: [PRIMARY, SECOND], primary_root_id: PRIMARY.id })) })

  it('marks the primary folder and offers "make primary" only on the others', async () => {
    const wrapper = render()
    const rows = wrapper.findAll('.ws-root-row')
    expect(rows).toHaveLength(2)
    expect(rows[0]!.find('.ws-primary-badge').exists()).toBe(true)
    expect(rows[0]!.find('.ws-row-action').exists()).toBe(false)
    expect(rows[1]!.find('.ws-primary-badge').exists()).toBe(false)

    await rows[1]!.find('.ws-row-action').trigger('click')
    expect(h.spies.setPrimaryWorkspaceRoot).toHaveBeenCalledWith(SECOND.id)
    wrapper.unmount()
  })

  it('states why the primary folder cannot be removed, and disables only that button', async () => {
    const wrapper = render()
    const removeButtons = wrapper.findAll('.ws-row-remove')
    expect(removeButtons[0]!.attributes('disabled')).toBeDefined()
    expect(removeButtons[0]!.attributes('title')).toBe(t('workspaceRoots.removeBlockedPrimary'))
    expect(removeButtons[1]!.attributes('disabled')).toBeUndefined()

    await removeButtons[1]!.trigger('click')
    expect(h.spies.removeWorkspaceRoot).toHaveBeenCalledWith(SECOND.id)
    wrapper.unmount()
  })

  /**
   * The last-folder rule is checked first because it is the binding one when both apply: with a
   * single folder the person cannot "make another primary" — that instruction would be a dead end.
   * Two cases, two sentences: a lone primary folder, and a lone folder whose recorded marker is
   * stale (no folder in the list is primary, so "make another primary" would also be a dead end
   * but for a different reason).
   */
  it('refuses to remove the only folder, with the last-folder sentence', async () => {
    h.setProject(project())
    const wrapper = render()
    const button = wrapper.find('.ws-row-remove')
    expect(button.attributes('disabled')).toBeDefined()
    expect(button.attributes('title')).toBe(t('workspaceRoots.removeBlockedLast'))
    wrapper.unmount()
  })

  it('refuses to remove the only folder even when the recorded primary id is stale', async () => {
    h.setProject(project({ roots: [PRIMARY], primary_root_id: 'root-gone' }))
    const wrapper = render()
    const button = wrapper.find('.ws-row-remove')
    expect(button.attributes('disabled')).toBeDefined()
    expect(button.attributes('title')).toBe(t('workspaceRoots.removeBlockedLast'))
    wrapper.unmount()
  })

  it('points at a reload when a write came back without changing the list', async () => {
    // The controller leaves the list untouched when Core refused the save (412 on a stale digest
    // is the common one): retrying the same bytes cannot help, re-reading can.
    const wrapper = render()
    ;(window.tinadec as unknown as { selectWorkspaceFolders: () => Promise<string[]> }).selectWorkspaceFolders = vi.fn(async () => ['/work/extra'])
    await buttonsByText(wrapper, t('workspaceRoots.addFolder'))[0]!.trigger('click')
    await flushPromises()

    expect(h.spies.addWorkspaceFolderPaths).toHaveBeenCalledWith(['/work/extra'])
    const notice = wrapper.find('.ws-notice')
    expect(notice.exists()).toBe(true)
    expect(notice.text()).toContain(t('workspaceRoots.applyNextRun'))
    await buttonsByText(wrapper, t('workspaceRoots.loadLatest'))[0]!.trigger('click')
    expect(h.spies.refreshProjectsAndSessions).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })
})

describe('workspace card · dropped folders and files are two different operations', () => {
  beforeEach(() => {
    h.setProject(project({ roots: [PRIMARY, SECOND], primary_root_id: PRIMARY.id }))
  })

  it('references a dropped folder in place instead of copying it', async () => {
    const wrapper = render()
    await drop(wrapper, '.ws-drop', [dropItem('/work/assets', true)])

    expect(h.spies.addWorkspaceFolderPaths).toHaveBeenCalledWith(['/work/assets'])
    expect(h.spies.importWorkspaceFiles).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('binds a dropped file in place and never copies it', async () => {
    const wrapper = render()
    await drop(wrapper, '.ws-drop', [dropItem('/Users/me/Desktop/shot.png', false)])

    expect(h.spies.addWorkspaceFilePaths).toHaveBeenCalledWith(['/Users/me/Desktop/shot.png'])
    expect(h.spies.importWorkspaceFiles).not.toHaveBeenCalled()
    expect(h.spies.addWorkspaceFolderPaths).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain(t('workspaceRoots.boundFiles', { count: 1 }))
    wrapper.unmount()
  })

  it('classifies each item of a mixed drop separately', async () => {
    const wrapper = render()
    await drop(wrapper, '.ws-drop', [dropItem('/work/assets', true), dropItem('/tmp/notes.txt', false)])

    expect(h.spies.addWorkspaceFolderPaths).toHaveBeenCalledWith(['/work/assets'])
    expect(h.spies.addWorkspaceFilePaths).toHaveBeenCalledWith(['/tmp/notes.txt'])
    wrapper.unmount()
  })

  it('keeps the explicit copy path for files that should live inside the workspace', async () => {
    h.spies.importWorkspaceFiles.mockResolvedValueOnce({
      imported: [{ name: 'kept.md', path: '/work/app/kept.md', bytes: 3 }],
      skipped: [{ path: '/work/app/kept.md', reason: 'exists' }],
    })
    const wrapper = render()
    await pickFiles(wrapper, t('workspaceRoots.copyFile'), [{ name: 'kept.md', path: '/drop/kept.md' }])

    expect(h.spies.importWorkspaceFiles).toHaveBeenCalledWith(['/drop/kept.md'])
    expect(wrapper.text()).toContain(t('workspaceRoots.importSkipped', { count: 1 }))
    // The skipped path is named, not just counted: the person has to know which file stayed out.
    expect(wrapper.find('.ws-skipped').text()).toContain('/work/app/kept.md')
    // ...and why, in words. The main process reports a stable code (`exists`) and spells out no
    // user-facing language, so a raw code here would be a contract leak, not a reason.
    expect(wrapper.find('.ws-skipped').text()).toContain(t('workspaceRoots.skipReason.exists'))
    expect(wrapper.find('.ws-skipped-reason').text()).not.toContain('exists')

    wrapper.unmount()
  })

  it('refuses a file dropped on the folder control, naming the file', async () => {
    const wrapper = render()
    await drop(wrapper, '[data-testid="workspace-add-folder"]', [dropItem('/tmp/a.txt', false)])

    expect(h.spies.addWorkspaceFolderPaths).not.toHaveBeenCalled()
    expect(h.spies.addWorkspaceFilePaths).not.toHaveBeenCalled()
    expect(h.spies.importWorkspaceFiles).not.toHaveBeenCalled()
    expect(wrapper.find('.ws-problem').text()).toContain(t('workspaceRoots.notAFolder', { path: '/tmp/a.txt' }))
    wrapper.unmount()
  })

  it('names an unknown reason code as it arrived instead of leaving a blank', async () => {
    // A code this build has not translated yet must stay readable and visible: a silent empty
    // space where a reason belongs is worse than a raw token, and it hides the missing wording.
    h.spies.importWorkspaceFiles.mockResolvedValueOnce({
      imported: [], skipped: [{ path: '/tmp/x.bin', reason: 'some_future_code' }],
    })
    const wrapper = render()
    await pickFiles(wrapper, t('workspaceRoots.copyFile'), [{ name: 'x.bin', path: '/tmp/x.bin' }])

    expect(wrapper.find('.ws-skipped-reason').text()).toBe('some_future_code')
    wrapper.unmount()
  })

  it('says a copy failed instead of reporting an empty success', async () => {
    h.spies.importWorkspaceFiles.mockRejectedValueOnce(new Error('Import requires the trusted main host page.'))
    const wrapper = render()
    await pickFiles(wrapper, t('workspaceRoots.copyFile'), [{ name: 'a.txt', path: '/tmp/a.txt' }])

    expect(wrapper.find('.ws-problem').text()).toContain('Import requires the trusted main host page.')
    expect(wrapper.text()).not.toContain(t('workspaceRoots.imported', { count: 0 }))
    wrapper.unmount()
  })

  it('stays usable when the host bridge has no file-path method at all', async () => {
    // A preload older than the card, or a browser preview: dropping must not throw.
    Object.defineProperty(window, 'tinadec', { configurable: true, value: { selectWorkspaceFolders: vi.fn(async () => []) } })
    const wrapper = render()
    await drop(wrapper, '.ws-drop', [dropItem('/tmp/a.txt', false)])

    expect(h.spies.importWorkspaceFiles).not.toHaveBeenCalled()
    expect(h.spies.addWorkspaceFolderPaths).not.toHaveBeenCalled()
    expect(h.spies.addWorkspaceFilePaths).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('attaches an original file to the composer with workspace provenance', async () => {
    const wrapper = render()
    await pickFiles(wrapper, t('workspaceRoots.attachFile'), [{ name: 'shot.png', path: '/work/app/shot.png', type: 'image/png' }])

    expect(h.spies.prefillWorkspaceAttachments).toHaveBeenCalledWith([
      expect.objectContaining({ name: 'shot.png', sourcePath: '/work/app/shot.png', origin: 'workspace', projectId: 'p1' }),
    ])
    expect(h.spies.addWorkspaceFilePaths).not.toHaveBeenCalled()
    expect(h.spies.importWorkspaceFiles).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})

describe('workspace card · access block states the frozen mode, never a switch', () => {
  beforeEach(() => { h.setProject(project()) })

  const cases: Array<[PermissionLevel, string]> = [
    ['default', 'workspaceRoots.accessModeDefault'],
    ['auto-approve', 'workspaceRoots.accessModeAutoApprove'],
    ['full-access', 'workspaceRoots.accessModeFullAccess'],
  ]

  for (const [mode, key] of cases) {
    it(`describes ${mode} by its consequence`, () => {
      h.setPermission(mode)
      const wrapper = render()
      expect(wrapper.find('.ws-access').text()).toContain(t(key))
      wrapper.unmount()
    })
  }

  it('offers no control that changes the permission mode', () => {
    const wrapper = render()
    // The card manages folders. Handing the approval decision away belongs to the composer's
    // permission menu; a file-management card must not rewrite a run's safety policy.
    const labels = wrapper.findAll('button').map(button => `${button.text()} ${button.attributes('aria-label') ?? ''}`).join(' ')
    for (const mode of ['permission.fullAccess', 'permission.autoApprove', 'permission.default']) {
      expect(labels).not.toContain(t(mode))
    }
    wrapper.unmount()
  })

  it('says the change applies to the next run, not to one already running', () => {
    const wrapper = render()
    expect(wrapper.find('.ws-access').text()).toContain(t('workspaceRoots.applyNextRun'))
    wrapper.unmount()
  })
})
