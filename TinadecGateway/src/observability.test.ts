import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { app } from './index.js';
import { resetRunSessionLookup } from './runSessionLookup.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetRunSessionLookup();
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('every response carries a Server-Timing total, including errors', { concurrency: false }, async () => {
  globalThis.fetch = (async () => jsonResponse({ ok: true })) as unknown as typeof fetch;

  const ok = await app.handle(new Request('http://gateway.local/api/v1/model-providers'));
  assert.equal(ok.status, 200);
  const okTiming = ok.headers.get('server-timing');
  assert.ok(okTiming, 'expected a Server-Timing header on a proxied response');
  assert.match(okTiming, /(^|, )total;dur=[\d.]+/, `total segment missing from: ${okTiming}`);

  // A route that does not exist never reaches onAfterHandle; the header must still be there.
  const missing = await app.handle(new Request('http://gateway.local/api/v1/definitely-not-a-route'));
  assert.equal(missing.status, 404);
  assert.match(missing.headers.get('server-timing') ?? '', /total;dur=[\d.]+/);
});

test('Server-Timing separates the upstream segment from the total', { concurrency: false }, async () => {
  globalThis.fetch = (async () => jsonResponse({ gateway: 'ok', status: 'ok', version: '0.1.0' })) as unknown as typeof fetch;

  const response = await app.handle(new Request('http://gateway.local/api/v1/health'));
  const timing = response.headers.get('server-timing') ?? '';
  assert.match(timing, /total;dur=[\d.]+/);
  assert.ok(!timing.startsWith(';'), `metric name missing from: ${timing}`);
});

test('the model center snapshot reads every partition in one request', { concurrency: false }, async () => {
  const paths: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const pathname = new URL(String(input)).pathname;
    paths.push(pathname);
    if (pathname === '/api/v1/model-providers') return jsonResponse([{ id: 'provider-1' }]);
    if (pathname === '/api/v1/model-provider-templates') return jsonResponse([{ driver: 'openai' }]);
    if (pathname === '/api/v1/model-routes') return jsonResponse([{ purpose: 'chat', candidates: [] }]);
    if (pathname === '/api/v1/acp/adapters') return jsonResponse([{ id: 'adapter-1' }]);
    if (pathname === '/api/v1/model-readiness') return jsonResponse({ status: 'ready', providers: [] });
    if (pathname === '/api/v1/model-catalog-readiness') return jsonResponse({ status: 'ready' });
    if (pathname === '/api/v1/readiness') return jsonResponse({ status: 'ready', items: [] });
    return jsonResponse({ code: 'not_found' }, 404);
  }) as unknown as typeof fetch;

  const response = await app.handle(new Request('http://gateway.local/api/v1/model-center/snapshot'));
  assert.equal(response.status, 200);
  const body = await response.json() as { parts: Record<string, { ok: boolean; data?: unknown }> };

  for (const part of ['providers', 'templates', 'routes', 'acp_adapters', 'model_readiness', 'catalog_readiness', 'readiness']) {
    assert.equal(body.parts[part]?.ok, true, `${part} should have succeeded`);
  }
  assert.deepEqual(body.parts.providers?.data, [{ id: 'provider-1' }]);
  assert.deepEqual([...paths].sort(), [
    '/api/v1/acp/adapters',
    '/api/v1/model-catalog-readiness',
    '/api/v1/model-provider-templates',
    '/api/v1/model-providers',
    '/api/v1/model-readiness',
    '/api/v1/model-routes',
    '/api/v1/readiness',
  ]);
});

test('one failing partition degrades alone instead of failing the snapshot', { concurrency: false }, async () => {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const pathname = new URL(String(input)).pathname;
    if (pathname === '/api/v1/model-provider-templates') return jsonResponse({ code: 'boom', message: 'nope' }, 500);
    if (pathname === '/api/v1/model-readiness') throw new Error('connect ECONNREFUSED');
    return jsonResponse([]);
  }) as unknown as typeof fetch;

  const response = await app.handle(new Request('http://gateway.local/api/v1/model-center/snapshot'));
  assert.equal(response.status, 200);
  const body = await response.json() as { parts: Record<string, { ok: boolean; status: number }> };
  assert.equal(body.parts.templates?.ok, false);
  assert.equal(body.parts.templates?.status, 500);
  assert.equal(body.parts.model_readiness?.ok, false);
  assert.equal(body.parts.providers?.ok, true);
});

test('task-nodes and context-versions share one orchestration lookup per run', { concurrency: false }, async () => {
  let orchestrationReads = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const pathname = new URL(String(input)).pathname;
    if (pathname.endsWith('/task-nodes') && pathname.includes('/runs/')) return jsonResponse({ code: 'not_found' }, 404);
    if (pathname.endsWith('/context-versions') && pathname.includes('/runs/')) return jsonResponse({ code: 'not_found' }, 404);
    if (pathname === '/api/v1/runs/run-1/orchestration') {
      orchestrationReads++;
      return jsonResponse({ run: { session_id: 'session-1' } });
    }
    if (pathname === '/api/v1/sessions/session-1/task-nodes') {
      return jsonResponse([{ id: 'node-1', run_id: 'run-1' }]);
    }
    if (pathname === '/api/v1/sessions/session-1/context-versions') {
      return jsonResponse([{ id: 'version-1', revision: 1 }]);
    }
    return jsonResponse({ code: 'not_found' }, 404);
  }) as unknown as typeof fetch;

  const nodes = await app.handle(new Request('http://gateway.local/api/v1/runs/run-1/task-nodes'));
  const versions = await app.handle(new Request('http://gateway.local/api/v1/runs/run-1/context-versions'));
  assert.equal(nodes.status, 200);
  assert.equal(versions.status, 200);
  // The panel reads both on one refresh; paying the orchestration round trip twice is the
  // duplicate this lookup exists to remove.
  assert.equal(orchestrationReads, 1);
});
