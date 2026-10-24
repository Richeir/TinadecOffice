// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { ref } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import DocumentReaderCard from './DocumentReaderCard.vue'

const doc = vi.hoisted(() => ({
  tabs: null as unknown,
  active: null as unknown,
  focus: null as unknown,
  openDocument: vi.fn((_input: { path: string; line?: number }) => true),
  openInEditor: vi.fn((_input: { path: string; line?: number }) => true),
  activateDocument: vi.fn(),
  closeDocument: vi.fn(),
  syncDocumentWorkspace: vi.fn(),
  dispatch: vi.fn((_envelope: unknown) => true),
}))

const controller = vi.hoisted(() => ({
  selectedProjectId: { value: 'p1' as string | null },
  currentProject: { value: { path: '/w' } as { path: string } | null },
  approvals: { value: [] as unknown[] },
  selectedSessionId: { value: null as string | null },
  recordApproval: vi.fn(),
}))

vi.mock('@/lib/documentWorkspace', () => ({
  // Getters, not values: the store refs are re-created per test in beforeEach.
  get docTabs() { return doc.tabs },
  get activeDocPath() { return doc.active },
  get docFocus() { return doc.focus },
  CODE_EDITOR_CARD: 'codeEditor',
  openDocument: doc.openDocument,
  openInEditor: doc.openInEditor,
  activateDocument: doc.activateDocument,
  closeDocument: doc.closeDocument,
  syncDocumentWorkspace: doc.syncDocumentWorkspace,
}))

vi.mock('@tinadec/ui', () => ({
  useUie: () => ({
    snapshot: { value: { revision: 1 } },
    scope: { value: { kind: 'page', pageId: 'home' } },
    dispatch: doc.dispatch,
  }),
}))

vi.mock('@/controllers/HomeController', () => ({ homeController: controller }))

const ReaderStub = {
  props: ['path', 'cwd', 'line', 'revealNonce'],
  emits: ['edit'],
  template: '<div class="reader-stub" @click="$emit(\'edit\')">{{ path }}</div>',
}
const ShelfStub = {
  props: ['cwd'],
  emits: ['open'],
  template: '<div class="shelf-stub" :data-cwd="cwd" @click="$emit(\'open\', \'docs/spec.md\')" />',
}

function render() {
  return mount(DocumentReaderCard, {
    global: {
      plugins: [createI18n({
        legacy: false,
        locale: 'en',
        messages: {
          en: {
            documents: { noWorkspace: 'No project is selected.' },
            docReader: {
              tabs: 'Open documents',
              openEditor: 'Browse every file in the code editor',
              closeTab: 'Close document',
            },
          },
        },
      })],
      stubs: { DocumentReader: ReaderStub, DocumentShelf: ShelfStub },
    },
  })
}

beforeEach(() => {
  doc.tabs = ref([])
  doc.active = ref(null)
  doc.focus = ref(null)
  doc.openDocument.mockClear()
  doc.openInEditor.mockClear()
  doc.activateDocument.mockClear()
  doc.closeDocument.mockClear()
  doc.syncDocumentWorkspace.mockClear()
  doc.dispatch.mockClear()
  controller.currentProject.value = { path: '/w' }
})

describe('DocumentReaderCard', () => {
  it('binds the workspace tab list on mount and names each tab', () => {
    doc.tabs = ref([{ path: 'docs/spec.md' }, { path: 'src/app.ts', line: 3 }])
    doc.active = ref('src/app.ts')
    const wrapper = render()

    expect(doc.syncDocumentWorkspace).toHaveBeenCalledWith('/w')
    const names = wrapper.findAll('.doc-card-tab-name').map((node) => node.text())
    expect(names).toEqual(['spec.md', 'app.ts'])
    const labels = wrapper.findAll('.doc-card-tab-label')
    expect(labels[0]!.attributes('aria-selected')).toBe('false')
    expect(labels[1]!.attributes('aria-selected')).toBe('true')
    wrapper.unmount()
  })

  it('offers the workspace documents as a shelf, with no file tree of its own', async () => {
    const wrapper = render()
    expect(wrapper.get('.shelf-stub').attributes('data-cwd')).toBe('/w')
    expect(wrapper.find('.doc-card-empty-title').exists()).toBe(false)
    expect(wrapper.find('.doc-tree').exists()).toBe(false)

    // A book on the shelf opens in the viewer itself.
    await wrapper.get('.shelf-stub').trigger('click')
    expect(doc.openDocument).toHaveBeenCalledWith({ path: 'docs/spec.md', cwd: '/w' })
    wrapper.unmount()
  })

  it('links to the editor card for files the shelf does not list', async () => {
    const wrapper = render()
    await wrapper.get('.doc-card-empty-link').trigger('click')

    expect(doc.dispatch).toHaveBeenCalledWith(expect.objectContaining({
      command: expect.objectContaining({ type: 'openCard', descriptorId: 'codeEditor', slotId: 'right' }),
    }))
    wrapper.unmount()
  })

  it('asks for a project when there is no workspace root', () => {
    controller.currentProject.value = null
    const wrapper = render()

    expect(wrapper.get('.doc-card-empty-hint').text()).toBe('No project is selected.')
    expect(wrapper.find('.shelf-stub').exists()).toBe(false)
    expect(wrapper.find('.doc-card-empty-link').exists()).toBe(false)
    wrapper.unmount()
  })

  it('hands the document on screen to the editor instead of turning into one', async () => {
    doc.tabs = ref([{ path: 'docs/spec.md', line: 12 }])
    doc.active = ref('docs/spec.md')
    const wrapper = render()

    await wrapper.get('.reader-stub').trigger('click')
    expect(doc.openInEditor).toHaveBeenCalledWith({ path: 'docs/spec.md', line: 12, cwd: '/w' })
    // The reader stays mounted: editing happens in the other card.
    expect(wrapper.find('.reader-stub').exists()).toBe(true)
    wrapper.unmount()
  })

  it('activates a tab from the strip and closes one from its own button', async () => {
    doc.tabs = ref([{ path: 'docs/spec.md' }, { path: 'src/app.ts' }])
    doc.active = ref('docs/spec.md')
    const wrapper = render()

    await wrapper.findAll('.doc-card-tab-label')[1]!.trigger('click')
    expect(doc.activateDocument).toHaveBeenCalledWith('src/app.ts')

    await wrapper.findAll('.doc-card-tab-close')[0]!.trigger('click')
    expect(doc.closeDocument).toHaveBeenCalledWith('docs/spec.md')
    // Closing a tab must not also activate the tab underneath it.
    expect(doc.activateDocument).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })
})
