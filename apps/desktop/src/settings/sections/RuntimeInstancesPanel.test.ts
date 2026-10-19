// @vitest-environment happy-dom
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { beforeEach, expect, it, vi } from 'vitest'
import { createI18n } from 'vue-i18n'
import en from '@/locales/en'

/**
 * The runtime tab has to answer "which number stopped my run?" without the user opening
 * runtime.toml. These assertions pin the read-only policy block: every ceiling is shown, a value
 * an operator changed is marked as such, an unreadable report degrades to a note, and a policy
 * failure never blanks the instance list beside it.
 */
const mocks = vi.hoisted(() => ({
  listRuntimeInstances: vi.fn(),
  getAgentRuntimePolicy: vi.fn(),
  controlRun: vi.fn(),
  notify: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}))
vi.mock('@/api', () => ({ api: mocks }))
vi.mock('@/generated/client', () => ({ generatedApi: { controlRun: mocks.controlRun } }))
vi.mock('@/lib/storageScope', () => ({ scopedApi: (api: unknown) => api }))
vi.mock('@/composables/useNotifications', () => ({ useNotifications: () => ({ notify: mocks.notify }) }))
// UI primitives are Vapor components; their own tests cover rendering. This fixture exercises
// what the panel reports, so plain vdom stubs keep it mountable.
vi.mock('@/components/ui', () => ({
  UiBadge: { template: '<span class="ui-badge"><slot /></span>' },
  UiButton: { template: '<button><slot /></button>' },
  UiInput: { props: ['modelValue'], template: '<input :value="modelValue" />' },
  UiLabel: { template: '<label><slot /></label>' },
  UiSheet: { props: ['open'], template: '<div class="ui-sheet"><slot /></div>' },
}))

const { default: RuntimeInstancesPanel } = await import('./RuntimeInstancesPanel.vue')

const global = { plugins: [createI18n({ legacy: false, locale: 'en', messages: { en } })] }

const policy = {
  revision: 7,
  content_hash: 'abc123',
  loaded_at: '2026-10-20T00:00:00Z',
  source_path: 'C:/user/config/runtime.toml',
  document_id: 'runtime',
  diagnostic: { state: 'ready', detail: 'Loaded runtime configuration v7.', checked_at: '2026-10-20T00:00:00Z' },
  defaults_available: true,
  deviations: ['scheduling.max_active_runs_per_session'],
  spawn: { max_depth: 2, max_agents_per_run: 16, max_parallel_workers: 4 },
  scheduling: { max_active_runs_per_session: 4, worker_retry_limit: 2, preserve_partial_results: true },
  supervision: { required_before_final: true, max_revision_rounds: 2 },
  context: { default_token_budget: 131072, task_token_budget: 0, effective_task_token_budget: 0, run_token_budget: 0, recent_message_limit: 128 },
  tools: { max_tool_calls: 500, max_tool_rounds: 0, default_timeout_seconds: 600 },
}

const instance = {
  id: 'i-1', run_id: 'r-1', agent_name: 'search#1', status: 'running',
  source_definition: null, frozen_version: null, recent_actual_model: null, fallback_summary: null,
}

function mountPanel(): VueWrapper {
  return mount(RuntimeInstancesPanel, { global })
}

async function load(wrapper: VueWrapper) {
  await (wrapper.vm as unknown as { loadRuntimeInstances: () => Promise<void> }).loadRuntimeInstances()
  await flushPromises()
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.listRuntimeInstances.mockResolvedValue([instance])
  mocks.getAgentRuntimePolicy.mockResolvedValue(policy)
})

it('reports every policy ceiling, and marks the ones an operator changed', async () => {
  const wrapper = mountPanel()
  await load(wrapper)

  const rows = wrapper.findAll('.ac-policy-row')
  expect(rows).toHaveLength(9)
  const byLabel = (text: string) => rows.find((row) => row.find('.ac-policy-label').text() === text)!
  expect(byLabel('Nesting depth (max_depth)').find('.ac-policy-value').text()).toBe('2')
  expect(byLabel('Agents per run').find('.ac-policy-value').text()).toBe('16')
  expect(byLabel('Context window').find('.ac-policy-value').text()).toBe('131072')
  // 0 means "disabled" for the run-wide fuse, not "zero tokens".
  expect(byLabel('Run token fuse').find('.ac-policy-value').text()).toBe('off')

  expect(byLabel('Active runs per session').text()).toContain('customized')
  expect(byLabel('Agents per run').text()).not.toContain('customized')
  // The document that owns these numbers is named, so the report is actionable.
  expect(wrapper.get('.ac-policy-source').text()).toContain('C:/user/config/runtime.toml')
  wrapper.unmount()
})

it('degrades to a note when the payload is not the full report', async () => {
  // The settings smoke test mocks every `get*` as `{}`; a partial payload must not throw.
  mocks.getAgentRuntimePolicy.mockResolvedValue({})
  const wrapper = mountPanel()
  await load(wrapper)

  expect(wrapper.findAll('.ac-policy-row')).toHaveLength(0)
  expect(wrapper.text()).toContain('runtime policy could not be read')
  wrapper.unmount()
})

it('keeps the instance list when the policy request fails', async () => {
  mocks.getAgentRuntimePolicy.mockRejectedValue(new Error('offline'))
  const wrapper = mountPanel()
  await load(wrapper)

  expect(wrapper.findAll('.ac-instance-row')).toHaveLength(1)
  expect(wrapper.text()).toContain('runtime policy could not be read')
  // A read failure is not an error to interrupt the user with.
  expect(mocks.notify.error).not.toHaveBeenCalled()
  wrapper.unmount()
})
