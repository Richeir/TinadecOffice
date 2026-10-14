// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { defineComponent } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import en from '@/locales/en'
import type { ModelProviderInstanceDto } from '@/api'

const h = vi.hoisted(() => ({ providers: [] as ModelProviderInstanceDto[], save: vi.fn(), error: vi.fn() }))
vi.mock('@/api', () => ({
  api: {
    listModelProviders: async () => h.providers,
    listModelRoutes: async () => [{ purpose: 'chat', revision: 3, candidates: [{ provider_instance_id: 'p1', model: 'gpt-5' }] }],
    saveModelProvider: h.save,
  },
}))
vi.mock('@/composables/useNotifications', () => ({ useNotifications: () => ({ notify: { error: h.error } }) }))
const { useDefaultModel } = await import('./useDefaultModel')
const { default: ReasoningEffortSlider } = await import('@/components/ReasoningEffortSlider.vue')

const provider = (protocol: string): ModelProviderInstanceDto => ({
  id: 'p1', driver: 'openai', protocol, display_name: 'P', connection_kind: 'api-key', has_api_key: true, enabled: true,
  capabilities: ['chat'], status: 'ready', status_message: '', revision: 9, created_at: '', updated_at: '',
  model_parameters: { 'gpt-5': { reasoning_effort: 'low', max_output_tokens: 4096 }, other: { temperature: 0.3 } },
})

/** The composer's wiring in miniature: the slider commits into the default model. */
const Host = defineComponent({
  components: { ReasoningEffortSlider },
  setup() { const model = useDefaultModel(); void model.load(); return { model } },
  template: `<ReasoningEffortSlider v-if="model.reasoningSupported.value" :model-value="model.reasoningEffort.value" @commit="model.setReasoningEffort($event)" />`,
})
const mountHost = () => mount(Host, { global: { plugins: [createI18n({ legacy: false, locale: 'en', messages: { en } })] } })

describe('default model reasoning effort', () => {
  it('saves the chosen effort on the default model, against its revision, keeping every other parameter', async () => {
    h.providers = [provider('openai-chat')]
    h.save.mockResolvedValue(h.providers[0])
    const wrapper = mountHost()
    await flushPromises()
    const slider = wrapper.get('[data-testid="reasoning-slider"]')
    expect((slider.element as HTMLInputElement).value).toBe('2')
    ;(slider.element as HTMLInputElement).value = '4'
    await slider.trigger('change')
    await flushPromises()
    expect(h.save).toHaveBeenCalledOnce()
    expect(h.save).toHaveBeenCalledWith('p1', expect.objectContaining({
      model_parameters: { 'gpt-5': { reasoning_effort: 'high', max_output_tokens: 4096 }, other: { temperature: 0.3 } },
    }), { expected_revision: 9 })
    wrapper.unmount()
  })

  it('offers no effort where the provider protocol has none', async () => {
    h.providers = [provider('anthropic-messages')]
    const wrapper = mountHost()
    await flushPromises()
    expect(wrapper.find('[data-testid="reasoning-slider"]').exists()).toBe(false)
    wrapper.unmount()
  })
})
