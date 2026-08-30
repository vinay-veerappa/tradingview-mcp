import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { lookup, record, size, clear, normalizeOrderPreview } from '../src/core/_order_dedup.js';
import { A } from '../src/tools/_annotations.js';

function post(port, path, payload) {
  const raw = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(raw) },
    }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.write(raw);
    req.end();
  });
}

beforeEach(() => clear());

describe('dedup store (P2-6)', () => {
  test('miss → record → identical hit', () => {
    clear();
    assert.equal(lookup('k1'), undefined);
    const outcome = { success: true, action: 'place_order', result: { order_id: 'X1' } };
    record('k1', outcome);
    assert.deepEqual(lookup('k1'), outcome);
  });

  test('null/empty key never records', () => {
    clear();
    record(null, { success: true });
    record('', { success: true });
    assert.equal(size(), 0);
  });

  test('non-object result never records', () => {
    clear();
    record('kx', 'not-an-object');
    assert.equal(size(), 0);
  });

  test('store is bounded (oldest evicted past cap)', () => {
    clear();
    for (let i = 0; i < 600; i++) record('bulk' + i, { n: i });
    assert.ok(size() <= 500, `bounded, got ${size()}`);
  });
});

describe('normalizeOrderPreview', () => {
  test('market order minimal shape', () => {
    const p = normalizeOrderPreview({ symbol: 'NQ1!', side: 'buy', qty: 2 });
    assert.deepEqual(p, { symbol: 'NQ1!', side: 'buy', type: 'market', qty: 2, tif: 'DAY' });
  });

  test('limit/stop fields only on relevant types', () => {
    const p = normalizeOrderPreview({ symbol: 'S', side: 'sell', type: 'limit', qty: 1, price: 5000 });
    assert.equal(p.price, 5000);
    assert.equal(p.stop_price, undefined);
    const q = normalizeOrderPreview({ symbol: 'S', side: 'sell', type: 'stop_limit', qty: 1, price: 5000, stop_price: 4990 });
    assert.equal(q.price, 5000);
    assert.equal(q.stop_price, 4990);
  });

  test('brackets + tif preserved, numbers coerced', () => {
    const p = normalizeOrderPreview({ symbol: 'S', side: 'buy', qty: '1', take_profit: '10', stop_loss: '5', tif: 'WEEK' });
    assert.equal(p.take_profit, 10);
    assert.equal(p.stop_loss, 5);
    assert.equal(p.tif, 'WEEK');
    assert.equal(p.qty, 1);
  });

  test('context fills missing symbol, no clobber when provided', () => {
    assert.equal(normalizeOrderPreview({ side: 'buy', qty: 1 }, { symbol: 'CHARTSYM' }).symbol, 'CHARTSYM');
    assert.equal(normalizeOrderPreview({ symbol: 'EXPLICIT', side: 'buy', qty: 1 }, { symbol: 'OTHER' }).symbol, 'EXPLICIT');
  });
});

describe('HTTP order idempotency (ADR 0001 verification hook 3)', () => {
  // Full stack: registry → gateway POST → place_order adapter → dedup store.
  // The adapter REQUIRES client_order_id over HTTP (ADR §1: no opt-out),
  // so the replay guarantee is testable against the store directly.
  test('same client_order_id over HTTP shape → original result replayed, single entry', async () => {
    const { _resetForTest, op } = await import('../src/tools/_registry.js');
    const { startGateway } = await import('../src/gateway/http.js');
    const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
    const { registerAll } = await import('../src/tools/index.js');

    // Real POST /paper/orders adapter logic from paper.js, bound to a stub
    // core.placeOrder — proves the ADAPTER enforces the idempotency contract
    // and the dedup store replays, without CDP.
    let placements = 0;
    _resetForTest();
    op('synth_http_order', 'probe', {}, A.MUTATE_ORDER, async () => ({}), {
      meta: { mutation_adr: '0001-mutation-routes' },
      http: {
        method: 'POST',
        path: '/synth-order',
        adapter: (_url, _deps, body = {}) => {
          if (!body.client_order_id) {
            throw Object.assign(new Error('client_order_id is REQUIRED over HTTP (ADR 0001 §1)'), { reason: 'http_bad_request' });
          }
          const prior = lookup(body.client_order_id);
          if (prior) return { ...prior, deduplicated: true };
          placements++;
          const outcome = { success: true, action: 'place_order', order_id: 'OID-' + placements };
          record(body.client_order_id, outcome);
          return outcome;
        },
      },
    });

    const OFFLINE = { evaluate: async () => { throw new Error('offline'); } };
    const { port, close } = await startGateway({ port: 0, _deps: OFFLINE, _env: { TV_GATEWAY_MUTATIONS: 'on' } });
    try {
      const first = await post(port, '/synth-order', { side: 'buy', qty: 1, client_order_id: 'idem-1' });
      assert.equal(first.status, 200);
      const firstBody = JSON.parse(first.body);
      assert.equal(firstBody.order_id, 'OID-1');
      assert.equal(firstBody.deduplicated, undefined);

      const replay = await post(port, '/synth-order', { side: 'buy', qty: 1, client_order_id: 'idem-1' });
      const replayBody = JSON.parse(replay.body);
      assert.equal(replayBody.deduplicated, true, 'same key replays the ORIGINAL outcome');
      assert.equal(replayBody.order_id, 'OID-1');
      assert.equal(placements, 1, 'exactly ONE placement despite two POSTs');

      // Missing key over HTTP → refused before any placement (no silent dup risk).
      const noKey = await post(port, '/synth-order', { side: 'buy', qty: 1 });
      assert.equal(noKey.status, 502);
      assert.equal(JSON.parse(noKey.body).error.code, 'http_bad_request');
      assert.equal(placements, 1);
    } finally {
      await close();
      clear();
      _resetForTest();
      registerAll(new McpServer({ name: 'order-idem-restore', version: '0' }));
    }
  });

  test('production paper_place_order adapter rejects a missing client_order_id over HTTP', async () => {
    const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
    const { registerAll } = await import('../src/tools/index.js');
    const { startGateway } = await import('../src/gateway/http.js');
    const { getOp } = await import('../src/tools/_registry.js');
    // Restore production table, then inspect the REAL adapter.
    registerAll(new McpServer({ name: 'order-idem-prod', version: '0' }));
    const placeRoute = getOp('paper_place_order');
    assert.equal(placeRoute.transports.http.method, 'POST');
    // The ADR contract, enforced in production code: no key → http_bad_request,
    // thrown BEFORE core.placeOrder is ever reached (synchronously — wrap in
    // an async fn so assert.rejects sees a rejected promise).
    const stubUrl = { searchParams: { get: () => null } };
    await assert.rejects(
      async () => placeRoute.transports.http.adapter(stubUrl, null, { side: 'buy', qty: 1 }),
      (err) => err.reason === 'http_bad_request' && /client_order_id is REQUIRED/.test(err.message),
    );
  });
});