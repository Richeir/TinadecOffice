import { describe, expect, it } from 'vitest'
import {
  activityDurationMs,
  activityTone,
  formatActivityDuration,
  formatActivityMoment,
  isTerminalRunStatus,
  presentActivity,
} from './recentActivity'

const run = (status: string, created: string, updated = created) => ({ status, created_at: created, updated_at: updated })
const session = (at: string) => ({ created_at: at, updated_at: at })

describe('recent activity presentation', () => {
  it('maps the canonical run vocabulary onto one display tone per outcome', () => {
    const statuses = [
      'planning', 'understanding', 'executing', 'replanning', 'reviewing', 'paused',
      'awaiting_approval', 'awaiting_delegate', 'awaiting_user',
      'completed', 'failed', 'cancelled',
    ]
    expect(statuses.map(activityTone)).toEqual([
      'active', 'active', 'active', 'active', 'active', 'active',
      'awaiting', 'awaiting', 'awaiting',
      'completed', 'failed', 'cancelled',
    ])
    // A word outside the vocabulary is not a new state: it is the signal that Core knows something
    // this surface does not, so it stays honest instead of guessing.
    expect(activityTone('running')).toBe('unknown')
    expect(activityTone('')).toBe('idle')
    expect(activityTone(null)).toBe('idle')
  })

  it('measures a finished run by its own span and a live one against the clock', () => {
    expect(activityDurationMs(run('completed', '2026-10-21T10:00:00Z', '2026-10-21T10:05:30Z'), Date.now())).toBe(330_000)
    expect(activityDurationMs(run('executing', '2026-10-21T10:00:00Z', '2026-10-21T10:05:30Z'), Date.parse('2026-10-21T10:02:00Z'))).toBe(120_000)
    // An unreadable timestamp reports "not measured" rather than a made-up zero.
    expect(activityDurationMs(run('completed', 'not-a-date'), Date.now())).toBeNull()
    expect(activityDurationMs(null, Date.now())).toBeNull()
    expect(isTerminalRunStatus('cancelled')).toBe(true)
    expect(isTerminalRunStatus('awaiting_user')).toBe(false)
  })

  it('formats durations and moments through Intl, so every locale reads them natively', () => {
    expect(formatActivityDuration(45_000, 'en')).toBe('45s')
    expect(formatActivityDuration(3_900_000, 'en')).toBe('1h 5m')
    expect(formatActivityDuration(3_900_000, 'zh-CN')).toBe('1小时 5分钟')
    expect(formatActivityMoment('2026-10-21T07:00:00Z', Date.parse('2026-10-21T10:00:00Z'), 'en')).toBe('3 hours ago')
    expect(formatActivityMoment('2026-10-21T07:00:00Z', Date.parse('2026-10-21T10:00:00Z'), 'zh-CN')).toBe('3小时前')
    expect(formatActivityMoment('not-a-date', Date.now(), 'en')).toBe('')
  })

  it('falls back to when the conversation was last touched when no run can be measured', () => {
    const now = Date.parse('2026-10-21T10:00:00Z')
    expect(presentActivity(null, session('2026-10-21T07:00:00Z'), now, 'en'))
      .toEqual({ tone: 'idle', durationMs: null, moment: '3 hours ago', measure: '3 hours ago' })
    const done = presentActivity(run('completed', '2026-10-21T09:00:00Z', '2026-10-21T09:02:00Z'), session('2026-10-21T09:02:00Z'), now, 'en')
    expect(done.tone).toBe('completed')
    expect(done.measure).toBe('2m')
    // An unread roster is not an idle task: the card says so instead of inventing "no task".
    expect(presentActivity(null, session('2026-10-21T09:02:00Z'), now, 'en', false).tone).toBe('unknown')
  })
})
