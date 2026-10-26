// @vitest-environment happy-dom
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import zh from '@/locales/zh-CN'
import CompanionPage from './CompanionPage.vue'

/**
 * The window renders what the main process reports and sends gestures; it never flips `expanded`
 * itself. Every fake command therefore broadcasts the next snapshot back through `onStateChanged`
 * like the real main process does, and a page that mutated local state would still look right in
 * these tests only if the mirror agreed — which is what the broadcast-only fakes rule out.
 */

const CAPSULE_RIGHT: CompanionState = { open: true, expanded: false, side: 'right' }
const PANEL_RIGHT: CompanionState = { open: true, expanded: true, side: 'right' }
const PANEL_LEFT: CompanionState = { open: true, expanded: true, side: 'left' }

// Every page answers Escape on `window`; a wrapper left mounted keeps collapsing in later tests.
enableAutoUnmount(afterEach)

let state: CompanionState
let listener: ((next: CompanionState) => void) | undefined
let disposeState: ReturnType<typeof vi.fn>
let companion: {
  getState: ReturnType<typeof vi.fn>
  expand: ReturnType<typeof vi.fn>
  collapse: ReturnType<typeof vi.fn>
  moveTo: ReturnType<typeof vi.fn>
  setSide: ReturnType<typeof vi.fn>
  onStateChanged: ReturnType<typeof vi.fn>
}

function broadcast(patch: Partial<CompanionState>): CompanionState {
  state = { ...state, ...patch }
  listener?.({ ...state })
  return { ...state }
}

function create() {
  return mount(CompanionPage, {
    global: {
      plugins: [createI18n({ legacy: false, locale: 'zh-CN', messages: { 'zh-CN': zh } })],
    },
  })
}

function pointer(target: Element, type: string, init: { screenX: number; screenY: number }): void {
  target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, button: 0, ...init }))
}

function click(target: Element, detail: number): void {
  target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail }))
}

function pressEscape(): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
  window.dispatchEvent(event)
  return event
}

