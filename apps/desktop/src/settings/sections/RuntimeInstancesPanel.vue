<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Info, Search, Shield } from '@lucide/vue'
import { UiBadge, UiButton, UiInput, UiLabel, UiSheet } from '@/components/ui'
import { api as baseApi, type AgentRuntimeInstanceDto, type AgentRuntimePolicyDto } from '@/api'
import { scopedApi } from '@/lib/storageScope'
const api = scopedApi(baseApi, () => 'user')
import { generatedApi as baseGeneratedApi } from '@/generated/client'
const generatedApi = scopedApi(baseGeneratedApi, () => 'user')
import { useNotifications } from '@/composables/useNotifications'
import { useStatusLabels } from '@/lib/statusLabels'

const { t } = useI18n()
const { instanceStatusLabel } = useStatusLabels()
const { notify } = useNotifications()

const runtimeInstances = ref<AgentRuntimeInstanceDto[]>([])
const runtimeLoaded = ref(false)
const runtimeSessionFilter = ref('')
const runtimeStatusFilter = ref('all')
const runtimePage = ref(1)
const runtimePageSize = ref(10)
const runtimeTimer: ReturnType<typeof setInterval> | null = null
const runtimeControlBusy = ref<string | null>(null)
const showReassignSheet = ref(false)
const reassignForm = ref({ session_id: '', interaction_id: '', target_run_id: '' })

/**
 * The policy ceilings that decide whether a legitimate run may continue: nesting depth, agents
 * per run, parallel runs per session, retries, revision rounds, context window and the call
 * fuse. All of them live in runtime.toml only, so a run that stopped because one of them was
 * reached left the user with nothing to look at. This is that surface — read-only, because the
 * document is the editing authority, and marked where a value was changed from the shipped one.
 */
const runtimePolicy = ref<AgentRuntimePolicyDto | null>(null)
const runtimePolicyLoaded = ref(false)
const runtimePolicyFailed = ref(false)

interface PolicyRow { key: string; label: string; value: string; help: string; changed: boolean }

const runtimePolicyRows = computed<PolicyRow[]>(() => {
  const policy = runtimePolicy.value
  // The proxy-based API doubles answer `{}`; anything that is not the full shape is "no data".
  if (!policy?.spawn || !policy?.scheduling || !policy?.supervision || !policy?.context || !policy?.tools) return []
  const deviations = new Set(policy.deviations ?? [])
  const disabled = t('settings.runtimeCeilings.disabled')
  const rows: Omit<PolicyRow, 'changed'>[] = [
    { key: 'spawn.max_depth', label: t('settings.runtimeCeilings.depth'), value: String(policy.spawn.max_depth), help: t('settings.runtimeCeilings.depthHint') },
    { key: 'spawn.max_agents_per_run', label: t('settings.runtimeCeilings.agentsPerRun'), value: String(policy.spawn.max_agents_per_run), help: t('settings.runtimeCeilings.agentsPerRunHint') },
    { key: 'spawn.max_parallel_workers', label: t('settings.runtimeCeilings.parallelWorkers'), value: String(policy.spawn.max_parallel_workers), help: t('settings.runtimeCeilings.parallelWorkersHint') },
    { key: 'scheduling.max_active_runs_per_session', label: t('settings.runtimeCeilings.activeRuns'), value: String(policy.scheduling.max_active_runs_per_session), help: t('settings.runtimeCeilings.activeRunsHint') },
    { key: 'scheduling.worker_retry_limit', label: t('settings.runtimeCeilings.workerRetries'), value: String(policy.scheduling.worker_retry_limit), help: t('settings.runtimeCeilings.workerRetriesHint') },
    { key: 'supervision.max_revision_rounds', label: t('settings.runtimeCeilings.revisionRounds'), value: String(policy.supervision.max_revision_rounds), help: t('settings.runtimeCeilings.revisionRoundsHint') },
    { key: 'context.default_token_budget', label: t('settings.runtimeCeilings.contextWindow'), value: String(policy.context.default_token_budget), help: t('settings.runtimeCeilings.contextWindowHint') },
    {
      key: 'context.run_token_budget',
      label: t('settings.runtimeCeilings.runBudget'),
      value: policy.context.run_token_budget > 0 ? String(policy.context.run_token_budget) : disabled,
      help: t('settings.runtimeCeilings.runBudgetHint'),
    },
    { key: 'tools.max_tool_calls', label: t('settings.runtimeCeilings.toolCalls'), value: String(policy.tools.max_tool_calls), help: t('settings.runtimeCeilings.toolCallsHint') },
  ]
  return rows.map((row) => ({ ...row, changed: deviations.has(row.key) }))
})

