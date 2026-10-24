/**
 * Document reference resolver for one conversation surface.
 *
 * The contract with the renderer is unusual on purpose: `resolve(raw)` is called from
 * inside a computed (MarkdownRender's block parse), so it must stay synchronous and
 * side-effect free from the caller's point of view. It therefore only answers from
 * cache and, when a path has never been seen, queues a verification and returns `null`
 * — the token stays plain text until the answer lands. When verification settles the
 * shared `revision` bumps and the renderer re-parses, upgrading the text to a link.
 *
 * That is also why verification is gated on "the answer stopped streaming": a reply
 * emits dozens of deltas and each one would re-examine the same handful of paths.
 */
import { ref, watch, type Ref } from 'vue'
import {
  documentParentDir,
  normalizeWorkspacePath,
  parseDocumentRef,
  type DocumentRef,
} from '@/lib/documentPath'
import { listWorkspaceDir, peekWorkspaceEntry } from '@/lib/workspaceFiles'

export interface DocumentRefResolver {
  /** Cache-only. `null` means "not a document (yet)" — never triggers a render change. */
  resolve(raw: string): DocumentRef | null
  /** Bumps when a verification lands; the renderer depends on it to re-parse. */
  revision: Ref<number>
  /** Forget this workspace's verdicts (after a save, or a manual refresh). */
  refresh(): void
}

/** Verifications in flight at once; each one is an `ls` over one directory. */
const CONCURRENCY = 2
/** A negative verdict expires: the file may be created later in the same session. */
const NEGATIVE_TTL_MS = 60_000
const POSITIVE_TTL_MS = 5 * 60_000

type Verdict = 'file' | 'missing'

interface VerdictEntry {
  verdict: Verdict
  at: number
}

const verdicts = new Map<string, VerdictEntry>()
const revision = ref(0)
const queued = new Set<string>()
const pending: string[] = []
let active = 0

function verdictKey(cwd: string, path: string): string {
  return `${cwd.replace(/\\/g, '/')}\u0000${path}`
}

function readVerdict(cwd: string, path: string): Verdict | undefined {
  const hit = verdicts.get(verdictKey(cwd, path))
  if (!hit) return undefined
  const ttl = hit.verdict === 'file' ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS
  if (Date.now() - hit.at > ttl) {
    verdicts.delete(verdictKey(cwd, path))
    return undefined
  }
  return hit.verdict
}

function writeVerdict(cwd: string, path: string, verdict: Verdict): void {
  verdicts.set(verdictKey(cwd, path), { verdict, at: Date.now() })
}

function drain(): void {
  while (active < CONCURRENCY && pending.length > 0) {
    const next = pending.shift()!
    const [cwd, path] = splitTask(next)
    if (!cwd || !path) {
      queued.delete(next)
      continue
    }
    active += 1
    void verify(cwd, path).finally(() => {
      active -= 1
      queued.delete(next)
      drain()
    })
  }
}

function splitTask(task: string): [string, string] {
  const index = task.indexOf('\u0000')
  return index === -1 ? ['', ''] : [task.slice(0, index), task.slice(index + 1)]
}

async function verify(cwd: string, path: string): Promise<void> {
  const known = peekWorkspaceEntry(cwd, path)
  if (known !== undefined) {
    // The directory is already indexed (the tree listed it, or an earlier reference
    // did): settle immediately instead of paying for another listing.
    writeVerdict(cwd, path, known === 'file' ? 'file' : 'missing')
    revision.value += 1
    return
  }
  const entries = await listWorkspaceDir(cwd, documentParentDir(path))
  if (!entries) return // failed listing: no verdict, retried on the next attempt
  const name = path.slice(path.lastIndexOf('/') + 1)
  const hit = entries.find((entry) => entry.name === name)
  writeVerdict(cwd, path, hit && !hit.isDir ? 'file' : 'missing')
  revision.value += 1
}

function enqueue(cwd: string, path: string): void {
  // `<root>\0<path>`; the root never contains the separator, so splitTask is exact.
  const key = verdictKey(cwd, path)
  if (queued.has(key)) return
  queued.add(key)
  pending.push(key)
  drain()
}

export function useDocumentRefs(cwd: Ref<string | null | undefined>): DocumentRefResolver {
  watch(cwd, () => {
    // A different workspace has different files; the verdict map is keyed by cwd so
    // nothing is stale, but the rendered replies must re-parse for the new root.
    revision.value += 1
  })

  function resolve(raw: string): DocumentRef | null {
    const root = (cwd.value ?? '').trim()
    if (!root) return null
    const parsed = parseDocumentRef(raw)
    if (!parsed) return null
    const path = normalizeWorkspacePath(root, parsed.path)
    if (!path) return null
    const verdict = readVerdict(root, path)
    if (verdict !== 'file') {
      if (verdict === undefined) enqueue(root, path)
      return null
    }
    return { path, line: parsed.line, source: 'markdown' }
  }

  function refresh(): void {
    const root = (cwd.value ?? '').trim()
    if (root) {
      const prefix = `${root.replace(/\\/g, '/')}\u0000`
      for (const key of [...verdicts.keys()]) {
        if (key.startsWith(prefix)) verdicts.delete(key)
      }
    }
    revision.value += 1
  }

  return { resolve, revision, refresh }
}

/** Tests and project switches: drop every verdict and every queued task. */
export function __resetDocumentRefsForTests(): void {
  verdicts.clear()
  queued.clear()
  pending.length = 0
  active = 0
  revision.value = 0
}
