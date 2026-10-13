<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { UiButton } from '@/components/ui'
import { api } from '@/api'
import { selectedStorage } from '@/lib/storageScope'
import { useNotifications } from '@/composables/useNotifications'

/**
 * The model center always edits the user scope. A workspace keeps its own models.toml, copied
 * from the user scope when the workspace was created and independent after that, and its
 * conversations run on that copy. Without saying so, a model set up here looked "unusable" in
 * the workspace, and one deleted here stayed in use there. While a workspace is open this says
 * which copy its conversations use, whether it still matches, and offers to replace it with the
 * user configuration — an explicit, confirmed overwrite, never an automatic one.
 */
const emit = defineEmits<{ synced: [] }>()
const { t } = useI18n()
const { notify, confirm } = useNotifications()

const scopeId = computed(() => selectedStorage.value)
const scopeName = ref('')
const differs = ref<boolean | null>(null)
const busy = ref(false)
let read = 0

async function inspect() {
  const current = ++read
  differs.value = null
  if (scopeId.value === 'user') return
  const storageId = scopeId.value
  try {
    const [scopes, user, workspace] = await Promise.all([
      api.listStorageScopes(),
      api.getConfigurationDocument('user', 'models'),
      api.getConfigurationDocument(storageId, 'models'),
    ])
    if (current !== read) return
    const scope = scopes.find(row => row.storage_id === storageId)
    scopeName.value = scope?.workspace?.name || scope?.project_root?.split(/[\\/]/).filter(Boolean).at(-1) || storageId
    differs.value = user.content_hash !== workspace.content_hash
  } catch {
    // Unknown, not "in sync": the notice still names the workspace copy, without a verdict.
    if (current === read) differs.value = null
  }
}

async function sync() {
  const storageId = scopeId.value
  if (storageId === 'user' || busy.value) return
  if (!await confirm({
    title: t('settings.modelScope.syncTitle', { name: scopeName.value }),
    message: t('settings.modelScope.syncMessage', { name: scopeName.value }),
    confirmLabel: t('settings.modelScope.syncConfirm'),
    cancelLabel: t('settings.cancel'),
    destructive: true,
  })) return
  busy.value = true
  try {
    // Read both again: the copy may have changed since the notice was drawn, and the
    // conditional save below must name the bytes that are actually being replaced.
    const [user, workspace] = await Promise.all([
      api.getConfigurationDocument('user', 'models'),
      api.getConfigurationDocument(storageId, 'models'),
    ])
    if (user.content_hash !== workspace.content_hash) {
      const check = await api.validateConfigurationDocument(storageId, 'models', user.text)
      if (!check.valid) throw new Error(t('settings.modelScope.syncInvalid'))
      await api.saveConfigurationDocument(storageId, 'models', user.text, workspace.content_hash)
    }
    notify.success(t('settings.modelScope.synced', { name: scopeName.value }))
    emit('synced')
  } catch (error) {
    notify.error(error, { title: t('settings.modelScope.syncFailed') })
  } finally {
    busy.value = false
    await inspect()
  }
}

onMounted(() => { void inspect() })
watch(scopeId, () => { void inspect() })
defineExpose({ inspect })
</script>

<template>
  <div v-if="scopeId !== 'user'" class="model-scope-notice" role="status" data-testid="model-scope-notice">
    <p>
      {{ t('settings.modelScope.workspaceCopy', { name: scopeName || scopeId }) }}
      <strong v-if="differs === true" data-testid="model-scope-differs">{{ t('settings.modelScope.differs') }}</strong>
      <span v-else-if="differs === false" data-testid="model-scope-same">{{ t('settings.modelScope.same') }}</span>
    </p>
    <UiButton
      v-if="differs !== false"
      size="sm"
      variant="outline"
      :disabled="busy"
      data-testid="model-scope-sync"
      @click="sync"
    >{{ t('settings.modelScope.sync') }}</UiButton>
  </div>
</template>

<style scoped>
.model-scope-notice { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 0 0 12px; padding: 8px 12px; border: 1px solid var(--border-card); border-radius: 10px; background: var(--surface-section); font-size: 12px; color: var(--text-secondary); }
.model-scope-notice p { margin: 0; }
.model-scope-notice strong { margin-left: 4px; color: var(--accent-warning); font-weight: 600; }
.model-scope-notice span { margin-left: 4px; }
</style>
