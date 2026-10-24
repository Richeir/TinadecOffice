<script setup lang="ts">
import { FileCode, PanelLeftClose, PanelLeftOpen, X } from '@lucide/vue'
import { onMounted, ref, shallowRef, type Component } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ApprovalDto } from '@/api'
import DocumentFileTree from './DocumentFileTree.vue'

/**
 * The body of the sidebar code editor: folder structure on the left, the real editor on the
 * right, and the file browser when no file is open yet.
 *
 * Monaco is imported here, on mount, rather than in the reader — the reader is the common
 * case and must stay free of a ~3.9MB chunk. Saving is `CodeEditor`'s own: it already asks
 * for a `write_file` approval and carries the hash the file had when it was loaded, so an
 * edit made elsewhere on disk is refused instead of overwritten.
 */
const props = defineProps<{
  /** File being edited; null shows the folder tree plus a "pick a file" prompt. */
  path: string | null
  cwd: string
  /** Line the reference pointed at, revealed once the editor mounts. */
  line?: number
  /** Changes when the same reference is clicked again, so the reveal is re-applied. */
  revealNonce?: number
  approvals?: readonly ApprovalDto[]
  selectedSessionId?: string | null
}>()
const emit = defineEmits<{
  'approval-requested': [approval: ApprovalDto]
  saved: [path: string]
  close: []
  select: [path: string]
}>()

const { t } = useI18n()

const treeOpen = ref(true)
const editor = shallowRef<Component | null>(null)
const editorFailed = ref(false)

onMounted(async () => {
  try {
    const module = await import('@/components/code/CodeEditor.vue')
    editor.value = module.default
  } catch (error) {
    console.error('[documents] the code editor chunk could not be loaded', error)
    editorFailed.value = true
  }
})
</script>

<template>
  <div class="doc-editor" :class="{ 'is-browser': !path }">
    <div v-if="path" class="doc-editor-rail">
      <button
        type="button"
        class="doc-editor-rail-button"
        :title="t('codeEditor.closeFile')"
        :aria-label="t('codeEditor.closeFile')"
        @click="emit('close')"
      >
        <X :size="13" aria-hidden="true" />
      </button>
      <button
        type="button"
        class="doc-editor-rail-button"
        :title="treeOpen ? t('documents.hideTree') : t('documents.showTree')"
        :aria-label="treeOpen ? t('documents.hideTree') : t('documents.showTree')"
        :aria-expanded="treeOpen"
        @click="treeOpen = !treeOpen"
      >
        <PanelLeftClose v-if="treeOpen" :size="13" aria-hidden="true" />
        <PanelLeftOpen v-else :size="13" aria-hidden="true" />
      </button>
    </div>

    <!-- The browser state always shows the tree: it is the only content it has. Without a
         workspace root there is nothing to list, so the tree is not mounted at all — an
         empty tree with no explanation is the worst of both states. -->
    <DocumentFileTree
      v-if="cwd && (treeOpen || !path)"
      class="doc-editor-tree"
      :cwd="cwd"
      :selected="path"
      @select="emit('select', $event)"
    />

    <div v-if="path" class="doc-editor-body">
      <p v-if="editorFailed" class="doc-editor-failed" role="alert">{{ t('documents.editorFailed') }}</p>
      <component
        :is="editor"
        v-else-if="editor"
        :cwd="cwd"
        :file-path="path"
        :reveal-line="line"
        :reveal-nonce="revealNonce"
        :approvals="approvals ? [...approvals] : undefined"
        :selected-session-id="selectedSessionId"
        @approval-requested="emit('approval-requested', $event)"
        @saved="emit('saved', $event)"
        @cancel="emit('close')"
      />
      <p v-else class="doc-editor-loading" role="status">{{ t('documents.loadingEditor') }}</p>
    </div>

    <div v-else class="doc-editor-browser">
      <FileCode :size="16" aria-hidden="true" />
      <div>
        <p class="doc-editor-browser-title">{{ t('codeEditor.emptyTitle') }}</p>
        <p class="doc-editor-browser-hint">
          {{ cwd ? t('codeEditor.emptyHint') : t('documents.noWorkspace') }}
        </p>
      </div>
    </div>
  </div>
</template>
