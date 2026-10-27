'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

/**
 * A batch larger than this is almost certainly a mis-drop (a whole home directory): copying it
 * would take minutes with no progress the renderer can show. The overflow is reported, never
 * dropped silently.
 */
const MAX_FILES = 200;

/**
 * Files above this are refused rather than copied. A drop of a multi-gigabyte video would
 * otherwise sit in the IPC call until the renderer's timeout with no way to cancel it, and the
 * copy has to finish before the agent can be told about the file anyway.
 */
const MAX_FILE_BYTES = 64 * 1024 * 1024;

/**
 * Copies dropped files into a workspace source folder.
 *
 * The main process spells out no user-facing language — `reason` is a stable code the renderer
 * owns the wording for, exactly like the folder picker's title being passed in rather than written
 * here. Symbolic links are refused instead of followed: the tool layer rejects every path that
 * traverses a link (`TinadecTools/Tools/FileRW/FileToolRuntime.cs` `EnsureNoLinkTraversal`), so a
 * copy into the workspace would produce a file the agent could never read back.
 *
 * Only new files are created (`COPYFILE_EXCL`): importing never overwrites what is already there,
 * because the approval gate does not stand between this copy and the workspace.
 */
async function importWorkspaceFiles(event, { mainWindow, trusted }, input) {
  if (mainWindow?.webContents !== event.sender || !trusted(event)) throw new Error('File import requires the trusted main host page.');
  const destDir = typeof input?.destDir === 'string' ? input.destDir.trim() : '';
  if (!destDir || !path.isAbsolute(destDir)) throw new Error('Import requires an absolute destination folder.');
  const destination = await fsp.stat(destDir).catch(() => null);
  if (!destination?.isDirectory()) throw new Error('Import destination is not a folder.');

  const requested = Array.isArray(input?.files)
    ? input.files.filter((file) => typeof file === 'string' && file.trim()).map((file) => file.trim())
    : [];
  const imported = [];
  const skipped = [];
  for (const file of requested.slice(MAX_FILES)) skipped.push({ path: file, reason: 'too_many' });

  const taken = new Set();
  for (const file of requested.slice(0, MAX_FILES)) {
    if (!path.isAbsolute(file)) { skipped.push({ path: file, reason: 'relative_path' }); continue; }
    const source = await fsp.lstat(file).catch(() => null);
    if (!source) { skipped.push({ path: file, reason: 'missing' }); continue; }
    if (source.isSymbolicLink()) { skipped.push({ path: file, reason: 'link' }); continue; }
    if (!source.isFile()) { skipped.push({ path: file, reason: 'not_a_file' }); continue; }
    if (source.size > MAX_FILE_BYTES) { skipped.push({ path: file, reason: 'too_large' }); continue; }
    const name = path.basename(file);
    const target = path.join(destDir, name);
    // Windows and macOS are case-insensitive by default: two dropped files whose names differ only
    // in case would otherwise fight over one target and one of them would be reported as copied
    // when it was not.
    const identity = process.platform === 'linux' ? target : target.toLowerCase();
    if (taken.has(identity)) { skipped.push({ path: file, reason: 'duplicate' }); continue; }
    taken.add(identity);
    if (await fsp.lstat(target).catch(() => null)) { skipped.push({ path: file, reason: 'exists' }); continue; }
    try {
      await fsp.copyFile(file, target, fs.constants.COPYFILE_EXCL);
      imported.push({ name, path: target, bytes: source.size });
    } catch {
      skipped.push({ path: file, reason: 'copy_failed' });
    }
  }
  return { imported, skipped };
}

module.exports = { importWorkspaceFiles, MAX_FILES, MAX_FILE_BYTES };
