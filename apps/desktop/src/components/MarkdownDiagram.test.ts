// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { afterEach, describe, expect, it, vi } from 'vitest'
import mermaid from 'mermaid'
import MarkdownDiagram, { diagramMinWidth, diagramMinWidthFromPx } from './MarkdownDiagram.vue'

// Pele is the primary engine and runs for real here. Mermaid is the fallback; mocking it
// keeps a Pele bug from importing the heavy bundle and pins that it is not used.
vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    parse: vi.fn(async () => true),
    render: vi.fn(async () => ({ svg: '<svg data-testid="diagram"></svg>' })),
  },
}))

const diagram = vi.mocked(mermaid)

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

async function waitForDiagram(wrapper: ReturnType<typeof render>) {
  await vi.waitFor(() => {
    expect(wrapper.find('.markdown-diagram-svg svg').exists()).toBe(true)
  }, { timeout: 5000 })
}

afterEach(() => {
  vi.clearAllMocks()
  document.documentElement.removeAttribute('data-theme')
})

const SOURCE = 'graph TD\n  A --> B'

describe('MarkdownDiagram', () => {
  it('draws with Pele and does not touch the mermaid fallback', async () => {
    const wrapper = render(SOURCE)
    await waitForDiagram(wrapper)
    expect(wrapper.get('.markdown-diagram-svg').attributes('data-engine')).toBe('pele')
    expect(wrapper.get('.markdown-diagram-svg svg').classes()).toContain('pele')
    expect(wrapper.find('.markdown-diagram-note').exists()).toBe(false)
    expect(diagram.initialize).not.toHaveBeenCalled()
    expect(diagram.render).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('draws a second diagram type, so the lazy per-type entry loads', async () => {
    const wrapper = render('sequenceDiagram\n  Alice->>Bob: Hi')
    await waitForDiagram(wrapper)
    expect(wrapper.get('.markdown-diagram-svg').attributes('data-engine')).toBe('pele')
    expect(diagram.render).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('takes the shrink floor from the width Pele reports', async () => {
    const wrapper = render(SOURCE)
    await waitForDiagram(wrapper)
    const width = Number(wrapper.get('.markdown-diagram-svg svg').attributes('width'))
    expect(Number.isFinite(width) && width > 0).toBe(true)
    expect(wrapper.get('.markdown-diagram-svg').attributes('style'))
      .toContain(`--diagram-min-width: ${Math.round(width * 0.8)}px`)
    wrapper.unmount()
  })

  it('leaves a Pele diagram alone when the theme changes', async () => {
    const wrapper = render(SOURCE)
    await waitForDiagram(wrapper)
    const node = wrapper.get('.markdown-diagram-svg svg').element
    document.documentElement.setAttribute('data-theme', 'light')
    await new Promise(resolve => setTimeout(resolve, 400))
    expect(wrapper.get('.markdown-diagram-svg svg').element).toBe(node)
    expect(wrapper.find('.markdown-diagram-note').exists()).toBe(false)
    wrapper.unmount()
  })

  it('shows an empty fence as source without an error', async () => {
    const wrapper = render('')
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(wrapper.find('.markdown-diagram-svg').exists()).toBe(false)
    expect(wrapper.find('.markdown-diagram-note').exists()).toBe(false)
    wrapper.unmount()
  })

  it('does not let diagram labels introduce scripts, handlers or foreign objects', async () => {
    const wrapper = render('flowchart TD\n  A["<img src=x onerror=alert(1)>"] --> B')
    await waitForDiagram(wrapper)
    const markup = wrapper.get('.markdown-diagram-svg').html()
    expect(wrapper.find('.markdown-diagram-svg img').exists()).toBe(false)
    expect(markup).not.toMatch(/\son[a-z]+=/i)
    expect(markup).not.toContain('<script')
    expect(markup).not.toContain('foreignObject')
    wrapper.unmount()
  })

  it('does not emit javascript links from click statements', async () => {
    const wrapper = render('flowchart LR\n  A[ok] --> B[ok]\n  click A "javascript:alert(1)"')
    await waitForDiagram(wrapper)
    expect(wrapper.get('.markdown-diagram-svg').html()).not.toMatch(/javascript:/i)
    wrapper.unmount()
  })

  it('does not hand an oversized diagram to either engine', async () => {
    const wrapper = render(`graph TD\n${'A-->B\n'.repeat(4000)}`)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(wrapper.find('.markdown-diagram-svg').exists()).toBe(false)
    expect(wrapper.get('.markdown-diagram-note').text()).toContain('Diagram failed')
    expect(diagram.render).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})

describe('diagram width helpers', () => {
  it('reads the width mermaid writes into its inline max-width', () => {
    expect(diagramMinWidth('<svg id="d" width="100%" style="max-width: 640px;" viewBox="0 0 640 900">')).toBe('512px')
    expect(diagramMinWidth('<svg id="d" viewBox="0 0 10 10">')).toBeNull()
  })

  it('takes the same 80% floor from the width Pele returns', () => {
    expect(diagramMinWidthFromPx(640)).toBe('512px')
    expect(diagramMinWidthFromPx(0)).toBeNull()
    expect(diagramMinWidthFromPx(Number.NaN)).toBeNull()
  })
})
