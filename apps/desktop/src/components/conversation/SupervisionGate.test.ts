// @vitest-environment happy-dom
import { mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { describe, expect, it, vi } from 'vitest'
import en from '@/locales/en'
import SupervisionGate from './SupervisionGate.vue'
import type { SupervisionReview } from '@/lib/conversation/supervision'

vi.mock('@/controllers/HomeController', () => ({
  homeController: { currentSession: { value: { id: 'session-1' } } },
}))
vi.mock('@/composables/useNotifications', () => ({
  useNotifications: () => ({ notify: { error: vi.fn() } }),
}))
vi.mock('@/api', () => ({
  api: { createInteraction: vi.fn(), controlRun: vi.fn() },
}))

const i18n = createI18n({ legacy: false, locale: 'en', messages: { en } })
const global = { plugins: [i18n] }

describe('SupervisionGate review brief', () => {
  it('renders structured facts, guidance and option meanings', () => {
    const review: SupervisionReview = {
      runId: 'run-1',
      reasons: ['task_outcome:backend:blocked — evidence'],
      options: ['continue', 'correct', 'cancel'],
      brief: {
        totalTasks: 4,
        completedTasks: 2,
        blockedTasks: 1,
        failedTasks: 0,
        pendingTasks: 1,
        unmetCriteria: 2,
        revisionRound: 2,
        maxRevisionRounds: 2,
        supervisorRequired: true,
        supervisorAvailable: false,
      },
    }
    const wrapper = mount(SupervisionGate, { props: { review }, global })

    const brief = wrapper.get('[data-testid="supervision-brief"]')
    expect(brief.text()).toContain('2 of 4 tasks completed')
    expect(brief.text()).toContain('1 blocked')
    expect(brief.text()).toContain('1 still pending')
    expect(brief.text()).toContain('2 success criteria lack evidence')
    expect(brief.text()).toContain('No supervisor model was available')
    expect(brief.text()).toContain('Automatic revision budget used: 2/2')
    expect(brief.get('details').text()).toContain('task_outcome:backend:blocked')

    const actions = wrapper.findAll('[data-testid="supervision-decision"]')
    expect(actions).toHaveLength(3)
    expect(actions[0]!.text()).toContain('Keep the current evidence')
    expect(actions[1]!.text()).toContain('Add guidance and replan')
    expect(actions[2]!.text()).toContain('Stop this run')
  })

  it('keeps the legacy reason list when an older event has no brief', () => {
    const wrapper = mount(SupervisionGate, {
      props: {
        review: {
          runId: 'run-2',
          reasons: ['legacy reason'],
          options: ['continue', 'cancel'],
        },
      },
      global,
    })
    expect(wrapper.find('[data-testid="supervision-brief"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="supervision-reasons"]').text()).toContain('legacy reason')
  })
})
