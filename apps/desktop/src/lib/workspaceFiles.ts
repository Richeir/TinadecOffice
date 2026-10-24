/**
 * Workspace directory index — one cache in front of the `ls` tool.
 *
 * Two consumers need it: reference verification (does `docs/spec.md` exist before the
 * answer turns it into a link) and the sidebar file tree. Both speak "list this
 * directory", never "stat this file", because a single answer usually references
 * several files in one or two directories. Stat-per-candidate would be one tool call
 * per path; this is one per directory.
 *
 * Single-flight, 30s TTL, LRU 200. Failures are never cached: a directory that failed
 * once must be retried on the next look, otherwise "the host was not ready" would look
 * like "the folder is empty" for the rest of the session.
 */
import { api } from '@/api'
import { isDocumentPath } from '@/lib/documentPath'
import { toDirEntryView, type DirEntryDto, type DirEntryView } from '@/lib/workspaceSearch'

const TTL_MS = 30_000
const MAX_DIRS = 200

export type WorkspaceEntryKind = 'file' | 'directory'

interface DirCacheEntry {
  at: number
  entries: DirEntryView[]
}

const dirCache = new Map<string, DirCacheEntry>()
const inFlight = new Map<string, Promise<DirEntryView[] | null>>()

/**
 * Directories that are large, generated or never a document reference. The repo itself
 * is the reason: `apps/desktop/release` alone holds 1112 html files.
 */
const SKIPPED_DIRS = new Set([
  'node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out', 'release', 'runtime',
  'coverage', 'target', 'bin', 'obj', '.cache', '.next', '.nuxt', '.turbo', '.venv',
  'venv', '__pycache__', '.gradle', '.idea', '.vs', 'logs', 'tmp', 'temp',
])

export function shouldSkipDirName(name: string): boolean {
  return SKIPPED_DIRS.has(name.toLowerCase())
}

