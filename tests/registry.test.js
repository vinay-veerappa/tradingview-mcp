import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAll } from '../src/tools/index.js';
import {
  op, listOps, getOp, httpRoutes, accessFromAnnotations, accessFromClassRef, _resetForTest,
} from '../src/tools/_registry.js';
import { A } from '../src/tools/_annotations.js';

// Register production tooling exactly once at module scope. registerAll()
// resets the registry itself and re-registers all 102 tool ops; system_status
// and profile_set (P2-14) are ALWAYS-VISIBLE system tools registered outside
// the registry on purpose (they describe the registry, so they cannot live in
// it without a bootstrapping cycle) — the bijectivity test asserts against
// registerAll's surface alone.
registerAll(new McpServer({ name: 't', version: '0' }));
const REGISTRY_TOOLS = listOps().map((o) => o.name);
const ALWAYS_VISIBLE = ['system_status', 'profile_set'];

describe('canonical operation registry (P2-19)', () => {
  test('every registry op is unique and non-empty (full surface)', () => {
    assert.equal(new Set(REGISTRY_TOOLS).size, REGISTRY_TOOLS.length, 'duplicate op names');
    assert.ok(REGISTRY_TOOLS.length >= 114, `expected the full surface, got ${REGISTRY_TOOLS.length}`);
  });

  test('no registry op collides with the always-visible system tools', () => {
    for (const s of ALWAYS_VISIBLE) {
      assert.equal(REGISTRY_TOOLS.includes(s), false, `${s} must live outside the registry (P2-14)`);
    }
  });

  test('op names are unique by construction (duplicate registration throws)', () => {
    _resetForTest();
    op('dup_probe', 'probe', {}, A.READ, async () => ({ success: true }));
    assert.throws(() => op('dup_probe', 'probe again', {}, A.READ, async () => ({})), /duplicate op/);
    // Restore the production table — the registry is module-level shared state;
    // every probe test must leave it as it found it (registerAll resets+fills).
    registerAll(new McpServer({ name: 'restore', version: '0' }));
  });

  test('annotations without a known access class are refused (P2-13 coherence enforced in op())', () => {
    assert.throws(
      () => op('bad_ann', 'probe', {}, { readOnlyHint: true }, async () => ({})),
      /access class/,
    );
    // Partial/unknown custom shapes refused via the mapper too
    assert.equal(accessFromAnnotations({ readOnlyHint: true, destructiveHint: false }), null);
  });

  test('access classes map 1:1 from the six annotation classes', () => {
    assert.equal(accessFromAnnotations(A.READ), 'read');
    assert.equal(accessFromAnnotations(A.MUTATE_IDEMPOTENT), 'mutate');
    assert.equal(accessFromAnnotations(A.MUTATE_ORDER), 'order');
    assert.equal(accessFromAnnotations(A.DESTRUCTIVE), 'destructive');
    assert.equal(accessFromAnnotations(A.OPEN_WORLD), 'open-world');
    assert.equal(accessFromAnnotations(A.SYSTEM), 'system');
    assert.equal(accessFromClassRef(A.READ), 'read');
    assert.equal(accessFromClassRef({}), null);
  });

  test('every derived registry entry carries name/description/handler/annotations/access', () => {
    for (const e of listOps()) {
      assert.equal(typeof e.name, 'string', e.name);
      assert.equal(typeof e.description, 'string', e.name);
      assert.equal(typeof e.handler, 'function', e.name);
      assert.ok(e.annotations && typeof e.annotations.readOnlyHint === 'boolean', e.name);
      assert.ok(['read', 'mutate', 'order', 'destructive', 'open-world', 'system'].includes(e.access), e.name);
    }
  });

  test('access ↔ annotation coherence across ALL registered ops', () => {
    for (const e of listOps()) {
      const a = e.annotations;
      if (e.access === 'read') {
        assert.equal(a.readOnlyHint, true, e.name);
        assert.equal(a.destructiveHint, false, e.name);
      }
      if (e.access === 'destructive') assert.equal(a.destructiveHint, true, e.name);
      if (e.access === 'order') { assert.equal(a.idempotentHint, false, e.name); assert.equal(a.readOnlyHint, false, e.name); }
      if (e.access === 'open-world') assert.equal(a.openWorldHint, true, e.name);
    }
  });
});

