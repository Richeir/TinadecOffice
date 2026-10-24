// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const apiMock = vi.hoisted(() => ({ listDirectory: vi.fn() }))
vi.mock('@/api', () => ({ api: apiMock }))

const {
  __resetWorkspaceFilesForTests,
  findWorkspaceEntry,
  invalidateWorkspaceDir,
  listWorkspaceDir,
  peekWorkspaceEntry,
  scanWorkspaceDocuments,
  shouldSkipDirName,
} = await import('./workspaceFiles')

function listing(entries: Array<{ name: string; type: string }>) {
  return { data: { entries: entries.map((entry) => ({ ...entry, size: null, modified_at: null })) } }
}

beforeEach(() => {
  __resetWorkspaceFilesForTests()
  apiMock.listDirectory.mockReset()
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-24T10:00:00Z'))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('listWorkspaceDir', () => {
  it('shares one request between concurrent callers of the same directory', async () => {
    apiMock.listDirectory.mockResolvedValue(listing([{ name: 'a.md', type: 'file' }]))
    const [first, second] = await Promise.all([
      listWorkspaceDir('/w', 'docs'),
      listWorkspaceDir('/w', 'docs'),
    ])
    expect(apiMock.listDirectory).toHaveBeenCalledTimes(1)
    expect(first).toEqual(second)
    expect(first?.map((entry) => entry.name)).toEqual(['a.md'])
  })

  it('serves a second read from the cache inside the TTL and refetches after it', async () => {
    apiMock.listDirectory.mockResolvedValue(listing([{ name: 'a.md', type: 'file' }]))
    await listWorkspaceDir('/w', 'docs')
    await listWorkspaceDir('/w', 'docs')
    expect(apiMock.listDirectory).toHaveBeenCalledTimes(1)

    vi.setSystemTime(new Date('2026-10-24T10:00:31Z'))
    await listWorkspaceDir('/w', 'docs')
    expect(apiMock.listDirectory).toHaveBeenCalledTimes(2)
  })

  it('keeps a failed listing out of the cache so the next look retries', async () => {
    apiMock.listDirectory.mockRejectedValueOnce(new Error('host not ready'))
    expect(await listWorkspaceDir('/w', 'docs')).toBeNull()

    apiMock.listDirectory.mockResolvedValueOnce(listing([{ name: 'a.md', type: 'file' }]))
    const retried = await listWorkspaceDir('/w', 'docs')
    expect(apiMock.listDirectory).toHaveBeenCalledTimes(2)
    expect(retried?.map((entry) => entry.name)).toEqual(['a.md'])
  })

  it('treats the tool own failure envelope as a failure, not as an empty folder', async () => {
    apiMock.listDirectory.mockResolvedValueOnce({ data: { success: false, error: 'denied' } })
    expect(await listWorkspaceDir('/w', 'docs')).toBeNull()
    expect(peekWorkspaceEntry('/w', 'docs/a.md')).toBeUndefined()
  })

  it('drops one directory on request', async () => {
    apiMock.listDirectory.mockResolvedValue(listing([{ name: 'a.md', type: 'file' }]))
    await listWorkspaceDir('/w', 'docs')
    invalidateWorkspaceDir('/w', 'docs')
    // `./docs` normalises to the same key; the refetch proves the entry was dropped.
    await listWorkspaceDir('/w', './docs')
    expect(apiMock.listDirectory).toHaveBeenCalledTimes(2)
  })
})

describe('findWorkspaceEntry', () => {
  it('reports a file, a directory and a missing entry from one listing', async () => {
    apiMock.listDirectory.mockResolvedValue(listing([
      { name: 'a.md', type: 'file' },
      { name: 'nested', type: 'directory' },
    ]))
    expect(await findWorkspaceEntry('/w', 'docs/a.md')).toBe('file')
    expect(await findWorkspaceEntry('/w', 'docs/nested')).toBe('directory')
    expect(await findWorkspaceEntry('/w', 'docs/missing.md')).toBeNull()
    // The three answers came from the same cached listing.
    expect(apiMock.listDirectory).toHaveBeenCalledTimes(1)
  })

  it('answers synchronously once the parent is indexed', async () => {
    expect(peekWorkspaceEntry('/w', 'docs/a.md')).toBeUndefined()
    apiMock.listDirectory.mockResolvedValue(listing([{ name: 'a.md', type: 'file' }]))
    await listWorkspaceDir('/w', 'docs')
    expect(peekWorkspaceEntry('/w', 'docs/a.md')).toBe('file')
    expect(peekWorkspaceEntry('/w', 'docs/b.md')).toBeNull()
  })

  it('lists the workspace root when the reference has no parent folder', async () => {
    apiMock.listDirectory.mockResolvedValue(listing([{ name: 'README.md', type: 'file' }]))
    expect(await findWorkspaceEntry('/w', 'README.md')).toBe('file')
    expect(apiMock.listDirectory).toHaveBeenCalledWith('/w', '.')
  })
})