async function loadRuntimePolicy() {
  try {
    runtimePolicy.value = await api.getAgentRuntimePolicy()
    runtimePolicyFailed.value = false
  } catch {
    // The instance list stays useful without the ceilings; a failed report must not blank it.
    runtimePolicyFailed.value = true
  } finally {
    runtimePolicyLoaded.value = true
  }
}

const runtimeStatusOptions = computed(() => ['all', ...Array.from(new Set(runtimeInstances.value.map((r) => String(r.status ?? '')).filter(Boolean)))])
const filteredRuntimeInstances = computed(() => {
  const qs = runtimeSessionFilter.value.trim().toLowerCase()
  const st = runtimeStatusFilter.value
  return runtimeInstances.value.filter((r) => {
    if (st !== 'all' && String(r.status) !== st) return false
    if (qs && !String(r.session_id ?? r.run_id ?? '').toLowerCase().includes(qs)) return false
    return true
  })
})
const runtimeTotalPages = computed(() => Math.max(1, Math.ceil(filteredRuntimeInstances.value.length / runtimePageSize.value)))
const pagedRuntimeInstances = computed(() => {
  const start = (runtimePage.value - 1) * runtimePageSize.value
  return filteredRuntimeInstances.value.slice(start, start + runtimePageSize.value)
})

watch([runtimeSessionFilter, runtimeStatusFilter], () => { runtimePage.value = 1 })
watch(filteredRuntimeInstances, () => { if (runtimePage.value > runtimeTotalPages.value) runtimePage.value = runtimeTotalPages.value })

function readinessVariant(status?: string): 'default' | 'secondary' | 'destructive' | 'outline' {
  const s = String(status ?? '')
  if (['running', 'completed'].includes(s)) return 'default'
  if (['failed', 'cancelled', 'blocked'].includes(s)) return 'destructive'
  if (['queued', 'pending', 'waiting'].includes(s)) return 'outline'
  return 'secondary'
}

async function loadRuntimeInstances() {
  // Both halves are independent reads: a policy failure must not blank the instance list,
  // and the ceilings are worth showing even when the list query fails.
  void loadRuntimePolicy()
  try {
    runtimeInstances.value = await api.listRuntimeInstances()
    runtimeLoaded.value = true
  } catch (e) {
    runtimeLoaded.value = true
    notify.error(e, { title: t('agentCenter.runtimeLoadFailed') })
  }
}

async function controlInstance(runId: string, action: 'pause' | 'resume' | 'cancel') {
  const labels: Record<string, string> = { pause: t('settings.pauseAction'), resume: t('settings.resumeAction'), cancel: t('settings.cancelAction') }
  runtimeControlBusy.value = `${runId}:${action}`
  try {
    await generatedApi.controlRun(runId, { action })
    notify.success(t('settings.runControlDone', { action: labels[action] }))
    await loadRuntimeInstances()
  } catch (e) {
    notify.error(e, { title: `${labels[action]} ✕` })
  } finally {
    runtimeControlBusy.value = null
  }
}

function openReassignForm(targetRunId: string) {
  reassignForm.value = { session_id: '', interaction_id: '', target_run_id: targetRunId }
  showReassignSheet.value = true
}

async function submitReassign() {
  const { session_id, interaction_id, target_run_id } = reassignForm.value
  if (!session_id.trim() || !interaction_id.trim() || !target_run_id.trim()) {
    notify.error(new Error(t('settings.reassignFieldsRequired')))
    return
  }
  try {
    await api.reassignInteraction(session_id.trim(), interaction_id.trim(), { target_run_id: target_run_id.trim() })
    notify.success(t('settings.reassignDone'))
    showReassignSheet.value = false
    await loadRuntimeInstances()
  } catch (e) {
    notify.error(e, { title: t('settings.reassignFailed') })
  }
}

onBeforeUnmount(() => { if (runtimeTimer) clearInterval(runtimeTimer) })

defineExpose({ loadRuntimeInstances })
</script>

