<script setup lang="ts">
import { FileText, Pencil, RefreshCw } from '@lucide/vue'
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { api } from '@/api'
import MarkdownRender from '@/components/MarkdownRender.vue'
import { highlightCode } from '@/lib/highlight'
import { documentBaseName, documentExtension, isMarkdownPath, isTextLikePath } from '@/lib/documentPath'
import { readFileText, type DirEntryDto, type ReadFileDataDto } from '@/lib/workspaceSearch'

/**
 * The read half of the sidebar document card: Markdown through the conversation
 * renderer, any other text file as a highlighted, line-numbered pane. It deliberately
 * does not load Monaco — the editor is a separate lazy chunk, and a user who only wants
 * to read a log should not pay 3.9MB for it.
 */
const props = defineProps<{
  path: string
  cwd: string
  /** Line the reference pointed at; the reader centres it and marks the row. */
  line?: number
  /** Bumped when the same reference is clicked again — re-centre even if `line` is equal. */
  revealNonce?: number
}>()
const emit = defineEmits<{ edit: [] }>()

const { t, locale } = useI18n()

/** `read_file` answers text; anything larger than this is not worth a sidebar render. */
const MAX_BYTES = 512 * 1024
const MAX_LINES = 5000

type ReaderState = 'loading' | 'ready' | 'unsupported' | 'tooLarge' | 'error'

const state = ref<ReaderState>('loading')
const content = ref('')
const fileSize = ref<number | null>(null)
const modifiedAt = ref<string | null>(null)
const truncated = ref(false)
const errorText = ref('')
const bodyRef = ref<HTMLElement | null>(null)
let loadGeneration = 0

const isMarkdown = computed(() => isMarkdownPath(props.path))
const fileName = computed(() => documentBaseName(props.path))
const targetLine = computed(() => (props.line && props.line > 0 ? props.line : null))
const lineLabel = computed(() => (props.line ? t('docReader.line', { line: props.line }) : ''))

const lines = computed(() => {
  if (state.value !== 'ready' || isMarkdown.value) return []
  const language = documentExtension(props.path)
  return content.value.split('\n').map((text, index) => ({
    number: index + 1,
    html: highlightCode(text, language),
  }))
})
const visibleLines = computed(() => lines.value.slice(0, MAX_LINES))

