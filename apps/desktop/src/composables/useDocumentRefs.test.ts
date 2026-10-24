// @vitest-environment happy-dom
import { ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const apiMock = vi.hoisted(() => ({ listDirectory: vi.fn() }))
vi.mock('@/api', () => ({ api: apiMock }))

const { useDocumentRefs, __resetDocumentRefsForTests } = await import('./useDocumentRefs')
const { __resetWorkspaceFilesForTests } = await import('@/lib/workspaceFiles')

function listing(names: string[]) {
  return { data: { entries: names.map((name) => ({ name, type: 'file', size: 10, modified_at: null })) } }
}

beforeEach(() => {
  __resetDocumentRefsForTests()
  __resetWorkspaceFilesForTests()
  apiMock.listDirectory.mockReset()
})

describe('useDocumentRefs', () => {
  it('answers only from cache, then upgrades once the directory has been listed', async () => {
    apiMock.listDirectory.mockResolvedValue(listing(['spec.md']))
    const resolver = useDocumentRefs(ref('/w'))

    // First look: not verified yet, so the caller keeps plain text.
    expect(resolver.resolve('docs/spec.md:12')).toBeNull()
    const before = resolver.revision.value

    await vi.waitFor(() => expect(resolver.resolve('docs/spec.md:12')).not.toBeNull())
    expect(resolver.resolve('docs/spec.md:12')).toEqual({ path: 'docs/spec.md', line: 12, source: 'markdown' })
    expect(resolver.revision.value).toBeGreaterThan(before)
  })

  it('never turns a missing file, a non-path or a reference without a workspace into a link', async () => {
    apiMock.listDirectory.mockResolvedValue(listing(['other.md']))
    const resolver = useDocumentRefs(ref('/w'))

    expect(resolver.resolve('localhost:8080')).toBeNull()
    expect(resolver.resolve('docs/spec.md')).toBeNull()
    await vi.waitFor(() => expect(apiMock.listDirectory).toHaveBeenCalled())
    expect(resolver.resolve('docs/spec.md')).toBeNull()

    const noWorkspace = useDocumentRefs(ref(null))
    expect(noWorkspace.resolve('docs/spec.md')).toBeNull()
  })

  it('verifies a directory once for several references inside it', async () => {
    apiMock.listDirectory.mockResolvedValue(listing(['one.md', 'two.md']))
    const resolver = useDocumentRefs(ref('/w'))

    resolver.resolve('docs/one.md')
    resolver.resolve('docs/two.md')
    expect(resolver.resolve('docs/one.md')).toBeNull()

    await vi.waitFor(() => expect(resolver.resolve('docs/two.md')).not.toBeNull())
    expect(resolver.resolve('docs/one.md')).not.toBeNull()
    expect(apiMock.listDirectory).toHaveBeenCalledTimes(1)
  })

  it('queues a path once even when the same delta is rendered repeatedly', async () => {
    apiMock.listDirectory.mockResolvedValue(listing(['spec.md']))
    const resolver = useDocumentRefs(ref('/w'))

    for (let index = 0; index < 5; index += 1) resolver.resolve('docs/spec.md')
    await vi.waitFor(() => expect(apiMock.listDirectory).toHaveBeenCalled())
    expect(apiMock.listDirectory).toHaveBeenCalledTimes(1)
  })

  it('retries a failed listing instead of remembering the file as missing', async () => {
    apiMock.listDirectory.mockRejectedValueOnce(new Error('host offline'))
    const resolver = useDocumentRefs(ref('/w'))
    resolver.resolve('docs/spec.md')
    await vi.waitFor(() => expect(apiMock.listDirectory).toHaveBeenCalledTimes(1))
    expect(resolver.resolve('docs/spec.md')).toBeNull()

    apiMock.listDirectory.mockResolvedValueOnce(listing(['spec.md']))
    resolver.resolve('docs/spec.md')
    await vi.waitFor(() => expect(resolver.resolve('docs/spec.md')).not.toBeNull())
    expect(apiMock.listDirectory).toHaveBeenCalledTimes(2)
  })

  it('forgets this workspace verdicts on refresh', async () => {
    apiMock.listDirectory.mockResolvedValue(listing(['spec.md']))
    const resolver = useDocumentRefs(ref('/w'))
    resolver.resolve('docs/spec.md')
    await vi.waitFor(() => expect(resolver.resolve('docs/spec.md')).not.toBeNull())

    resolver.refresh()
    expect(resolver.resolve('docs/spec.md')).toBeNull()
  })
})
