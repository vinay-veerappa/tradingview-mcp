import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startGateway, handleRequest, GATEWAY_DEFAULT_PORT } from '../src/gateway/http.js';
import { SUBSCRIPTION_KINDS } from '../src/core/subscribe.js';

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

  test('mutations are refused: POST → 405 read-only', async () => {
    const { port, close } = await boot();
    try {
      const r = await get(port, '/state', 'POST');
      assert.equal(r.status, 405);
      const body = JSON.parse(r.body);
      assert.equal(body.error.code, 'http_method_not_allowed');
      assert.ok(/read-only/.test(body.error.message));
    } finally { await close(); }
  });

  test('SSE stream serves event-stream and emits connection events offline', async () => {
    const { port, close } = await boot();
    try {
      const r = await getSse(port, '/stream/quote?interval=40', 600);
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

  test('upstream failure yields retryable envelope (route handler throws)', async () => {
    const { port, close } = await boot();
    try {
      // Offline deps: /state → getState throws → 502 upstream_failed.
      const r = await get(port, '/state');
      assert.equal(r.status, 502);
      const body = JSON.parse(r.body);
      assert.equal(body.success, false);
      assert.equal(body.error.code, 'upstream_failed');
      assert.equal(body.error.retryable, true);
      assert.ok(/ECONNREFUSED EPIPE/.test(body.error.message), 'real error message carried through');
    } finally { await close(); }
  });

  test('default port constant sane', () => {
    assert.equal(typeof GATEWAY_DEFAULT_PORT, 'number');
    assert.equal(SUBSCRIPTION_KINDS.length, 4);
  });
});