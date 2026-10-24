// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import DocumentReader from './DocumentReader.vue'

const apiMock = vi.hoisted(() => ({ readFile: vi.fn(), statEntry: vi.fn() }))
vi.mock('@/api', () => ({ api: apiMock }))

const messages = {
  documents: {
    tree: 'Files',
    treeEmpty: 'This folder is empty',
    treeFailed: 'The folder could not be loaded',
    reload: 'Reload',
    showTree: 'Show folders',
    hideTree: 'Hide folders',
    noWorkspace: 'No project is selected, so workspace files cannot be read.',
    loadingEditor: 'Loading the editor…',
    editorFailed: 'The editor could not be loaded',
  },
  docReader: {
    tabs: 'Open documents',
    emptyTitle: 'No document is open',
    emptyHint: 'A reference in the chat opens here.',
    openEditor: 'Open the code editor',
    line: 'Line {line}',
    edit: 'Edit',
    openInEditor: 'Open in editor',
    loading: 'Reading the document…',
    loadFailedTitle: 'This document could not be read',
    loadFailed: 'Reading the document failed',
    missingPath: 'The file path is missing.',
    unsupportedTitle: 'This file cannot be previewed here',
    unsupportedDetail: '{path} is not a text file. Open it in the editor.',
    tooLargeTitle: 'The file is too large',
    tooLargeDetail: 'The file is {size}; it is not rendered in the side panel.',
    closeTab: 'Close document',
    truncated: 'Showing the first {count} lines only',
  },
  common: { retry: 'Retry' },
}

function render(props: Record<string, unknown>) {
  return mount(DocumentReader, {
    props: { path: 'docs/spec.md', cwd: '/w', ...props } as never,
    global: {
      plugins: [createI18n({ legacy: false, locale: 'en', messages: { en: messages } })],
      stubs: {
        MarkdownRender: { props: ['content'], template: '<div class="stub-markdown">{{ content }}</div>' },
      },
    },
  })
}

function fileBody(lines: string[], hash = 'abc') {
  return {
    data: {
      success: true,
      file_hash: hash,
      all_contents: lines.map((line) => ({ content: { Content: line } })),
    },
  }
}

beforeEach(() => {
  apiMock.readFile.mockReset()
  apiMock.statEntry.mockReset()
  apiMock.statEntry.mockResolvedValue({ data: { entry: { size: 120, modified_at: '2026-10-24T09:00:00Z' } } })
})

describe('DocumentReader', () => {
  it('renders a markdown document through the shared renderer', async () => {
    apiMock.readFile.mockResolvedValue(fileBody(['# Title', '', 'Body']))
    const wrapper = render({ path: 'docs/spec.md' })
    await flushPromises()

    expect(wrapper.find('.doc-reader-markdown').exists()).toBe(true)
    expect(wrapper.get('.stub-markdown').text()).toContain('# Title')
    expect(wrapper.find('.doc-reader-code').exists()).toBe(false)
    expect(wrapper.get('.doc-reader-name').text()).toBe('spec.md')
    wrapper.unmount()
  })

  it('renders a code file line by line and marks the referenced line', async () => {
    apiMock.readFile.mockResolvedValue(fileBody(['const a = 1', 'const b = 2', 'const c = 3']))
    const wrapper = render({ path: 'src/app.ts', line: 2 })
    await flushPromises()

    const rows = wrapper.findAll('.doc-reader-line')
    expect(rows).toHaveLength(3)
    expect(rows[0]!.get('.doc-reader-gutter').text()).toBe('1')
    expect(wrapper.get('.doc-reader-line.is-target').attributes('data-line')).toBe('2')
    expect(wrapper.get('[data-testid="doc-reader-line"]').text()).toBe('Line 2')
    expect(wrapper.find('.stub-markdown').exists()).toBe(false)
    wrapper.unmount()
  })

  it('refuses a binary file without reading it', async () => {
    const wrapper = render({ path: 'assets/shot.png' })
    await flushPromises()

    expect(apiMock.readFile).not.toHaveBeenCalled()
    expect(apiMock.statEntry).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('This file cannot be previewed here')
    wrapper.unmount()
  })

  it('reports an oversized file instead of rendering it', async () => {
    apiMock.statEntry.mockResolvedValue({ data: { entry: { size: 2 * 1024 * 1024 } } })
    const wrapper = render({ path: 'logs/run.log' })
    await flushPromises()

    expect(apiMock.readFile).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('The file is too large')
    wrapper.unmount()
  })

  it('states a read failure and retries on demand', async () => {
    apiMock.readFile.mockRejectedValueOnce(new Error('host offline'))
    const wrapper = render({ path: 'docs/spec.md' })
    await flushPromises()
    expect(wrapper.text()).toContain('This document could not be read')
    expect(wrapper.text()).toContain('host offline')

    apiMock.readFile.mockResolvedValueOnce(fileBody(['# Title']))
    await wrapper.get('.doc-reader-empty-action').trigger('click')
    await flushPromises()
    expect(wrapper.get('.stub-markdown').text()).toContain('# Title')
    wrapper.unmount()
  })

  it('refuses to read without a workspace root', async () => {
    const wrapper = render({ cwd: '' })
    await flushPromises()
    expect(apiMock.readFile).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('No project is selected')
    wrapper.unmount()
  })
})
