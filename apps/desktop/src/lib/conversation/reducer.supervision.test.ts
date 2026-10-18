import { describe, expect, it } from 'vitest'
import { applyEvent, createFeedState } from './reducer'
import type { EventEnvelope } from '@/api'

function ev(seq: number, type: string, payload: Record<string, unknown> = {}): EventEnvelope {
  return { seq, ts: '2026-10-18T08:42:51Z', type, run_id: 'run-1', payload } as EventEnvelope
}

/**
 * A supervision escalation is run state, not a log line. The run is parked until the person
 * decides, so the gate has to survive refolding and reopening the session: if it only existed
 * as an event entry, a reader who came back later could not find the decision they owe.
 */
describe('supervision escalation', () => {
  it('records the reasons and options Core is waiting on', () => {
    const state = createFeedState()
    applyEvent(state, ev(1, 'supervision.user_review.requested', {
      decision: 'escalate',
      reasons: ['no supervisor in the frozen roster', 'task_outcome:research:blocked'],
      options: ['continue', 'correct', 'cancel'],
      brief: {
        total_tasks: 4,
        completed_tasks: 2,
        blocked_tasks: 1,
        failed_tasks: 0,
        pending_tasks: 1,
        unmet_criteria: 2,
        revision_round: 2,
        max_revision_rounds: 2,
        supervisor_required: true,
        supervisor_available: false,
      },
    }))
    const record = state.runs.get('run-1')!
    expect(record.review).not.toBeNull()
    expect(record.review!.reasons).toEqual(['no supervisor in the frozen roster', 'task_outcome:research:blocked'])
    expect(record.review!.options).toEqual(['continue', 'correct', 'cancel'])
    expect(record.review!.brief).toEqual({
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
    })
  })

  it('is not lost when the escalation frame is replayed', () => {
    const state = createFeedState()
    const frame = ev(7, 'supervision.user_review.requested', { reasons: ['r'], options: ['cancel'] })
    applyEvent(state, frame)
    applyEvent(state, frame)
    expect(state.runs.get('run-1')!.review!.reasons).toEqual(['r'])
  })

  it('stops asking once the person decides', () => {
    const state = createFeedState()
    applyEvent(state, ev(1, 'supervision.user_review.requested', { reasons: ['r'], options: ['cancel'] }))
    applyEvent(state, ev(2, 'supervision.user_decision', { decision: 'continue' }))
    expect(state.runs.get('run-1')!.review).toBeNull()
  })

  it('stops asking when an accepted correction resumes the run', () => {
    const state = createFeedState()
    applyEvent(state, ev(1, 'supervision.user_review.requested', { reasons: ['r'], options: ['cancel'] }))
    applyEvent(state, ev(2, 'context.goal_adjusted', {}))
    expect(state.runs.get('run-1')!.review).toBeNull()
  })

  it('keeps the gate through unrelated events', () => {
    const state = createFeedState()
    applyEvent(state, ev(1, 'supervision.user_review.requested', { reasons: ['r'], options: ['continue'] }))
    applyEvent(state, ev(2, 'tool.execution.requested', { execution_id: 'e-1', tool_id: 'read_file' }))
    expect(state.runs.get('run-1')!.review!.reasons).toEqual(['r'])
  })

  it('tolerates a payload without reasons or options', () => {
    const state = createFeedState()
    applyEvent(state, ev(1, 'supervision.user_review.requested', {}))
    const record = state.runs.get('run-1')!
    expect(record.review).not.toBeNull()
    expect(record.review!.reasons).toEqual([])
    expect(record.review!.options).toEqual([])
    expect(record.review!.brief).toBeNull()
  })
})
