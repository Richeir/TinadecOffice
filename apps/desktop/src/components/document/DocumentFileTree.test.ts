// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import DocumentFileTree from './DocumentFileTree.vue'

const filesMock = vi.hoisted(() => ({
  listWorkspaceDir: vi.fn(),
  invalidateWorkspace: vi.fn(),
}))

vi.mock('@/lib/workspaceFiles', () => ({
  listWorkspaceDir: filesMock.listWorkspaceDir,
  invalidateWorkspace: filesMock.invalidateWorkspace,
  shouldSkipDirName: (name: string) => ['node_modules', '.git', 'release'].includes(name),
}))

function entry(name: string, isDir: boolean) {
  return { name, isDir, size: null, modifiedAt: null }
}

function render(props: Record<string, unknown> = {}) {
  return mount(DocumentFileTree, {
    props: { cwd: '/w', ...props } as never,
    global: {
      plugins: [createI18n({
        legacy: false,
        locale: 'en',
        messages: { en: { documents: { tree: 'Files', reload: 'Reload', treeFailed: 'The folder could not be loaded', treeEmpty: 'This folder is empty' } } },
      })],
    },
  })
}

beforeEach(() => {
  filesMock.listWorkspaceDir.mockReset()
  filesMock.invalidateWorkspace.mockReset()
})

describe('DocumentFileTree', () => {
  it('lists the root with folders first and hides heavy or dot folders', async () => {
    filesMock.listWorkspaceDir.mockResolvedValue([
      entry('README.md', false),
      entry('src', true),
      entry('node_modules', true),
      entry('.git', true),
      entry('zeta.txt', false),
    ])
    const wrapper = render()
    await flushPromises()

    const names = wrapper.findAll('.doc-tree-name').map((node) => node.text())
    expect(names).toEqual(['src', 'README.md', 'zeta.txt'])
    expect(filesMock.listWorkspaceDir).toHaveBeenCalledWith('/w', '')
    wrapper.unmount()
  })

  it('loads a folder only when it is expanded', async () => {
    filesMock.listWorkspaceDir.mockImplementation(async (_cwd: string, dir: string) => (
      dir === '' ? [entry('src', true)] : [entry('app.ts', false), entry('nested', true)]
    ))
    const wrapper = render()
    await flushPromises()
    expect(filesMock.listWorkspaceDir).toHaveBeenCalledTimes(1)

    await wrapper.get('.doc-tree-row').trigger('click')
    await flushPromises()

    expect(filesMock.listWorkspaceDir).toHaveBeenCalledWith('/w', 'src')
    // Children sort folders first, so the expanded folder shows `nested` above `app.ts`.
    const names = wrapper.findAll('.doc-tree-name').map((node) => node.text())
    expect(names).toEqual(['src', 'nested', 'app.ts'])
    expect(wrapper.get('.doc-tree-row').attributes('aria-expanded')).toBe('true')
    wrapper.unmount()
  })

  it('emits the workspace path of a clicked file', async () => {
    filesMock.listWorkspaceDir.mockImplementation(async (_cwd: string, dir: string) => (
      dir === '' ? [entry('docs', true)] : [entry('spec.md', false)]
    ))
    const wrapper = render()
    await flushPromises()

    await wrapper.get('.doc-tree-row').trigger('click')
    await flushPromises()
    const rows = wrapper.findAll('.doc-tree-row')
    expect(rows.map((row) => row.get('.doc-tree-name').text())).toEqual(['docs', 'spec.md'])

    await rows[1]!.trigger('click')
    expect(wrapper.emitted('select')?.at(-1)).toEqual(['docs/spec.md'])
    wrapper.unmount()
  })

  it('says the folder could not be read instead of showing it empty', async () => {
    filesMock.listWorkspaceDir.mockResolvedValue(null)
    const wrapper = render()
    await flushPromises()
    expect(wrapper.text()).toContain('The folder could not be loaded')
    wrapper.unmount()
  })
})
