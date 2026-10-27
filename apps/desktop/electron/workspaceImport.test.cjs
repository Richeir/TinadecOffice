const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { importWorkspaceFiles, MAX_FILES, MAX_FILE_BYTES } = require('./workspaceImport.cjs');

/** A real temp tree: the point of this module is filesystem behaviour, so a mocked fs proves nothing. */
async function fixture() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'tinadec-import-'));
  const source = path.join(root, 'source');
  const dest = path.join(root, 'dest');
  await fsp.mkdir(source);
  await fsp.mkdir(dest);
  return { root, source, dest, cleanup: () => fsp.rm(root, { recursive: true, force: true }) };
}

const sender = {};
const options = { mainWindow: { webContents: sender }, trusted: () => true };
const event = { sender };

test('copies files into the destination and reports name, landing path and byte count', async () => {
  const f = await fixture();
  try {
    const one = path.join(f.source, 'notes.txt');
    await fsp.writeFile(one, 'hello');
    const result = await importWorkspaceFiles(event, options, { destDir: f.dest, files: [one] });
    assert.deepEqual(result.skipped, []);
    assert.equal(result.imported.length, 1);
    // The reported path is the copy, not the source: the caller shows where the file landed.
    assert.deepEqual(result.imported[0], { name: 'notes.txt', path: path.join(f.dest, 'notes.txt'), bytes: 5 });
    assert.equal(await fsp.readFile(path.join(f.dest, 'notes.txt'), 'utf8'), 'hello');
  } finally { await f.cleanup(); }
});

test('never overwrites an existing file: the copy is skipped and the original survives', async () => {
  const f = await fixture();
  try {
    const source = path.join(f.source, 'keep.txt');
    await fsp.writeFile(source, 'from source');
    await fsp.writeFile(path.join(f.dest, 'keep.txt'), 'already here');
    const result = await importWorkspaceFiles(event, options, { destDir: f.dest, files: [source] });
    assert.deepEqual(result.imported, []);
    assert.deepEqual(result.skipped, [{ path: source, reason: 'exists' }]);
    assert.equal(await fsp.readFile(path.join(f.dest, 'keep.txt'), 'utf8'), 'already here');
  } finally { await f.cleanup(); }
});

test('refuses links, directories, missing paths and relative paths with distinct reasons', async () => {
  const f = await fixture();
  try {
    const folder = path.join(f.source, 'a-folder');
    await fsp.mkdir(folder);
    const missing = path.join(f.source, 'nope.txt');
    const link = path.join(f.source, 'alias.txt');
    let linked = true;
    try { await fsp.symlink(path.join(f.source, 'target.txt'), link); } catch { linked = false; }
    const files = [folder, missing, 'relative.txt', ...(linked ? [link] : [])];
    const result = await importWorkspaceFiles(event, options, { destDir: f.dest, files });
    const reasons = Object.fromEntries(result.skipped.map((row) => [row.path, row.reason]));
    assert.equal(reasons[folder], 'not_a_file');
    assert.equal(reasons[missing], 'missing');
    assert.equal(reasons['relative.txt'], 'relative_path');
    // The tool layer rejects every path that traverses a link, so a link copied in would be
    // unreadable for the agent: it is refused here rather than silently dereferenced.
    if (linked) assert.equal(reasons[link], 'link');
    assert.deepEqual(result.imported, []);
  } finally { await f.cleanup(); }
});

test('a batch larger than the ceiling reports the overflow instead of dropping it silently', async () => {
  const f = await fixture();
  try {
    // Nonexistent paths keep this cheap: the ceiling is applied before any file is touched, so the
    // boundary is visible without copying hundreds of files to prove it.
    const files = Array.from({ length: MAX_FILES + 2 }, (_, index) => path.join(f.source, `f${index}.txt`));
    const result = await importWorkspaceFiles(event, options, { destDir: f.dest, files });
    // The overflow is named before any file is touched, so a caller can tell "we stopped at the
    // ceiling" from "these paths were unreadable".
    assert.deepEqual(result.skipped.slice(0, 2), [
      { path: files[MAX_FILES], reason: 'too_many' },
      { path: files[MAX_FILES + 1], reason: 'too_many' },
    ]);
    assert.equal(result.skipped.length, MAX_FILES + 2);
    assert.ok(result.skipped.every((row) => row.reason === 'too_many' || row.reason === 'missing'));
  } finally { await f.cleanup(); }
});

test('refuses a file above the size ceiling instead of copying it', async () => {
  const f = await fixture();
  try {
    // A sparse file of the ceiling + 1 byte: the check reads `stat().size`, so this costs no disk.
    const huge = path.join(f.source, 'huge.bin');
    const handle = await fsp.open(huge, 'w');
    await handle.truncate(MAX_FILE_BYTES + 1);
    await handle.close();
    const small = path.join(f.source, 'small.txt');
    await fsp.writeFile(small, 'ok');
    const result = await importWorkspaceFiles(event, options, { destDir: f.dest, files: [huge, small] });
    // The oversized file is refused by name, and the ordinary one in the same drop still lands:
    // one refused entry must not abort its neighbours.
    assert.deepEqual(result.skipped, [{ path: huge, reason: 'too_large' }]);
    assert.deepEqual(result.imported.map((row) => row.name), ['small.txt']);
  } finally { await f.cleanup(); }
});

test('two dropped files that differ only in case cannot claim the same target', async () => {
  const f = await fixture();
  try {
    const upper = path.join(f.source, 'Report.txt');
    const lower = path.join(f.source, 'report.txt');
    await fsp.writeFile(upper, 'upper');
    await fsp.writeFile(lower, 'lower');
    const result = await importWorkspaceFiles(event, options, { destDir: f.dest, files: [upper, lower] });
    // Windows and macOS resolve both names to one file; counting two successes would report a
    // copy that never happened.
    assert.equal(result.imported.length + result.skipped.length, 2);
    assert.ok(result.skipped.every((row) => row.reason === 'duplicate'));
  } finally { await f.cleanup(); }
});

test('requires the trusted main host page and a real absolute destination folder', async () => {
  const f = await fixture();
  try {
    const one = path.join(f.source, 'notes.txt');
    await fsp.writeFile(one, 'hello');
    await assert.rejects(importWorkspaceFiles({ sender: {} }, options, { destDir: f.dest, files: [one] }), /trusted main/);
    await assert.rejects(importWorkspaceFiles(event, { ...options, trusted: () => false }, { destDir: f.dest, files: [one] }), /trusted main/);
    await assert.rejects(importWorkspaceFiles(event, options, { destDir: 'dest', files: [one] }), /absolute destination/);
    // A file is not a place to copy into; the handler must not create one.
    const asFile = path.join(f.dest, 'plain.txt');
    await fsp.writeFile(asFile, 'x');
    await assert.rejects(importWorkspaceFiles(event, options, { destDir: asFile, files: [one] }), /not a folder/);
    await assert.rejects(importWorkspaceFiles(event, options, { destDir: path.join(f.dest, 'gone'), files: [one] }), /not a folder/);
  } finally { await f.cleanup(); }
});