function formatSize(bytes: number | null): string {
  if (bytes === null) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
const sizeLabel = computed(() => formatSize(fileSize.value))
const modifiedLabel = computed(() => {
  if (!modifiedAt.value) return ''
  try {
    return new Date(modifiedAt.value).toLocaleString(locale.value)
  } catch {
    return modifiedAt.value
  }
})

function scrollToTarget(): void {
  const target = targetLine.value
  if (!target || !bodyRef.value) return
  const row = bodyRef.value.querySelector(`[data-line="${target}"]`)
  // `scrollIntoView` is absent in the test DOM; a missing scroll must not fail the load.
  row?.scrollIntoView?.({ block: 'center' })
}

async function load(): Promise<void> {
  const generation = ++loadGeneration
  errorText.value = ''
  truncated.value = false

  if (!props.path) {
    state.value = 'error'
    errorText.value = t('docReader.missingPath')
    return
  }
  if (!props.cwd) {
    state.value = 'error'
    errorText.value = t('documents.noWorkspace')
    return
  }

  if (!isTextLikePath(props.path)) {
    state.value = 'unsupported'
    return
  }

  state.value = 'loading'
  try {
    // Size first: a 40MB log should be refused before its lines cross the wire.
    const meta = await api.statEntry(props.cwd, props.path)
    if (generation !== loadGeneration) return
    const entry = (meta.data as { entry?: DirEntryDto }).entry
    fileSize.value = typeof entry?.size === 'number' ? entry.size : null
    modifiedAt.value = typeof entry?.modified_at === 'string' ? entry.modified_at : null
    if (fileSize.value !== null && fileSize.value > MAX_BYTES) {
      state.value = 'tooLarge'
      return
    }

    const file = await api.readFile(props.cwd, props.path)
    if (generation !== loadGeneration) return
    const data = file.data as ReadFileDataDto
    if (data?.success === false) {
      state.value = 'error'
      errorText.value = t('docReader.loadFailed')
      return
    }
    content.value = readFileText(data)
    truncated.value = !isMarkdown.value && content.value.split('\n').length > MAX_LINES
    state.value = 'ready'
    await nextTick()
    scrollToTarget()
  } catch (error) {
    if (generation !== loadGeneration) return
    console.error('[documents] reading a document failed', props.path, error)
    state.value = 'error'
    errorText.value = error instanceof Error ? error.message : t('docReader.loadFailed')
  }
}

onMounted(() => { void load() })
watch(() => [props.path, props.cwd], () => { void load() })
watch(() => props.line, async () => {
  await nextTick()
  scrollToTarget()
})
watch(() => props.revealNonce, async () => {
  await nextTick()
  scrollToTarget()
})

defineExpose({ reload: load })
</script>

<template>
  <div class="doc-reader" :data-state="state">
    <div class="doc-reader-bar">
      <FileText class="doc-reader-icon" :size="13" aria-hidden="true" />
      <span class="doc-reader-name" :title="path">{{ fileName }}</span>
      <span v-if="lineLabel" class="doc-reader-chip" data-testid="doc-reader-line">{{ lineLabel }}</span>
      <span class="doc-reader-meta">
        <span v-if="sizeLabel">{{ sizeLabel }}</span>
        <span v-if="modifiedLabel" class="doc-reader-meta-time">{{ modifiedLabel }}</span>
      </span>
      <div class="doc-reader-actions">
        <button
          type="button"
          class="doc-reader-action"
          :title="t('documents.reload')"
          :aria-label="t('documents.reload')"
          :disabled="state === 'loading'"
          @click="load"
        >
          <RefreshCw :size="13" :class="{ 'is-spinning': state === 'loading' }" aria-hidden="true" />
        </button>
        <button
          type="button"
          class="doc-reader-action doc-reader-action--edit"
          :title="t('docReader.openInEditor')"
          @click="emit('edit')"
        >
          <Pencil :size="13" aria-hidden="true" />
          <span>{{ t('docReader.edit') }}</span>
        </button>
      </div>
    </div>

    <p class="doc-reader-path" :title="path">{{ path }}</p>

    <div ref="bodyRef" class="doc-reader-body" aria-live="polite">
      <div v-if="state === 'loading'" class="doc-reader-placeholder" role="status">
        {{ t('docReader.loading') }}
      </div>

      <div v-else-if="state === 'error'" class="doc-reader-empty" role="alert">
        <p class="doc-reader-empty-title">{{ t('docReader.loadFailedTitle') }}</p>
        <p class="doc-reader-empty-detail">{{ errorText }}</p>
        <button type="button" class="doc-reader-empty-action" @click="load">{{ t('common.retry') }}</button>
      </div>

      <div v-else-if="state === 'unsupported'" class="doc-reader-empty">
        <p class="doc-reader-empty-title">{{ t('docReader.unsupportedTitle') }}</p>
        <p class="doc-reader-empty-detail">{{ t('docReader.unsupportedDetail', { path }) }}</p>
        <button type="button" class="doc-reader-empty-action" @click="emit('edit')">{{ t('docReader.openInEditor') }}</button>
      </div>

      <div v-else-if="state === 'tooLarge'" class="doc-reader-empty">
        <p class="doc-reader-empty-title">{{ t('docReader.tooLargeTitle') }}</p>
        <p class="doc-reader-empty-detail">{{ t('docReader.tooLargeDetail', { size: sizeLabel }) }}</p>
        <button type="button" class="doc-reader-empty-action" @click="emit('edit')">{{ t('docReader.openInEditor') }}</button>
      </div>

      <div v-else-if="isMarkdown" class="doc-reader-markdown">
        <MarkdownRender :content="content" />
      </div>

      <div v-else class="doc-reader-code" role="document">
        <div
          v-for="row in visibleLines"
          :key="row.number"
          class="doc-reader-line"
          :class="{ 'is-target': row.number === targetLine }"
          :data-line="row.number"
        >
          <span class="doc-reader-gutter" aria-hidden="true">{{ row.number }}</span>
          <!-- eslint-disable-next-line vue/no-v-html -- highlight.js output, already escaped -->
          <span class="doc-reader-text" v-html="row.html" />
        </div>
        <p v-if="truncated" class="doc-reader-truncated">{{ t('docReader.truncated', { count: MAX_LINES }) }}</p>
      </div>
    </div>
  </div>
</template>
