import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { startGateway, handleRequest, GATEWAY_DEFAULT_PORT } from '../src/gateway/http.js';
import { SUBSCRIPTION_KINDS } from '../src/core/subscribe.js';
import { registerAll } from '../src/tools/index.js';

// The gateway's route table is DERIVED from the canonical operation registry
// (P2-19) — module-level shared state. Fill it exactly as server.js does, so
// the derived routes exist in this process.
registerAll(new McpServer({ name: 'gateway-test', version: '0' }));

// Ephemeral-port gateway. Route handlers touch CDP unless we inject _deps —
// and a REAL CDP client is a pooled socket that keeps the test process alive.
// The offline seam (house pattern since step 2): a failing evaluate means
// every CDP-backed route deterministically throws → 502, and SSE emits
// connection-lost — without ever opening a socket.
const OFFLINE_DEPS = {
  evaluate: async () => { throw new Error('ECONNREFUSED EPIPE test-injected'); },
  sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20))),
};
async function boot() {
  const { port, close } = await startGateway({ port: 0, _deps: OFFLINE_DEPS });
  return { port, close };
}

function get(port, path, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

function post(port, path, payload) {
  return postRaw(port, path, JSON.stringify(payload));
}

function postRaw(port, path, rawBody) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(rawBody) },
    }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.write(rawBody);
    req.end();
  });
}

function getSse(port, path, ms) {
  // fetch + AbortController — the same pattern proven to exit cleanly
  // (http.get + req.destroy leaves an error-time race that hangs --test).
  return (async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), ms);
    const controller2 = controller;
    try {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, { signal: controller2.signal });
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let body = '';
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          body += dec.decode(value, { stream: true });
        }
      } catch { /* aborted */ }
      return { status: res.status, headers: Object.fromEntries(res.headers), body };
    } catch (e) {
      return { status: 0, headers: {}, body: '', err: String(e) };
    }
  })();
}

