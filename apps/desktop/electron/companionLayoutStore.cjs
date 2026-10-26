// companionLayoutStore.cjs — where the companion capsule sits.
//
// Separate from desktop.toml on purpose: dragging the capsule writes on every gesture, and the
// user-editable config file should not churn for that. Shape is small and validated on read; a
// corrupt file falls back to the default dock (right edge, vertically centred) instead of failing
// startup.

const fs = require('node:fs/promises');
const path = require('node:path');

const VERSION = 1;
const FILE_NAME = 'companion-layout.json';

// Test hook: point the store at a temp dir instead of Electron's userData.
let __userDataDir = null;
function __setUserDataDir(dir) {
  __userDataDir = dir;
}

function userDataDir() {
  if (__userDataDir) return __userDataDir;
  return require('electron').app.getPath('userData');
}

function layoutPath() {
  return path.join(userDataDir(), FILE_NAME);
}

/** Returns `{ side, centerY, displayId }` or null when nothing usable is stored. */
function normalizeLayout(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return {
    side: value.side === 'left' ? 'left' : 'right',
    centerY: Number.isFinite(value.centerY) ? value.centerY : null,
    displayId: Number.isInteger(value.displayId) ? value.displayId : null,
  };
}

async function load() {
  try {
    const raw = await fs.readFile(layoutPath(), 'utf-8');
    return normalizeLayout(JSON.parse(raw));
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.warn('[companionLayoutStore] failed to read layout:', error.message);
    }
    return null;
  }
}

async function save(layout) {
  const normalized = normalizeLayout(layout);
  if (!normalized) throw new Error('[companionLayoutStore] refusing to save an invalid layout');
  const target = layoutPath();
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify({ version: VERSION, ...normalized }, null, 2), 'utf-8');
  await fs.rename(temporary, target);
}

module.exports = { VERSION, layoutPath, load, normalizeLayout, save, __setUserDataDir };
