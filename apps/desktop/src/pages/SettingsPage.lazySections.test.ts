// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { defineComponent, h, Fragment, vaporInteropPlugin } from 'vue'
import en from '@/locales/en'
import SettingsPage from './SettingsPage.vue'
import { setHostAccessStatus } from '@/lib/hostAccess'

/**
 * Opening settings used to issue sixteen reads for two sections the user had not opened —
 * the personal section was on screen while the model center, the agent center and their
 * auxiliary catalogs were all fetched on mount. The reads are now lazy: entering a section
 * is what asks for its data. Measured as request names, so this does not depend on how fast
 * the machine running the test happens to be.
 */
const mocks = vi.hoisted(() => {
  const calls = { model: [] as string[], agent: [] as string[] }
  return { calls }
})

const MODEL_READS = ['getModelCenterSnapshot', 'listModelProviders', 'listModelRoutes', 'getModelReadiness']
const AGENT_READS = ['listAgents', 'listAgentModes', 'listAgentCandidates', 'getToolLayerReadiness', 'getAgentPack']

vi.mock('@/api', () => ({
  api: new Proxy({}, {
    get(_target, key) {
      if (typeof key !== 'string') return undefined
      return vi.fn(async () => {
        if (MODEL_READS.includes(key)) mocks.calls.model.push(key)
        if (AGENT_READS.includes(key)) mocks.calls.agent.push(key)
        return key.startsWith('list') ? [] : {}
      })
    },
  }),
  scopedApi: (base: unknown) => base,
}))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn(), back: vi.fn() }), useRoute: () => ({ query: {}, params: {} }), onBeforeRouteLeave: vi.fn() }))
// Vapor primitives need the browser's single ESM runtime; rendering the real barrel inside
// VTU's CJS runtime crashes on section switch ("Cannot read properties of null (reading
// 'emitsOptions')"). These are display-only for this test, so they render as spans.
vi.mock('@/components/ui', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>()
  const { defineComponent, h } = await import('vue')
  const display = defineComponent({ setup: (_, { slots }) => () => h('span', null, slots.default?.()) })
  return { ...actual, UiBadge: display, UiLabel: display, UiSkeleton: display }
})
vi.mock('@/composables/useNotifications', () => ({ useNotifications: () => ({
  notify: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
  status: { error: vi.fn() }, banner: null, confirm: vi.fn(async () => true),
  dismissByKey: vi.fn(), dismiss: vi.fn(), items: [],
}) }))

beforeEach(() => {
  mocks.calls.model.length = 0
  mocks.calls.agent.length = 0
  setHostAccessStatus({ state: 'ready', managed: true })
  const storage = new Map<string, string>()
  Object.defineProperty(window, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
    clear: () => storage.clear(),
  } })
  Object.defineProperty(window, 'tinadec', { configurable: true, value: { gatewayUrl: () => 'http://127.0.0.1:48730', getAppConfig: vi.fn(async () => ({})) } })
})

async function mountSettings() {
  const transition = defineComponent({ inheritAttrs: false, setup(_, { slots }) { return () => h(Fragment, null, slots.default?.()) } })
  const wrapper = mount(SettingsPage, { global: {
    plugins: [vaporInteropPlugin, createPinia(), createI18n({ legacy: false, locale: 'en', messages: { en } })],
    stubs: { PersonalSection: true, Transition: transition, transition, Teleport: true },
  } })
  await flushPromises()
  return wrapper
}

describe('settings opens without reading the sections nobody asked for', () => {
  it('reads neither center while the personal section is on screen', async () => {
    const wrapper = await mountSettings()
    expect(mocks.calls.model).toEqual([])
    expect(mocks.calls.agent).toEqual([])
    wrapper.unmount()
  })

  it('reads only the model center when the user enters it', async () => {
    const wrapper = await mountSettings()
    await wrapper.findAll('.settings-nav-item').find(button => button.attributes('aria-label') === en.settings.model)!.trigger('click')
    await flushPromises()
    expect(mocks.calls.model.length).toBeGreaterThan(0)
    // Entering one section must not wake the other.
    expect(mocks.calls.agent).toEqual([])
    wrapper.unmount()
  })

  it('reads the agent center on entry and does not re-read it on a second visit', async () => {
    const wrapper = await mountSettings()
    const agentNav = () => wrapper.findAll('.settings-nav-item').find(button => button.attributes('aria-label') === en.settings.agentCenter)!
    await agentNav().trigger('click')
    await flushPromises()
    const first = mocks.calls.agent.length
    expect(first).toBeGreaterThan(0)
    // Leave and come back: the section already has its data.
    await wrapper.findAll('.settings-nav-item').find(button => button.attributes('aria-label') === en.settings.model)!.trigger('click')
    await flushPromises()
    await agentNav().trigger('click')
    await flushPromises()
    expect(mocks.calls.agent.length).toBe(first)
    wrapper.unmount()
  })
})