<template>
  <section class="center-resource-section agent-runtime-panel">
    <div class="center-resource-heading">
      <div>
        <h3>{{ t('settings.runtimeInstances') }}</h3>
        <p>{{ t('settings.runtimePanelHint') }}</p>
      </div>
      <UiBadge variant="outline">{{ runtimeInstances.length }}</UiBadge>
    </div>

    <!-- Policy ceilings: the numbers that can stop a legitimate run. Read-only here because
         runtime.toml stays the editing authority; a changed value is marked, not clipped. -->
    <div class="ac-policy-card">
      <div class="ac-policy-head">
        <Shield :size="14" />
        <strong>{{ t('settings.runtimeCeilings.title') }}</strong>
        <UiBadge v-if="runtimePolicy" variant="outline">{{ t('settings.runtimeCeilings.revision', { revision: runtimePolicy.revision }) }}</UiBadge>
      </div>
      <p class="ac-policy-hint">{{ t('settings.runtimeCeilings.hint') }}</p>
      <p v-if="runtimePolicyFailed" class="ac-policy-empty">{{ t('settings.runtimeCeilings.unavailable') }}</p>
      <p v-else-if="runtimePolicyLoaded && runtimePolicyRows.length === 0" class="ac-policy-empty">{{ t('settings.runtimeCeilings.unavailable') }}</p>
      <div v-else class="ac-policy-grid">
        <div v-for="row in runtimePolicyRows" :key="row.key" class="ac-policy-row">
          <span class="ac-policy-label" :title="row.help">{{ row.label }}</span>
          <strong class="ac-policy-value">{{ row.value }}</strong>
          <UiBadge v-if="row.changed" variant="secondary">{{ t('settings.runtimeCeilings.changed') }}</UiBadge>
        </div>
      </div>
      <p v-if="runtimePolicy && runtimePolicyRows.length > 0" class="ac-policy-source">
        {{ t('settings.runtimeCeilings.editHint') }} <code>{{ runtimePolicy.source_path }}</code>
      </p>
    </div>

    <div class="model-provider-toolbar ac-runtime-toolbar">
      <div class="model-provider-search">
        <Search :size="15" />
        <UiInput v-model="runtimeSessionFilter" :placeholder="t('agentCenter.filter.searchInstances')" />
      </div>
      <div class="model-provider-filters" role="group" :aria-label="t('settings.runtimeStatusFilter')">
        <button v-for="opt in runtimeStatusOptions" :key="opt" :class="{ active: runtimeStatusFilter === opt }" :aria-pressed="runtimeStatusFilter === opt" @click="runtimeStatusFilter = opt">
          {{ opt === 'all' ? t('settings.allStatuses') : instanceStatusLabel(opt) }}
        </button>
      </div>
    </div>

    <div v-if="runtimeLoaded && filteredRuntimeInstances.length === 0" class="model-provider-empty">
      <Info :size="24" />
      <span>{{ t('agentCenter.runtimeInfo.noInstances') }}</span>
    </div>

    <div v-else class="ac-runtime-list">
      <div v-for="inst in pagedRuntimeInstances" :key="inst.id" class="ac-instance-row">
        <div class="ac-instance-head">
          <strong>{{ inst.agent_name ?? inst.agent_id ?? inst.id.slice(0, 8) }}</strong>
          <UiBadge :variant="readinessVariant(inst.status)">{{ instanceStatusLabel(inst.status) }}</UiBadge>
          <span class="ac-instance-ids">{{ t('settings.instanceIds', { run: inst.run_id.slice(0, 8), session: String(inst.session_id ?? '—').slice(0, 8) }) }}</span>
        </div>
        <div v-if="inst.source_definition || inst.frozen_version || inst.recent_actual_model" class="ac-instance-evidence">
          <span v-if="inst.source_definition">
            {{ t('agentCenter.runtimeInfo.sourceDefinition') }}: {{ inst.source_definition.display_name }} · {{ inst.source_definition.source_kind }}<template v-if="inst.source_definition.managed"> · {{ t('settings.agentSourceManaged') }}</template>
          </span>
          <span v-if="inst.frozen_version">
            {{ t('agentCenter.runtimeInfo.frozenVersion') }}: {{ inst.frozen_version.agent_version_id.slice(0, 8) }} · {{ inst.frozen_version.content_hash.slice(0, 8) }}
          </span>
          <span v-if="inst.recent_actual_model">
            {{ t('agentCenter.runtimeInfo.recentModel') }}: {{ inst.recent_actual_model.provider_instance_id }}{{ inst.recent_actual_model.model ? ` · ${inst.recent_actual_model.model}` : '' }} · {{ inst.recent_actual_model.strategy_source }}<template v-if="inst.recent_actual_model.fallback_position > 0"> · {{ t('settings.fallbackPosition', { n: inst.recent_actual_model.fallback_position }) }}</template>
          </span>
          <span v-if="inst.fallback_summary">
            {{ t('agentCenter.runtimeInfo.fallbackSummary') }}: {{ inst.fallback_summary.attempts - inst.fallback_summary.failed_attempts }}/{{ inst.fallback_summary.attempts }}<template v-if="inst.fallback_summary.used_fallback"> · {{ t('agentCenter.runtimeInfo.usedFallback') }}</template>
          </span>
        </div>
        <div class="ac-instance-actions">
          <UiButton size="xs" variant="outline" :disabled="runtimeControlBusy === `${inst.run_id}:pause`" @click="controlInstance(inst.run_id, 'pause')">{{ t('agentCenter.runtimeInfo.actionPause') }}</UiButton>
          <UiButton size="xs" variant="outline" :disabled="runtimeControlBusy === `${inst.run_id}:resume`" @click="controlInstance(inst.run_id, 'resume')">{{ t('agentCenter.runtimeInfo.actionResume') }}</UiButton>
          <UiButton size="xs" variant="outline" :disabled="runtimeControlBusy === `${inst.run_id}:cancel`" @click="controlInstance(inst.run_id, 'cancel')">{{ t('agentCenter.runtimeInfo.actionCancel') }}</UiButton>
          <UiButton size="xs" variant="ghost" @click="openReassignForm(inst.run_id)">{{ t('agentCenter.runtimeInfo.actionSteer') }}</UiButton>
        </div>
      </div>

      <div class="ac-runtime-pager">
        <UiButton size="xs" variant="outline" :disabled="runtimePage <= 1" @click="runtimePage = Math.max(1, runtimePage - 1)">{{ t('settings.prevPage') }}</UiButton>
        <span class="quiet">{{ runtimePage }} / {{ runtimeTotalPages }}</span>
        <UiButton size="xs" variant="outline" :disabled="runtimePage >= runtimeTotalPages" @click="runtimePage = Math.min(runtimeTotalPages, runtimePage + 1)">{{ t('settings.nextPage') }}</UiButton>
      </div>
    </div>

    <UiSheet :open="showReassignSheet" side="right" @update:open="showReassignSheet = $event">
      <div class="ac-sheet-body">
        <h3>{{ t('settings.reassignTitle') }}</h3>
        <p class="quiet">{{ t('settings.reassignHint') }}</p>
        <div><UiLabel>{{ t('settings.sessionIdLabel') }}</UiLabel><UiInput v-model="reassignForm.session_id" placeholder="session_id" /></div>
        <div><UiLabel>{{ t('settings.interactionIdLabel') }}</UiLabel><UiInput v-model="reassignForm.interaction_id" placeholder="interaction_id" /></div>
        <div><UiLabel>{{ t('settings.targetRunIdLabel') }}</UiLabel><UiInput v-model="reassignForm.target_run_id" placeholder="target_run_id" /></div>
        <div class="ac-sheet-actions">
          <UiButton size="sm" variant="outline" @click="showReassignSheet = false">{{ t('settings.cancel') }}</UiButton>
          <UiButton size="sm" @click="submitReassign">{{ t('settings.reassignConfirm') }}</UiButton>
        </div>
      </div>
    </UiSheet>
  </section>
