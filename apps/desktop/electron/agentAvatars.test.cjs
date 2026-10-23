'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

const Module = require('node:module')
const originalLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') {
    return { app: { getPath: () => tmpRoot } }
  }
  return originalLoad.call(this, request, parent, isMain)
}

const agentAvatars = require('./agentAvatars.cjs')
Module._load = originalLoad

let tmpRoot = ''

test.beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-avatars-'))
  agentAvatars.__setStateDir(path.join(tmpRoot, 'pets'))
})

test.afterEach(async () => {
  agentAvatars.__setStateDir(null)
  agentAvatars.__setInstanceLimit(1000)
  await fs.rm(tmpRoot, { recursive: true, force: true })
})

test('starts empty when nothing was written yet', async () => {
  const state = await agentAvatars.loadState()
  assert.deepEqual(state, { version: 1, preferences: {}, instances: {} })
})

test('stores a random preference and a pinned preference', async () => {
  await agentAvatars.setPreference('agent-a', { mode: 'random' })
  await agentAvatars.setPreference('agent-b', { mode: 'fixed', petSlug: 'Boba' })

  const state = await agentAvatars.loadState()
  assert.deepEqual(state.preferences['agent-a'], { mode: 'random' })
  assert.deepEqual(state.preferences['agent-b'], { mode: 'fixed', petSlug: 'boba' })
})

test('rejects an invalid preference or agent id', async () => {
  await assert.rejects(() => agentAvatars.setPreference('', { mode: 'random' }), /agent id/)
  await assert.rejects(() => agentAvatars.setPreference('a', { mode: 'fixed' }), /invalid/)
  await assert.rejects(() => agentAvatars.setPreference('a', { mode: 'nope' }), /invalid/)
})

test('keeps one instance record per key and refreshes it', async () => {
  await agentAvatars.saveInstance({ instanceKey: 'run:1', petSlug: 'boba', agentId: 'a' })
  const updated = await agentAvatars.saveInstance({ instanceKey: 'run:1', petSlug: 'mochi', agentId: 'a' })

  assert.equal(updated.petSlug, 'mochi')
  assert.equal(updated.source, 'random')
  const state = await agentAvatars.loadState()
  assert.equal(Object.keys(state.instances).length, 1)
})

test('evicts the least recently assigned instances beyond the limit', async () => {
  agentAvatars.__setInstanceLimit(2)
  await agentAvatars.saveInstance({ instanceKey: 'run:1', petSlug: 'a' })
  await new Promise((resolve) => setTimeout(resolve, 5))
  await agentAvatars.saveInstance({ instanceKey: 'run:2', petSlug: 'b' })
  await new Promise((resolve) => setTimeout(resolve, 5))
  await agentAvatars.saveInstance({ instanceKey: 'run:3', petSlug: 'c' })

  const state = await agentAvatars.loadState()
  assert.deepEqual(Object.keys(state.instances).sort(), ['run:2', 'run:3'])
})

test('releases finished runs but keeps the record of unknown keys untouched', async () => {
  await agentAvatars.saveInstance({ instanceKey: 'run:1', petSlug: 'boba' })
  await agentAvatars.saveInstance({ instanceKey: 'run:2', petSlug: 'mochi' })

  const released = await agentAvatars.releaseInstances(['run:1', 'run:missing'])

  assert.equal(released, 1)
  assert.deepEqual(Object.keys((await agentAvatars.loadState()).instances), ['run:2'])
})

test('clearing a pet drops instance records and resets pinned preferences', async () => {
  await agentAvatars.setPreference('agent-a', { mode: 'fixed', petSlug: 'boba' })
  await agentAvatars.setPreference('agent-b', { mode: 'fixed', petSlug: 'mochi' })
  await agentAvatars.saveInstance({ instanceKey: 'run:1', petSlug: 'boba' })

  const changed = await agentAvatars.clearPet('boba')
  const state = await agentAvatars.loadState()

  assert.equal(changed, 2)
  assert.deepEqual(state.preferences['agent-a'], { mode: 'random' })
  assert.deepEqual(state.preferences['agent-b'], { mode: 'fixed', petSlug: 'mochi' })
  assert.equal(state.instances['run:1'], undefined)
})

test('a corrupt state file degrades to empty instead of failing every avatar', async () => {
  const directory = path.join(tmpRoot, 'pets')
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(path.join(directory, 'agent-avatars.json'), '{ not json')

  assert.deepEqual(await agentAvatars.loadState(), { version: 1, preferences: {}, instances: {} })
})
