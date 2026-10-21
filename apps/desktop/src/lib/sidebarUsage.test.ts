import { describe, expect, it } from 'vitest'
import type { ModelInvocationDto } from '../api'
import { buildSidebarUsage, SIDEBAR_USAGE_DAYS, usageWindow } from './sidebarUsage'

const NOW = new Date(2026, 9, 21, 12, 0, 0)

function at(daysAgo: number, hour = 10): Date {
  const date = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - daysAgo, hour)
  return date
}

function row(over: Partial<ModelInvocationDto> = {}): ModelInvocationDto {
  return {
    id: 'inv-1',
    call_id: 'call-1',
    attempt: 1,
    session_id: 'session-1',
    run_id: 'run-1',
    agent_definition_id: 'agent-1',
    agent_version_id: 'agent-version-1',
    mode_version_id: 'mode-version-1',
    strategy_source: 'route',
    provider_instance_id: 'provider-1',
    provider_version_id: 'provider-version-1',
    protocol: 'openai-chat',
    fallback_position: 0,
    status: 'succeeded',
    started_at: at(0).toISOString(),
    ...over,
  }
}

describe('usageWindow', () => {
  it('returns the last seven local days, oldest first, ending today', () => {
    const window = usageWindow(NOW)
    expect(window).toHaveLength(SIDEBAR_USAGE_DAYS)
    expect(window[0]).toEqual(new Date(2026, 9, 15))
    expect(window.at(-1)).toEqual(new Date(2026, 9, 21))
  })
})

describe('buildSidebarUsage', () => {
  it('sums reported usage per local day and leaves unreported calls as null', () => {
    const usage = buildSidebarUsage([
      row({ id: 'a', started_at: at(0).toISOString(), total_tokens: 120 }),
      row({ id: 'b', started_at: at(0, 11).toISOString(), total_tokens: null, input_tokens: 30, output_tokens: 10 }),
      row({ id: 'c', started_at: at(1).toISOString(), total_tokens: null, input_tokens: null, output_tokens: null }),
      row({ id: 'd', started_at: at(8).toISOString(), total_tokens: 999 }),
    ], { now: NOW })

    expect(usage.bars).toHaveLength(7)
    expect(usage.bars[6]).toMatchObject({ dayKey: '2026-10-21', calls: 2, tokens: 160 })
    expect(usage.bars[5]).toMatchObject({ calls: 1, tokens: null })
    expect(usage.total).toBe(160)
    expect(usage.calls).toBe(3)
  })

  it('keeps a measured zero distinct from an unreported day', () => {
    const usage = buildSidebarUsage([
      row({ id: 'zero', started_at: at(0).toISOString(), total_tokens: 0 }),
      row({ id: 'absent', started_at: at(1).toISOString() }),
    ], { now: NOW })

    expect(usage.bars[6]?.tokens).toBe(0)
    expect(usage.bars[5]?.tokens).toBeNull()
    expect(usage.total).toBe(0)
  })

  it('scales bar heights to the busiest day and keeps a visible floor', () => {
    const usage = buildSidebarUsage([
      row({ id: 'peak', started_at: at(0).toISOString(), total_tokens: 100 }),
      row({ id: 'mid', started_at: at(1).toISOString(), total_tokens: 40 }),
      row({ id: 'tiny', started_at: at(2).toISOString(), total_tokens: 1 }),
      row({ id: 'none', started_at: at(3).toISOString() }),
    ], { now: NOW })

    expect(usage.bars[6]).toMatchObject({ height: 100, level: 'high' })
    expect(usage.bars[5]).toMatchObject({ height: 40, level: 'medium' })
    expect(usage.bars[4]).toMatchObject({ height: 4, level: 'low' })
    expect(usage.bars[3]).toMatchObject({ height: 0, level: 'empty' })
  })

  it('ignores rows with an unreadable timestamp', () => {
    const usage = buildSidebarUsage([row({ started_at: 'not-a-date', total_tokens: 50 })], { now: NOW })
    expect(usage.calls).toBe(0)
    expect(usage.total).toBeNull()
  })

  it('carries the truncation flag into the chart data', () => {
    expect(buildSidebarUsage([], { now: NOW, truncated: true }).truncated).toBe(true)
    expect(buildSidebarUsage([], { now: NOW }).truncated).toBe(false)
  })
})
