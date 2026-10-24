<script setup lang="ts">
import { ChevronRight, FileText, Folder, FolderOpen, RefreshCw } from '@lucide/vue'
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { documentBaseName } from '@/lib/documentPath'
import { invalidateWorkspace, listWorkspaceDir, shouldSkipDirName } from '@/lib/workspaceFiles'

/**
 * The folder structure beside the sidebar editor.
 *
 * It reads directories through `workspaceFiles`, the same single-flight cache reference
 * verification uses, so expanding a folder also answers "does `docs/spec.md` exist" for
 * the next answer. Only expanded folders are listed, and generated/heavy directories are
 * filtered — `apps/desktop/release` alone would put 1112 html files in the tree.
 *
 * Deliberately read-only: creating, renaming and deleting files stays in the full code
 * page's tree, which owns the approval flow for those actions.
 */
const props = defineProps<{
  cwd: string
  /** Workspace-relative path of the document on screen; its ancestors auto-expand. */
  selected?: string | null
}>()
const emit = defineEmits<{ select: [path: string] }>()

const { t } = useI18n()

/** Last path segment of the root being listed; the full path lives in the tooltip. */
const rootLabel = computed(() => documentBaseName(props.cwd) || t('documents.tree'))

interface TreeNode {
  name: string
  path: string
  isDir: boolean
  loaded: boolean
  loading: boolean
  expanded: boolean
  children: TreeNode[]
}

interface Row {
  node: TreeNode
  depth: number
}

const nodes = ref<TreeNode[]>([])
const loading = ref(false)
const failed = ref(false)

function isVisibleEntry(name: string, isDir: boolean): boolean {
  if (name.startsWith('.')) return false
  return !(isDir && shouldSkipDirName(name))
}

function toNode(entry: { name: string; isDir: boolean }, parent: string): TreeNode {
  return {
    name: entry.name,
    path: parent ? `${parent}/${entry.name}` : entry.name,
    isDir: entry.isDir,
    loaded: false,
    loading: false,
    expanded: false,
    children: [],
  }
}

async function listChildren(node: TreeNode): Promise<void> {
  if (node.loaded || node.loading) return
  node.loading = true
  try {
    const entries = await listWorkspaceDir(props.cwd, node.path)
    if (!entries) {
      failed.value = true
      return
    }
    node.children = entries
      .filter((entry) => isVisibleEntry(entry.name, entry.isDir))
      .map((entry) => toNode(entry, node.path))
      .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1))
    node.loaded = true
    failed.value = false
  } finally {
    node.loading = false
  }
}

async function loadRoot(force = false): Promise<void> {
  if (force) invalidateWorkspace(props.cwd)
  loading.value = true
  failed.value = false
  try {
    const entries = await listWorkspaceDir(props.cwd, '')
    if (!entries) {
      failed.value = true
      nodes.value = []
      return
    }
    nodes.value = entries
      .filter((entry) => isVisibleEntry(entry.name, entry.isDir))
      .map((entry) => toNode(entry, ''))
      .sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1))
  } finally {
    loading.value = false
  }
}

const rows = computed<Row[]>(() => {
  const out: Row[] = []
  const walk = (list: TreeNode[], depth: number) => {
    for (const node of list) {
      out.push({ node, depth })
      if (node.isDir && node.expanded) walk(node.children, depth + 1)
    }
  }
  walk(nodes.value, 0)
  return out
})

function toggle(node: TreeNode): void {
  if (!node.isDir) {
    emit('select', node.path)
    return
  }
  node.expanded = !node.expanded
  if (node.expanded) void listChildren(node)
}

/** Open the folders leading to the document on screen so its row is visible. */
async function reveal(path: string | null | undefined): Promise<void> {
  if (!path) return
  const segments = path.split('/').slice(0, -1)
  let list = nodes.value
  let parent = ''
  for (const segment of segments) {
    parent = parent ? `${parent}/${segment}` : segment
    const node = list.find((candidate) => candidate.name === segment && candidate.isDir)
    if (!node) return
    node.expanded = true
    await listChildren(node)
    list = node.children
  }
}

onMounted(() => { void loadRoot() })
watch(() => props.cwd, () => {
  nodes.value = []
  void loadRoot(true)
})
watch(() => props.selected, (path) => { void reveal(path) })

defineExpose({ reload: () => loadRoot(true) })
</script>

<template>
  <div class="doc-tree">
    <div class="doc-tree-bar">
      <!-- The root on screen, so "no files" can be told apart from "wrong folder". -->
      <span class="doc-tree-title" :title="cwd">{{ rootLabel }}</span>
      <button
        type="button"
        class="doc-tree-action"
        :title="t('documents.reload')"
        :aria-label="t('documents.reload')"
        :disabled="loading"
        @click="loadRoot(true)"
      >
        <RefreshCw :size="12" :class="{ 'is-spinning': loading }" aria-hidden="true" />
      </button>
    </div>

    <p v-if="failed" class="doc-tree-error" role="alert">{{ t('documents.treeFailed') }}</p>

    <div class="doc-tree-rows" role="tree" :aria-label="t('documents.tree')">
      <button
        v-for="row in rows"
        :key="row.node.path"
        type="button"
        class="doc-tree-row"
        :class="{ 'is-dir': row.node.isDir, 'is-selected': row.node.path === selected }"
        :style="{ paddingLeft: `${6 + row.depth * 12}px` }"
        :aria-expanded="row.node.isDir ? row.node.expanded : undefined"
        :title="row.node.path"
        @click="toggle(row.node)"
      >
        <ChevronRight
          v-if="row.node.isDir"
          class="doc-tree-chevron"
          :class="{ 'is-open': row.node.expanded }"
          :size="12"
          aria-hidden="true"
        />
        <span v-else class="doc-tree-chevron-spacer" aria-hidden="true" />
        <FolderOpen v-if="row.node.isDir && row.node.expanded" :size="12" aria-hidden="true" />
        <Folder v-else-if="row.node.isDir" :size="12" aria-hidden="true" />
        <FileText v-else :size="12" aria-hidden="true" />
        <span class="doc-tree-name">{{ row.node.name }}</span>
      </button>

      <p v-if="!loading && rows.length === 0 && !failed" class="doc-tree-empty">{{ t('documents.treeEmpty') }}</p>
    </div>
  </div>
</template>
