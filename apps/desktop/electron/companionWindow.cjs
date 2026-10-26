// companionWindow.cjs — the docked companion: one window, two shapes.
//
// Collapsed, it is a narrow capsule flush with the left or right edge of a display's work area;
// expanded, the same window grows inward into a panel. Keeping one window means the panel and the
// capsule can never disagree about which display they are on, and collapsing is a resize rather
// than a hand-off between two windows.
//
// Authority split: the renderer owns the look and the gestures (click, inward drag, header drag),
// this module owns screen geometry, docking side, and when an expanded panel closes. It never
// loads remote content and takes no business IPC; every handler below accepts only the companion
// window's own webContents.

const { BrowserWindow, screen } = require('electron');
const path = require('node:path');
const { appBundleUrl } = require('./appBundle.cjs');
const { attachExternalLinkGuards } = require('./externalLinks.cjs');
const geometry = require('./companionGeometry.cjs');
const layoutStore = require('./companionLayoutStore.cjs');

const isDev = Boolean(process.env.VITE_DEV_SERVER_URL);
const noTransparency = process.env.TINADEC_DISABLE_TRANSPARENCY === '1';
// A blur fires before the OS has handed focus to its new owner, so the collapse check waits a
// beat: clicking a TinadecOffice window blurs the panel first, and that window must win the race.
const BLUR_SETTLE_MS = 120;
const PERSIST_DELAY_MS = 200;

let win = null;
let side = 'right';
let centerY = null;
let displayId = null;
let expanded = false;
let saveTimer = null;
let blurTimer = null;
let displayListenersAttached = false;

function companionWindowUrl() {
  const hash = '/companion';
  if (isDev) return `${process.env.VITE_DEV_SERVER_URL}?splash=0#${hash}`;
  return appBundleUrl({ hash, query: { splash: '0' } });
}

function displayFor() {
  if (Number.isInteger(displayId)) {
    const stored = screen.getAllDisplays().find((entry) => entry.id === displayId);
    if (stored) return stored;
  }
  return screen.getPrimaryDisplay();
}

function currentBounds() {
  const area = displayFor().workArea;
  const anchor = centerY ?? area.height / 2;
  return expanded
    ? geometry.panelBounds(area, side, anchor)
    : geometry.capsuleBounds(area, side, anchor);
}

function snapshot() {
  return { open: Boolean(win && !win.isDestroyed()), expanded, side };
}

function broadcastState() {
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
    win.webContents.send('tinadec:companion-state-changed', snapshot());
  }
}

function schedulePersist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const current = win;
    if (!current || current.isDestroyed()) return;
    layoutStore.save({ side, centerY, displayId: displayFor().id }).catch((error) => {
      console.warn('[companion] failed to persist layout:', error.message);
    });
  }, PERSIST_DELAY_MS);
}

function applyBounds() {
  if (win && !win.isDestroyed()) win.setBounds(currentBounds());
}

function inWorkArea() {
  return displayFor().workArea;
}

/**
 * Move the companion so its window top sits at `top` in screen coordinates. The dragged shape is
 * whichever one is open, so the anchor follows the pointer for both the capsule and the panel.
 */
function moveTo(top) {
  if (!Number.isFinite(top)) return snapshot();
  const area = inWorkArea();
  const height = expanded ? geometry.panelSize(area).height : geometry.CAPSULE.height;
  centerY = geometry.clampCenter(geometry.centerFromWindowTop(top, area, height), area, height);
  applyBounds();
  schedulePersist();
  return snapshot();
}

function setSide(nextSide) {
  const normalized = geometry.normalizeSide(nextSide);
  if (normalized === side) return snapshot();
  side = normalized;
  applyBounds();
  schedulePersist();
  broadcastState();
  return snapshot();
}

function setExpanded(next) {
  const value = Boolean(next);
  if (value === expanded) return snapshot();
  expanded = value;
  clearTimeout(blurTimer);
  blurTimer = null;
  applyBounds();
  broadcastState();
  return snapshot();
}

