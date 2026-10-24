<script setup lang="ts">
import { FileText, PencilLine, X } from '@lucide/vue'
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { homeController } from '@/controllers/HomeController'
import { documentBaseName } from '@/lib/documentPath'
import { useUie } from '@tinadec/ui'
import {
  CODE_EDITOR_CARD,
  activateDocument,
  activeDocPath,
  closeDocument,
  docFocus,
  docTabs,
  openDocument,
  openInEditor,
  syncDocumentWorkspace,
} from '@/lib/documentWorkspace'
import DocumentReader from './DocumentReader.vue'
import DocumentShelf from './DocumentShelf.vue'

/**
 * The `docReader` card: a read-only viewer with one tab per document.
 *
 * It never becomes an editor. Editing lives in its own `codeEditor` card, which owns the
 * folder tree, the monaco instance and the approval save; this card only offers to hand a
 * file over (`openInEditor`). Mixing the two produced a panel that was neither: a reader
 * with no tree, or an editor you could only reach through a reference.
 *
 * The card owns its tab strip because the layout engine's own bar cannot: the feature column
 * is 420px and already hosts nine tabs, so it is in icon-only mode there and every unknown
 * descriptor falls back to a Globe — one card per document would be a row of identical
 * globes with no filename.
 */
const { t } = useI18n()

const tabs = docTabs
const activePath = activeDocPath
const workspaceRoot = computed(() => homeController.currentProject.value?.path ?? '')
const activeTab = computed(() => tabs.value.find((tab) => tab.path === activePath.value) ?? null)
const revealNonce = computed(() => (
  docFocus.value && docFocus.value.path === activePath.value ? docFocus.value.nonce : 0
))

/** Restore the workspace's own tab list; a fresh window has none bound yet. */
onMounted(() => { syncDocumentWorkspace(workspaceRoot.value) })

watch(workspaceRoot, (root) => { syncDocumentWorkspace(root) })

function activate(path: string): void {
  activateDocument(path)
}

function close(path: string): void {
  closeDocument(path)
}

/** A book on the shelf opens in this card, in reading mode. */
function openInViewer(path: string): void {
  openDocument({ path, cwd: workspaceRoot.value })
}

/** Hand the document on screen to the editor card; the viewer keeps its tab. */
function handOffToEditor(): void {
  const path = activePath.value
  if (!path) return
  openInEditor({ path, line: activeTab.value?.line, cwd: workspaceRoot.value })
}

/** The viewer's empty state is a way into the editor, not a folder browser of its own. */
function openEditorCard(): void {
  try {
    const uie = useUie()
    uie.dispatch({
      command: { type: 'openCard', scope: uie.scope.value, descriptorId: CODE_EDITOR_CARD, slotId: 'right' },
      source: 'user',
      expectedRevision: uie.snapshot.value.revision,
    })
  } catch {
    // No layout engine on this surface; the button is inert rather than fatal.
  }
}

</script>

<template>
  <div class="doc-card">
    <div v-if="tabs.length" class="doc-card-tabs" role="tablist" :aria-label="t('docReader.tabs')">
      <div v-for="tab in tabs" :key="tab.path" class="doc-card-tab">
        <button
          type="button"
          role="tab"
          class="doc-card-tab-label"
          :class="{ 'is-active': tab.path === activePath }"
          :aria-selected="tab.path === activePath"
          :title="tab.path"
          @click="activate(tab.path)"
        >
          <FileText :size="11" aria-hidden="true" />
          <span class="doc-card-tab-name">{{ documentBaseName(tab.path) }}</span>
        </button>
        <button
          type="button"
          class="doc-card-tab-close"
          :title="t('docReader.closeTab')"
          :aria-label="t('docReader.closeTab')"
          @click="close(tab.path)"
        >
          <X :size="10" aria-hidden="true" />
        </button>
      </div>
    </div>

    <div class="doc-card-body">
      <!-- Nothing open yet: the viewer scans the workspace and offers its documents as a
           shelf. No tree, no editing — those belong to the code editor card, which this
           footer links to for files the shelf does not list (code, assets). -->
      <div v-if="!activeTab" class="doc-card-empty" data-testid="doc-card-empty">
        <DocumentShelf v-if="workspaceRoot" :cwd="workspaceRoot" @open="openInViewer" />
        <p v-else class="doc-card-empty-hint">{{ t('documents.noWorkspace') }}</p>
        <div v-if="workspaceRoot" class="doc-card-empty-foot">
          <button type="button" class="doc-card-empty-link" @click="openEditorCard">
            <PencilLine :size="11" aria-hidden="true" />
            <span>{{ t('docReader.openEditor') }}</span>
          </button>
        </div>
      </div>

      <DocumentReader
        v-else
        :path="activeTab.path"
        :cwd="workspaceRoot"
        :line="activeTab.line"
        :reveal-nonce="revealNonce"
        @edit="handOffToEditor"
      />
    </div>
  </div>
</template>
