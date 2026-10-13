<script setup lang="ts">
import { Check, ChevronDown, Settings, Sparkles } from '@lucide/vue'
import { computed, onMounted, ref, watch } from 'vue'
import { onClickOutside } from '@vueuse/core'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { api, type ModelProviderInstanceDto, type ModelRouteDto } from '@/api'
import { aggregateModelCenterOverview } from '@/runtimeCenterView'
import { selectedStorage } from '@/lib/storageScope'
import { requestSettingsSection } from '@/lib/pageRequests'
import { useNotifications } from '@/composables/useNotifications'

/**
 * The default model, switchable from the composer. It is the model center's default (the chat
 * route) — one value, not a per-conversation choice — so switching here is the same as "set as
 * default" in the model center. Requests run in the current storage scope: a workspace that uses
 * the user's models writes the user file, one that keeps its own models writes its own copy;
 * either way, the model its conversations run on. The list is the model center's own projection
 * (provider models plus models named only on routes), so nothing configured there is missing.
 */
const { t } = useI18n()
const router = useRouter()
const { notify } = useNotifications()

const open = ref(false)
const busy = ref(false)
const providers = ref<ModelProviderInstanceDto[]>([])
const routes = ref<ModelRouteDto[]>([])
const root = ref<HTMLElement | null>(null)
let read = 0

const chatRoute = computed(() => routes.value.find(route => route.purpose === 'chat') ?? null)
const current = computed(() => chatRoute.value?.candidates[0] ?? null)
const models = computed(() => aggregateModelCenterOverview({ providers: providers.value, routes: routes.value, templates: [] }).models
  .filter(model => model.enabled))
const label = computed(() => {
  const candidate = current.value
  if (!candidate) return t('composer.modelSwitch.none')
  return candidate.model || providers.value.find(row => row.id === candidate.provider_instance_id)?.display_name || t('composer.modelSwitch.none')
})

async function load() {
  const sequence = ++read
  try {
    const [providerRows, routeRows] = await Promise.all([api.listModelProviders(), api.listModelRoutes()])
    if (sequence !== read) return
    providers.value = Array.isArray(providerRows) ? providerRows : []
    routes.value = Array.isArray(routeRows) ? routeRows : []
  } catch { /* keeps the last known list; the label says nothing it does not know */ }
}

async function choose(providerId: string, model: string) {
  if (busy.value) return
  if (current.value?.provider_instance_id === providerId && current.value.model === model) { open.value = false; return }
  busy.value = true
  try {
    await api.saveModelRoute('chat', { candidates: [{ provider_instance_id: providerId, model }] }, undefined,
      chatRoute.value?.revision != null ? { expected_revision: chatRoute.value.revision } : undefined)
    open.value = false
  } catch (error) {
    notify.error(error, { title: t('composer.modelSwitch.failed') })
  } finally {
    busy.value = false
    await load()
  }
}

function manage() {
  open.value = false
  requestSettingsSection('model')
  if (router.currentRoute.value.name !== 'settings') void router.push({ name: 'settings' })
}

function toggle() {
  open.value = !open.value
  if (open.value) void load()
}

onClickOutside(root, () => { open.value = false })
onMounted(() => { void load() })
watch(selectedStorage, () => { void load() })
</script>

<template>
  <div ref="root" class="composer-model-switch">
    <button
      type="button"
      class="composer-model-trigger"
      :title="t('composer.modelSwitch.hint')"
      aria-haspopup="listbox"
      :aria-expanded="open"
      data-testid="composer-model-switch"
      @click="toggle"
    ><Sparkles :size="14" aria-hidden="true" /><span class="composer-model-label">{{ label }}</span><ChevronDown :size="12" aria-hidden="true" /></button>
    <div v-if="open" class="composer-model-menu" role="listbox" :aria-label="t('composer.modelSwitch.hint')">
      <button
        v-for="model in models"
        :key="model.id"
        type="button"
        role="option"
        class="composer-model-option"
        :aria-selected="current?.provider_instance_id === model.provider_instance_id && current?.model === model.model_id"
        :disabled="busy"
        :data-testid="`composer-model-${model.provider_instance_id}:${model.model_id}`"
        @click="choose(model.provider_instance_id, model.model_id)"
      >
        <span class="composer-model-option-text"><strong>{{ model.display_name || model.model_id }}</strong><small>{{ model.provider_display_name }}</small></span>
        <Check v-if="current?.provider_instance_id === model.provider_instance_id && current?.model === model.model_id" :size="14" aria-hidden="true" />
      </button>
      <p v-if="!models.length" class="composer-model-empty">{{ t('composer.modelSwitch.empty') }}</p>
      <button type="button" class="composer-model-manage" @click="manage"><Settings :size="13" aria-hidden="true" />{{ t('composer.modelSwitch.manage') }}</button>
    </div>
  </div>
</template>

<style scoped>
.composer-model-switch { position: relative; }
.composer-model-trigger { display: inline-flex; align-items: center; gap: 4px; max-width: 14rem; padding: 4px 8px; border: none; border-radius: 6px; background: transparent; color: var(--text-secondary); font-size: 12px; cursor: pointer; }
.composer-model-trigger:hover { background: var(--surface-hover); color: var(--text-primary); }
.composer-model-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.composer-model-menu { position: absolute; bottom: calc(100% + 6px); left: 0; z-index: 60; display: flex; flex-direction: column; width: 16rem; max-height: 18rem; overflow-y: auto; padding: 4px; border: 1px solid var(--border-card); border-radius: 10px; background: var(--surface-raised); box-shadow: 0 8px 24px rgb(0 0 0 / 0.18); }
.composer-model-option { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 8px; border: none; border-radius: 6px; background: transparent; color: var(--text-primary); text-align: left; cursor: pointer; }
.composer-model-option:hover, .composer-model-option[aria-selected='true'] { background: var(--surface-hover); }
.composer-model-option-text { display: flex; flex-direction: column; min-width: 0; }
.composer-model-option-text strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; font-weight: 500; }
.composer-model-option-text small { color: var(--text-muted); font-size: 11px; }
.composer-model-empty { margin: 0; padding: 8px; color: var(--text-muted); font-size: 12px; }
.composer-model-manage { display: flex; align-items: center; gap: 6px; margin-top: 4px; padding: 6px 8px; border: none; border-top: 1px solid var(--border-muted); border-radius: 0 0 6px 6px; background: transparent; color: var(--text-secondary); font-size: 12px; cursor: pointer; }
.composer-model-manage:hover { color: var(--text-primary); }
</style>
