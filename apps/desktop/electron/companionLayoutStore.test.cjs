const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const {
  VERSION,
  __setUserDataDir,
  layoutPath,
  load,
  normalizeLayout,
  save,
} = require('./companionLayoutStore.cjs');

function temporaryStore(t) {
  const dir = require('node:fs').mkdtempSync(path.join(os.tmpdir(), 'tinadec-companion-layout-'));
  t.after(() => require('node:fs').rmSync(dir, { recursive: true, force: true }));
  __setUserDataDir(dir);
  return dir;
}

test('normalizeLayout accepts a stored shape and drops unusable fields', () => {
  assert.equal(normalizeLayout(null), null);
  assert.equal(normalizeLayout(undefined), null);
  assert.equal(normalizeLayout('left'), null);
  assert.equal(normalizeLayout(42), null);
  assert.equal(normalizeLayout([]), null);

  assert.deepEqual(normalizeLayout({ side: 'left', centerY: 12.5, displayId: 3 }),
    { side: 'left', centerY: 12.5, displayId: 3 });
  // Anything not exactly 'left' docks right, matching the geometry module.
  assert.deepEqual(normalizeLayout({ side: 'LEFT', centerY: '480', displayId: 1.5 }),
    { side: 'right', centerY: null, displayId: null });
  assert.deepEqual(normalizeLayout({}), { side: 'right', centerY: null, displayId: null });
});

test('save then load round-trips through the versioned file', async (t) => {
  const dir = temporaryStore(t);
  await save({ side: 'left', centerY: 240, displayId: 2 });

  assert.equal(layoutPath(), path.join(dir, 'companion-layout.json'));
  const raw = JSON.parse(await fs.readFile(layoutPath(), 'utf-8'));
  assert.equal(raw.version, VERSION);
  assert.deepEqual(raw, { version: VERSION, side: 'left', centerY: 240, displayId: 2 });
  assert.deepEqual(await load(), { side: 'left', centerY: 240, displayId: 2 });

  // The atomic write leaves no temporary sibling behind.
  assert.deepEqual((await fs.readdir(dir)).sort(), ['companion-layout.json']);
});

test('save normalizes before writing and load ignores unrelated keys', async (t) => {
  const dir = temporaryStore(t);
  await fs.writeFile(layoutPath(), JSON.stringify({ side: 'bogus', centerY: 100, displayId: 1, extra: true }));
  assert.deepEqual(await load(), { side: 'right', centerY: 100, displayId: 1 });

  await save({ side: 'right', centerY: Number.NaN, displayId: 1 });
  assert.deepEqual(await load(), { side: 'right', centerY: null, displayId: 1 });
  assert.equal((await fs.readdir(dir)).some((name) => name.endsWith('.tmp')), false);
});

test('a missing or corrupt file reads as no layout without failing', async (t) => {
  const dir = temporaryStore(t);
  assert.equal(await load(), null);

  await fs.writeFile(layoutPath(), '{ not json');
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    assert.equal(await load(), null);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /failed to read layout/);
  assert.deepEqual((await fs.readdir(dir)).sort(), ['companion-layout.json']);
});

test('save refuses an invalid layout without touching the stored file', async (t) => {
  const dir = temporaryStore(t);
  await save({ side: 'left', centerY: 100, displayId: null });
  const before = await fs.readFile(layoutPath(), 'utf-8');

  for (const value of [null, undefined, [], 'left']) {
    await assert.rejects(save(value), /refusing to save an invalid layout/);
  }
  assert.equal(await fs.readFile(layoutPath(), 'utf-8'), before);
  assert.deepEqual((await fs.readdir(dir)).sort(), ['companion-layout.json']);
});
