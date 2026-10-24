// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { describe, expect, it, vi } from 'vitest'
import DocumentEditorPane from './DocumentEditorPane.vue'

// The real editor is a monaco chunk; a stub keeps this test about the browser/pane split.
vi.mock('@/components/code/CodeEditor.vue', () => ({
  default: {
    props: ['filePath', 'cwd', 'revealLine', 'revealNonce', 'approvals', 'selectedSessionId'],
    emits: ['cancel', 'saved', 'approval-requested'],
    template: '<div class="editor-stub">{{ filePath }}</div>',
  },
}))

const TreeStub = {
  props: ['cwd', 'selected'],
  emits: ['select'],
  template: '<div class="tree-stub">{{ cwd }}</div>',
}

function render(props: Record<string, unknown> = {}) {
  return mount(DocumentEditorPane, {
    props: { path: null, cwd: '/w', ...props } as never,
    global: {
      plugins: [createI18n({
        legacy: false,
        locale: 'en',
        messages: {
          en: {
            documents: {
              tree: 'Files',
              reload: 'Reload',
              treeEmpty: 'This folder is empty',
              treeFailed: 'The folder could not be loaded',
              showTree: 'Show folders',
              hideTree: 'Hide folders',
              noWorkspace: 'No project is selected.',
              loadingEditor: 'Loading the editor…',
              editorFailed: 'The editor could not be loaded',
            },
            codeEditor: {
              emptyTitle: 'Pick a file to edit',
              emptyHint: 'The left side is this workspace’s folder tree.',
              closeFile: 'Close this file',
            },
          },
        },
      })],
      stubs: { DocumentFileTree: TreeStub },
    },
  })
}

describe('DocumentEditorPane', () => {
  it('is the file browser when no file is open', async () => {
    const wrapper = render()
    await flushPromises()

    expect(wrapper.get('.tree-stub').text()).toBe('/w')
    expect(wrapper.get('.doc-editor-browser-title').text()).toBe('Pick a file to edit')
    expect(wrapper.find('.editor-stub').exists()).toBe(false)
    // There is nothing to close or collapse against, so the rail stays out of the way.
    expect(wrapper.find('.doc-editor-rail').exists()).toBe(false)
    wrapper.unmount()
  })

  it('asks for a project instead of mounting an empty tree', async () => {
    const wrapper = render({ cwd: '' })
    await flushPromises()

    expect(wrapper.get('.doc-editor-browser-hint').text()).toBe('No project is selected.')
    expect(wrapper.find('.tree-stub').exists()).toBe(false)
    wrapper.unmount()
  })

  it('renders the editor beside the tree once a file is open', async () => {
    const wrapper = render({ path: 'docs/spec.md', line: 4 })
    await flushPromises()

    expect(wrapper.get('.editor-stub').text()).toBe('docs/spec.md')
    expect(wrapper.find('.doc-editor-browser').exists()).toBe(false)
    expect(wrapper.find('.tree-stub').exists()).toBe(true)
    expect(wrapper.find('.doc-editor-rail').exists()).toBe(true)
    wrapper.unmount()
  })

  it('collapses the tree and closes the file from the rail', async () => {
    const wrapper = render({ path: 'docs/spec.md' })
    await flushPromises()

    const [closeButton, treeButton] = wrapper.findAll('.doc-editor-rail-button')
    await treeButton!.trigger('click')
    expect(wrapper.find('.tree-stub').exists()).toBe(false)

    await closeButton!.trigger('click')
    expect(wrapper.emitted('close')).toHaveLength(1)
    wrapper.unmount()
  })
})