describe('gateway (loopback HTTP + SSE)', () => {
  test('health responds with envelope', async () => {
    const { port, close } = await boot();
    try {
      const r = await get(port, '/health');
      assert.equal(r.status, 200);
      const body = JSON.parse(r.body);
      assert.equal(body.success, true);
      assert.equal(body.gateway, 'up');
    } finally { await close(); }
  });

  test('routes 404 cleanly with envelope', async () => {
    const { port, close } = await boot();
    try {
      const r = await get(port, '/nope');
      assert.equal(r.status, 404);
      const body = JSON.parse(r.body);
      assert.equal(body.success, false);
      assert.equal(body.error.code, 'http_not_found');
    } finally { await close(); }
  });

  test('/levels serves normalized named levels (P2-10, offline deps)', async () => {
    // Route table gains /levels only when data_get_pine_labels carries it —
    // assert presence through the derived table itself.
    const { httpRoutes } = await import('../src/tools/_registry.js');
    assert.ok(httpRoutes().some((r) => r.path === '/levels'), '/levels derived from op');
    // Offline CDP: the adapter's failing injected evaluate still reaches core
    // (P2-19 _deps seam) → 502 envelope, same as /state etc.
    const { port, close } = await boot();
    try {
      const r = await get(port, '/levels');
      assert.equal(r.status, 502);
      JSON.parse(r.body); // envelope, not a stack trace
    } finally { await close(); }
  });

  test('mutations are refused: POST → 405 read-only', async () => {
    const { port, close } = await boot();
    try {
      const r = await get(port, '/state', 'POST');
      assert.equal(r.status, 405);
      const body = JSON.parse(r.body);
      assert.equal(body.error.code, 'http_method_not_allowed');
      assert.ok(/read-only|TV_GATEWAY_MUTATIONS/.test(body.error.message));
      // Panel finding (r1): stream routes are known paths — POST must 405, not 404.
      const rs = await get(port, '/stream/quote', 'POST');
      assert.equal(rs.status, 405);
      assert.equal(JSON.parse(rs.body).error.code, 'http_method_not_allowed');
    } finally { await close(); }
  });

  test('ADR 0001: mutation routes are 404 with the gate OFF (default posture)', async () => {
    // Hermetic: explicit OFFLINE env — never trusts the developer's shell.
    const { port, close } = await startGateway({ port: 0, _deps: OFFLINE_DEPS, _env: {} });
    try {
      const r = await post(port, '/paper/orders', { side: 'buy', qty: 1, client_order_id: 'x' });
      assert.equal(r.status, 404, 'route not installed when TV_GATEWAY_MUTATIONS != on');
      const body = JSON.parse(r.body);
      assert.equal(body.error.code, 'http_mutations_disabled');
      assert.ok(/TV_GATEWAY_MUTATIONS/.test(body.error.message));
    } finally { await close(); }
  });

  test('ADR 0001: with the gate ON, POST reaches the adapter; body → core (_deps end-to-end)', async () => {
    // Synthetic mutation op with a recording adapter: proves dispatch order
    // (env gate → body parse → adapter(url, _deps, body)) without CDP.
    const { _resetForTest, op } = await import('../src/tools/_registry.js');
    const { A } = await import('../src/tools/_annotations.js');
    const calls = [];
    _resetForTest();
    op('synth_mut', 'probe', {}, A.MUTATE_IDEMPOTENT, async () => ({}), {
      meta: { mutation_adr: '0001-mutation-routes' },
      http: { method: 'POST', path: '/synth-mut', adapter: (_url, _deps, body) => { calls.push(body); return { success: true, echo: body }; } },
    });
    const { port, close } = await startGateway({ port: 0, _deps: OFFLINE_DEPS, _env: { TV_GATEWAY_MUTATIONS: 'on' } });
    try {
      const ok = await post(port, '/synth-mut', { hello: 'world' });
      assert.equal(ok.status, 200);
      assert.deepEqual(JSON.parse(ok.body).echo, { hello: 'world' });
      assert.deepEqual(calls[0], { hello: 'world' });
      // Invalid JSON → 400 (not a 502): the body is the client's fault.
      const bad = await postRaw(port, '/synth-mut', '{not json');
      assert.equal(bad.status, 400);
      assert.equal(JSON.parse(bad.body).error.code, 'http_bad_request');
      // GET on a POST-only route → 405 with Allow: POST.
      const wrong = await get(port, '/synth-mut');
      assert.equal(wrong.status, 405);
      assert.match(wrong.headers.allow, /POST/);
    } finally {
      await close();
      _resetForTest();
      registerAll(new McpServer({ name: 'gateway-test', version: '0' }));
    }
  });

  test('ADR 0001: gate ON but flag value anything but "on" → still 404 (exact-match gate)', async () => {
    const { _resetForTest, op } = await import('../src/tools/_registry.js');
    const { A } = await import('../src/tools/_annotations.js');
    _resetForTest();
    op('synth_mut2', 'probe', {}, A.MUTATE_IDEMPOTENT, async () => ({}), {
      meta: { mutation_adr: '0001-mutation-routes' },
      http: { method: 'POST', path: '/synth-mut2', adapter: () => ({ success: true }) },
    });
    const { port, close } = await startGateway({ port: 0, _deps: OFFLINE_DEPS, _env: { TV_GATEWAY_MUTATIONS: '1' } });
    try {
      const r = await post(port, '/synth-mut2', {});
      assert.equal(r.status, 404, '"1"/"true"/"yes" do NOT arm the gate — only the literal "on"');
    } finally {
      await close();
      _resetForTest();
      registerAll(new McpServer({ name: 'gateway-test', version: '0' }));
    }
  });

  test('interval boundary (panel r2): 49→400, 50→ok, empty→400', async () => {
    const { port, close } = await boot();
    try {
      const bad49 = await get(port, '/stream/quote?interval=49');
      assert.equal(bad49.status, 400, '49 is below the floor');
      const ok50 = await getSse(port, '/stream/quote?interval=50', 400);
      assert.equal(ok50.status, 200, '50 is the floor — accepted');
      const badEmpty = await get(port, '/stream/quote?interval=');
      assert.equal(badEmpty.status, 400, 'empty string → Number("")=0 → below floor');
      const badZero = await get(port, '/stream/quote?interval=0');
      assert.equal(badZero.status, 400, '0 was a hot loop pre-r1; deliberately 400 now');
    } finally { await close(); }
  });

  test('interval validation: negative/non-numeric → 400 (panel r1: negative = hot-loop)', async () => {
    const { port, close } = await boot();
    try {
      for (const q of ['?interval=-5', '?interval=abc']) {
        const r = await get(port, `/stream/quote${q}`);
        assert.equal(r.status, 400, q);
        assert.equal(JSON.parse(r.body).error.code, 'http_bad_request', q);
      }
    } finally { await close(); }
  });

  test('SSE stream serves event-stream and emits connection events offline', async () => {
    const { port, close } = await boot();
    try {
      const r = await getSse(port, '/stream/quote?interval=100', 600);
      assert.equal(r.status, 200);
      assert.match(r.headers['content-type'] ?? '', /text\/event-stream/);
      assert.ok(r.body.startsWith(':ok'), 'SSE prelude present');
      assert.ok(r.body.includes('event: connection'), 'connection event emitted');
      assert.ok(r.body.includes('"status":"lost"'), 'lost status present');
    } finally { await close(); }
  });

  test('unknown stream kind → 404', async () => {
    const { port, close } = await boot();
    try {
      const r = await get(port, '/stream/badkind');
      assert.equal(r.status, 404);
      assert.equal(JSON.parse(r.body).error.code, 'http_not_found');
    } finally { await close(); }
  });

  test('upstream failure yields the stable error envelope (route adapter throws)', async () => {
    const { port, close } = await boot();
    try {
      // Offline deps: /state → getState throws → 502. Since P2-19 the gateway
      // reuses the MCP layer's buildErrorEnvelope (P2-4): the generic error is
      // message-classified to cdp_command_failed (retryable=false) — the same
      // code a tool call would surface for the same failure.
      const r = await get(port, '/state');
      assert.equal(r.status, 502);
      const body = JSON.parse(r.body);
      assert.equal(body.success, false);
      assert.equal(body.error.code, 'cdp_command_failed');
      assert.ok(/ECONNREFUSED EPIPE/.test(body.error.message), 'real error message carried through');
      assert.ok(body.error.suggested_action, 'stable envelope carries suggested_action');
    } finally { await close(); }
  });

  test('CdpError fidelity survives the gateway hop (P2-4 over HTTP)', async () => {
    // A CdpError-shaped failure (e.g. target_replaced) keeps its reason as the
    // envelope code and its retryability — not flattened to upstream_failed.
    const { _resetForTest, op } = await import('../src/tools/_registry.js');
    const { A } = await import('../src/tools/_annotations.js');
    _resetForTest();
    op('cdp_fail_probe', 'probe', {}, A.READ, async () => ({}), {
      http: {
        path: '/cdp-fail-probe',
        adapter: () => { throw Object.assign(new Error('session closed'), { name: 'CdpError', reason: 'target_replaced' }); },
      },
    });
    const { port, close } = await startGateway({ port: 0 });
    try {
      const r = await get(port, '/cdp-fail-probe');
      assert.equal(r.status, 502);
      const body = JSON.parse(r.body);
      assert.equal(body.error.code, 'target_replaced');
      assert.equal(body.error.retryable, true);
    } finally {
      await close();
      _resetForTest();
      registerAll(new McpServer({ name: 'gateway-test', version: '0' }));
    }
  });

  test('default port constant sane', () => {
    assert.equal(typeof GATEWAY_DEFAULT_PORT, 'number');
    assert.equal(SUBSCRIPTION_KINDS.length, 4);
  });
});