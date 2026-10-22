// @vitest-environment happy-dom
import { defineComponent } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import zh from '@/locales/zh-CN'
import {
  CONVERSATION_FLOW_KEY,
  conversationFlowPreset,
  resetConversationFlowStyleForTests,
} from '@/lib/conversationFlowStyle'
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
  localStorage.clear()
  resetConversationFlowStyleForTests()
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

/**
 * The conversation-flow picker is a radio group of five transcript shapes. What a shape *does*
 * is the consumers' business (lib/grouping, SubAgentCard, TurnWork); this file only has to prove
 * the page shows the stored choice, writes a new one, and behaves like a radio group on the keys.
 */
describe('conversation flow', () => {
  function radios(wrapper: ReturnType<typeof create>) {
    return wrapper.findAll('[data-testid^="flow-style-"]')
  }

  it('lists all five shapes and marks the stored one', async () => {
    const wrapper = create()
    await flushPromises()
    const rows = radios(wrapper)
    expect(rows.map((row) => row.attributes('data-testid'))).toEqual([
      'flow-style-codex',
      'flow-style-claude',
      'flow-style-openchamber',
      'flow-style-trae',
      'flow-style-qoder',
    ])
    // The default shape is the one the flat feed was modelled on, and it is the only checked row.
    expect(rows.filter((row) => row.attributes('aria-checked') === 'true').map((row) => row.attributes('data-testid'))).toEqual(['flow-style-qoder'])
    // Every row shows a density word next to its name, so "which one is quiet" is readable.
    expect(wrapper.get('[data-testid="flow-style-codex"]').text()).toContain('简洁')
    expect(wrapper.get('[data-testid="flow-style-qoder"]').text()).toContain('丰富')
  })

  it('stores the picked shape instead of only restyling the page', async () => {
    const wrapper = create()
    await flushPromises()

    await wrapper.get('[data-testid="flow-style-openchamber"]').trigger('click')
    expect(localStorage.getItem(CONVERSATION_FLOW_KEY)).toBe('openchamber')
    expect(conversationFlowPreset.value).toBe('openchamber')
    expect(wrapper.get('[data-testid="flow-style-openchamber"]').attributes('aria-checked')).toBe('true')
    expect(wrapper.get('[data-testid="flow-style-qoder"]').attributes('aria-checked')).toBe('false')
  })

  it('moves the choice and the focus together on the arrow keys, as a radio group does', async () => {
    const wrapper = create()
    await flushPromises()

    const first = wrapper.get('[data-testid="flow-style-codex"]')
    await first.trigger('keydown', { key: 'ArrowDown' })
    expect(localStorage.getItem(CONVERSATION_FLOW_KEY)).toBe('claude')
    expect(wrapper.get('[data-testid="flow-style-claude"]').attributes('aria-checked')).toBe('true')

    // Wrapping: up from the second shape lands on the first, not on nothing.
    await wrapper.get('[data-testid="flow-style-claude"]').trigger('keydown', { key: 'ArrowUp' })
    expect(conversationFlowPreset.value).toBe('codex')

    // A key the group does not own must not steal the choice.
    await wrapper.get('[data-testid="flow-style-codex"]').trigger('keydown', { key: 'a' })
    expect(conversationFlowPreset.value).toBe('codex')
  })
})
