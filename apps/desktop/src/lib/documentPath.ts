/**
 * Document references — the pure part.
 *
 * The Agent does not emit structured citations (there is no Core contract for them),
 * so a reference is recognised from the text it wrote: inline code and links in an
 * answer, the paths a tool reports it changed, and the file tree. Everything here is
 * a pure function so the recognition rules can be tested without a workspace.
 *
 * The rules are deliberately conservative. A false positive costs the user a click
 * that ends in "file not found"; a false negative only leaves text as text. So a
 * token must survive: no whitespace, no URL scheme, a known file extension, and — for
 * `path:12` — a prefix that still looks like a path on its own. That last rule is what
 * keeps `localhost:8080`, `10:30` and `v1.2:3` from becoming document links.
 */

export interface DocumentRef {
  /** Workspace-relative, forward slashes when the caller already normalised it. */
  path: string
  /** 1-based line number the reference points at. */
  line?: number
  /** Where the reference was found; kept so a future Core citation can share the shape. */
  source?: 'markdown' | 'tool' | 'tree' | 'editor'
}

/**
 * Extensions that can be a document reference. Text-like ones render in the reader,
 * the rest open in the "cannot preview" state so a `shot.png` reference still leads
 * somewhere instead of being silently plain.
 */
const DOCUMENT_EXTENSIONS = new Set([
  // prose / data
  'md', 'mdx', 'markdown', 'txt', 'log', 'rst', 'adoc', 'csv', 'tsv', 'json', 'jsonc', 'json5',
  'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'env', 'properties', 'xml', 'plist',
  // markup / style
  'html', 'htm', 'xhtml', 'css', 'scss', 'sass', 'less', 'svg',
  // code
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx', 'vue', 'svelte', 'astro', 'py', 'pyi',
  'rb', 'go', 'rs', 'java', 'kt', 'kts', 'scala', 'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'cs',
  'php', 'swift', 'm', 'mm', 'lua', 'pl', 'r', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'psm1',
  'bat', 'cmd', 'sql', 'graphql', 'gql', 'proto', 'gradle', 'cmake', 'dockerfile', 'gitignore',
  'editorconfig', 'diff', 'patch',
  // binaries the reader cannot show but the user may still want to open
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'pdf', 'zip', 'gz', 'tar', '7z',
  'mp3', 'mp4', 'wav', 'woff', 'woff2', 'ttf', 'otf', 'exe', 'dll', 'so', 'dylib', 'wasm',
])

/** Extensions the reader renders as text (everything else falls to "not supported"). */
const TEXT_EXTENSIONS = new Set([...DOCUMENT_EXTENSIONS].filter((ext) => ![
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'pdf', 'zip', 'gz', 'tar', '7z',
  'mp3', 'mp4', 'wav', 'woff', 'woff2', 'ttf', 'otf', 'exe', 'dll', 'so', 'dylib', 'wasm',
].includes(ext)))

const MARKDOWN_EXTENSIONS = new Set(['md', 'mdx', 'markdown'])

/** A token longer than this is not a path anyone means; it is a code snippet. */
const MAX_REFERENCE_LENGTH = 512
const MAX_LINE_NUMBER = 1_000_000

export function documentExtension(path: string): string {
  const name = documentBaseName(path)
  const dot = name.lastIndexOf('.')
  if (dot <= 0 || dot === name.length - 1) return ''
  return name.slice(dot + 1).toLowerCase()
}

export function documentBaseName(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const trimmed = normalized.endsWith('/') ? normalized.slice(0, -1) : normalized
  return trimmed.slice(trimmed.lastIndexOf('/') + 1)
}

/** Parent directory of a workspace-relative path; `''` means the workspace root. */
export function documentParentDir(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const index = normalized.lastIndexOf('/')
  return index <= 0 ? '' : normalized.slice(0, index)
}

export function isMarkdownPath(path: string): boolean {
  return MARKDOWN_EXTENSIONS.has(documentExtension(path))
}

/**
 * What the viewer's shelf lists: prose, not source. A workspace is mostly code, and a
 * "shelf of documents" that opens on 800 `.ts` files is a file browser with worse sorting.
 * Code and images still open fine when a reference points at them.
 */
