/**
 * Vitest global setup.
 *
 * happy-dom 20 ships `sessionStorage` but no `localStorage`, so tests that touch
 * persisted UI state (appearance, panel styles, Settings page) crashed on
 * `localStorage.clear()` before asserting anything. Several files worked around
 * this locally with `vi.stubGlobal`; providing the shim once here keeps the
 * environment honest for every file and lets those workarounds stay as they are.
 *
 * A plain in-memory `Storage` is enough: no test asserts cross-run persistence,
 * and `storage` events are not part of the desktop's storage model.
 */
function createMemoryStorage(): Storage {
  const store = new Map<string, string>()
  return {
    get length() {
      return store.size
    },
    clear: () => store.clear(),
    getItem: (key: string) => store.get(key) ?? null,
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    removeItem: (key: string) => void store.delete(key),
    setItem: (key: string, value: string) => void store.set(key, String(value)),
  } as Storage
}

// Component fixtures use the same standards mode as the app's <!doctype html>.
// Browser-dependent renderers (including the math renderer) reject quirks mode.
if (typeof document !== 'undefined' && !document.doctype) {
  document.insertBefore(document.implementation.createDocumentType('html', '', ''), document.documentElement)
}

const target = typeof window === 'undefined' ? globalThis : (window as unknown as Record<string, unknown>)
if (!('localStorage' in target) || target.localStorage == null) {
  Object.defineProperty(target, 'localStorage', {
    configurable: true,
    value: createMemoryStorage(),
  })
}

/**
 * happy-dom's `Node.prototype.nodeName` getter returns '' for every node — the real
 * name lives one level down on Element/CharacterData prototypes, which is why direct
 * reads work. DOMPurify ≥ 3.4.8 hardened its walk to read tag names through exactly
 * that cached Node-level getter (realm-safety), so under happy-dom every element
 * looked "unnamed" and the sanitizer unwrapped the first top-level element of a
 * document (headings, tables and fences lost their tags in MarkdownRender). Real
 * browsers implement the Node-level getter per spec, so this is a test-environment
 * repair, not an app change. The shim delegates to the nearest concrete getter and
 * disarms itself if happy-dom ever fixes the Node-level read.
 */
if (typeof Node !== 'undefined' && typeof document !== 'undefined') {
  const nodeProto = Node.prototype
  const original = Object.getOwnPropertyDescriptor(nodeProto, 'nodeName')
  const nodeGetter = original?.get
  const probe = document.createElement('div')
  const readsEmpty = nodeGetter
    ? (nodeGetter as (this: Node) => string).call(probe) === ''
    : false
  if (nodeGetter && readsEmpty && probe.nodeName !== '') {
    Object.defineProperty(nodeProto, 'nodeName', {
      configurable: true,
      get(this: Node): string {
        let proto: object | null = Object.getPrototypeOf(this)
        while (proto && proto !== nodeProto) {
          const desc = Object.getOwnPropertyDescriptor(proto, 'nodeName')
          if (desc?.get) return desc.get.call(this) as string
          proto = Object.getPrototypeOf(proto)
        }
        return (nodeGetter as (this: Node) => string).call(this)
      },
    })
  }
}
