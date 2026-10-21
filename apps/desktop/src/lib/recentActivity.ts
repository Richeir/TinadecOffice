import type { OrchestrationRunDto } from '../api'

/**
 * Core 的 12 态词表（RunStatusMachine / Gateway `runStatuses.ts`）。这里只做归并，
 * 不新增状态词——出现词表外的值就是"需要看 Core 事实"的信号，原样报 unknown。
 */
const AWAITING = new Set(['awaiting_approval', 'awaiting_delegate', 'awaiting_user'])
const ACTIVE = new Set(['planning', 'understanding', 'executing', 'replanning', 'reviewing', 'paused'])
const TERMINAL = new Set(['completed', 'failed', 'cancelled'])

export type ActivityTone = 'awaiting' | 'active' | 'completed' | 'failed' | 'cancelled' | 'unknown' | 'idle'

export function isTerminalRunStatus(status: string): boolean {
  return TERMINAL.has(status.toLowerCase())
}

/** One display tone per canonical status. A missing run is idle, not "unknown". */
export function activityTone(status: string | null | undefined): ActivityTone {
  if (!status) return 'idle'
  const value = status.toLowerCase()
  if (AWAITING.has(value)) return 'awaiting'
  if (ACTIVE.has(value)) return 'active'
  if (TERMINAL.has(value)) return value as ActivityTone
  return 'unknown'
}

/**
 * How long the run has been going: finished−started for a terminal run, now−started while it
 * is still live. A run whose timestamps cannot be parsed reports null instead of a made-up 0.
 */
export function activityDurationMs(run: Pick<OrchestrationRunDto, 'created_at' | 'updated_at' | 'status'> | null, now: number): number | null {
  if (!run) return null
  const started = Date.parse(run.created_at)
  if (Number.isNaN(started)) return null
  const ended = isTerminalRunStatus(run.status) ? Date.parse(run.updated_at) : now
  if (Number.isNaN(ended)) return null
  return Math.max(0, ended - started)
}

// Durations and moments go through Intl so all five locales read them correctly without a
// translation key per unit.
function unit(value: number, u: 'hour' | 'minute' | 'second', locale: string): string {
  return new Intl.NumberFormat(locale, { style: 'unit', unit: u, unitDisplay: 'narrow' }).format(value)
}

export function formatActivityDuration(ms: number, locale: string): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  if (hours > 0) return minutes > 0 ? `${unit(hours, 'hour', locale)} ${unit(minutes, 'minute', locale)}` : unit(hours, 'hour', locale)
  if (minutes > 0) return unit(minutes, 'minute', locale)
  return unit(total % 60, 'second', locale)
}

/** "3 小时前" / "3 hours ago": the fallback when a session has no run to measure. */
export function formatActivityMoment(iso: string, now: number, locale: string): string {
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return ''
  const diff = at - now
  const size = Math.abs(diff)
  const [value, unitName] = size < 60_000 ? [Math.round(diff / 1000), 'second']
    : size < 3_600_000 ? [Math.round(diff / 60_000), 'minute']
      : size < 86_400_000 ? [Math.round(diff / 3_600_000), 'hour']
        : size < 2_592_000_000 ? [Math.round(diff / 86_400_000), 'day']
          : [Math.round(diff / 2_592_000_000), 'month']
  return new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(value, unitName as Intl.RelativeTimeFormatUnit)
}

export interface ActivityFacts {
  tone: ActivityTone
  /** Measured run duration, null when there is no run to measure. */
  durationMs: number | null
  /** Relative moment of the session's last touch, shown instead of a duration. */
  moment: string
  /** Whatever the card prints in its fact slot: the run's duration, else the moment. */
  measure: string
}

export function presentActivity(
  run: Pick<OrchestrationRunDto, 'created_at' | 'updated_at' | 'status'> | null,
  session: { created_at: string; updated_at: string },
  now: number,
  locale: string,
  /** False while the roster has not been read (or could not be): "unknown", not "no task". */
  read = true,
): ActivityFacts {
  const durationMs = activityDurationMs(run, now)
  const moment = formatActivityMoment(session.updated_at || session.created_at, now, locale)
  return {
    tone: read ? activityTone(run?.status) : 'unknown',
    durationMs,
    moment,
    measure: durationMs === null ? moment : formatActivityDuration(durationMs, locale),
  }
}
