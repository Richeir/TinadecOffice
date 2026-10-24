/**
 * The document panels: the read-only `docReader` card and the `codeEditor` card.
 *
 * They are two cards on purpose. A viewer whose "edit" button turns it into an editor ends
 * up being neither: the reader has no file tree, no approval flow and no dirty state, and
 * the editor needs all three. So the viewer hands a path over to the editor card instead of
 * growing one, and each card owns one job.
 *
 * The reader is a singleton that hosts every document as an internal tab. The reason is
 * measured, not stylistic: the feature column is 420px wide and already carries nine tabs,
 * so `useTabLabelMode` is in icon-only mode there and `featureIconFor` falls back to a Globe
 * for unknown descriptors — one card per document would produce a row of identical globe
 * icons with no filename anywhere. Inside the card we control the strip.
 *
 * `docFocus` / `editorFocus` carry "the reference the user just clicked" separately from the
 * tab list: the layout engine has no command to rewrite an existing card's `state`, and
 * reusing `openCard` with an explicit instanceId would insert the tabId twice.
 */
import { ref, type Ref } from 'vue'
import { useUie, type UieCommand, type UieStore } from '@tinadec/ui'
import { normalizeWorkspacePath, type DocumentRef } from '@/lib/documentPath'

export const DOC_READER_CARD = 'docReader'
export const CODE_EDITOR_CARD = 'codeEditor'

export interface DocumentTab {
  /** Workspace-relative path with forward slashes. */
  path: string
  /** Line the reference pointed at when the tab was opened or last focused. */
  line?: number
}

export interface DocumentFocus extends DocumentTab {
  /** Changes on every open, so focusing the same tab twice still scrolls. */
  nonce: number
}

/** Documents open in the read-only viewer, of the workspace currently bound to it. */
export const docTabs = ref<DocumentTab[]>([])
export const activeDocPath = ref<string | null>(null)
export const docFocus: Ref<DocumentFocus | null> = ref(null)

/** The single file the editor card is editing; null shows that card's file browser. */
export const editorPath = ref<string | null>(null)
export const editorFocus: Ref<DocumentFocus | null> = ref(null)

const STORAGE_KEY = 'tinadec.docReader.tabs.v1'
const WORKSPACE_KEY_NONE = '\u0000none'

/**
 * All of this is keyed by the workspace root, not by project id. The root is what every
 * caller already has (`openDocument` needs it to validate the path anyway), and it keeps
 * this module free of a controller import — importing HomeController from here would drag
 * the whole host/transport graph into every component that renders a conversation.
 */
let boundWorkspaceRoot: string | null = null
let boundWorkspaceKey: string | null = null
let focusNonce = 0

function storage(): Storage | null {
  try {
    return window.localStorage ?? null
  } catch {
    return null
  }
}

interface StoredWorkspacePanels {
  tabs: DocumentTab[]
  active: string | null
  /** Path the editor card had open; a missing file is dropped on restore by the editor. */
  editor?: string | null
}

type StoredShape = Record<string, StoredWorkspacePanels>

function readStore(): StoredShape {
  const raw = storage()?.getItem(STORAGE_KEY)
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as StoredShape) : {}
  } catch (error) {
    console.error('[documents] the saved document panels could not be read', error)
    return {}
  }
}

function writeStore(workspace: string | null, value: StoredWorkspacePanels): void {
  const store = readStore()
  // The read path uses the same prefixed key; a bare path here would never be found again.
  store[persistedKey(workspace)] = value
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify(store))
  } catch (error) {
    // A full or unavailable store must not break opening a document.
    console.error('[documents] the document panels could not be saved', error)
  }
}

function persistedKey(workspace: string | null): string {
  if (!workspace) return WORKSPACE_KEY_NONE
  return `w:${workspace.replace(/\\/g, '/').replace(/\/+$/, '')}`
}

function bindWorkspace(workspace: string | null): void {
  const key = persistedKey(workspace)
  if (boundWorkspaceKey === key) return
  boundWorkspaceKey = key
  boundWorkspaceRoot = workspace
  const saved = readStore()[key]
  docTabs.value = Array.isArray(saved?.tabs)
    ? saved.tabs.filter((tab): tab is DocumentTab => Boolean(tab?.path))
    : []
  activeDocPath.value = saved?.active && docTabs.value.some((tab) => tab.path === saved.active)
    ? saved.active
    : docTabs.value[0]?.path ?? null
  editorPath.value = saved?.editor ?? null
  editorFocus.value = null
}

function persist(): void {
  writeStore(boundWorkspaceRoot, {
    tabs: docTabs.value,
    active: activeDocPath.value,
    editor: editorPath.value,
  })
}

function uieStore(): UieStore | null {
  try {
    return useUie()
  } catch {
    // Markdown renders on surfaces without the layout engine (and in tests); a
    // reference click there is a no-op, never an exception thrown into the transcript.
    return null
  }
}

function dispatch(uie: UieStore, command: UieCommand): boolean {
  return uie.dispatch({
    command,
    source: 'user',
    expectedRevision: uie.snapshot.value.revision,
  })
}

