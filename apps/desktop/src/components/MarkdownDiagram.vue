<script lang="ts">
interface MermaidApi {
  initialize: (config: Record<string, unknown>) => void
  parse: (text: string, options?: { suppressErrors?: boolean }) => Promise<unknown> | unknown
  render: (id: string, text: string) => Promise<{ svg: string }>
}

interface PeleApi {
  renderAsync: (
    source: string,
    options?: { fontSize?: number; fontFamily?: string; fontFamilyMono?: string },
  ) => Promise<{ svg: string; width: number; height: number }>
}

type DiagramEngine = 'pele' | 'mermaid'

/*
 * Shared by every diagram on the page, so it lives outside the per-instance setup. Pele is
 * the primary engine; mermaid is the fallback for diagrams Pele rejects. Mermaid scopes a
 * diagram's styles and its temporary render node by the id it is given, and its
 * configuration is global as well, so its renders take turns.
 */
let mermaidLoader: Promise<MermaidApi> | null = null
let peleLoader: Promise<PeleApi> | null = null
let diagramCounter = 0
let initialisedTheme: string | null = null
let renderQueue: Promise<unknown> = Promise.resolve()

/**
 * Pele is imported through its lazy entry so only the diagram type actually used is
 * downloaded. A failed chunk must be retried by the next diagram instead of poisoning the
 * window for its whole lifetime.
 */
function loadPele(): Promise<PeleApi> {
  let cached = peleLoader
  if (!cached) {
    cached = import('pele/lazy').then(
      module => module as unknown as PeleApi,
      (error) => {
        peleLoader = null
        throw error
      },
    )
    peleLoader = cached
  }
  return cached
}

/**
 * Mermaid is imported only after Pele has failed on a source that has stopped changing.
 */
function loadMermaid(): Promise<MermaidApi> {
  mermaidLoader ??= import('mermaid').then(module => module.default as unknown as MermaidApi)
  return mermaidLoader
}

function serialised<T>(task: () => Promise<T>): Promise<T> {
  const run = renderQueue.then(task, task)
  renderQueue = run.catch(() => undefined)
  return run
}

/** Narrowest a diagram may shrink to, as a share of the width its engine laid it out at. */
const MIN_DIAGRAM_SCALE = 0.8

/** Mermaid writes the laid-out width as the svg's inline max-width; null when it is absent. */
export function diagramMinWidth(svg: string): string | null {
  const match = /<svg\b[^>]*\bstyle="[^"]*max-width:\s*([\d.]+)px/.exec(svg)
  const width = match ? Number(match[1]) : NaN
  return minWidthOf(width)
}

/** Pele returns its laid-out width directly; there is no max-width to parse. */
export function diagramMinWidthFromPx(width: number): string | null {
  return minWidthOf(width)
}

function minWidthOf(width: number): string | null {
  return Number.isFinite(width) && width > 0 ? `${Math.round(width * MIN_DIAGRAM_SCALE)}px` : null
}

/** Mermaid scopes a diagram's styles by the id it is given, so every diagram needs its own. */
function nextDiagramId(): string {
  diagramCounter += 1
  return `md-diagram-${diagramCounter}`
}

/**
 * Streaming writes a fence in pieces. A partial fence is not evidence that Pele cannot
 * draw the diagram, and loading mermaid on every such failure would pull the whole
 * fallback engine in while the reply is still streaming. The fallback therefore waits for
 * the source to stop changing.
 */
export const DIAGRAM_FALLBACK_DELAY_MS = 1000
</script>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { TriangleAlert } from '@lucide/vue'

const props = defineProps<{
  /** Raw diagram source (Mermaid syntax), drawn by Pele with mermaid as the fallback. */
  code: string
}>()

const { t } = useI18n()

/** Past this size a diagram is more likely to hang the reply than to inform it. */
const MAX_DIAGRAM_CHARS = 20000
/** Streaming writes a fence in pieces; wait for it to settle before laying out. */
const SETTLE_MS = 250