describe('derived HTTP route table (gateway generation)', () => {
  test('every bound op cites its authorization: read-GET needs none, mutations must cite ADR 0001', () => {
    for (const r of httpRoutes()) {
      const e = getOp(r.op);
      assert.ok(e, `route references unknown op '${r.op}'`);
      if (r.method === 'GET') {
        assert.equal(e.access, 'read', r.path);
        assert.equal(e.meta?.mutation_adr, undefined, `${r.path}: read routes carry no ADR meta`);
      } else {
        // ADR 0001: mutation binding ⇔ meta.mutation_adr cited + allowed method + allowed class.
        assert.equal(e.meta?.mutation_adr, '0001-mutation-routes', r.path);
        assert.ok(['POST', 'PATCH', 'DELETE'].includes(r.method), r.path);
        assert.ok(['mutate', 'order'].includes(e.access), `${r.path}: access '${e.access}' not HTTP-bindable`);
        assert.ok(e.annotations.readOnlyHint === false, r.path);
      }
    }
  });

  test('op() refuses a mutation http binding WITHOUT the ADR meta key', () => {
    _resetForTest();
    try {
      assert.throws(
        () => op('mut_probe', 'probe', {}, A.MUTATE_IDEMPOTENT, async () => ({}),
          { http: { method: 'POST', path: '/will-not-bind', adapter: () => ({}) } }),
        /mutation_adr|read-only/,
        'non-read op without meta.mutation_adr must be refused',
      );
      assert.throws(
        () => op('mut_get_probe', 'probe', {}, A.MUTATE_IDEMPOTENT, async () => ({}),
          { meta: { mutation_adr: '0001-mutation-routes' }, http: { path: '/will-not-bind', adapter: () => ({}) } }),
        /access 'read'/,
        'mutation ops cannot bind GET — even with the ADR meta, GET stays read-only access',
      );
    } finally {
      _resetForTest();
      registerAll(new McpServer({ name: 'restore', version: '0' }));
    }
  });

  test('op() refuses destructive/open-world transports even WITH the ADR meta', () => {
    _resetForTest();
    try {
      assert.throws(
        () => op('destructive_probe', 'probe', {}, A.DESTRUCTIVE, async () => ({}),
          { meta: { mutation_adr: '0001-mutation-routes' }, http: { method: 'POST', path: '/nope', adapter: () => ({}) } }),
        /MCP-only|destructive/,
      );
      assert.throws(
        () => op('openworld_probe', 'probe', {}, A.OPEN_WORLD, async () => ({}),
          { meta: { mutation_adr: '0001-mutation-routes' }, http: { method: 'POST', path: '/nope', adapter: () => ({}) } }),
        /MCP-only|open-world/,
      );
      assert.throws(
        // PUT is outside the ADR's allowed mutation verbs
        () => op('put_probe', 'probe', {}, A.MUTATE_IDEMPOTENT, async () => ({}),
          { meta: { mutation_adr: '0001-mutation-routes' }, http: { method: 'PUT', path: '/nope', adapter: () => ({}) } }),
        /not allowed/,
      );
    } finally {
      _resetForTest();
      registerAll(new McpServer({ name: 'restore', version: '0' }));
    }
  });

  test('the expected read surface binds: identity + snapshot + panes + diagnostics', () => {
    const paths = httpRoutes().filter((r) => r.method === 'GET').map((r) => r.path);
    for (const p of ['/state', '/quote', '/snapshot', '/panes', '/compat', '/diagnostics']) {
      assert.ok(paths.includes(p), `missing ${p}`);
    }
  });

  test('REST data surface binds as read-only GETs (docs/REST_DATA_SURFACES.md §11)', () => {
    const restOps = listOps().filter((o) => o.name.startsWith('tv_') && o.transports.http);
    const restRoutes = restOps.filter((o) => /^\/(symbol|screener|calendar|news|documents)/.test(o.transports.http.path));
    assert.equal(restRoutes.length, 12, 'all 12 REST tools carry a route');
    for (const o of restRoutes) {
      assert.equal(o.access, 'read', o.name);
      assert.equal(o.transports.http.method, 'GET', o.name);
      assert.equal(o.meta?.mutation_adr, undefined, `${o.name}: reads cite no ADR`);
      assert.ok(o.annotations.readOnlyHint === true, o.name);
    }
    // REST route paths are disjoint from the chart routes. Uniqueness itself is
    // method+path (one path may deliberately serve GET + POST, e.g. /paper/orders).
    const chartPaths = new Set(
      listOps().filter((o) => o.transports.http && !/^\/(symbol|screener|calendar|news|documents)/.test(o.transports.http.path))
        .map((o) => o.transports.http.path),
    );
    for (const o of restRoutes) {
      assert.equal(chartPaths.has(o.transports.http.path), false, `${o.name} reuses a chart path`);
    }
    const keys = httpRoutes().map((r) => `${r.method} ${r.path}`);
    assert.equal(new Set(keys).size, keys.length, 'duplicate method+path in the derived table');
  });

  test('mutation routes exist ONLY for paper mutation ops (ADR 0001 scope)', () => {
    const mut = httpRoutes().filter((r) => r.method !== 'GET');
    const paths = mut.map((r) => r.path);
    assert.deepEqual(
      [...paths].sort(),
      ['/paper/brackets', '/paper/connect', '/paper/orders', '/paper/orders/cancel', '/paper/orders/modify', '/paper/positions/close'].sort(),
    );
    // Paper order POST must require the idempotency key — enforced in the adapter.
    const place = getOp('paper_place_order');
    assert.equal(place.transports.http.method, 'POST');
  });

  test('route paths are unique and every route carries its op + access', () => {
    const routes = httpRoutes();
    const paths = routes.map((r) => r.path + ' ' + r.method);
    assert.equal(new Set(paths).size, paths.length, 'duplicate method+path in derived table');
    for (const r of routes) assert.ok(['GET', 'POST', 'PATCH', 'DELETE'].includes(r.method), r.path);
  });

  test('gateway request path executes the op adapter and maps failures to 502 (envelope preserved)', async () => {
    _resetForTest();
    // Adapters return the RAW payload (no MCP wrapper) — the production pattern.
    op('synth_ok', 'probe', {}, A.READ, async () => ({}),
      { http: { path: '/synth-ok', adapter: () => ({ success: true, hello: 1 }) } });
    op('synth_err', 'probe', {}, A.READ, async () => ({}),
      { http: { path: '/synth-err', adapter: () => { throw Object.assign(new Error('ECONNREFUSED EPIPE synth'), { name: 'CdpError', reason: 'target_replaced' }); } } });
    const { startGateway } = await import('../src/gateway/http.js');
    const { port, close } = await startGateway({ port: 0 });
    try {
      const ok = await fetch(`http://127.0.0.1:${port}/synth-ok`).then((r) => r.json());
      assert.equal(ok.success, true);
      assert.equal(ok.hello, 1);
      const res = await fetch(`http://127.0.0.1:${port}/synth-err`);
      const body = await res.json();
      assert.equal(res.status, 502);
      assert.equal(body.error.code, 'target_replaced'); // CdpError envelope preserved, not flattened
      assert.equal(body.error.retryable, true);
    } finally { await close(); }
    // Restore the production table for any later reader.
    _resetForTest();
    registerAll(new McpServer({ name: 'restore', version: '0' }));
  });
});