function normalizeRoot(cwd: string): string {
  return (cwd ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
}

function normalizeDir(dir: string): string {
  const value = (dir ?? '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
  return value === '.' ? '' : value
}

function cacheKey(cwd: string, dir: string): string {
  return `${normalizeRoot(cwd)}\u0000${normalizeDir(dir)}`
}

function write(cacheKeyValue: string, entries: DirEntryView[]): void {
  // Re-insert so Map iteration order stays "least recently written last"; the first
  // key is therefore the eviction candidate.
  dirCache.delete(cacheKeyValue)
  dirCache.set(cacheKeyValue, { at: Date.now(), entries })
  while (dirCache.size > MAX_DIRS) {
    const oldest = dirCache.keys().next().value
    if (oldest === undefined) break
    dirCache.delete(oldest)
  }
}

/** Synchronous cache read for the render path. `undefined` means "not verified yet". */
export function peekWorkspaceDir(cwd: string, dir: string): DirEntryView[] | undefined {
  const key = cacheKey(cwd, dir)
  const hit = dirCache.get(key)
  if (!hit) return undefined
  if (Date.now() - hit.at > TTL_MS) {
    dirCache.delete(key)
    return undefined
  }
  return hit.entries
}

export async function listWorkspaceDir(cwd: string, dir: string): Promise<DirEntryView[] | null> {
  const key = cacheKey(cwd, dir)
  const cached = peekWorkspaceDir(cwd, dir)
  if (cached) return cached
  const pending = inFlight.get(key)
  if (pending) return pending

  const request = (async () => {
    try {
      const result = await api.listDirectory(cwd, normalizeDir(dir) || '.')
      const data = result.data as { entries?: DirEntryDto[]; success?: boolean }
      if (data?.success === false) return null
      const entries = (Array.isArray(data?.entries) ? data.entries : [])
        .map(toDirEntryView)
        .filter((entry): entry is DirEntryView => entry !== null)
      write(key, entries)
      return entries
    } catch (error) {
      // A failed listing is not an empty directory: report failure and let the next
      // look retry instead of caching `[]`.
      console.error('[documents] listing a workspace directory failed', dir, error)
      return null
    } finally {
      inFlight.delete(key)
    }
  })()

  inFlight.set(key, request)
  return request
}

/**
 * Synchronous existence probe over the parent directory. `undefined` means the parent
 * has not been listed yet — the caller should verify asynchronously rather than
 * declaring the file missing.
 */
export function peekWorkspaceEntry(cwd: string, path: string): WorkspaceEntryKind | null | undefined {
  const normalized = normalizeDir(path)
  if (!normalized) return null
  const slash = normalized.lastIndexOf('/')
  const parent = slash === -1 ? '' : normalized.slice(0, slash)
  const name = slash === -1 ? normalized : normalized.slice(slash + 1)
  const entries = peekWorkspaceDir(cwd, parent)
  if (!entries) return undefined
  const hit = entries.find((entry) => entry.name === name)
  if (!hit) return null
  return hit.isDir ? 'directory' : 'file'
}

export async function findWorkspaceEntry(cwd: string, path: string): Promise<WorkspaceEntryKind | null> {
  const peeped = peekWorkspaceEntry(cwd, path)
  if (peeped !== undefined) return peeped
  const normalized = normalizeDir(path)
  const slash = normalized.lastIndexOf('/')
  const parent = slash === -1 ? '' : normalized.slice(0, slash)
  const name = slash === -1 ? normalized : normalized.slice(slash + 1)
  const entries = await listWorkspaceDir(cwd, parent)
  if (!entries) return null
  const hit = entries.find((entry) => entry.name === name)
  if (!hit) return null
  return hit.isDir ? 'directory' : 'file'
}

/** Drop one directory after a write, so the tree and the next reference read it again. */
export function invalidateWorkspaceDir(cwd: string, dir: string): void {
  dirCache.delete(cacheKey(cwd, dir))
}

// ---------------------------------------------------------------------------
// Document shelf — one bounded walk over the workspace.
//
// The viewer opens on "every document in this workspace", so it needs a scan rather than a
// tree the user expands. It is bounded on purpose: depth, directory count and result count
// all have caps, because a workspace can hold tens of thousands of files and this runs when
// the panel becomes visible. A capped scan says so (`truncated`) instead of pretending the
// workspace is that small.
// ---------------------------------------------------------------------------

export interface ShelfDocument {
  /** Workspace-relative path with forward slashes. */
  path: string
  name: string
  /** Parent directory; `''` is the workspace root. */
  dir: string
  size: number | null
}

export interface ShelfScanResult {
  documents: ShelfDocument[]
  /** Directories actually listed; the cost of the scan, useful in diagnostics. */
  scannedDirs: number
  /** A cap stopped the walk, so this list is a part of the workspace, not all of it. */
  truncated: boolean
  /** The workspace root itself could not be listed (host not ready, path gone). */
  failed: boolean
}

export interface ShelfScanOptions {
  maxDepth?: number
  maxDirs?: number
  maxDocuments?: number
  /** Cap on in-flight `ls` calls. */
  concurrency?: number
}

const SHELF_DEFAULTS = { maxDepth: 3, maxDirs: 48, maxDocuments: 240, concurrency: 5 }

export async function scanWorkspaceDocuments(
  cwd: string,
  options: ShelfScanOptions = {},
): Promise<ShelfScanResult> {
  const { maxDepth, maxDirs, maxDocuments, concurrency } = { ...SHELF_DEFAULTS, ...options }
  const documents: ShelfDocument[] = []
  const queue: Array<{ dir: string; depth: number }> = [{ dir: '', depth: 0 }]
  let scannedDirs = 0
  let truncated = false
  let failed = false

  while (queue.length > 0) {
    if (scannedDirs >= maxDirs || documents.length >= maxDocuments) {
      truncated = true
      break
    }
    const batch = queue.splice(0, concurrency)
    const listings = await Promise.all(batch.map((item) => listWorkspaceDir(cwd, item.dir)))

    for (const [index, entries] of listings.entries()) {
      const { dir, depth } = batch[index]!
      scannedDirs += 1
      if (!entries) {
        // Only the root failing is the caller's problem; one unreadable subfolder is not.
        if (depth === 0) failed = true
        continue
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue
        if (entry.isDir) {
          if (depth < maxDepth && !shouldSkipDirName(entry.name)) {
            queue.push({ dir: dir ? `${dir}/${entry.name}` : entry.name, depth: depth + 1 })
          }
          continue
        }
        if (!isDocumentPath(entry.name)) continue
        documents.push({
          path: dir ? `${dir}/${entry.name}` : entry.name,
          name: entry.name,
          dir,
          size: entry.size,
        })
        if (documents.length >= maxDocuments) {
          truncated = true
          break
        }
      }
      if (truncated) break
    }
  }

  documents.sort((a, b) => a.path.localeCompare(b.path))
  return { documents, scannedDirs, truncated, failed }
}

/** Drop every directory of a workspace (project switch, manual refresh). */
export function invalidateWorkspace(cwd: string): void {
  const root = normalizeRoot(cwd)
  for (const key of [...dirCache.keys()]) {
    if (key.startsWith(`${root}\u0000`)) dirCache.delete(key)
  }
}

export function __resetWorkspaceFilesForTests(): void {
  dirCache.clear()
  inFlight.clear()
}