const PROSE_EXTENSIONS = new Set(['md', 'mdx', 'markdown', 'txt', 'rst', 'adoc', 'org', 'text'])

export function isDocumentPath(path: string): boolean {
  return PROSE_EXTENSIONS.has(documentExtension(path))
}

export function isTextLikePath(path: string): boolean {
  return TEXT_EXTENSIONS.has(documentExtension(path))
}

function hasKnownExtension(path: string): boolean {
  return DOCUMENT_EXTENSIONS.has(documentExtension(path))
}

function looksLikePath(candidate: string): boolean {
  if (!candidate || candidate.length > MAX_REFERENCE_LENGTH) return false
  if (/\s/.test(candidate)) return false
  // Command flags, npm scopes, globs and template placeholders are not documents.
  if (/^[-@]/.test(candidate)) return false
  if (/[<>()"'{}$*?|]/.test(candidate)) return false
  if (candidate.startsWith('#')) return false
  if (candidate.endsWith('/') || candidate.endsWith(':')) return false
  // A bare word with no slash and no extension (`localhost`, `main`) is prose.
  return hasKnownExtension(candidate) || (candidate.includes('/') && /\.[A-Za-z0-9]{1,8}$/.test(candidate))
}

/**
 * Recognise a single reference token. `raw` is the text content of an inline code
 * span or a link label — already trimmed of backticks by the renderer.
 */
export function parseDocumentRef(raw: string): DocumentRef | null {
  const text = raw.trim().replace(/^`+/, '').replace(/`+$/, '')
  if (!text || text.length > MAX_REFERENCE_LENGTH) return null
  if (/\s/.test(text)) return null
  if (text.includes('://')) return null
  if (/^(https?|mailto|tel|data|ftp|file|node|npm|ms-[a-z-]+):/i.test(text)) return null
  if (text.startsWith('#') || text.startsWith('?')) return null

  let path = text
  let line: number | undefined

  const hash = /#L(\d+)(?:-L?\d+)?$/.exec(path)
  if (hash) {
    line = Number(hash[1])
    path = path.slice(0, hash.index)
  } else {
    const colon = /:(\d+)(?::\d+)?$/.exec(path)
    if (colon) {
      const prefix = path.slice(0, colon.index)
      // `localhost:8080` and `v1.2:3` die here: the prefix is not a path on its own.
      if (!looksLikePath(prefix)) return null
      line = Number(colon[1])
      path = prefix
    }
  }

  path = path.replace(/\\/g, '/').replace(/^\.\//, '')
  if (!looksLikePath(path)) return null
  if (line !== undefined && (!Number.isInteger(line) || line < 1 || line > MAX_LINE_NUMBER)) return null

  return line === undefined ? { path } : { path, line }
}

/**
 * Turn a reference from any surface into a path inside the workspace root.
 *
 * Returning `null` is the safety boundary: `..` escapes, absolute paths outside the
 * root and the root itself never become a document tab, so nothing outside the
 * project can be read by clicking a link the model wrote.
 */
export function normalizeWorkspacePath(cwd: string, raw: string): string | null {
  const root = (cwd ?? '').replace(/\\/g, '/').replace(/\/+$/, '')
  if (!root) return null
  let path = (raw ?? '').trim().replace(/\\/g, '/')
  if (!path) return null
  if (path.startsWith('file://')) path = path.slice('file://'.length)

  const absolute = path.startsWith('/') || /^[A-Za-z]:\//.test(path)
  if (absolute) {
    const lowerPath = path.toLowerCase()
    const lowerRoot = root.toLowerCase()
    if (lowerPath === lowerRoot) return null
    if (!lowerPath.startsWith(`${lowerRoot}/`)) {
      // Windows drive letters differ in case only; anything else is a real escape.
      return null
    }
    path = path.slice(root.length + 1)
  }

  const segments: string[] = []
  for (const segment of path.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (segments.length === 0) return null
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  return segments.length > 0 ? segments.join('/') : null
}
