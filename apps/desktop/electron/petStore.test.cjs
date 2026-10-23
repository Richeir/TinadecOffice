'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

// petStore requires 'electron' for app.getPath only. The tests point the store at a temporary
// directory, but the module still loads the import — stub it like layoutStore.test.cjs does.
const Module = require('node:module')
const originalLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') {
    return { app: { getPath: () => tmpRoot } }
  }
  return originalLoad.call(this, request, parent, isMain)
}

const petStore = require('./petStore.cjs')
Module._load = originalLoad

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13])

let tmpRoot = ''
let bundleDir = ''
let previousBundleDir = ''

async function writeBundledPet(slug, options = {}) {
  const directory = path.join(bundleDir, slug)
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(path.join(directory, 'pet.json'), JSON.stringify({
    id: slug,
    name: options.displayName || 'Tinadec',
    kind: 'companion',
    spritesheetPath: 'spritesheet.png',
  }))
  await fs.writeFile(path.join(directory, 'spritesheet.png'), PNG_SIGNATURE)
}

test.beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pet-store-'))
  bundleDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pet-bundle-'))
  previousBundleDir = process.env.TINADEC_BUILTIN_PETS_DIR || ''
  process.env.TINADEC_BUILTIN_PETS_DIR = bundleDir
  petStore.__setPetsDir(path.join(tmpRoot, 'pets'))
})

test.afterEach(async () => {
  petStore.__setPetsDir(null)
  if (previousBundleDir) process.env.TINADEC_BUILTIN_PETS_DIR = previousBundleDir
  else delete process.env.TINADEC_BUILTIN_PETS_DIR
  await fs.rm(tmpRoot, { recursive: true, force: true })
  await fs.rm(bundleDir, { recursive: true, force: true })
})

test('seeds a bundled pet into userData and marks it built-in', async () => {
  await writeBundledPet('tinadec', { displayName: 'Tinadec' })

  const seeded = await petStore.ensureBuiltinPets()
  assert.equal(seeded.length, 1)
  assert.equal(seeded[0].slug, 'tinadec')
  assert.equal(seeded[0].builtin, true)
  assert.equal(seeded[0].source, 'builtin')
  assert.equal(seeded[0].enabled, false)

  const pets = await petStore.listDownloaded()
  assert.equal(pets.length, 1)
  assert.equal(pets[0].displayName, 'Tinadec')
  assert.equal(pets[0].builtin, true)
  assert.match(pets[0].imageDataUrl, /^data:image\/png;base64,/)
})

test('seeding is idempotent and keeps one record per slug', async () => {
  await writeBundledPet('tinadec')

  await petStore.ensureBuiltinPets()
  const secondRun = await petStore.ensureBuiltinPets()

  assert.equal(secondRun.length, 0)
  assert.equal((await petStore.listDownloaded()).length, 1)
})

test('the built-in pet cannot be removed', async () => {
  await writeBundledPet('tinadec')
  await petStore.ensureBuiltinPets()

  await assert.rejects(() => petStore.removePet('tinadec'), /cannot be removed/)
  assert.equal((await petStore.listDownloaded()).length, 1)
})

test('a user pet that already owns the slug is never overwritten', async () => {
  const petsRoot = path.join(tmpRoot, 'pets')
  const directory = path.join(petsRoot, 'tinadec')
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(path.join(directory, 'spritesheet.webp'), Buffer.from('RIFF0000WEBP'))
  await fs.writeFile(path.join(petsRoot, 'registry.json'), JSON.stringify({
    pets: [{
      slug: 'tinadec',
      displayName: 'User copy',
      kind: 'pet',
      submittedBy: 'someone',
      enabled: false,
      spriteFile: 'spritesheet.webp',
      source: 'petdex',
      installedAt: 1,
      scale: 1,
    }],
  }))
  await writeBundledPet('tinadec')

  const seeded = await petStore.ensureBuiltinPets()
  const pets = await petStore.listDownloaded()

  assert.equal(seeded.length, 0)
  assert.equal(pets.length, 1)
  assert.equal(pets[0].displayName, 'User copy')
  assert.equal(pets[0].builtin, false)
  assert.equal(pets[0].source, 'petdex')
})

test('a missing bundle directory is a no-op rather than a crash', async () => {
  process.env.TINADEC_BUILTIN_PETS_DIR = path.join(bundleDir, 'does-not-exist')

  assert.deepEqual(await petStore.ensureBuiltinPets(), [])
  assert.deepEqual(await petStore.listDownloaded(), [])
})
