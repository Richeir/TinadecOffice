// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const hoisted = vi.hoisted(() => ({
  throwOnUse: false,
  store: null as unknown,
}))

vi.mock('@tinadec/ui', () => ({
  useUie: () => {
    if (hoisted.throwOnUse) throw new Error('useUie: store not initialized')
    return hoisted.store
  },
}))

const {
  __resetDocumentWorkspaceForTests,
  activeDocPath,
  closeEditor,
  docFocus,
  docTabs,
  editorPath,
  openDocument,
  openInEditor,
  syncDocumentWorkspace,
  widenDocumentColumn,
} = await import('./documentWorkspace')

interface FakeStore {
  snapshot: { value: { revision: number; columns: Record<string, { width: number; collapsed: boolean }> } }
  scope: { value: { kind: 'page'; pageId: 'home' } }
  dispatch: ReturnType<typeof vi.fn>
  commands: Array<Record<string, unknown>>
}

function fakeStore(width = 420, collapsed = false): FakeStore {
  const commands: Array<Record<string, unknown>> = []
  const store: FakeStore = {
    snapshot: { value: { revision: 3, columns: { right: { width, collapsed } } } },
    scope: { value: { kind: 'page', pageId: 'home' } },
    commands,
    dispatch: vi.fn((envelope: { command: Record<string, unknown> }) => {
      commands.push(envelope.command)
      return true
    }),
  }
  return store
}

/**
 * The test host exposes Node's `localStorage`, which is unavailable without a flag; the
 * real renderer has a normal one. A memory-backed stand-in keeps the persistence path
 * under test instead of silently skipping it.
 */
function installMemoryStorage(): void {
  const map = new Map<string, string>()
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => { map.set(key, String(value)) },
      removeItem: (key: string) => { map.delete(key) },
      clear: () => { map.clear() },
      key: (index: number) => [...map.keys()][index] ?? null,
      get length() { return map.size },
    },
  })
}

beforeEach(() => {
  installMemoryStorage()
  __resetDocumentWorkspaceForTests()
  hoisted.throwOnUse = false
  hoisted.store = fakeStore()
})

describe('openDocument', () => {
  it('opens the singleton reader in the right column and focuses the reference', () => {
    const store = hoisted.store as FakeStore
    expect(openDocument({ path: 'docs/spec.md', line: 12, cwd: '/w' })).toBe(true)

    expect(store.commands).toContainEqual({
      type: 'openCard',
      scope: { kind: 'page', pageId: 'home' },
      descriptorId: 'docReader',
      slotId: 'right',
    })
    expect(docTabs.value).toEqual([{ path: 'docs/spec.md', line: 12 }])
    expect(activeDocPath.value).toBe('docs/spec.md')
    expect(docFocus.value).toMatchObject({ path: 'docs/spec.md', line: 12 })
  })

  it('focuses an already-open document instead of adding a second tab', () => {
    openDocument({ path: 'docs/spec.md', cwd: '/w' })
    const firstNonce = docFocus.value?.nonce ?? 0
    expect(openDocument({ path: 'docs/spec.md', line: 40, cwd: '/w' })).toBe(true)

    expect(docTabs.value).toHaveLength(1)
    expect(docTabs.value[0]).toEqual({ path: 'docs/spec.md', line: 40 })
    // The nonce moves so a second click on the same reference still scrolls the reader.
    expect(docFocus.value?.nonce).toBeGreaterThan(firstNonce)
  })

  it('expands a collapsed feature column before opening the card', () => {
    const store = fakeStore(420, true)
    hoisted.store = store
    openDocument({ path: 'docs/spec.md', cwd: '/w' })

    expect(store.commands[0]).toMatchObject({ type: 'collapseColumn', slotId: 'right', collapsed: false })
    expect(store.commands[1]).toMatchObject({ type: 'openCard', descriptorId: 'docReader' })
  })

  it('refuses a path outside the workspace and leaves the tab list alone', () => {
    expect(openDocument({ path: '../secrets.md', cwd: '/w' })).toBe(false)
    expect(docTabs.value).toEqual([])
  })

  it('is a no-op without the layout engine instead of throwing into the transcript', () => {
    hoisted.throwOnUse = true
    expect(openDocument({ path: 'docs/spec.md', cwd: '/w' })).toBe(false)
    expect(docTabs.value).toEqual([])
  })
})

describe('tabs', () => {
  it('persists per workspace and restores that list when the root is bound again', () => {
    openDocument({ path: 'docs/spec.md', line: 7, cwd: '/w' })

    const stored = JSON.parse(window.localStorage.getItem('tinadec.docReader.tabs.v1') ?? '{}')
    expect(stored['w:/w'].tabs).toEqual([{ path: 'docs/spec.md', line: 7 }])

    syncDocumentWorkspace('/other')
    expect(docTabs.value).toEqual([])
    syncDocumentWorkspace('/w')
    expect(docTabs.value).toEqual([{ path: 'docs/spec.md', line: 7 }])
    expect(activeDocPath.value).toBe('docs/spec.md')
  })
})

describe('widenDocumentColumn', () => {
  it('widens a narrow feature column to the comfort width', () => {
    const store = hoisted.store as FakeStore
    widenDocumentColumn()
    expect(store.commands).toContainEqual({
      type: 'resizeColumn',
      scope: { kind: 'page', pageId: 'home' },
      slotId: 'right',
      width: 640,
    })
  })

  it('leaves an already-wide column alone', () => {
    const store = fakeStore(760)
    hoisted.store = store
    widenDocumentColumn()
    expect(store.commands).toEqual([])
  })
})

describe('openInEditor', () => {
  it('opens the editor card and widens the column, without touching the viewer tabs', () => {
    const store = hoisted.store as FakeStore
    expect(openInEditor({ path: 'docs/spec.md', line: 9, cwd: '/w' })).toBe(true)

    expect(editorPath.value).toBe('docs/spec.md')
    expect(docTabs.value).toEqual([])
    expect(store.commands).toContainEqual({
      type: 'openCard',
      scope: { kind: 'page', pageId: 'home' },
      descriptorId: 'codeEditor',
      slotId: 'right',
    })
    expect(store.commands).toContainEqual({
      type: 'resizeColumn',
      scope: { kind: 'page', pageId: 'home' },
      slotId: 'right',
      width: 640,
    })
  })

  it('refuses a path outside the workspace', () => {
    expect(openInEditor({ path: '../secrets.md', cwd: '/w' })).toBe(false)
    expect(editorPath.value).toBeNull()
  })

  it('clears the file but keeps the editor card open', () => {
    openInEditor({ path: 'docs/spec.md', cwd: '/w' })
    closeEditor()
    expect(editorPath.value).toBeNull()
  })

  it('restores the file the editor had when the workspace is bound again', () => {
    openInEditor({ path: 'docs/spec.md', cwd: '/w' })
    syncDocumentWorkspace('/other')
    expect(editorPath.value).toBeNull()
    syncDocumentWorkspace('/w')
    expect(editorPath.value).toBe('docs/spec.md')
  })
})
