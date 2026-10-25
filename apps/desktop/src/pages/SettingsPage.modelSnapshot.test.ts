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
 * The model center's shipping path is the cold-start snapshot: one request answers seven
 * projections, and each partition degrades alone. The other page suites stub `get*` to `{}`,
 * which the snapshot guard rejects, so they only ever exercise the per-endpoint fallback —
 * without this file the real path is never run.
 */
const mocks = vi.hoisted(() => ({
  snapshot: vi.fn(),
  providers: vi.fn(),
  routes: vi.fn(),
  statusError: vi.fn(),
}))

vi.mock('@/api', () => ({ api: new Proxy({}, { get(_target, key) {
  if (key === 'getModelCenterSnapshot') return mocks.snapshot
  if (key === 'listModelProviders') return mocks.providers
  if (key === 'listModelRoutes') return mocks.routes
  if (key === 'getModelReadiness' || key === 'getModelCatalogReadiness') return vi.fn(async () => null)
  if (typeof key === 'string' && key.startsWith('list')) return vi.fn(async () => [])
  return vi.fn(async () => ({}))
} }) }))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn(), back: vi.fn() }), useRoute: () => ({ query: {}, params: {} }), onBeforeRouteLeave: vi.fn() }))
// Vapor primitives need the browser's single ESM runtime; keep these display-only
// primitives out of VTU's CJS runtime.
vi.mock('@/components/ui', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>()
  const { defineComponent, h } = await import('vue')
  const display = defineComponent({ setup: (_, { slots }) => () => h('span', null, slots.default?.()) })
  return { ...actual, UiBadge: display, UiLabel: display, UiSkeleton: display }
})
vi.mock('@/composables/useNotifications', () => ({ useNotifications: () => ({
  notify: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
  status: { error: mocks.statusError },
  dismissByKey: vi.fn(), confirm: vi.fn(async () => true),
}) }))

const provider = {
  id: 'p1', driver: 'openai', protocol: 'openai-responses', display_name: 'Snapshot Provider',
  connection_kind: 'api-key', base_url: 'https://example.test/v1', model: 'model-one',
  models: ['model-one'], has_api_key: true, enabled: true, capabilities: ['chat'],
  status: 'ready', status_message: '', revision: 7, created_at: '', updated_at: '',
  model_parameters: {},
}

function snapshotWith(overrides: Record<string, unknown> = {}) {
  return {
    parts: {
      providers: { ok: true, status: 200, data: [provider] },
      templates: { ok: true, status: 200, data: [] },
      routes: { ok: true, status: 200, data: [] },
      acp_adapters: { ok: true, status: 200, data: [] },
      model_readiness: { ok: true, status: 200, data: null },
      catalog_readiness: { ok: true, status: 200, data: null },
      readiness: { ok: true, status: 200, data: null },
      ...overrides,
    },
  }
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.snapshot.mockResolvedValue(snapshotWith())
  mocks.providers.mockResolvedValue([])
  mocks.routes.mockResolvedValue([])
  const storage = new Map<string, string>()
  Object.defineProperty(window, 'localStorage', { configurable: true, value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
    clear: () => storage.clear(),
  } })
  Object.defineProperty(window, 'tinadec', { configurable: true, value: { gatewayUrl: () => 'http://127.0.0.1:48730', getAppConfig: vi.fn(async () => ({})) } })
  setHostAccessStatus({ state: 'ready', managed: true })
})

async function openModels() {
  const transition = defineComponent({ inheritAttrs: false, setup: (_, { slots }) => () => h(Fragment, null, slots.default?.()) })
  const wrapper = mount(SettingsPage, { global: {
    plugins: [vaporInteropPlugin, createPinia(), createI18n({ legacy: false, locale: 'en', messages: { en } })],
    stubs: { PersonalSection: true, Transition: transition, transition, Teleport: true },
  } })
  await flushPromises()
  await wrapper.findAll('.settings-nav-item').find(button => button.attributes('aria-label') === en.settings.model)!.trigger('click')
  await flushPromises()
  await wrapper.findAll('.model-center-tabs button').find(button => button.text().includes(en.settings.centerModels))!.trigger('click')
  await flushPromises()
  return wrapper
}

describe('settings model center cold-start snapshot', () => {
  it('answers the whole center from the snapshot without reading the endpoints', async () => {
    const wrapper = await openModels()
    expect(mocks.snapshot).toHaveBeenCalled()
    // The point of the snapshot: the projections it already carries are not re-requested.
    expect(mocks.providers).not.toHaveBeenCalled()
    expect(mocks.routes).not.toHaveBeenCalled()
    // The provider row and its model came from the snapshot's providers partition.
    expect(wrapper.get('.model-provider-group-head').text()).toContain('Snapshot Provider')
    expect(wrapper.get('.model-group-model').text()).toContain('model-one')
    wrapper.unmount()
  })

  // A degraded partition is not a failed screen: the sections that answered must stay
  // readable, and the page must not claim the whole center failed to load.
  it('degrades one partition alone and keeps the rest readable', async () => {
    mocks.snapshot.mockResolvedValue(snapshotWith({
      templates: { ok: false, status: 500, error: { code: 'core_unreachable', message: 'nope' } },
    }))
    const wrapper = await openModels()
    expect(wrapper.get('.model-provider-group-head').text()).toContain('Snapshot Provider')
    expect(wrapper.text()).toContain(en.settings.centerPartialLoadFailed)
    expect(wrapper.text()).toContain('model-provider-templates')
    expect(wrapper.find('[data-testid="model-center-read-failure"]').exists()).toBe(false)
    // A degraded section is still a failure the user can act on.
    expect(mocks.statusError).toHaveBeenCalled()
    wrapper.unmount()
  })
})
