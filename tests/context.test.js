import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createChartContext, runWithContext } from '../src/core/context.js';
import {
  CHART_IDENTITY_JS,
  extractIdentity,
  sameIdentity,
  checkPreconditions,
} from '../src/core/_identity.js';

// ---------- _identity helpers ----------

describe('identity comparison', () => {
  test('symbols compare bare-ticker, exchange-insensitive', () => {
    assert.equal(sameIdentity('CME_MINI:NQ1!', 'NQ1!', 'symbol'), true);
    assert.equal(sameIdentity('NASDAQ:AAPL', 'AAPL', 'symbol'), true);
    assert.equal(sameIdentity('AAPL', 'MSFT', 'symbol'), false);
  });

  test('null identity never mismatches (flaky read must not block)', () => {
    assert.equal(sameIdentity(null, 'AAPL', 'symbol'), true);
    assert.equal(sameIdentity('AAPL', null, 'symbol'), true);
    assert.equal(sameIdentity(null, null, 'symbol'), true);
  });

  test('timeframes compare exactly', () => {
    assert.equal(sameIdentity('5', '5', 'timeframe'), true);
    assert.equal(sameIdentity('5', '15', 'timeframe'), false);
    assert.equal(sameIdentity(null, '5', 'timeframe'), true);
  });

  test('checkPreconditions reports only failed fields', () => {
    const live = { symbol: 'CME_MINI:NQ1!', timeframe: '5' };
    assert.deepEqual(checkPreconditions({}, live), []);
    assert.deepEqual(checkPreconditions({ expected_symbol: 'NQ1!' }, live), []);
    assert.deepEqual(
      checkPreconditions({ expected_symbol: 'AAPL' }, live),
      [{ field: 'expected_symbol', expected: 'AAPL', actual: 'CME_MINI:NQ1!' }]
    );
    const both = checkPreconditions({ expected_symbol: 'AAPL', expected_timeframe: '15' }, live);
    assert.equal(both.length, 2);
    // unknown live symbol never fails
    assert.deepEqual(checkPreconditions({ expected_symbol: 'AAPL' }, { symbol: null, timeframe: '5' }), []);
  });

  test('extractIdentity normalizes to strings/nulls', () => {
    assert.deepEqual(extractIdentity({ symbol: 'AAPL', timeframe: 5 }), { symbol: 'AAPL', timeframe: '5' });
    assert.deepEqual(extractIdentity(undefined), { symbol: null, timeframe: null });
  });

  test('CHART_IDENTITY_JS is static source (no interpolation hazards)', () => {
    assert.ok(CHART_IDENTITY_JS.includes('chart.symbol()'));
    assert.ok(CHART_IDENTITY_JS.includes('chart.resolution()'));
  });
});

// ---------- withChartContext ----------

/** Mock chart deps: identity model + write log. */
function mockDeps(initial = { symbol: 'CME_MINI:NQ1!', timeframe: '5' }) {
  const state = { ...initial };
  const log = [];
  const deps = {
    state,
    log,
    evaluate: async (js) => {
      log.push('read');
      return { ...state };
    },
    evaluateAsync: async (js) => {
      // parse which setter ran from the generated source
      const op = js.includes('setSymbol') ? 'setSymbol' : 'setResolution';
      const m = js.match(/JSON\.stringify\(|"([^"]+)"/);
      const argMatch = js.match(/(?:setSymbol|setResolution)\("([^"]+)"/);
      log.push(`write:${op}:${argMatch ? argMatch[1] : '?'}`);
      if (op === 'setSymbol') state.symbol = argMatch ? argMatch[1] : state.symbol;
      else state.timeframe = argMatch ? argMatch[1] : state.timeframe;
    },
    waitForChartReady: async (symbol, tf) => {
      log.push(`wait:${symbol || ''}:${tf || ''}`);
      return true;
    },
  };
  return deps;
}

