// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import DocumentShelf from './DocumentShelf.vue'

const scan = vi.hoisted(() => ({ scanWorkspaceDocuments: vi.fn(), invalidateWorkspace: vi.fn() }))

vi.mock('@/lib/workspaceFiles', () => ({
  scanWorkspaceDocuments: scan.scanWorkspaceDocuments,
  invalidateWorkspace: scan.invalidateWorkspace,
}))

function doc(path: string, dir: string, name: string) {
  return { path, dir, name, size: 12 }
}

function render(cwd = '/w') {
  return mount(DocumentShelf, {
    props: { cwd },
    global: {
      plugins: [createI18n({
        legacy: false,
        locale: 'en',
        messages: {
          en: {
            documents: { reload: 'Reload' },
            docReader: {
              shelfTitle: 'Document shelf',
              shelfCount: '{count}',
              shelfScanning: 'Scanning the workspace…',
              shelfEmpty: 'No documents found in this workspace.',
              shelfFailed: 'The workspace could not be scanned.',
              shelfTruncated: 'Only the first {count} documents are listed.',
              shelfRoot: 'Workspace root',
            },
          },
        },
      })],
    },
  })
}

beforeEach(() => {
  scan.scanWorkspaceDocuments.mockReset()
  scan.invalidateWorkspace.mockReset()
})

describe('DocumentShelf', () => {
  it('groups documents by folder and opens one on click', async () => {
    scan.scanWorkspaceDocuments.mockResolvedValue({
      documents: [doc('README.md', '', 'README.md'), doc('docs/spec.md', 'docs', 'spec.md'), doc('docs/guide.md', 'docs', 'guide.md')],
      scannedDirs: 3,
      truncated: false,
      failed: false,
    })
    const wrapper = render()
    await flushPromises()

    const labels = wrapper.findAll('.doc-shelf-label').map((node) => node.text())
    expect(labels).toEqual(['Workspace root', 'docs'])
    const books = wrapper.findAll('.doc-shelf-book')
    expect(books).toHaveLength(3)
    expect(wrapper.get('.doc-shelf-count').text()).toBe('3')

    await books[1]!.trigger('click')
    expect(wrapper.emitted('open')?.at(-1)).toEqual(['docs/guide.md'])
    wrapper.unmount()
  })

  it('says the list is partial when the scan was capped', async () => {
    scan.scanWorkspaceDocuments.mockResolvedValue({
      documents: [doc('a.md', '', 'a.md')],
      scannedDirs: 48,
      truncated: true,
      failed: false,
    })
    const wrapper = render()
    await flushPromises()

    expect(wrapper.text()).toContain('Only the first 1 documents are listed.')
    wrapper.unmount()
  })

  it('states a failed scan and retries with a fresh cache', async () => {
    scan.scanWorkspaceDocuments.mockResolvedValue({ documents: [], scannedDirs: 1, truncated: false, failed: true })
    const wrapper = render()
    await flushPromises()

    expect(wrapper.get('.doc-shelf-message-title').text()).toBe('The workspace could not be scanned.')
    await wrapper.get('.doc-shelf-retry').trigger('click')
    expect(scan.invalidateWorkspace).toHaveBeenCalledWith('/w')
    expect(scan.scanWorkspaceDocuments).toHaveBeenCalledTimes(2)
    wrapper.unmount()
  })

  it('distinguishes an empty workspace from a failed scan', async () => {
    scan.scanWorkspaceDocuments.mockResolvedValue({ documents: [], scannedDirs: 2, truncated: false, failed: false })
    const wrapper = render()
    await flushPromises()

    expect(wrapper.text()).toContain('No documents found in this workspace.')
    expect(wrapper.find('.doc-shelf-message').exists()).toBe(false)
    wrapper.unmount()
  })

  it('rescans when the workspace changes', async () => {
    scan.scanWorkspaceDocuments.mockResolvedValue({ documents: [], scannedDirs: 1, truncated: false, failed: false })
    const wrapper = render()
    await flushPromises()

    await wrapper.setProps({ cwd: '/other' })
    await flushPromises()
    expect(scan.scanWorkspaceDocuments).toHaveBeenCalledWith('/other')
    expect(scan.invalidateWorkspace).toHaveBeenCalledWith('/other')
    wrapper.unmount()
  })
})
