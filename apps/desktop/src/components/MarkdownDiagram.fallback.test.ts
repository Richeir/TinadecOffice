// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { nextTick } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import mermaid from 'mermaid'
import MarkdownDiagram, { DIAGRAM_FALLBACK_DELAY_MS } from './MarkdownDiagram.vue'

// Pele rejects zenuml (its detector has no such type), so the fallback paths are
// exercised against the real primary engine. Only mermaid is mocked: it is the behaviour
// under test here, and the real bundle needs a full browser.
vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    parse: vi.fn(async () => true),
    render: vi.fn(async () => ({ svg: '<svg data-testid="diagram" style="max-width: 400px;"></svg>' })),
  },
}))

const diagram = vi.mocked(mermaid)
const UNSUPPORTED = 'zenuml\n  A.method()'
const THEME_SETTLE_MS = 250

function render(code: string) {
  return mount(MarkdownDiagram, {
    props: { code },
    attachTo: document.body,
    global: { plugins: [createI18n({
      legacy: false, locale: 'en',
      messages: { en: { chat: { markdownDiagram: 'Diagram', markdownDiagramError: 'Diagram failed' } } },
    })] },
  })
}

/** Let dynamic imports and Vue flush without advancing the fallback clock. */
async function settle() {
  for (let i = 0; i < 3; i += 1) {
    await vi.dynamicImportSettled()
    await vi.advanceTimersByTimeAsync(0)
    await nextTick()
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  diagram.initialize.mockReset()
  diagram.parse.mockReset().mockResolvedValue(true as never)
  diagram.render.mockReset().mockResolvedValue({
    svg: '<svg data-testid="diagram" style="max-width: 400px;"></svg>',
  } as never)
})

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
  document.documentElement.removeAttribute('data-theme')
})

describe('mermaid fallback', () => {
  it('waits for the source to stay unchanged before loading mermaid', async () => {
    const wrapper = render(UNSUPPORTED)
    await settle()

    expect(wrapper.find('.markdown-diagram-svg').exists()).toBe(false)
    expect(wrapper.find('.markdown-diagram-note').exists()).toBe(false)
    expect(diagram.render).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(DIAGRAM_FALLBACK_DELAY_MS - 1)
    expect(diagram.render).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    await settle()
    expect(diagram.render).toHaveBeenCalledTimes(1)
    expect(wrapper.get('.markdown-diagram-svg').attributes('data-engine')).toBe('mermaid')
    expect(wrapper.find('.markdown-diagram-note').exists()).toBe(false)
    wrapper.unmount()
  })

  it('cancels a pending fallback when the source keeps streaming', async () => {
    const streamed = `${UNSUPPORTED}\n  B.method()`
    const wrapper = render(UNSUPPORTED)
    await settle()

    await vi.advanceTimersByTimeAsync(500)
    await wrapper.setProps({ code: streamed })
    await vi.advanceTimersByTimeAsync(THEME_SETTLE_MS)
    await settle()

    // The first timer would have fired at 1000 ms; the change moved it to 1750 ms.
    await vi.advanceTimersByTimeAsync(249)
    expect(diagram.render).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(diagram.render).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(750)
    await settle()

    expect(diagram.render).toHaveBeenCalledTimes(1)
    expect(diagram.render.mock.calls[0]?.[1]).toBe(streamed)
    wrapper.unmount()
  })

  it('cancels the fallback on unmount', async () => {
    const wrapper = render(UNSUPPORTED)
    await settle()
    wrapper.unmount()
    await vi.advanceTimersByTimeAsync(5000)
    await settle()
    expect(diagram.render).not.toHaveBeenCalled()
  })

  it('shows the source and the note when both engines fail', async () => {
    diagram.parse.mockResolvedValueOnce(false as never)
    const wrapper = render(UNSUPPORTED)
    await settle()
    await vi.advanceTimersByTimeAsync(DIAGRAM_FALLBACK_DELAY_MS)
    await settle()

    expect(wrapper.find('.markdown-diagram-svg').exists()).toBe(false)
    expect(wrapper.get('.markdown-diagram-fallback code').text()).toBe(UNSUPPORTED)
    expect(wrapper.get('.markdown-diagram-note').text()).toContain('Diagram failed')
    wrapper.unmount()
  })

  it('renders two fallback diagrams one at a time with distinct mermaid ids', async () => {
    let active = 0
    let overlapped = false
    const resolvers: Array<(value: { svg: string }) => void> = []
    diagram.render.mockImplementation(async () => {
      active += 1
      if (active > 1) overlapped = true
      const result = await new Promise<{ svg: string }>((resolve) => { resolvers.push(resolve) })
      active -= 1
      return result as never
    })

    const first = render(UNSUPPORTED)
    const second = render('zenuml\n  B.method()')
    await settle()
    await vi.advanceTimersByTimeAsync(DIAGRAM_FALLBACK_DELAY_MS)
    await settle()

    expect(diagram.render).toHaveBeenCalledTimes(1)
    resolvers[0]?.({ svg: '<svg data-testid="first"></svg>' })
    await settle()
    expect(diagram.render).toHaveBeenCalledTimes(2)
    resolvers[1]?.({ svg: '<svg data-testid="second"></svg>' })
    await settle()

    const ids = diagram.render.mock.calls.map(call => call[0])
    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(2)
    expect(overlapped).toBe(false)
    first.unmount()
    second.unmount()
  })

  it('redraws a mermaid fallback when the theme changes', async () => {
    const wrapper = render(UNSUPPORTED)
    await settle()
    await vi.advanceTimersByTimeAsync(DIAGRAM_FALLBACK_DELAY_MS)
    await settle()
    expect(diagram.render).toHaveBeenCalledTimes(1)

    diagram.initialize.mockClear()
    diagram.render.mockClear()
    document.documentElement.setAttribute('data-theme', 'light')
    await settle()
    await vi.advanceTimersByTimeAsync(THEME_SETTLE_MS)
    await settle()

    expect(diagram.initialize).toHaveBeenCalledWith(expect.objectContaining({
      themeVariables: expect.objectContaining({ darkMode: 'false' }),
    }))
    expect(diagram.render).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })

  it('rejects an oversized diagram without loading either engine', async () => {
    const wrapper = render(`graph TD\n${'A-->B\n'.repeat(4000)}`)
    await settle()
    expect(wrapper.find('.markdown-diagram-svg').exists()).toBe(false)
    expect(wrapper.find('.markdown-diagram-note').exists()).toBe(true)
    expect(diagram.render).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('applies the 80% shrink floor to a mermaid diagram', async () => {
    const wrapper = render(UNSUPPORTED)
    await settle()
    await vi.advanceTimersByTimeAsync(DIAGRAM_FALLBACK_DELAY_MS)
    await settle()
    expect(wrapper.get('.markdown-diagram-svg').attributes('style'))
      .toContain('--diagram-min-width: 320px')
    wrapper.unmount()
  })
})