/** The editor needs a usable body width before the tree takes 176px of it. */
export const DOCUMENT_PANEL_COMFORT_WIDTH = 640

export function widenDocumentColumn(minWidth = DOCUMENT_PANEL_COMFORT_WIDTH): void {
  const uie = uieStore()
  if (!uie) return
  const column = uie.snapshot.value.columns.right
  if (!column || column.collapsed || column.width >= minWidth) return
  dispatch(uie, { type: 'resizeColumn', scope: uie.scope.value, slotId: 'right', width: minWidth })
}

/** Bring `descriptorId` to the front of the right column, expanding it if collapsed. */
function ensureCard(uie: UieStore, descriptorId: string): boolean {
  const column = uie.snapshot.value.columns.right
  if (column?.collapsed) {
    // Opening a tab into a collapsed column changes nothing the user can see.
    dispatch(uie, { type: 'collapseColumn', scope: uie.scope.value, slotId: 'right', collapsed: false })
  }
  // Both cards are singletons, so the engine activates an existing instance instead of
  // opening a second one — including when the user dragged it to another column.
  return dispatch(uie, { type: 'openCard', scope: uie.scope.value, descriptorId, slotId: 'right' })
}

/** Workspace-relative path, or null when the path leaves the workspace. */
function resolvePath(raw: string, cwd: string | null | undefined): string | null {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) return null
  let path = trimmed.replace(/\\/g, '/').replace(/^\.\//, '')
  if (cwd) {
    const normalized = normalizeWorkspacePath(cwd, path)
    if (!normalized) return null
    path = normalized
  }
  return path || null
}

export interface OpenDocumentInput {
  path: string
  line?: number
  /** Workspace root: ownership of the panel state, and the boundary for the path itself. */
  cwd?: string | null
  source?: DocumentRef['source']
}

/**
 * Open (or focus) a document in the read-only viewer. Returns false when the reference
 * could not be resolved or the layout engine is not on screen.
 */
export function openDocument(input: OpenDocumentInput): boolean {
  const uie = uieStore()
  if (!uie) return false
  const path = resolvePath(input.path, input.cwd)
  if (!path) return false

  // Without a workspace the tab is still readable, so it lands in the unbound list rather
  // than aborting — but a bound workspace must not silently inherit another one's tabs.
  bindWorkspace(input.cwd ?? boundWorkspaceRoot)

  const existing = docTabs.value.find((tab) => tab.path === path)
  if (existing) {
    if (input.line) existing.line = input.line
    activeDocPath.value = path
    docTabs.value = [...docTabs.value]
  } else {
    docTabs.value = [...docTabs.value, input.line ? { path, line: input.line } : { path }]
    activeDocPath.value = path
  }

  focusNonce += 1
  docFocus.value = input.line ? { path, line: input.line, nonce: focusNonce } : { path, nonce: focusNonce }

  if (!ensureCard(uie, DOC_READER_CARD)) return false
  persist()
  return true
}

/**
 * Hand a file to the editor card. This is the viewer's "open in editor" path and the tree's
 * click path; it never turns the viewer into an editor.
 */
export function openInEditor(input: OpenDocumentInput): boolean {
  const uie = uieStore()
  if (!uie) return false
  const path = resolvePath(input.path, input.cwd)
  if (!path) return false

  bindWorkspace(input.cwd ?? boundWorkspaceRoot)
  editorPath.value = path
  focusNonce += 1
  editorFocus.value = input.line ? { path, line: input.line, nonce: focusNonce } : { path, nonce: focusNonce }

  if (!ensureCard(uie, CODE_EDITOR_CARD)) return false
  widenDocumentColumn()
  persist()
  return true
}

/** Back to the editor card's file browser; the file stays readable in the viewer. */
export function closeEditor(): void {
  editorPath.value = null
  editorFocus.value = null
  persist()
}

export function activateDocument(path: string): void {
  if (!docTabs.value.some((tab) => tab.path === path)) return
  activeDocPath.value = path
  persist()
}

export function closeDocument(path: string): void {
  const index = docTabs.value.findIndex((tab) => tab.path === path)
  if (index === -1) return
  const remaining = docTabs.value.filter((tab) => tab.path !== path)
  docTabs.value = remaining
  if (activeDocPath.value === path) {
    activeDocPath.value = remaining[Math.min(index, remaining.length - 1)]?.path ?? null
  }
  persist()
}

export function activeDocument(): DocumentTab | null {
  const path = activeDocPath.value
  if (!path) return null
  return docTabs.value.find((tab) => tab.path === path) ?? null
}

/**
 * Project switch (or first mount): both cards show that workspace's own state. Called by
 * the cards, which are the only surfaces that know which root is on screen.
 */
export function syncDocumentWorkspace(cwd: string | null): void {
  bindWorkspace(cwd && cwd.trim() ? cwd.trim() : null)
}

export function __resetDocumentWorkspaceForTests(): void {
  docTabs.value = []
  activeDocPath.value = null
  docFocus.value = null
  editorPath.value = null
  editorFocus.value = null
  boundWorkspaceRoot = null
  boundWorkspaceKey = null
  focusNonce = 0
  storage()?.removeItem(STORAGE_KEY)
}