const svg = ref('')
const minWidth = ref<string | null>(null)
const failed = ref(false)
const engine = ref<DiagramEngine | null>(null)
const container = ref<HTMLElement | null>(null)

let themeObserver: MutationObserver | null = null
let settleTimer: ReturnType<typeof setTimeout> | null = null
let fallbackTimer: ReturnType<typeof setTimeout> | null = null
let renderSequence = 0
let firstPass = true
let renderedSource = ''

function cssVar(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value || fallback
}

/**
 * Diagrams inherit the active theme through the same CSS tokens the rest of the
 * app uses, so they follow the accent colour instead of shipping a second theme.
 */
function themeVariables(): Record<string, string> {
  const light = document.documentElement.getAttribute('data-theme') === 'light'
  return {
    darkMode: String(!light),
    background: 'transparent',
    primaryColor: cssVar('--surface-raised', light ? '#eef1f5' : '#28242c'),
    primaryTextColor: cssVar('--text-primary', light ? '#1f2328' : '#eadef7'),
    primaryBorderColor: cssVar('--border-default', light ? '#d0d7de' : '#28242c'),
    secondaryColor: cssVar('--surface-section', 'transparent'),
    tertiaryColor: cssVar('--surface-chrome', 'transparent'),
    lineColor: cssVar('--text-muted', '#6e7681'),
    textColor: cssVar('--text-primary', light ? '#1f2328' : '#eadef7'),
    // The base theme paints edge labels on a saturated block; keep them on the card surface.
    edgeLabelBackground: cssVar('--surface-section', light ? '#ffffff' : '#231f29'),
    fontSize: '12px',
  }
}

/** Pele measures text with a canvas, so it must be given the family the SVG will paint. */
function diagramFontFamily(): string | undefined {
  const host = container.value ?? document.body
  const family = host ? getComputedStyle(host).fontFamily.trim() : ''
  return family || undefined
}

function diagramFontMono(): string | undefined {
  return cssVar('--font-mono', '') || undefined
}

function renderOptions(): { fontSize: number; fontFamily?: string; fontFamilyMono?: string } {
  const family = diagramFontFamily()
  const mono = diagramFontMono()
  return {
    fontSize: 12,
    ...(family ? { fontFamily: family } : {}),
    ...(mono ? { fontFamilyMono: mono } : {}),
  }
}

/**
 * Pele escapes diagram text and filters link schemes; it emits no <script>, <img> or
 * <foreignObject> and has no HTML-label mode. Its output is therefore inserted as-is,
 * the same trust mermaid's securityLevel:'strict' output gets. Keep this the only place
 * that decides whether a diagram SVG needs sanitising.
 */
function sanitizePeleSvg(markup: string): string {
  return markup
}

function clearDiagram(): void {
  svg.value = ''
  minWidth.value = null
  engine.value = null
}

function clearFallbackTimer(): void {
  if (fallbackTimer) {
    clearTimeout(fallbackTimer)
    fallbackTimer = null
  }
}

function applySvg(markup: string, width: string | null, drawnBy: DiagramEngine, source: string): void {
  svg.value = markup
  minWidth.value = width
  engine.value = drawnBy
  failed.value = false
  renderedSource = source
}

function scheduleMermaidFallback(source: string, sequence: number): void {
  clearFallbackTimer()
  fallbackTimer = setTimeout(() => {
    fallbackTimer = null
    if (sequence !== renderSequence || props.code.trim() !== source) return
    void drawWithMermaid(source, sequence)
  }, DIAGRAM_FALLBACK_DELAY_MS)
}

