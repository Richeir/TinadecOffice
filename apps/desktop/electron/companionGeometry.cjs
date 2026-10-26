// companionGeometry.cjs — pure screen geometry for the companion capsule/panel.
//
// The companion is one window that swaps between two sizes: a narrow capsule docked to a
// screen edge, and a panel that opens inward from that edge. Both are positioned from a single
// vertical anchor (`centerY`, relative to the display's work area) so dragging either shape and
// then toggling keeps the companion where the user left it.
//
// No Electron imports here: `node --test` runs this file directly.

const CAPSULE = { width: 24, height: 108 };
const PANEL = { width: 340, height: 520 };
const EDGE_MARGIN = 8;

/** Anything that is not exactly 'left' docks right, matching the default side. */
function normalizeSide(value) {
  return value === 'left' ? 'left' : 'right';
}

/**
 * Keep the window's vertical centre inside the work area, leaving EDGE_MARGIN on both ends.
 * A work area shorter than the window collapses to its centre rather than going negative.
 */
function clampCenter(centerY, workArea, height) {
  const min = EDGE_MARGIN + height / 2;
  const max = workArea.height - EDGE_MARGIN - height / 2;
  if (max < min) return workArea.height / 2;
  const value = Number.isFinite(centerY) ? centerY : workArea.height / 2;
  return Math.min(max, Math.max(min, value));
}

/**
 * Window bounds for a shape docked to `side`.
 *
 * The window is flush with the work-area edge (`workArea.x` / its right edge) so the capsule's
 * visible pill can sit on the screen border; the transparent part of the capsule window is only
 * the inner few pixels.
 */
function boundsFor({ side, workArea, centerY, width, height }) {
  const center = clampCenter(centerY, workArea, height);
  const x = normalizeSide(side) === 'left'
    ? workArea.x
    : workArea.x + workArea.width - width;
  return {
    x: Math.round(x),
    y: Math.round(workArea.y + center - height / 2),
    width,
    height,
  };
}

function panelSize(workArea) {
  return {
    width: Math.min(PANEL.width, Math.max(0, workArea.width - EDGE_MARGIN * 2)),
    height: Math.min(PANEL.height, Math.max(0, workArea.height - EDGE_MARGIN * 2)),
  };
}

function capsuleBounds(workArea, side, centerY) {
  return boundsFor({ side, workArea, centerY: centerY ?? workArea.height / 2, ...CAPSULE });
}

function panelBounds(workArea, side, centerY) {
  return boundsFor({ side, workArea, centerY: centerY ?? workArea.height / 2, ...panelSize(workArea) });
}

/** Turn a dragged window's screen-space top into an anchor for the current display. */
function centerFromWindowTop(top, workArea, height) {
  return top - workArea.y + height / 2;
}

module.exports = {
  CAPSULE,
  PANEL,
  EDGE_MARGIN,
  boundsFor,
  capsuleBounds,
  centerFromWindowTop,
  clampCenter,
  normalizeSide,
  panelBounds,
  panelSize,
};
