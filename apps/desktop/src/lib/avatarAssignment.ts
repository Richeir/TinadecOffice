/**
 * Who gets which face.
 *
 * The avatar belongs to an **instance** — the agent that actually ran for one task — not to the
 * agent definition. That is why the key is `runId:taskId`: two runs of the same agent are two
 * different characters, unless the user pinned a pet in the agent's settings.
 *
 * This module is deliberately pure: the pool and the set of active pets come from the caller, so
 * the rule can be unit-tested without Electron, a registry, or a DOM.
 */

export interface AvatarPet {
  slug: string
  displayName?: string
  builtin?: boolean
}

export type AvatarPreference = { mode: 'random' } | { mode: 'fixed'; petSlug: string }

export const RANDOM_AVATAR: AvatarPreference = { mode: 'random' }

/**
 * The identity an avatar belongs to. One run can spawn several agents with the same slug, so the
 * key has to name the task, not the agent: `runId:taskId` is what `SubAgentsPanel` already uses
 * as its list key. Keep this the only place that formats it.
 */
export function instanceKeyOf(runId: string, taskId: string): string {
  return `${runId}:${taskId}`
}

/**
 * Spatial cards and feed rows name an agent by handle (`search#1`) or by slug. Settings stores
 * preferences per slug, so the ordinal is dropped before it is used as an agent key.
 */
export function agentKeyFromHandle(handle: string | null | undefined): string {
  return (handle ?? '').split('#')[0]?.trim() ?? ''
}

export function isRandomPreference(preference: AvatarPreference | null | undefined): boolean {
  return !preference || preference.mode !== 'fixed'
}

/** FNV-1a over the instance key: stable across reloads, cheap, and dependency-free. */
export function hashInstanceKey(key: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

function slugsOf(pool: readonly AvatarPet[]): string[] {
  return [...new Set(pool.map((pet) => pet.slug).filter(Boolean))].sort()
}

function builtinSlugsOf(pool: readonly AvatarPet[]): Set<string> {
  return new Set(pool.filter((pet) => pet.builtin).map((pet) => pet.slug))
}

function pickFrom(candidates: readonly string[], instanceKey: string): string {
  return candidates[hashInstanceKey(instanceKey) % candidates.length]!
}

/**
 * Picks a pet for one instance.
 *
 * Order of preference:
 * 1. a pet no other active instance is wearing;
 * 2. if only the built-in one is free, take it — it is the baseline, not a scarce resource;
 * 3. if every pet is taken, reuse one anyway (refusing would mean a spawned agent with no face);
 *    the built-in pet is the last thing to duplicate.
 */
export function pickInstancePet(
  pool: readonly AvatarPet[],
  activePetSlugs: ReadonlySet<string>,
  instanceKey: string,
): string | null {
  const slugs = slugsOf(pool)
  if (slugs.length === 0) return null
  if (slugs.length === 1) return slugs[0]!

  const builtin = builtinSlugsOf(pool)
  const free = slugs.filter((slug) => !activePetSlugs.has(slug))
  const freeNonBuiltin = free.filter((slug) => !builtin.has(slug))
  if (freeNonBuiltin.length > 0) return pickFrom(freeNonBuiltin, instanceKey)
  if (free.length > 0) return pickFrom(free, instanceKey)

  const reusable = slugs.filter((slug) => !builtin.has(slug))
  return pickFrom(reusable.length > 0 ? reusable : slugs, instanceKey)
}

/**
 * Resolves the pet an instance shows. A pinned pet wins as long as it is still installed; a
 * deleted pinned pet degrades to the baseline instead of leaving a hole.
 */
export function resolveAvatarSlug(
  pool: readonly AvatarPet[],
  preference: AvatarPreference | null | undefined,
  activePetSlugs: ReadonlySet<string>,
  instanceKey: string,
): string | null {
  const slugs = slugsOf(pool)
  if (slugs.length === 0) return null
  if (preference?.mode === 'fixed') {
    if (slugs.includes(preference.petSlug)) return preference.petSlug
    // A pinned pet that is no longer installed degrades to the baseline rather than to a
    // silent random pick: the user should notice their choice is gone.
    const baseline = [...builtinSlugsOf(pool)][0]
    return baseline ?? pickInstancePet(pool, activePetSlugs, instanceKey)
  }
  return pickInstancePet(pool, activePetSlugs, instanceKey)
}
