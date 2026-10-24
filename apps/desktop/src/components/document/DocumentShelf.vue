<script setup lang="ts">
import { BookOpen, FileText, RefreshCw } from '@lucide/vue'
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { invalidateWorkspace, scanWorkspaceDocuments, type ShelfDocument } from '@/lib/workspaceFiles'

/**
 * The viewer's empty state: every document in the workspace, as a shelf.
 *
 * Not a folder tree and not a one-column list — the reader has no file management to do, so
 * it offers what it can actually show. The scan is bounded (depth / directory / result
 * caps, see `scanWorkspaceDocuments`) and it says when it was cut short rather than
 * implying the workspace holds exactly this many files.
 */
const props = defineProps<{ cwd: string }>()
const emit = defineEmits<{ open: [path: string] }>()

const { t } = useI18n()

const documents = ref<ShelfDocument[]>([])
const state = ref<'idle' | 'scanning' | 'ready' | 'failed'>('idle')
const truncated = ref(false)
let generation = 0

interface Shelf {
  dir: string
  label: string
  documents: ShelfDocument[]
}

/** Shelves are folders: a group reads as one row of books, which is the whole metaphor. */
const shelves = computed<Shelf[]>(() => {
  const byDir = new Map<string, ShelfDocument[]>()
  for (const document of documents.value) {
    const list = byDir.get(document.dir)
    if (list) list.push(document)
    else byDir.set(document.dir, [document])
  }
  return [...byDir.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([dir, list]) => ({
      dir,
      label: dir || t('docReader.shelfRoot'),
      documents: [...list].sort((a, b) => a.name.localeCompare(b.name)),
    }))
})

async function load(force = false): Promise<void> {
  const cwd = props.cwd
  if (!cwd) {
    documents.value = []
    state.value = 'idle'
    return
  }
  const token = ++generation
  if (force) invalidateWorkspace(cwd)
  state.value = 'scanning'
  const result = await scanWorkspaceDocuments(cwd)
  // A project switch mid-scan must not paint the previous workspace's documents.
  if (token !== generation) return
  documents.value = result.documents
  truncated.value = result.truncated
  state.value = result.failed ? 'failed' : 'ready'
}

onMounted(() => { void load() })
watch(() => props.cwd, () => { void load(true) })
</script>

<template>
  <div class="doc-shelf">
    <div class="doc-shelf-bar">
      <BookOpen :size="12" aria-hidden="true" />
      <span class="doc-shelf-title">{{ t('docReader.shelfTitle') }}</span>
      <span v-if="state === 'ready' && documents.length" class="doc-shelf-count">
        {{ t('docReader.shelfCount', { count: documents.length }, documents.length) }}
      </span>
      <button
        type="button"
        class="doc-shelf-action"
        :title="t('documents.reload')"
        :aria-label="t('documents.reload')"
        :disabled="state === 'scanning'"
        @click="load(true)"
      >
        <RefreshCw :size="12" :class="{ 'is-spinning': state === 'scanning' }" aria-hidden="true" />
      </button>
    </div>

    <div class="doc-shelf-body">
      <p v-if="state === 'scanning' && !documents.length" class="doc-shelf-note" role="status">
        {{ t('docReader.shelfScanning') }}
      </p>

      <div v-else-if="state === 'failed'" class="doc-shelf-message" role="alert">
        <p class="doc-shelf-message-title">{{ t('docReader.shelfFailed') }}</p>
        <button type="button" class="doc-shelf-retry" @click="load(true)">{{ t('documents.reload') }}</button>
      </div>

      <p v-else-if="state === 'ready' && !documents.length" class="doc-shelf-note">
        {{ t('docReader.shelfEmpty') }}
      </p>

      <template v-else>
        <section v-for="shelf in shelves" :key="shelf.dir || '.'" class="doc-shelf-shelf">
          <h3 class="doc-shelf-label" :title="shelf.dir || t('docReader.shelfRoot')">{{ shelf.label }}</h3>
          <div class="doc-shelf-books">
            <button
              v-for="document in shelf.documents"
              :key="document.path"
              type="button"
              class="doc-shelf-book"
              :title="document.path"
              @click="emit('open', document.path)"
            >
              <span class="doc-shelf-spine" aria-hidden="true" />
              <FileText :size="13" aria-hidden="true" />
              <span class="doc-shelf-name">{{ document.name }}</span>
            </button>
          </div>
        </section>

        <p v-if="truncated" class="doc-shelf-note">
          {{ t('docReader.shelfTruncated', { count: documents.length }, documents.length) }}
        </p>
      </template>
    </div>
  </div>
</template>
