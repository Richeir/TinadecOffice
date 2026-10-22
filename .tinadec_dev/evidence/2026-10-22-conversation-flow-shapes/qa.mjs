/**
 * Pixel check for the conversation-flow shapes: one settled team run rendered five ways.
 *
 * Drives a headless Chrome over CDP against the Vite dev server (127.0.0.1:5173), opens the
 * Debug Studio preview gallery, switches the preset through Settings → General the way a reader
 * would, and records what each shape actually draws: which rows survive, whether the fold is
 * there, what a sub-agent row says, and whether opening it in place works.
 *
 * Usage: node .tinadec_dev/evidence/2026-10-22-conversation-flow-shapes/qa.mjs
 * The dev server must already be running (npm run dev in apps/desktop).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = 'http://127.0.0.1:5173';
const port = 9333;
const chromePath = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tinadec-flow-qa-'));
const PRESETS = ['codex', 'claude', 'openchamber', 'trae', 'qoder'];

const browser = spawn(chromePath, [
  '--headless=new',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  // Tall enough for a 12-row team turn to fit in the preview viewport without scrolling.
  '--window-size=1440,1700',
  '--no-first-run',
  '--disable-gpu',
  `${app}/#/settings`,
], { stdio: 'ignore' });

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function firstTarget() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) })).json();
      const found = list.find((entry) => entry.type === 'page' && entry.url.startsWith(app));
      if (found) return found;
    } catch { /* Chrome is still starting. */ }
    await delay(250);
  }
  throw new Error('headless Chrome never exposed the renderer target');
}

const page = await firstTarget();
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('CDP handshake timeout')), 5000);
  ws.onopen = () => { clearTimeout(timer); resolve(); };
  ws.onerror = reject;
});