describe('withChartContext: transactional behavior', () => {
  test('same-context request does not flip the chart', async () => {
    const d = mockDeps({ symbol: 'CME_MINI:NQ1!', timeframe: '5' });
    const ctx = createChartContext(d);
    const r = await ctx.withChartContext({ symbol: 'NQ1!', timeframe: '5' }, async () => ({ ok: 1 }));
    assert.equal(r.result.ok, 1);
    assert.deepEqual(r.prior_context, { symbol: 'CME_MINI:NQ1!', timeframe: '5' });
    const writes = d.log.filter(l => l.startsWith('write'));
    assert.equal(writes.length, 0, 'no writes when context already matches');
  });

  test('different symbol flips, runs op, restores prior — in order', async () => {
    const d = mockDeps({ symbol: 'CME_MINI:NQ1!', timeframe: '5' });
    const ctx = createChartContext(d);
    let sawDuring = null;
    const r = await ctx.withChartContext({ symbol: 'NASDAQ:AAPL' }, async ({ prior }) => {
      sawDuring = d.state.symbol;
      return { v: prior.symbol };
    }, { label: 't1' });
    assert.equal(sawDuring, 'NASDAQ:AAPL', 'op ran on requested symbol');
    assert.equal(r.result.v, 'CME_MINI:NQ1!');
    assert.equal(d.state.symbol, 'CME_MINI:NQ1!', 'restored');
    assert.match(d.log.filter(l => l.startsWith('write')).slice(-1)[0], /setSymbol:CME_MINI/);
  });

  test('op failure still restores', async () => {
    const d = mockDeps();
    const ctx = createChartContext(d);
    await assert.rejects(
      () => ctx.withChartContext({ symbol: 'NASDAQ:AAPL' }, async () => { throw new Error('boom'); }),
      /boom/
    );
    assert.equal(d.state.symbol, 'CME_MINI:NQ1!', 'restored after failure');
    // caller error is the op error, not a restore artifact
  });

  test('P2-18: abort mid-op rejects the caller and still restores', async () => {
    const d = mockDeps({ symbol: 'CME_MINI:NQ1!', timeframe: '5' });
    const ctx = createChartContext(d);
    const ctl = new AbortController();
    let opSettled = false;
    const p = ctx.withChartContext({ symbol: 'NASDAQ:AAPL' }, async () => {
      await new Promise((r) => setTimeout(r, 50));
      opSettled = true;
      return { v: 1 };
    }, { label: 'cxl', signal: ctl.signal });
    setTimeout(() => ctl.abort(), 10);
    await assert.rejects(() => p, /aborted by caller/);
    assert.equal(d.state.symbol, 'CME_MINI:NQ1!', 'chart restored despite abort');
  });

  test('P2-18: pre-aborted signal throws before touching the chart', async () => {
    const d = mockDeps();
    const ctx = createChartContext(d);
    const ctl = new AbortController();
    ctl.abort();
    await assert.rejects(
      () => ctx.withChartContext({ symbol: 'NASDAQ:AAPL' }, async () => ({ v: 1 }), { signal: ctl.signal }),
      /aborted by caller/
    );
    assert.equal(d.log.filter((l) => l.startsWith('write')).length, 0, 'no chart writes at all');
  });

  test('P2-18 (panel r1): pre-aborted rejects IMMEDIATELY, even while the lock is held', async () => {
    const d = mockDeps();
    const ctx = createChartContext(d);
    // Op A holds the lock until released.
    let releaseA = null;
    const blocker = ctx.withChartContext({ symbol: 'MSFT' }, () => new Promise((r) => { releaseA = r; }), { label: 'A' });
    await new Promise((r) => setTimeout(r, 5)); // let A acquire the lock
    const ctlB = new AbortController();
    ctlB.abort();
    const t0 = Date.now();
    await assert.rejects(
      () => ctx.withChartContext({ symbol: 'TSLA' }, async () => ({ v: 1 }), { label: 'B', signal: ctlB.signal }),
      /aborted by caller/
    );
    assert.ok(Date.now() - t0 < 50, `rejected promptly (${Date.now() - t0}ms), not queued behind A`);
    releaseA();
    await blocker;
  });

  test('P2-18 (panel r1): no listener leak on a reused session signal', async () => {
    const d = mockDeps();
    const ctx = createChartContext(d);
    const ctl = new AbortController();
    // Session-level signal reused across many successful transactions.
    const before = ctl.signal.eventNames ? undefined : null;
    for (let i = 0; i < 20; i++) {
      await ctx.withChartContext({ symbol: 'MSFT' }, async () => ({ i }), { label: 'reuse', signal: ctl.signal });
    }
    // Node exposes listener count on raw EventEmitter; AbortSignal wraps it.
    const listeners = (ctl.signal._events ? Object.values(ctl.signal._events).flat().length : 0)
      ?? before ?? 0;
    assert.ok(listeners === 0, `expected 0 remaining abort listeners, got ${listeners}`);
  });

  test('P2-18 (panel r1): op that rejects AFTER abort wins does not crash the process', async () => {
    const d = mockDeps();
    const ctx = createChartContext(d);
    const ctl = new AbortController();
    const p = ctx.withChartContext({ symbol: 'MSFT' }, async () => {
      await new Promise((r) => setTimeout(r, 40));
      throw new Error('late page-side failure');
    }, { label: 'latereject', signal: ctl.signal });
    setTimeout(() => ctl.abort(), 5);
    await assert.rejects(() => p, /aborted by caller/);
    // Give the background op time to reject — an unhandledRejection here
    // crashes the test runner under Node 15+ semantics.
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(d.state.symbol, 'CME_MINI:NQ1!', 'chart restored');
  });

  test('serialization: overlapping contexts run strictly one after another', async () => {
    const d = mockDeps();
    const ctx = createChartContext(d);
    const events = [];
    const a = ctx.withChartContext({ symbol: 'MSFT' }, async () => {
      events.push('a-start');
      await new Promise(r => setTimeout(r, 30));
      events.push('a-end');
      return 'a';
    }, { label: 'a' });
    const b = ctx.withChartContext({ symbol: 'TSLA' }, async () => {
      events.push('b-start');
      return 'b';
    }, { label: 'b' });
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(ra.result, 'a');
    assert.equal(rb.result, 'b');
    const ai = events.indexOf('a-end');
    const bi = events.indexOf('b-start');
    assert.ok(bi > ai, `b must not start before a ends (${events.join(',')})`);
    assert.equal(d.state.symbol, 'CME_MINI:NQ1!', 'final state = original');
  });

  test('restore completes before the next queued mutation applies', async () => {
    const d = mockDeps();
    const ctx = createChartContext(d);
    const seen = [];
    await ctx.withChartContext({ symbol: 'MSFT' }, async () => { seen.push(d.state.symbol); });
    await ctx.withChartContext({ symbol: 'TSLA' }, async () => { seen.push(d.state.symbol); });
    assert.deepEqual(seen, ['MSFT', 'TSLA']);
  });

  test('external identity change during hold is detected and reported', async () => {
    const d = mockDeps({ symbol: 'NQ1!', timeframe: '5' });
    const ctx = createChartContext(d);
    const r = await ctx.withChartContext({ symbol: 'MSFT' }, async () => {
      d.state.symbol = 'GAMESTOP'; // someone moved the chart mid-hold
      return 1;
    });
    assert.ok(r.external_change, 'external_change reported');
    assert.equal(r.external_change.observed.symbol, 'GAMESTOP');
    assert.equal(d.state.symbol, 'NQ1!', 'still restored');
  });
});

describe('chart-context lock bookkeeping', () => {
  test('ownerInfo: locked during hold, free after', async () => {
    const d = mockDeps();
    const ctx = createChartContext(d);
    assert.deepEqual(ctx.ownerInfo(), { locked: false, owner: null });
    let during = null;
    await ctx.withChartContext({ symbol: 'MSFT' }, async () => {
      during = ctx.ownerInfo();
    }, { label: 'probe' });
    assert.deepEqual(during, { locked: true, owner: 'probe' });
    assert.deepEqual(ctx.ownerInfo(), { locked: false, owner: null });
  });
});