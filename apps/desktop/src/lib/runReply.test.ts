import { describe, it, expect } from 'vitest'
import { projectRunReply, type RunReply } from './runReply'
import type { SseChunk } from '@/generated/client'

const chunk = (kind: string, delta = ''): SseChunk => ({
  kind,
  payload: { delta },
  run_id: 'run-1',
  turn_id: 'turn-1',
  message_id: null,
  seq: 1,
  occurred_at: '2026-09-23T00:00:00Z',
})

describe('run reply projection', () => {
  it('appends every answer.delta frame into one growing answer', () => {
    let state: RunReply = ''
    const push = (kind: string, delta = '') => {
      const next = projectRunReply(state, chunk(kind, delta))
      if (next !== null) state = next
      return state
    }
    push('answer.started')
    expect(push('answer.delta', 'Hello ')).toBe('Hello ')
    expect(push('answer.delta', 'world')).toBe('Hello world')
  })

  it('restarts the answer when a retry begins and drops the withdrawn text', () => {
    let state: RunReply = projectRunReply('', chunk('answer.started'))!
    state = projectRunReply(state, chunk('answer.delta', 'partial failure'))!
    expect(state).toBe('partial failure')
    expect(projectRunReply(state, chunk('answer.failed'))).toBe('')
    state = projectRunReply('', chunk('answer.started'))!
    expect(projectRunReply(state, chunk('answer.delta', 'Hello '))).toBe('Hello ')
  })

  it('ignores frames that are not answer increments', () => {
    expect(projectRunReply('kept', chunk('done'))).toBeNull()
    expect(projectRunReply('kept', chunk('heartbeat'))).toBeNull()
    expect(projectRunReply('kept', chunk('answer.delta'))).toBe('kept')
  })

  it('shows a whole-text answer published by a path that never streamed', () => {
    // Core publishes an evidence fallback as a single answer.delta rather than a second kind,
    // so the client needs no replace step: the same append renders it.
    expect(projectRunReply('', chunk('answer.delta', 'fallback answer'))).toBe('fallback answer')
  })
})