</template>

<style scoped>
.agent-runtime-panel {
  display: grid;
  gap: 12px;
}
.ac-policy-card {
  border: 1px solid var(--border-muted);
  border-radius: 10px;
  padding: 12px;
  display: grid;
  gap: 8px;
  background: var(--surface-section);
}
.ac-policy-head {
  display: flex;
  align-items: center;
  gap: 6px;
}
.ac-policy-hint,
.ac-policy-empty {
  margin: 0;
  color: var(--text-muted);
  font-size: 11px;
}
.ac-policy-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 4px 16px;
}
.ac-policy-row {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  min-width: 0;
}
.ac-policy-label {
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: help;
}
.ac-policy-value {
  font-family: var(--font-mono);
  color: var(--text-primary);
  margin-left: auto;
}
.ac-policy-source {
  margin: 0;
  font-size: 11px;
  color: var(--text-muted);
  overflow-wrap: anywhere;
}
.ac-policy-source code {
  font-family: var(--font-mono);
}
.ac-runtime-list {
  display: grid;
  gap: 8px;
}
.ac-instance-row {
  border: 1px solid var(--border-muted);
  border-radius: 10px;
  padding: 12px;
  display: grid;
  gap: 6px;
  background: var(--surface-section);
}
.ac-instance-head {
  display: flex;
  gap: 6px;
  align-items: center;
  flex-wrap: wrap;
}
.ac-instance-ids {
  color: var(--text-muted);
  font-size: 11px;
  font-family: var(--font-mono);
}
.ac-instance-evidence {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 11px;
  color: var(--text-secondary);
}
.ac-instance-evidence > span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ac-instance-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.ac-runtime-pager {
  display: flex;
  gap: 8px;
  align-items: center;
  justify-content: center;
  margin-top: 8px;
}
.ac-sheet-body {
  display: grid;
  gap: 12px;
  min-width: 300px;
  padding: 4px 0;
}
.ac-sheet-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 10px;
}
.quiet {
  color: var(--text-muted);
}
</style>
