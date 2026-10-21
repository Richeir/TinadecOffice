import type { ModelInvocationDto } from '../api'
import { toDayKey } from './shareCard'

export const SIDEBAR_USAGE_DAYS = 7

export interface SidebarUsageBar {
  dayKey: string
  date: Date
  calls: number
  /** Null when no call in that day reported usage; never coerced to zero. */
  tokens: number | null
  /** Percent of the busiest day in the window, with a visible floor for any nonzero day. */
  height: number
  level: 'empty' | 'low' | 'medium' | 'high'
}

export interface SidebarUsage {
  bars: SidebarUsageBar[]
  calls: number
  total: number | null
  /** True when the page walk stopped before Core's cursor was exhausted. */
  truncated: boolean
}

/** Oldest first, so the sparkline ends on today. */
export function usageWindow(now = new Date(), days = SIDEBAR_USAGE_DAYS): Date[] {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  return Array.from({ length: days }, (_, index) => {
    const date = new Date(today)
    date.setDate(today.getDate() - (days - 1 - index))
    return date
  })
}

function reportedTokens(row: ModelInvocationDto): number | null {
  const total = typeof row.total_tokens === 'number' && Number.isFinite(row.total_tokens) ? row.total_tokens : null
  if (total !== null) return total
  const input = typeof row.input_tokens === 'number' && Number.isFinite(row.input_tokens) ? row.input_tokens : null
  const output = typeof row.output_tokens === 'number' && Number.isFinite(row.output_tokens) ? row.output_tokens : null
  if (input === null && output === null) return null
  return (input ?? 0) + (output ?? 0)
}

export function buildSidebarUsage(
  rows: ModelInvocationDto[],
  options: { now?: Date; days?: number; truncated?: boolean } = {},
): SidebarUsage {
  const window = usageWindow(options.now, options.days ?? SIDEBAR_USAGE_DAYS)
  const keys = new Set(window.map(date => toDayKey(date)))
  const buckets = new Map<string, { calls: number; tokens: number | null }>()
  for (const row of rows) {
    const startedAt = new Date(row.started_at)
    if (Number.isNaN(startedAt.getTime())) continue
    const key = toDayKey(startedAt)
    if (!keys.has(key)) continue
    const bucket = buckets.get(key) ?? { calls: 0, tokens: null }
    bucket.calls += 1
    const tokens = reportedTokens(row)
    if (tokens !== null) bucket.tokens = (bucket.tokens ?? 0) + tokens
    buckets.set(key, bucket)
  }

  const peak = Math.max(0, ...[...buckets.values()].map(bucket => bucket.tokens ?? 0))
  let total: number | null = null
  let calls = 0
  const bars = window.map(date => {
    const key = toDayKey(date)
    const bucket = buckets.get(key)
    calls += bucket?.calls ?? 0
    if (typeof bucket?.tokens === 'number') total = (total ?? 0) + bucket.tokens
    const tokens = bucket?.tokens ?? null
    const height = tokens === null || peak === 0 ? 0 : Math.max(4, Math.round((tokens / peak) * 100))
    const level: SidebarUsageBar['level'] = tokens === null || tokens === 0
      ? 'empty'
      : height >= 70 ? 'high' : height >= 40 ? 'medium' : 'low'
    return { dayKey: key, date, calls: bucket?.calls ?? 0, tokens, height, level }
  })
  return { bars, calls, total, truncated: options.truncated === true }
}
