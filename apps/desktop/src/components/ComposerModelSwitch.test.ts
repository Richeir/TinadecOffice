// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import en from '@/locales/en'

const h = vi.hoisted(() => ({
  listModelProviders: vi.fn(),
  listModelRoutes: vi.fn(),
  saveModelRoute: vi.fn(async () => ({})),
}))
vi.mock('@/api', () => ({ api: h }))
vi.mock('vue-router', () => ({ useRouter: () => ({ currentRoute: { value: { name: 'home' } }, push: vi.fn() }) }))
vi.mock('@/composables/useNotifications', () => ({ useNotifications: () => ({ notify: { error: vi.fn() } }) }))
const { default: ComposerModelSwitch } = await import('./ComposerModelSwitch.vue')

describe('ComposerModelSwitch', () => {
  /**
   * The reported bug: a model set up in the model center was missing from the composer, which
   * listed provider models only. The switch lists the model center's own projection — here a
   * model named only on the chat route — and choosing one rewrites the chat route.
   */
  it('lists route-only models, shows the default, and switching it rewrites the chat route', async () => {
    h.listModelProviders.mockResolvedValue([{ id: 'p1', driver: 'openai', display_name: 'Provider', connection_kind: 'api-key', enabled: true, models: ['listed'], capabilities: ['chat'], status: 'ready', updated_at: '' }])
    h.listModelRoutes.mockResolvedValue([{ purpose: 'chat', revision: 3, updated_at: '', candidates: [{ provider_instance_id: 'p1', model: 'route-only', position: 0 }] }])
    const wrapper = mount(ComposerModelSwitch, { global: { plugins: [createI18n({ legacy: false, locale: 'en', messages: { en } })] } })
    await flushPromises()
    expect(wrapper.get('[data-testid="composer-model-switch"]').text()).toContain('route-only')
    await wrapper.get('[data-testid="composer-model-switch"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="composer-model-p1:route-only"]').attributes('aria-selected')).toBe('true')
    await wrapper.get('[data-testid="composer-model-p1:listed"]').trigger('click')
    await flushPromises()
    expect(h.saveModelRoute).toHaveBeenCalledWith('chat', { candidates: [{ provider_instance_id: 'p1', model: 'listed' }] }, undefined, { expected_revision: 3 })
  })
})
