import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { paneScan } from '../src/core/pane_scan.js';

// Four-pane layout mock in the exact shape the page returns.
const LAYOUT_MOCK = {
  panes: [
    { index: 0, symbol: 'CME_MINI:NQ1!', resolution: '5', bar_time: 1788013500, last: 24550.25, open: 24540, high: 24560, low: 24535, volume: 1234, change: 10.25, change_pct: 0.0418, bar_range: 20.25, freshness: { bar_age_ms: 84000 }, active: true,
      values: [{ indicator: 'Relative Strength Index', value: 61.2 }] },
    { index: 1, symbol: 'CME:ES1!', resolution: '5', last: 6900, change: -4, change_pct: -0.058 },
    { index: 2, symbol: 'NYMEX:CL1!', resolution: '15' },
    { index: 3, error: 'mainSeries unavailable' }, // dead pane stays a row
  ],
  pane_count: 4,
};

describe('pane_scan (P2-8)', () => {
  test('one compact row per pane, layout-wide, single evaluate', async () => {
    let evaluateCalls = 0;
    const r = await paneScan({ evaluate: async () => { evaluateCalls++; return { panes: LAYOUT_MOCK.panes, pane_count: 4, active_index: 0 }; } });
    assert.equal(evaluateCalls, 1, 'exactly ONE evaluate for the whole layout');
    assert.equal(r.success, true);
    assert.equal(r.pane_count, 4);
    assert.equal(r.panes.length, 4);
    assert.ok(r.observed_at);
  });

  test('rows carry symbol/last/change/freshness fields the plan names', async () => {
    const r = await paneScan({ evaluate: async () => ({ panes: LAYOUT_MOCK.panes, pane_count: 4, active_index: 0 }) });
    const nq = r.panes[0];
    assert.equal(nq.symbol, 'CME_MINI:NQ1!');
    assert.equal(nq.last, 24550.25);
    assert.equal(nq.change, 10.25);
    assert.ok(Math.abs(nq.change_pct - 0.0418) < 0.01, 'change_pct near 0.042');
    assert.ok(nq.freshness);
    assert.equal(nq.values[0].indicator, 'Relative Strength Index');
    void nq;
  });

  test('dead pane degrades its own row, never the scan', async () => {
    const r = await paneScan({ evaluate: async () => ({ panes: LAYOUT_MOCK.panes, pane_count: 4 }) });
    assert.equal(r.panes[3].error, 'mainSeries unavailable');
    assert.equal(r.panes[0].last, 24550.25, 'healthy rows unaffected');
  });

  test('unreadable layout throws with actionable message', async () => {
    await assert.rejects(
      () => paneScan({ evaluate: async () => null }),
      /layout unreadable/,
    );
  });

  test('read-only: source contains no clicks/focus/setSymbol side effects', async () => {
    const fs = await import('node:fs');
    const text = fs.readFileSync('src/core/pane_scan.js', 'utf8');
    assert.equal(text.includes('click()'), false, 'no DOM clicking');
    assert.equal(text.includes('.focus('), false, 'no pane focusing');
    assert.equal(text.includes('.setSymbol'), false, 'no symbol mutation');
  });

});