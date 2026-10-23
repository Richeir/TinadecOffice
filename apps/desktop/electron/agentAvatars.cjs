const fs = require('node:fs/promises');
const path = require('node:path');

/**
 * The avatar contract, persisted next to the pets:
 *
 *   preferences  — per agent definition: `random` (default) or a pinned pet.
 *   instances    — per spawned agent: the face it wears for this run. Bounded LRU, because runs
 *                  are ephemeral and this file must not grow forever.
 *
 * The renderer owns the picking rule (`src/lib/avatarAssignment.ts`); this module only stores
 * decisions. Keeping the rule out of the main process makes it testable and keeps IPC cheap.
 */
const STATE_VERSION = 1;
const MAX_INSTANCES = 1000;
let stateDirOverride = null;
let instanceLimit = MAX_INSTANCES;

function stateDirectory() {
  if (stateDirOverride) return stateDirOverride;
  const { app } = require('electron');
  return path.join(app.getPath('userData'), 'pets');
}

function statePath() {
  return path.join(stateDirectory(), 'agent-avatars.json');
}

/** Test seam, mirrors petStore.__setPetsDir. */
function __setStateDir(dir) {
  stateDirOverride = dir || null;
}

function __setInstanceLimit(limit) {
  instanceLimit = Number.isInteger(limit) && limit > 0 ? limit : MAX_INSTANCES;
}

function safeSlug(value) {
  const slug = String(value || '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug || slug.length > 120) return '';
  return slug;
}

function safeKey(value) {
  const key = String(value || '').trim();
  if (!key || key.length > 200) return '';
  return key;
}

function normalizePreference(value) {
  if (!value || typeof value !== 'object') return null;
  if (value.mode === 'random') return { mode: 'random' };
  if (value.mode === 'fixed') {
    const petSlug = safeSlug(value.petSlug);
    if (!petSlug) return null;
    return { mode: 'fixed', petSlug };
  }
  return null;
}

function normalizeInstance(value) {
  if (!value || typeof value !== 'object') return null;
  const petSlug = safeSlug(value.petSlug);
  if (!petSlug) return null;
  const source = value.source === 'fixed' ? 'fixed' : 'random';
  const agentId = typeof value.agentId === 'string' ? value.agentId.slice(0, 200) : '';
  const assignedAt = Number.isFinite(value.assignedAt) ? Number(value.assignedAt) : Date.now();
  return { petSlug, agentId, assignedAt, source };
}

function emptyState() {
  return { version: STATE_VERSION, preferences: {}, instances: {} };
}

function normalizeState(raw) {
  const state = emptyState();
  if (!raw || typeof raw !== 'object') return state;
  if (raw.preferences && typeof raw.preferences === 'object') {
    for (const [agentId, value] of Object.entries(raw.preferences)) {
      const key = safeKey(agentId);
      const preference = normalizePreference(value);
      if (key && preference) state.preferences[key] = preference;
    }
  }
  if (raw.instances && typeof raw.instances === 'object') {
    for (const [instanceKey, value] of Object.entries(raw.instances)) {
      const key = safeKey(instanceKey);
      const instance = normalizeInstance(value);
      if (key && instance) state.instances[key] = instance;
    }
  }
  return state;
}

async function readState() {
  let text;
  try {
    text = await fs.readFile(statePath(), 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return emptyState();
    throw error;
  }
  try {
    return normalizeState(JSON.parse(text));
  } catch {
    // A corrupt file costs the user their cosmetic choices, not their agents: start over rather
    // than blocking every avatar behind an unreadable file.
    console.error('[tinadec] agent avatar state is unreadable, starting from an empty state');
    return emptyState();
  }
}

async function writeState(state) {
  const directory = stateDirectory();
  await fs.mkdir(directory, { recursive: true });
  const temporaryPath = `${statePath()}.tmp`;
  await fs.writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await fs.rename(temporaryPath, statePath());
}

function trimInstances(state) {
  const keys = Object.keys(state.instances);
  if (keys.length <= instanceLimit) return false;
  // Insertion order is the recency order: saveInstance deletes before it re-inserts. Sorting by
  // assignedAt would evict the wrong record when two agents are spawned in the same millisecond.
  const excess = keys.length - instanceLimit;
  for (let index = 0; index < excess; index += 1) delete state.instances[keys[index]];
  return true;
}

async function loadState() {
  return readState();
}

async function setPreference(agentId, preference) {
  const key = safeKey(agentId);
  if (!key) throw new Error('A valid agent id is required');
  const normalized = normalizePreference(preference);
  if (!normalized) throw new Error('Avatar preference is invalid');
  const state = await readState();
  state.preferences[key] = normalized;
  await writeState(state);
  return normalized;
}

async function saveInstance(input) {
  const instanceKey = safeKey(input?.instanceKey);
  const petSlug = safeSlug(input?.petSlug);
  if (!instanceKey) throw new Error('A valid instance key is required');
  if (!petSlug) throw new Error('A valid pet id is required');
  const state = await readState();
  const source = input?.source === 'fixed' ? 'fixed' : 'random';
  const agentId = typeof input?.agentId === 'string' ? input.agentId.slice(0, 200) : '';
  // Re-insert so "most recently used" is the insertion order used by the trim below.
  delete state.instances[instanceKey];
  state.instances[instanceKey] = { petSlug, agentId, assignedAt: Date.now(), source };
  trimInstances(state);
  await writeState(state);
  return state.instances[instanceKey];
}

/** Frees the pets of finished runs so new instances can wear them. Records stay for history. */
async function releaseInstances(instanceKeys) {
  const keys = (Array.isArray(instanceKeys) ? instanceKeys : []).map(safeKey).filter(Boolean);
  if (keys.length === 0) return 0;
  const state = await readState();
  let removed = 0;
  for (const key of keys) {
    if (state.instances[key]) {
      delete state.instances[key];
      removed += 1;
    }
  }
  if (removed > 0) await writeState(state);
  return removed;
}

async function clearPet(slugInput) {
  const petSlug = safeSlug(slugInput);
  if (!petSlug) return 0;
  const state = await readState();
  let changed = 0;
  for (const [key, instance] of Object.entries(state.instances)) {
    if (instance.petSlug === petSlug) {
      delete state.instances[key];
      changed += 1;
    }
  }
  for (const [agentId, preference] of Object.entries(state.preferences)) {
    if (preference.mode === 'fixed' && preference.petSlug === petSlug) {
      state.preferences[agentId] = { mode: 'random' };
      changed += 1;
    }
  }
  if (changed > 0) await writeState(state);
  return changed;
}

module.exports = {
  STATE_VERSION,
  loadState,
  setPreference,
  saveInstance,
  releaseInstances,
  clearPet,
  __setStateDir,
  __setInstanceLimit,
};
