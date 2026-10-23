import { describe, expect, it } from 'vitest'
import {
  hashInstanceKey,
  pickInstancePet,
  resolveAvatarSlug,
  type AvatarPet,
} from './avatarAssignment'

const builtin: AvatarPet = { slug: 'tinadec', displayName: 'Tinadec', builtin: true }
const boba: AvatarPet = { slug: 'boba', displayName: 'Boba' }
const mochi: AvatarPet = { slug: 'mochi', displayName: 'Mochi' }
const nova: AvatarPet = { slug: 'nova', displayName: 'Nova' }

const none = new Set<string>()

describe('hashInstanceKey', () => {
  it('is stable for the same key', () => {
    expect(hashInstanceKey('run-1:task-1')).toBe(hashInstanceKey('run-1:task-1'))
  })

  it('differs across keys', () => {
    expect(hashInstanceKey('run-1:task-1')).not.toBe(hashInstanceKey('run-1:task-2'))
  })
})

describe('pickInstancePet', () => {
  it('returns null for an empty pool', () => {
    expect(pickInstancePet([], none, 'run:task')).toBeNull()
  })

  it('uses the only pet even when built-in', () => {
    expect(pickInstancePet([builtin], none, 'run:task')).toBe('tinadec')
  })

  it('prefers a downloaded pet over the built-in baseline', () => {
    const pool = [builtin, boba]
    for (const key of ['a', 'b', 'c', 'd', 'e']) {
      expect(pickInstancePet(pool, none, key)).toBe('boba')
    }
  })

  it('gives concurrent instances different faces', () => {
    const pool = [builtin, boba, mochi, nova]
    const picked = ['run:1', 'run:2', 'run:3'].map((key) => pickInstancePet(pool, none, key))
    expect(new Set(picked).size).toBe(3)
    expect(picked).not.toContain('tinadec')
  })

  it('is stable for the same instance key and occupancy', () => {
    const pool = [builtin, boba, mochi, nova]
    const active = new Set(['boba'])
    expect(pickInstancePet(pool, active, 'run:task')).toBe(pickInstancePet(pool, active, 'run:task'))
  })

  it('reuses a taken pet rather than leaving an instance without a face', () => {
    const pool = [boba, mochi]
    const active = new Set(['boba', 'mochi'])
    expect(['boba', 'mochi']).toContain(pickInstancePet(pool, active, 'run:task'))
  })

  it('duplicates the built-in pet only when there is nothing else', () => {
    const pool = [builtin, boba]
    const active = new Set(['boba', 'tinadec'])
    expect(pickInstancePet(pool, active, 'run:task')).toBe('boba')
  })
})

describe('resolveAvatarSlug', () => {
  const pool = [builtin, boba, mochi]

  it('honours a pinned pet', () => {
    expect(resolveAvatarSlug(pool, { mode: 'fixed', petSlug: 'mochi' }, none, 'run:task')).toBe('mochi')
  })

  it('falls back to the baseline when the pinned pet was deleted', () => {
    expect(resolveAvatarSlug(pool, { mode: 'fixed', petSlug: 'gone' }, none, 'run:task')).toBe('tinadec')
  })

  it('randomises per instance for the random preference', () => {
    const first = resolveAvatarSlug(pool, { mode: 'random' }, none, 'run:1')
    const second = resolveAvatarSlug(pool, { mode: 'random' }, none, 'run:2')
    expect(first).not.toBe('tinadec')
    expect(second).not.toBe('tinadec')
    expect(first).not.toBe(second)
  })

  it('treats a missing preference as random', () => {
    expect(resolveAvatarSlug(pool, null, none, 'run:1')).toBe(pickInstancePet(pool, none, 'run:1'))
  })
})
