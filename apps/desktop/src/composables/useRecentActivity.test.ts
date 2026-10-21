// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, ref } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import type { SessionDto } from '@/api'
import { setSelectedStorage } from '@/lib/storageScope'
import { ACTIVITY_LIMIT, ACTIVITY_TTL_MS, latestRun, useRecentActivity, type ActivityCandidate } from './useRecentActivity'

const { listRunsMock } = vi.hoisted(() => ({
  listRunsMock: vi.fn(async (..._args: unknown[]): Promise<unknown[]> => []),
}))

vi.mock('@/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api')>()
  return { ...actual, api: { ...actual.api, listRuns: (...args: unknown[]) => listRunsMock(...args) } }
})

function candidate(id: string, updatedAt = '2026-10-21T10:00:00Z'): ActivityCandidate {
  return {
    session: {
      permission_mode: 'default', space_options: null, settings_revision: 0,
      id, project_id: 'p-1', title: id, status: 'ready',
      created_at: '2026-10-01T00:00:00Z', updated_at: updatedAt,
    } as SessionDto,
    projectName: 'Demo project',
  }
}

function harness(candidates: () => ActivityCandidate[], enabled = ref(true)) {
  let activity!: ReturnType<typeof useRecentActivity>
  const wrapper = mount(defineComponent({
    setup() {
      activity = useRecentActivity(candidates, { enabled: () => enabled.value })
      return () => null
    },
  }))
  return { activity, wrapper, enabled }
}

const runRow = (id: string, status: string, createdAt: string) => ({
  id, session_id: 's', status, summary: '', created_at: createdAt, updated_at: createdAt,
})

beforeEach(() => {
  listRunsMock.mockReset()
  listRunsMock.mockResolvedValue([])
  setSelectedStorage('user')
})

describe('useRecentActivity', () => {
  it('asks only for the conversations the activity view renders', async () => {
    const rows = Array.from({ length: ACTIVITY_LIMIT + 3 }, (_, index) => candidate(`s-${index}`))
    const { activity, wrapper } = harness(() => rows)
    await activity.refresh()

    expect(listRunsMock).toHaveBeenCalledTimes(ACTIVITY_LIMIT)
    expect(listRunsMock).toHaveBeenCalledWith('s-0', expect.anything())
    wrapper.unmount()
  })

  it('reads nothing while the option is off', async () => {
    const enabled = ref(false)
    const { activity, wrapper } = harness(() => [candidate('s-1')], enabled)
    await activity.refresh()
    expect(listRunsMock).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('keeps the newest run of a roster instead of trusting its order', async () => {
    listRunsMock.mockResolvedValue([
      runRow('old', 'completed', '2026-10-20T09:00:00Z'),
      runRow('newest', 'awaiting_user', '2026-10-21T09:00:00Z'),
      runRow('middle', 'failed', '2026-10-20T18:00:00Z'),
    ])
    const { activity, wrapper } = harness(() => [candidate('s-1')])
    await activity.refresh()
    expect(activity.runs.value['s-1']?.id).toBe('newest')
    expect(latestRun([])).toBeNull()
    wrapper.unmount()
  })

  it('reuses a read until the session itself moves', async () => {
    const updated = ref('2026-10-21T10:00:00Z')
    const { activity, wrapper } = harness(() => [candidate('s-1', updated.value)])
    await activity.refresh()
    await activity.refresh()
    // A roster cannot change without the session changing, so the second read is skipped.
    expect(listRunsMock).toHaveBeenCalledTimes(1)

    updated.value = '2026-10-21T11:00:00Z'
    await activity.refresh()
    expect(listRunsMock).toHaveBeenCalledTimes(2)
    wrapper.unmount()
  })

  it('refreshes an unchanged session once the read passes the TTL', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-21T12:00:00Z'))
    try {
      const { activity, wrapper } = harness(() => [candidate('s-1')])
      await activity.refresh()
      await activity.refresh()
      expect(listRunsMock).toHaveBeenCalledTimes(1)

      clock.mockReturnValue(Date.parse('2026-10-21T12:00:00Z') + ACTIVITY_TTL_MS + 1)
      await activity.refresh()
      expect(listRunsMock).toHaveBeenCalledTimes(2)
      wrapper.unmount()
    } finally {
      clock.mockRestore()
    }
  })

  it('keeps the other cards when one roster cannot be read', async () => {
    listRunsMock.mockImplementation(async (sessionId: unknown) => {
      if (sessionId === 's-broken') throw new Error('roster unavailable')
      return [runRow(`${String(sessionId)}-run`, 'completed', '2026-10-21T09:00:00Z')]
    })
    const { activity, wrapper } = harness(() => [candidate('s-ok'), candidate('s-broken')])
    await activity.refresh()
    expect(activity.runs.value['s-ok']?.status).toBe('completed')
    expect(activity.runs.value['s-broken']).toBeUndefined()
    wrapper.unmount()
  })

  it('drops a read that lands after the storage scope changed', async () => {
    let release: (rows: unknown[]) => void = () => {}
    listRunsMock.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const { activity, wrapper } = harness(() => [candidate('s-1')])
    const pending = activity.refresh()
    setSelectedStorage('project-2')
    release([runRow('stale', 'completed', '2026-10-21T09:00:00Z')])
    await pending
    await flushPromises()
    expect(activity.runs.value['s-1']).toBeUndefined()
    wrapper.unmount()
    setSelectedStorage('user')
  })
})