async function draw(): Promise<void> {
  const source = props.code.trim()
  const sequence = ++renderSequence
  clearFallbackTimer()

  if (!source) {
    // A fence that has only opened is an empty source, not an error.
    clearDiagram()
    failed.value = false
    renderedSource = ''
    return
  }
  if (source.length > MAX_DIAGRAM_CHARS) {
    clearDiagram()
    failed.value = true
    renderedSource = ''
    return
  }

  // Pele paints through CSS variables, so a theme change does not need a re-render.
  if (engine.value === 'pele' && source === renderedSource) {
    failed.value = false
    return
  }
  // The theme observer re-enters here for a fallback diagram; do not retry Pele first.
  if (engine.value === 'mermaid' && source === renderedSource) {
    await drawWithMermaid(source, sequence)
    return
  }

  try {
    const pele = await loadPele()
    if (sequence !== renderSequence) return
    const rendered = await pele.renderAsync(source, renderOptions())
    if (sequence !== renderSequence || props.code.trim() !== source) return
    if (!rendered.svg) throw new Error('empty diagram')
    applySvg(sanitizePeleSvg(rendered.svg), diagramMinWidthFromPx(rendered.width), 'pele', source)
  } catch {
    if (sequence !== renderSequence || props.code.trim() !== source) return
    clearDiagram()
    // Do not pull the fallback engine in for a fence that is still streaming.
    failed.value = false
    scheduleMermaidFallback(source, sequence)
  }
}

async function drawWithMermaid(source: string, sequence: number): Promise<void> {
  try {
    const rendered = await serialised(async () => {
      if (sequence !== renderSequence) return null
      const mermaid = await loadMermaid()
      if (sequence !== renderSequence) return null
      const theme = document.documentElement.getAttribute('data-theme') ?? 'dark'
      if (initialisedTheme !== theme) {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: 'base',
          themeVariables: themeVariables(),
          fontFamily: 'inherit',
        })
        initialisedTheme = theme
      }
      // `suppressErrors` keeps an unfinished fence from logging while it streams in.
      const parsed = await mermaid.parse(source, { suppressErrors: true })
      if (sequence !== renderSequence) return null
      if (parsed === false) throw new Error('invalid diagram')
      return mermaid.render(nextDiagramId(), source)
    })
    if (!rendered || sequence !== renderSequence || props.code.trim() !== source) return
    applySvg(rendered.svg, diagramMinWidth(rendered.svg), 'mermaid', source)
  } catch {
    if (sequence !== renderSequence || props.code.trim() !== source) return
    clearDiagram()
    // An unrenderable diagram falls back to its own source instead of vanishing.
    failed.value = true
  }
}

watch(() => props.code, () => {
  clearFallbackTimer()
  if (firstPass) {
    firstPass = false
    void draw()
    return
  }
  if (settleTimer) clearTimeout(settleTimer)
  settleTimer = setTimeout(() => { void draw() }, SETTLE_MS)
}, { immediate: true })

onMounted(() => {
  themeObserver = new MutationObserver(() => {
    // Pele diagrams follow the CSS variables; only a mermaid fallback must be redrawn.
    if (engine.value !== 'mermaid') return
    if (settleTimer) clearTimeout(settleTimer)
    settleTimer = setTimeout(() => { void draw() }, SETTLE_MS)
  })
  themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
})

onBeforeUnmount(() => {
  renderSequence += 1
  themeObserver?.disconnect()
  if (settleTimer) clearTimeout(settleTimer)
  clearFallbackTimer()
})
</script>

<template>
  <div ref="container" class="markdown-diagram-body">
    <!-- Pele escapes labels and emits no script, image or foreignObject; mermaid runs with
         securityLevel strict. Their output is the one place v-html is allowed, and the
         source came from the already sanitised fence. -->
    <div
      v-if="svg"
      class="markdown-diagram-svg"
      :data-engine="engine ?? undefined"
      :style="minWidth ? { '--diagram-min-width': minWidth } : undefined"
      tabindex="0"
      role="img"
      :aria-label="t('chat.markdownDiagram')"
      v-html="svg"
    />
    <template v-else>
      <pre class="markdown-diagram-fallback"><code>{{ code }}</code></pre>
      <p v-if="failed" class="markdown-diagram-note" role="status">
        <TriangleAlert :size="12" aria-hidden="true" />
        <span>{{ t('chat.markdownDiagramError') }}</span>
      </p>
    </template>
  </div>
</template>
