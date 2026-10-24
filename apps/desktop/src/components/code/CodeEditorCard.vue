<script setup lang="ts">
import { computed, onMounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ApprovalDto } from '@/api'
import DocumentEditorPane from '@/components/document/DocumentEditorPane.vue'
import { homeController } from '@/controllers/HomeController'
import { documentBaseName, documentParentDir } from '@/lib/documentPath'
import {
  closeEditor,
  editorFocus,
  editorPath,
  openInEditor,
  syncDocumentWorkspace,
} from '@/lib/documentWorkspace'
import { listWorkspaceDir } from '@/lib/workspaceFiles'

/**
 * The `codeEditor` card: the workspace folder tree plus the real editor, in the side panel.
 *
 * It is deliberately separate from the read-only `docReader` card. This one is reachable
 * from the Home grid on its own (a tree needs no prior context), owns the monaco instance and
 * the `write_file` approval flow, and is what "open in editor" hands a file over to.
 */
const { t } = useI18n()
const controller = homeController

const workspaceRoot = computed(() => controller.currentProject.value?.path ?? '')
const revealLine = computed(() => (
  editorFocus.value && editorFocus.value.path === editorPath.value ? editorFocus.value.line : undefined
))
const revealNonce = computed(() => (
  editorFocus.value && editorFocus.value.path === editorPath.value ? editorFocus.value.nonce : 0
))

/** Restore this workspace's own editor state; a fresh window has none bound yet. */
onMounted(() => { syncDocumentWorkspace(workspaceRoot.value) })

watch(workspaceRoot, (root) => { syncDocumentWorkspace(root) })

/**
 * The restored file may be gone (renamed, or the remembered workspace was a different
 * checkout). Verify against a successful parent listing only: when the listing fails we do
 * not know, and closing the file would be a guess.
 */
watch([workspaceRoot, editorPath], async ([root, path]) => {
  if (!root || !path) return
  const entries = await listWorkspaceDir(root, documentParentDir(path))
  if (!entries) return
  if (editorPath.value !== path) return
  const name = documentBaseName(path)
  if (!entries.some((entry) => !entry.isDir && entry.name === name)) closeEditor()
}, { immediate: true })

function select(path: string): void {
  openInEditor({ path, cwd: workspaceRoot.value })
}

function recordApproval(approval: ApprovalDto): void {
  controller.recordApproval(approval)
}
</script>

<template>
  <div class="doc-card" role="region" :aria-label="t('context.homeCodeEditor')">
    <DocumentEditorPane
      :path="editorPath"
      :cwd="workspaceRoot"
      :line="revealLine"
      :reveal-nonce="revealNonce"
      :approvals="controller.approvals.value"
      :selected-session-id="controller.selectedSessionId.value"
      @close="closeEditor()"
      @select="select"
      @approval-requested="recordApproval"
    />
  </div>
</template>