/**
 * Collapse an open panel once focus has left every TinadecOffice window.
 *
 * Exported because the companion's own `blur` is not sufficient: when focus moves from the
 * companion to the main window and then to another application, the companion never blurs
 * again. `main.cjs` calls this from the app-level `browser-window-blur`, which does fire.
 */
function scheduleCollapseCheck() {
  clearTimeout(blurTimer);
  blurTimer = setTimeout(() => {
    blurTimer = null;
    if (!expanded || !win || win.isDestroyed()) return;
    // Focus inside any TinadecOffice window keeps the panel open — the user asked for that
    // explicitly — while null means another application (or the desktop) took focus.
    if (BrowserWindow.getFocusedWindow()) return;
    setExpanded(false);
  }, BLUR_SETTLE_MS);
}

function handleDisplaysChanged() {
  if (!win || win.isDestroyed()) return;
  const known = screen.getAllDisplays().some((entry) => entry.id === displayId);
  if (!known) displayId = screen.getPrimaryDisplay().id;
  applyBounds();
  schedulePersist();
}

function attachDisplayListeners() {
  if (displayListenersAttached) return;
  displayListenersAttached = true;
  screen.on('display-added', handleDisplaysChanged);
  screen.on('display-removed', handleDisplaysChanged);
  screen.on('display-metrics-changed', handleDisplaysChanged);
}

/** Create the capsule (collapsed). Reuses the existing window when one is already open. */
async function createCompanionWindow() {
  if (win && !win.isDestroyed()) {
    win.showInactive();
    return snapshot();
  }
  const stored = await layoutStore.load();
  side = geometry.normalizeSide(stored?.side);
  centerY = Number.isFinite(stored?.centerY) ? stored.centerY : null;
  displayId = Number.isInteger(stored?.displayId) ? stored.displayId : null;
  expanded = false;
  attachDisplayListeners();

  const created = new BrowserWindow({
    ...currentBounds(),
    title: 'Tinadec Companion',
    icon: path.join(__dirname, '..', isDev ? 'public' : 'dist', 'tinadec.ico'),
    frame: false,
    transparent: !noTransparency,
    backgroundColor: noTransparency ? '#1e1e2e' : '#00000000',
    hasShadow: false,
    thickFrame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win = created;
  created.setAlwaysOnTop(true, process.platform === 'darwin' ? 'floating' : 'normal');
  if (process.platform === 'darwin') created.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  attachExternalLinkGuards(created.webContents);
  created.on('blur', scheduleCollapseCheck);
  created.on('closed', () => {
    clearTimeout(blurTimer);
    clearTimeout(saveTimer);
    blurTimer = null;
    saveTimer = null;
    if (win === created) win = null;
  });
  created.once('ready-to-show', () => {
    // The capsule must not steal focus from whatever the user was doing at launch.
    if (!created.isDestroyed()) created.showInactive();
  });

  await created.loadURL(companionWindowUrl());
  return snapshot();
}

function closeCompanionWindow() {
  clearTimeout(blurTimer);
  clearTimeout(saveTimer);
  blurTimer = null;
  saveTimer = null;
  expanded = false;
  if (win && !win.isDestroyed()) win.close();
  win = null;
}

/** Show or hide the whole companion when the settings switch flips. */
async function applyCompanionMode(enabled) {
  if (enabled) return createCompanionWindow();
  closeCompanionWindow();
  return snapshot();
}

function isCompanionWindowSender(sender) {
  return Boolean(win && !win.isDestroyed() && win.webContents.id === sender.id);
}

function expandCompanionWindow() {
  return setExpanded(true);
}

function collapseCompanionWindow() {
  return setExpanded(false);
}

module.exports = {
  applyCompanionMode,
  closeCompanionWindow,
  collapseCompanionWindow,
  createCompanionWindow,
  expandCompanionWindow,
  isCompanionWindowSender,
  moveTo,
  scheduleCollapseCheck,
  setSide,
  snapshot,
};
