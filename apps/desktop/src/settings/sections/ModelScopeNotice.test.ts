// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import en from '@/locales/en'
import { setSelectedStorage } from '@/lib/storageScope'

const h = vi.hoisted(() => ({
  docs: {} as Record<string, { text: string; content_hash: string }>,
  listStorageScopes: vi.fn(),
  getConfigurationDocument: vi.fn(),
  validateConfigurationDocument: vi.fn(),
  saveConfigurationDocument: vi.fn(),
  confirm: vi.fn(async () => true),
  success: vi.fn(),
  error: vi.fn(),
}))
vi.mock('@/api', () => ({
  api: {
    listStorageScopes: h.listStorageScopes,
    getConfigurationDocument: h.getConfigurationDocument,
    validateConfigurationDocument: h.validateConfigurationDocument,
    saveConfigurationDocument: h.saveConfigurationDocument,
  },
}))
vi.mock('@/composables/useNotifications', () => ({
  useNotifications: () => ({ confirm: h.confirm, notify: { success: h.success, error: h.error } }),
}))
const { default: ModelScopeNotice } = await import('./ModelScopeNotice.vue')

const i18n = createI18n({ legacy: false, locale: 'en', messages: { en } })
const mountNotice = () => mount(ModelScopeNotice, { global: { plugins: [i18n] } })

beforeEach(() => {
  h.docs = { user: { text: 'user models', content_hash: 'u1' }, 'ws-1': { text: 'workspace copy', content_hash: 'w1' } }
  h.listStorageScopes.mockResolvedValue([{ storage_id: 'ws-1', scope_kind: 'project', project_root: '/home/me/demo', workspace: { name: 'Demo' } }])
  h.getConfigurationDocument.mockImplementation(async (storageId: string) => ({ document_id: 'models', ...h.docs[storageId] }))
  h.validateConfigurationDocument.mockResolvedValue({ valid: true, diagnostics: [] })
  h.saveConfigurationDocument.mockImplementation(async (storageId: string, _id: string, text: string) => {
    h.docs[storageId] = { text, content_hash: h.docs.user.content_hash }
    return { document_id: 'models', ...h.docs[storageId] }
  })
  h.confirm.mockResolvedValue(true)
})
afterEach(() => {
  setSelectedStorage('user')
  vi.clearAllMocks()
})

describe('ModelScopeNotice', () => {
  it('says nothing in the user scope, which the model center edits directly', async () => {
    setSelectedStorage('user')
    const wrapper = mountNotice()
    await flushPromises()
    expect(wrapper.find('[data-testid="model-scope-notice"]').exists()).toBe(false)
    expect(h.getConfigurationDocument).not.toHaveBeenCalled()
  })

  it('names the workspace copy its conversations use and whether it still matches', async () => {
    setSelectedStorage('ws-1')
    const wrapper = mountNotice()
    await flushPromises()
    expect(wrapper.get('[data-testid="model-scope-notice"]').text()).toContain('“Demo”')
    expect(wrapper.find('[data-testid="model-scope-differs"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="model-scope-sync"]').exists()).toBe(true)

    h.docs['ws-1'] = { ...h.docs.user }
    await (wrapper.vm as unknown as { inspect: () => Promise<void> }).inspect()
    await flushPromises()
    expect(wrapper.find('[data-testid="model-scope-same"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="model-scope-sync"]').exists()).toBe(false)
  })

  it('replaces the workspace copy only after confirmation, naming the bytes it replaces', async () => {
    setSelectedStorage('ws-1')
    const wrapper = mountNotice()
    await flushPromises()
    await wrapper.get('[data-testid="model-scope-sync"]').trigger('click')
    await flushPromises()
    expect(h.confirm).toHaveBeenCalledWith(expect.objectContaining({ destructive: true }))
    expect(h.validateConfigurationDocument).toHaveBeenCalledWith('ws-1', 'models', 'user models')
    expect(h.saveConfigurationDocument).toHaveBeenCalledWith('ws-1', 'models', 'user models', 'w1')
    expect(h.success).toHaveBeenCalled()
    expect(wrapper.find('[data-testid="model-scope-same"]').exists()).toBe(true)
  })

  it.each([
    ['cancelled', () => h.confirm.mockResolvedValue(false)],
    ['invalid there', () => h.validateConfigurationDocument.mockResolvedValue({ valid: false, diagnostics: [{}] })],
  ])('writes nothing when %s', async (_case, arrange) => {
    arrange()
    setSelectedStorage('ws-1')
    const wrapper = mountNotice()
    await flushPromises()
    await wrapper.get('[data-testid="model-scope-sync"]').trigger('click')
    await flushPromises()
    expect(h.saveConfigurationDocument).not.toHaveBeenCalled()
    expect(h.success).not.toHaveBeenCalled()
  })

  it('gives no verdict when either copy cannot be read', async () => {
    h.getConfigurationDocument.mockRejectedValue(new Error('offline'))
    setSelectedStorage('ws-1')
    const wrapper = mountNotice()
    await flushPromises()
    expect(wrapper.find('[data-testid="model-scope-same"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="model-scope-differs"]').exists()).toBe(false)
  })
})