let serial = 0;
const pending = new Map();
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);
  if (!message.id) return;
  const entry = pending.get(message.id);
  pending.delete(message.id);
  if (!entry) return;
  message.error ? entry.reject(new Error(JSON.stringify(message.error))) : entry.resolve(message.result);
};
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++serial;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 20000);
  pending.set(id, {
    resolve: (value) => { clearTimeout(timer); resolve(value); },
    reject: (error) => { clearTimeout(timer); reject(error); },
  });
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(`${result.exceptionDetails.text} ${result.exceptionDetails.exception?.description ?? ''}`);
  return result.result.value;
};
async function until(expression, label = expression) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (await evaluate(expression)) return;
    await delay(100);
  }
  throw new Error(`UI did not settle: ${label}`);
}
async function shot(name, selector) {
  const rect = selector
    ? await evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    })()`)
    : null;
  const capture = await call('Page.captureScreenshot', rect
    ? { format: 'jpeg', quality: 88, clip: { ...rect, scale: 1 } }
    : { format: 'jpeg', quality: 88 });
  fs.writeFileSync(path.join(here, `${name}.jpg`), Buffer.from(capture.data, 'base64'));
}

/** The preview shim reports debug studio off; the gallery is a dev surface, so admit this window. */
async function admitDebugStudio() {
  await evaluate(`(async () => {
    const real = window.tinadec.getAppConfig.bind(window.tinadec);
    window.tinadec.getAppConfig = async () => ({ ...(await real()), debug_studio_enabled: true });
    return true;
  })()`);
}

async function openGeneral() {
  await evaluate(`location.hash = '#/settings'`);
  await until(`!!document.querySelector('.settings-nav button')`, 'settings page');
  await evaluate(`(() => {
    const el = [...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === '常规');
    if (el) el.click();
  })()`);
  await until(`!!document.querySelector('.flow-style-options')`, 'conversation flow group');
}

async function openFlowPreview() {
  await evaluate(`location.hash = '#/debug-studio'`);
  await until(`[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === '预览')`, 'debug studio tabs');
  await evaluate(`(() => {
    const el = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '预览');
    if (el) el.click();
  })()`);
  await until(`!!document.querySelector('.tree-item')`, 'preview gallery');
  await evaluate(`(() => {
    const el = [...document.querySelectorAll('.tree-item')].find((b) => b.textContent.includes('对话消息流'));
    if (!el) throw new Error('no conversation page row');
    el.click();
  })()`);
  await until(`!!document.querySelector('.conversation-preview-scenario')`, 'conversation preview');
  await evaluate(`(() => {
    const el = [...document.querySelectorAll('.conversation-preview-scenario')].find((b) => b.textContent.trim() === 'finished-team-run');
    if (!el) throw new Error('no finished-team-run scenario');
    el.click();
  })()`);
  await until(`!!document.querySelector('[data-testid="conversation-turn"]')`, 'a rendered turn');
  await delay(600);
}

const result = { presets: {} };
try {
  await call('Page.enable');
  await until(`!!document.querySelector('.settings-nav button') && !!window.tinadec`, 'app shell');
  await evaluate(`localStorage.setItem('tinadec.conversation-flow-preset', 'qoder')`);
  await admitDebugStudio();
  console.log('step: settings control');

  // 1. The settings control itself: five rows, one density tag each, one row carrying the accent.
  await openGeneral();
  await evaluate(`document.querySelector('.flow-style-options').scrollIntoView({ block: 'center' })`);
  await delay(500);
  result.settings = await evaluate(`(() => {
    const group = document.querySelector('.flow-style-options');
    const rows = [...group.querySelectorAll('[role="radio"]')].map((row) => {
      const name = row.querySelector('.flow-style-option-name');
      const density = row.querySelector('.flow-style-option-density');
      return {
        checked: row.getAttribute('aria-checked'),
        name: name.textContent.trim(),
        density: density.textContent.trim(),
        nameColor: getComputedStyle(name).color,
        densityColor: getComputedStyle(density).color,
      };
    });
    return { label: group.getAttribute('aria-label'), rows };
  })()`);
  await shot('settings-flow-options', '.general-settings-group[aria-labelledby="conversation-flow-title"]');

  // 2. One settled team run, five shapes. Switching through the radio also checks that the
  //    control is wired to the feed, not only to storage.
  for (const preset of PRESETS) {
    console.log(`step: ${preset}`);
    await openGeneral();
    await evaluate(`document.querySelector('[data-testid="flow-style-${preset}"]').click()`);
    await delay(300);
    await openFlowPreview();
    result.presets[preset] = await evaluate(`(() => {
      const turn = document.querySelector('[data-testid="conversation-turn"]');
      const cards = [...turn.querySelectorAll('[data-testid="sub-agent-card"]')];
      const first = cards[0];
      return {
        stored: localStorage.getItem('tinadec.conversation-flow-preset'),
        summary: turn.querySelector('[data-testid="turn-summary"]')?.textContent.trim() ?? null,
        earlier: turn.querySelector('[data-testid="turn-earlier"]')?.textContent.trim() ?? null,
        nodes: [...turn.querySelectorAll('[data-node]')].map((node) => node.getAttribute('data-node')),
        groups: turn.querySelectorAll('[data-testid="activity-group"]').length,
        tools: turn.querySelectorAll('[data-testid="tool-row"]').length,
        failedTools: turn.querySelectorAll('[data-testid="tool-row"][data-phase="failed"]').length,
        agents: cards.length,
        agentRow: first ? first.innerText.replace(/\\s+/g, ' ').trim() : null,
        agentResult: first?.querySelector('[data-testid="sub-agent-result"]')?.textContent.trim() ?? null,
        agentOpen: first?.querySelector('[data-testid="sub-agent-toggle"]')?.getAttribute('aria-expanded') ?? null,
        agentToggle: first?.querySelector('[data-testid="sub-agent-toggle"]')?.tagName ?? null,
      };
    })()`);
    // A screenshot that starts mid-run shows the rows but not the shape: begin at the user bubble.
    result.presets[preset].frame = await evaluate(`(() => {
      const turn = document.querySelector('[data-testid="conversation-turn"]');
      const scroller = turn.parentElement.closest('[data-slot="message-scroller-viewport"]') ?? turn.parentElement;
      turn.scrollIntoView({ block: 'start' });
      return { turnHeight: Math.round(turn.getBoundingClientRect().height), viewportHeight: Math.round(scroller.getBoundingClientRect().height) };
    })()`);
    await delay(400);
    await shot(`turn-${preset}`, '.conversation-preview-inner');

    // A shape that opens in place says so by rendering a button, not by pretending with a div.
    if (result.presets[preset].agentToggle === 'BUTTON') {
      await evaluate(`document.querySelector('[data-testid="sub-agent-toggle"]').click()`);
      await delay(500);
      result.presets[preset].detailAfterClick = await evaluate(`(() => {
        const detail = document.querySelector('[data-testid="sub-agent-detail"]');
        if (!detail) return null;
        const style = getComputedStyle(detail);
        return { capped: detail.classList.contains('is-capped'), maxHeight: style.maxHeight, overscroll: style.overscrollBehaviorY };
      })()`);
      await shot(`turn-${preset}-detail`, '.conversation-preview-inner');
    }
  }

  // 3. The contract each shape promises, against the same twelve-row turn. The readings are
  //    written first: a failed assertion should still leave the evidence on disk.
  fs.writeFileSync(path.join(here, 'checks.json'), JSON.stringify(result, null, 2));
  const { settings, presets } = result;
  const chosen = settings.rows.filter((row) => row.checked === 'true');
  assert.equal(settings.rows.length, 5);
  assert.equal(chosen.length, 1);
  const muted = settings.rows.filter((row) => row.checked !== 'true').map((row) => row.densityColor);
  assert.equal(new Set(muted).size, 1, 'every unselected density word shares one muted colour');
  assert.notEqual(chosen[0].densityColor, muted[0], 'the chosen density word carries the accent');

  assert.equal(presets.codex.stored, 'codex');
  assert.equal(presets.codex.nodes.length, 0, 'codex folds a settled turn away');
  assert.ok(presets.codex.summary, 'codex still offers the summary line');
  assert.equal(presets.codex.agents, 0);

  assert.equal(presets.claude.nodes.length, 14, 'claude lists every quiet step');
  assert.equal(presets.claude.groups, 0, 'claude draws no exploration group');
  assert.equal(presets.claude.tools, 10);
  assert.equal(presets.claude.earlier, null);
  assert.match(presets.claude.agentRow ?? '', /Research the callers of useResults/);
  assert.equal(presets.claude.agentResult, null, 'claude stops at the task line');

  assert.equal(presets.openchamber.nodes.filter((node) => node !== 'earlier').length, 10, 'openchamber hides two of twelve rows');
  assert.match(presets.openchamber.earlier ?? '', /2/);
  assert.equal(presets.openchamber.agents, 2, 'the budget never hides a sub-agent row');
  assert.equal(presets.openchamber.failedTools, 1, 'the budget never hides a failure');
  assert.equal(presets.openchamber.tools, 7);

  for (const preset of ['trae', 'qoder']) {
    assert.equal(presets[preset].nodes.length, 12, `${preset} keeps every row`);
    assert.equal(presets[preset].earlier, null);
    assert.equal(presets[preset].agents, 2);
    assert.equal(presets[preset].agentResult, 'Found 4 callers');
    assert.equal(presets[preset].agentToggle, 'BUTTON');
    assert.equal(presets[preset].agentOpen, 'false', 'a finished agent starts closed');
    assert.equal(presets[preset].detailAfterClick?.capped, true, 'in-place detail is capped');
    assert.equal(presets[preset].detailAfterClick?.overscroll, 'contain');
  }

  fs.writeFileSync(path.join(here, 'checks.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error('QA failed:', error);
  throw error;
} finally {
  ws.close();
  browser.kill();
  await delay(1000);
  try {
    fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  } catch {
    console.warn('profile left behind:', profile);
  }
}