describe('shouldSkipDirName', () => {
  it('filters generated and heavy folders case-insensitively', () => {
    expect(shouldSkipDirName('node_modules')).toBe(true)
    expect(shouldSkipDirName('Release')).toBe(true)
    expect(shouldSkipDirName('src')).toBe(false)
    expect(shouldSkipDirName('docs')).toBe(false)
  })
})

describe('scanWorkspaceDocuments', () => {
  it('walks subfolders and keeps prose documents only', async () => {
    apiMock.listDirectory.mockImplementation(async (_cwd: string, dir: string) => {
      if (dir === '.') {
        return { data: { entries: [
          { name: 'README.md', type: 'file', size: 10 },
          { name: '.hidden.md', type: 'file', size: 1 },
          { name: 'main.ts', type: 'file', size: 1 },
          { name: 'node_modules', type: 'directory' },
          { name: 'src', type: 'directory' },
        ] } }
      }
      if (dir === 'src') {
        return { data: { entries: [
          { name: 'app.ts', type: 'file' },
          { name: 'guide.md', type: 'file', size: 20 },
        ] } }
      }
      return { data: { entries: [] } }
    })

    const scan = await scanWorkspaceDocuments('/w')
    expect(scan.failed).toBe(false)
    expect(scan.documents.map((doc) => doc.path)).toEqual(['README.md', 'src/guide.md'])
    expect(scan.documents[1]).toMatchObject({ name: 'guide.md', dir: 'src', size: 20 })
    // node_modules is never listed; the hidden file and the .ts file are never offered.
    expect(apiMock.listDirectory).not.toHaveBeenCalledWith('/w', 'node_modules')
  })

  it('honours the document cap and admits the list is partial', async () => {
    apiMock.listDirectory.mockResolvedValue({ data: { entries: [
      { name: 'a.md', type: 'file' },
      { name: 'b.md', type: 'file' },
      { name: 'c.md', type: 'file' },
    ] } })

    const scan = await scanWorkspaceDocuments('/w', { maxDocuments: 2 })
    expect(scan.documents).toHaveLength(2)
    expect(scan.truncated).toBe(true)
  })

  it('stops descending at maxDepth instead of walking the whole tree', async () => {
    apiMock.listDirectory.mockImplementation(async (_cwd: string, dir: string) => ({
      data: { entries: dir === '.' ? [{ name: 'deep', type: 'directory' }, { name: 'top.md', type: 'file' }] : [{ name: 'inner.md', type: 'file' }] },
    }))

    const shallow = await scanWorkspaceDocuments('/w', { maxDepth: 0 })
    expect(shallow.documents.map((doc) => doc.path)).toEqual(['top.md'])
    expect(apiMock.listDirectory).toHaveBeenCalledTimes(1)

    __resetWorkspaceFilesForTests()
    const deep = await scanWorkspaceDocuments('/w')
    expect(deep.documents.map((doc) => doc.path)).toEqual(['deep/inner.md', 'top.md'])
  })

  it('reports a failed root but forgives one unreadable subfolder', async () => {
    apiMock.listDirectory.mockResolvedValueOnce(null)
    expect((await scanWorkspaceDocuments('/w')).failed).toBe(true)

    apiMock.listDirectory.mockImplementation(async (_cwd: string, dir: string) => {
      if (dir === '.') return { data: { entries: [{ name: 'broken', type: 'directory' }] } }
      return null
    })
    __resetWorkspaceFilesForTests()
    const scan = await scanWorkspaceDocuments('/w')
    expect(scan.failed).toBe(false)
    expect(scan.documents).toEqual([])
  })
})
