// companionGeometry.cjs is pure, so these are plain assertions against node --test — no Electron.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CAPSULE,
  EDGE_MARGIN,
  PANEL,
  boundsFor,
  capsuleBounds,
  centerFromWindowTop,
  clampCenter,
  normalizeSide,
  panelBounds,
  panelSize,
} = require('./companionGeometry.cjs');

const SCREEN = { x: 0, y: 0, width: 1920, height: 1080 };

test('any side other than the literal left docks right', () => {
  assert.equal(normalizeSide('left'), 'left');
  assert.equal(normalizeSide('right'), 'right');
  assert.equal(normalizeSide('LEFT'), 'right');
  assert.equal(normalizeSide(''), 'right');
  assert.equal(normalizeSide(undefined), 'right');
  assert.equal(normalizeSide(null), 'right');
});

test('clampCenter keeps the window inside the work area and centres on nonsense', () => {
  const min = EDGE_MARGIN + CAPSULE.height / 2;
  const max = SCREEN.height - EDGE_MARGIN - CAPSULE.height / 2;
  assert.equal(clampCenter(500, SCREEN, CAPSULE.height), 500);
  assert.equal(clampCenter(0, SCREEN, CAPSULE.height), min);
  assert.equal(clampCenter(5000, SCREEN, CAPSULE.height), max);
  assert.equal(clampCenter(Number.NaN, SCREEN, CAPSULE.height), SCREEN.height / 2);
  assert.equal(clampCenter(Number.POSITIVE_INFINITY, SCREEN, CAPSULE.height), SCREEN.height / 2);
  // A work area shorter than the window collapses to its centre instead of going negative.
  assert.equal(clampCenter(500, { height: 100 }, 200), 50);
});

test('boundsFor docks flush to the work-area edge and rounds the placement', () => {
  assert.deepEqual(boundsFor({ side: 'right', workArea: SCREEN, centerY: undefined, ...CAPSULE }),
    { x: SCREEN.width - CAPSULE.width, y: (SCREEN.height - CAPSULE.height) / 2, width: 24, height: 108 });
  assert.deepEqual(boundsFor({ side: 'left', workArea: SCREEN, centerY: undefined, ...CAPSULE }).x, 0);

  // Display offsets (a monitor left of or above the primary one) move the y anchor with the area.
  const offset = { x: -1920, y: -100, width: 1920, height: 1080 };
  assert.deepEqual(boundsFor({ side: 'left', workArea: offset, centerY: 540, ...PANEL }),
    { x: -1920, y: 180, width: 340, height: 520 });
  // A panel is taller than a capsule, so the same anchor clamps to the larger shape's margin.
  assert.equal(boundsFor({ side: 'left', workArea: offset, centerY: 0, ...PANEL }).y, offset.y + EDGE_MARGIN);

  // Half-pixel anchors round to whole window coordinates.
  const rounded = boundsFor({ side: 'right', workArea: { x: 0, y: 0, width: 1000, height: 1000 }, centerY: 100.4, ...CAPSULE });
  assert.equal(rounded.y, 46);
});

test('panelSize shrinks inside small work areas instead of overflowing', () => {
  assert.deepEqual(panelSize(SCREEN), { width: PANEL.width, height: PANEL.height });
  assert.deepEqual(panelSize({ width: 300, height: 400 }), {
    width: 300 - EDGE_MARGIN * 2,
    height: 400 - EDGE_MARGIN * 2,
  });
  assert.deepEqual(panelSize({ width: 10, height: 10 }), { width: 0, height: 0 });
});

test('capsuleBounds and panelBounds default to a vertically centred anchor', () => {
  assert.deepEqual(capsuleBounds(SCREEN, 'right', null),
    { x: 1896, y: 486, width: 24, height: 108 });
  // The same anchor centres both shapes, so toggling does not jump vertically.
  assert.equal(capsuleBounds(SCREEN, 'right', 540).y + CAPSULE.height / 2, 540);
  assert.equal(panelBounds(SCREEN, 'right', 540).y + panelSize(SCREEN).height / 2, 540);
  assert.deepEqual(panelBounds(SCREEN, 'left', 540), { x: 0, y: 280, width: 340, height: 520 });
});

test('centerFromWindowTop converts a dragged screen-space top into a work-area anchor', () => {
  assert.equal(centerFromWindowTop(586, SCREEN, CAPSULE.height), 640);
  assert.equal(centerFromWindowTop(-50, { x: 0, y: -100, width: 1920, height: 1080 }, CAPSULE.height), 104);
});