beforeEach(() => {
  state = { ...CAPSULE_RIGHT }
  listener = undefined
  disposeState = vi.fn(() => { listener = undefined })
  companion = {
    getState: vi.fn(async () => ({ ...state })),
    expand: vi.fn(async () => broadcast({ expanded: true })),
    collapse: vi.fn(async () => broadcast({ expanded: false })),
    moveTo: vi.fn(async () => ({ ...state })),
    setSide: vi.fn(async (side: 'left' | 'right') => broadcast({ side })),
    onStateChanged: vi.fn((callback: (next: CompanionState) => void) => {
      listener = callback
      return disposeState
    }),
  }
  vi.stubGlobal('tinadec', { companion })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('companion capsule', () => {
  it('renders the stored shape and expands on a mouse click', async () => {
    const wrapper = create()
    await flushPromises()

    const capsule = wrapper.get('.companion-capsule')
    expect(capsule.attributes('aria-label')).toBe(zh.companion.expand)
    expect(capsule.attributes('aria-expanded')).toBe('false')
    expect(wrapper.find('.companion-panel').exists()).toBe(false)
    expect(wrapper.classes()).toContain('companion--side-right')

    click(capsule.element, 1)
    await flushPromises()

    expect(companion.expand).toHaveBeenCalledTimes(1)
    expect(wrapper.find('.companion-capsule').exists()).toBe(false)
    expect(wrapper.get('[role="region"]').attributes('aria-label')).toBe(zh.companion.title)
  })

  it('reports a command failure instead of pretending the panel opened', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    companion.expand.mockRejectedValue(new Error('window unavailable'))
    const wrapper = create()
    await flushPromises()

    click(wrapper.get('.companion-capsule').element, 1)
    await flushPromises()

    expect(wrapper.find('.companion-panel').exists()).toBe(false)
    expect(warn).toHaveBeenCalledWith('[companion] expand failed:', expect.any(Error))
  })

  it('keeps a broadcast that lands while the initial read is still pending', async () => {
    let resolveInitial: ((next: CompanionState) => void) | undefined
    companion.getState.mockReturnValue(new Promise<CompanionState>((resolve) => { resolveInitial = resolve }))
    const wrapper = create()

    // The subscription is installed before the read, so the main process's later answer wins.
    broadcast({ expanded: true })
    await flushPromises()
    expect(wrapper.find('.companion-panel').exists()).toBe(true)

    resolveInitial?.({ ...CAPSULE_RIGHT })
    await flushPromises()
    expect(wrapper.find('.companion-panel').exists()).toBe(true)
  })
})

describe('panel controls', () => {
  it('collapses only through the main process, which reports the capsule back', async () => {
    state = { ...PANEL_RIGHT }
    const wrapper = create()
    await flushPromises()

    await wrapper.get(`[aria-label="${zh.companion.collapse}"]`).trigger('click')
    await flushPromises()

    expect(companion.collapse).toHaveBeenCalledTimes(1)
    expect(wrapper.find('.companion-panel').exists()).toBe(false)
    expect(wrapper.find('.companion-capsule').exists()).toBe(true)
  })

  it('offers the opposite edge and follows the new side', async () => {
    state = { ...PANEL_RIGHT }
    const wrapper = create()
    await flushPromises()

    await wrapper.get(`[aria-label="${zh.companion.dockLeft}"]`).trigger('click')
    await flushPromises()
    expect(companion.setSide).toHaveBeenCalledWith('left')
    expect(wrapper.classes()).toContain('companion--side-left')
    expect(wrapper.find(`[aria-label="${zh.companion.dockRight}"]`).exists()).toBe(true)

    await wrapper.get(`[aria-label="${zh.companion.dockRight}"]`).trigger('click')
    await flushPromises()
    expect(companion.setSide).toHaveBeenLastCalledWith('right')
    expect(wrapper.classes()).toContain('companion--side-right')
  })

  it('collapses on Escape only while the panel is open', async () => {
    const wrapper = create()
    await flushPromises()

    const collapsed = pressEscape()
    await flushPromises()
    expect(companion.collapse).not.toHaveBeenCalled()
    expect(collapsed.defaultPrevented).toBe(false)

    broadcast({ expanded: true })
    await flushPromises()
    const expanded = pressEscape()
    await flushPromises()
    expect(companion.collapse).toHaveBeenCalledTimes(1)
    expect(expanded.defaultPrevented).toBe(true)
  })
})

describe('capsule gestures', () => {
  it('expands when a right-docked capsule is dragged inward far enough', async () => {
    const wrapper = create()
    await flushPromises()
    const capsule = wrapper.get('.companion-capsule').element

    pointer(capsule, 'pointerdown', { screenX: 900, screenY: 300 })
    pointer(capsule, 'pointermove', { screenX: 880, screenY: 300 })
    pointer(capsule, 'pointerup', { screenX: 870, screenY: 300 })
    await flushPromises()

    expect(companion.expand).toHaveBeenCalledTimes(1)
    expect(wrapper.find('.companion-panel').exists()).toBe(true)
  })

  it('expands inward on a left-docked capsule too', async () => {
    state = { ...CAPSULE_RIGHT, side: 'left' }
    const wrapper = create()
    await flushPromises()
    const capsule = wrapper.get('.companion-capsule').element

    pointer(capsule, 'pointerdown', { screenX: 200, screenY: 400 })
    pointer(capsule, 'pointermove', { screenX: 215, screenY: 400 })
    pointer(capsule, 'pointerup', { screenX: 230, screenY: 400 })
    await flushPromises()

    expect(companion.expand).toHaveBeenCalledTimes(1)
  })

  it('does not expand on a short drag and suppresses the click that follows it', async () => {
    const wrapper = create()
    await flushPromises()
    const capsule = wrapper.get('.companion-capsule').element

    pointer(capsule, 'pointerdown', { screenX: 900, screenY: 300 })
    pointer(capsule, 'pointermove', { screenX: 890, screenY: 300 })
    pointer(capsule, 'pointerup', { screenX: 885, screenY: 300 })
    await flushPromises()
    expect(companion.expand).not.toHaveBeenCalled()

    // A drag ends on the button and therefore still produces a click; that click is not a request.
    click(capsule, 1)
    await flushPromises()
    expect(companion.expand).not.toHaveBeenCalled()

    // Keyboard activation reports detail 0 and must always open, even inside the suppression window.
    click(capsule, 0)
    await flushPromises()
    expect(companion.expand).toHaveBeenCalledTimes(1)
  })

  it('drags the window vertically without expanding it', async () => {
    const wrapper = create()
    await flushPromises()
    const capsule = wrapper.get('.companion-capsule').element

    pointer(capsule, 'pointerdown', { screenX: 900, screenY: 300 })
    await flushPromises()
    expect(wrapper.classes()).toContain('companion--dragging')

    pointer(capsule, 'pointermove', { screenX: 901, screenY: 340 })
    pointer(capsule, 'pointerup', { screenX: 901, screenY: 340 })
    await flushPromises()

    // happy-dom reports window.screenY as 0, so the target top is the gesture delta itself.
    expect(companion.moveTo).toHaveBeenCalledWith(40)
    expect(companion.expand).not.toHaveBeenCalled()
    expect(wrapper.classes()).not.toContain('companion--dragging')
  })
})

describe('panel drag and teardown', () => {
  it('moves the panel by the vertical drag delta', async () => {
    state = { ...PANEL_LEFT }
    const wrapper = create()
    await flushPromises()
    const panel = wrapper.get('.companion-panel').element

    pointer(panel, 'pointerdown', { screenX: 100, screenY: 200 })
    pointer(panel, 'pointermove', { screenX: 140, screenY: 260 })
    pointer(panel, 'pointerup', { screenX: 140, screenY: 260 })
    await flushPromises()

    expect(companion.moveTo).toHaveBeenCalledWith(60)
    expect(companion.setSide).not.toHaveBeenCalled()
  })

  it('drops the state listener and the Escape binding on unmount', async () => {
    state = { ...PANEL_RIGHT }
    const wrapper = create()
    await flushPromises()

    wrapper.unmount()
    expect(disposeState).toHaveBeenCalledTimes(1)

    const event = pressEscape()
    await flushPromises()
    expect(companion.collapse).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
  })
})
