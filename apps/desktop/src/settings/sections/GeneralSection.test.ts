// @vitest-environment happy-dom
import { defineComponent } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import zh from '@/locales/zh-CN'
import GeneralSection from './GeneralSection.vue'

/**
 * The window/tray switch is one of two views of `window.close_to_tray` — the tray checkbox is the
 * other. These cases cover the renderer half: it reads the stored value, writes through IPC, and
 * follows a change made from the tray while the page is open.
 */

const notifications = vi.hoisted(() => ({
  items: { value: [] as Array<{ id: string; key?: string }> },
  notify: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
  banner: { warning: vi.fn() },
  status: { error: vi.fn() },
}))
vi.mock('@/composables/useNotifications', () => ({
  useNotifications: () => ({
    items: notifications.items,
    notify: notifications.notify,
    banner: notifications.banner,
    status: notifications.status,
    confirm: vi.fn(),
    dismiss: vi.fn(),
    dismissByKey: vi.fn(),
  }),
}))
vi.mock('@/api', () => ({ api: { gatewayUrl: 'http://127.0.0.1:48730' } }))
vi.mock('@/lib/storageScope', () => ({ scopedApi: (api: unknown) => api }))
vi.mock('@/i18n', () => ({ SUPPORTED_LOCALES: ['zh-CN'], setInterfaceLocale: vi.fn(async () => true) }))
// UI primitives use Vapor; their own tests cover rendering. This fixture exercises settings state.
vi.mock('@/components/ui', () => ({
  UiBadge: { template: '<span><slot /></span>' },
  UiButton: { template: '<button v-bind="$attrs"><slot /></button>' },
  UiInput: defineComponent({ props: ['modelValue'], emits: ['update:modelValue'], template: '<input :value="modelValue" />' }),
  UiLabel: { template: '<label><slot /></label>' },
  UiSelectField: { props: ['value'], template: '<span class="ui-select" />' },
  UiSwitch: {
    props: ['modelValue', 'disabled'],
    emits: ['update:modelValue'],
    template: '<button type="button" role="switch" :aria-checked="String(!!modelValue)" :disabled="disabled" @click="$emit(\'update:modelValue\', !modelValue)" />',
  },
}))

let trayListener: ((value: { close_to_tray: boolean }) => void) | undefined
const bridge = {
  getAppConfig: vi.fn(),
  saveCloseToTray: vi.fn(),
  onCloseToTrayChanged: vi.fn((callback: (value: { close_to_tray: boolean }) => void) => {
    trayListener = callback
    return () => { trayListener = undefined }
  }),
}

function create() {
  return mount(GeneralSection, {
    global: {
      plugins: [createI18n({ legacy: false, locale: 'zh-CN', messages: { 'zh-CN': zh } })],
    },
  })
}

function switchState(wrapper: ReturnType<typeof create>): string | undefined {
  return wrapper.get('[data-testid="close-to-tray-switch"]').attributes('aria-checked')
}

beforeEach(() => {
  vi.clearAllMocks()
  trayListener = undefined
  bridge.getAppConfig.mockResolvedValue({ gateway_url: 'http://127.0.0.1:48730', source: 'default', managed: false, close_to_tray: false })
  bridge.saveCloseToTray.mockImplementation(async (enabled: boolean) => ({ close_to_tray: enabled }))
  vi.stubGlobal('tinadec', bridge)
})

describe('window and tray settings', () => {
  it('shows the stored preference instead of a local default', async () => {
    bridge.getAppConfig.mockResolvedValue({ gateway_url: 'http://127.0.0.1:48730', source: 'default', managed: false, close_to_tray: true })
    const wrapper = create()
    await flushPromises()
    expect(switchState(wrapper)).toBe('true')
  })

  it('writes the preference through IPC and keeps the stored answer', async () => {
    const wrapper = create()
    await flushPromises()
    expect(switchState(wrapper)).toBe('false')

    await wrapper.get('[data-testid="close-to-tray-switch"]').trigger('click')
    await flushPromises()
    expect(bridge.saveCloseToTray).toHaveBeenCalledWith(true)
    expect(switchState(wrapper)).toBe('true')
  })

  it('rolls back and reports when the write fails', async () => {
    bridge.saveCloseToTray.mockRejectedValue(new Error('disk full'))
    const wrapper = create()
    await flushPromises()

    await wrapper.get('[data-testid="close-to-tray-switch"]').trigger('click')
    await flushPromises()
    expect(switchState(wrapper)).toBe('false')
    expect(notifications.notify.error).toHaveBeenCalledTimes(1)
  })

  it('follows a change made from the tray menu while the page is open', async () => {
    const wrapper = create()
    await flushPromises()

    trayListener?.({ close_to_tray: true })
    await flushPromises()
    expect(switchState(wrapper)).toBe('true')

    wrapper.unmount()
    // Unmounting must drop the IPC listener so a hidden window does not keep a stale closure alive.
    expect(bridge.onCloseToTrayChanged).toHaveBeenCalledTimes(1)
    expect(trayListener).toBeUndefined()
  })
})
