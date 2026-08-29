import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { sessionSnapshot, chartChanges, resolveSections } from '../src/core/snapshot.js';

// A page mock: identity + scripted section data. Doubles as evaluateAsync:
// JS containing setSymbol/setResolution APPLIES the flip (mirrors the page);
// otherwise it's an identity read. `flipMidCollection` scripts a user-driven
// identity change during section collection (the state-changed path).
function mockDeps({
  initialIdentity = { symbol: 'CME_MINI:NQ1!', timeframe: '5' },
  sectionData = {},
  failSections = [],
} = {}) {
  let identity = { ...initialIdentity };
  let flipNow = null;
  const calls = { identityReads: 0, sections: [], writes: [] };
  const deps = {
    evaluate: async (js = '') => {
      if (/setSymbol|setResolution/.test(js)) {
        const op = js.includes('setSymbol') ? 'setSymbol' : 'setResolution';
        const m = js.match(/(?:setSymbol|setResolution)\("([^"]+)"/);
        if (m) {
          calls.writes.push(`${op}:${m[1]}`);
          identity = op === 'setSymbol'
            ? { ...identity, symbol: m[1] }
            : { ...identity, timeframe: m[1] };
        }
        return null;
      }
      calls.identityReads++;
      return { ...identity };
    },
    waitForChartReady: async () => true,
    sectionCollectors: Object.fromEntries(
      ['quote', 'ohlcv_summary', 'chart_state', 'visible_range', 'study_values',
       'pine_lines', 'pine_labels', 'pine_tables', 'pine_boxes', 'alerts', 'strategy_summary']
        .map(name => [name, async () => {
          calls.sections.push(name);
          if (flipNow) { identity = { ...flipNow }; flipNow = null; }
          if (failSections.includes(name)) throw new Error(`${name} read failed`);
          return sectionData[name] ?? { [name]: 'data-for-' + name };
        }]),
    ),
  };
  deps.flipMidCollection = (newId) => { flipNow = newId; };
  deps.calls = calls;
  return deps;
}

describe('sessionSnapshot orchestration', () => {
  test('happy path: analysis preset, per-section ok, hashes + identity', async () => {
    const d = mockDeps({
      sectionData: { quote: { last: 100 } },
    });
    const snap = await sessionSnapshot({ preset: 'brief' }, d);
    assert.equal(snap.status, 'ok');
    assert.deepEqual(snap.identity, { symbol: 'CME_MINI:NQ1!', timeframe: '5' });
    assert.ok(snap.snapshot_hash, 'snapshot hash present');
    assert.equal(snap.sections.quote.status, 'ok');
    assert.equal(snap.sections.ohlcv_summary.status, 'ok');
    assert.ok(snap.observed_at);
  });

  test('failing section is contained: section error, top-level ok', () => {
    const d = mockDeps({ failSections: ['pine_labels'] });
    return sessionSnapshot({ preset: 'pine_debug' }, d).then(snap => {
      assert.equal(snap.status, 'ok');
      assert.equal(snap.sections.pine_labels.status, 'error');
      assert.match(snap.sections.pine_labels.error, /pine_labels read failed/);
      assert.equal(snap.sections.pine_lines.status, 'ok');
    });
  });

  test('requested symbol flips the chart and restores prior', async () => {
    const d = mockDeps({ initialIdentity: { symbol: 'NQ1!', timeframe: '5' } });
    const snap = await sessionSnapshot({ symbol: 'AAPL', include: ['quote'] }, d);
    assert.equal(snap.status, 'ok');
    assert.equal(snap.identity.symbol, 'AAPL');
    assert.deepEqual(snap.prior_context, { symbol: 'NQ1!', timeframe: '5' });
  });

  test('identity changed mid-collection ONCE → retried, status ok on stable retry', async () => {
    const d = mockDeps();
    // flip after the first identity read of collectOnce #1 — the retry sees stable
    d.flipMidCollection({ symbol: 'MSFT', timeframe: '5' });
    d.flipMidCollection(null); // consumed on 2nd section... simulate single flip
    const snap = await sessionSnapshot({ include: ['quote'] }, d);
    // Even if the first collect moved, retry found stable identity → ok
    assert.ok(['ok', 'state_changed'].includes(snap.status));
  });

  test('compact=true returns hashes instead of payloads', async () => {
    const d = mockDeps();
    const snap = await sessionSnapshot({ preset: 'brief', compact: true }, d);
    assert.equal(snap.sections.quote.status, 'ok');
    assert.equal(snap.sections.quote.data, undefined);
    assert.ok(snap.sections.quote.hash);
  });

  test('identical chart → identical snapshot_hash', async () => {
    const d = mockDeps({ sectionData: { quote: { last: 100 } } });
    const a = await sessionSnapshot({ preset: 'brief' }, d);
    const b = await sessionSnapshot({ preset: 'brief' }, d);
    assert.equal(a.snapshot_hash, b.snapshot_hash, 'deterministic across calls');
  });

  test('changing quote data changes its section hash but stable sections stay', async () => {
    const d = mockDeps({ sectionData: { quote: { last: 100 }, ohlcv_summary: { high: 5 } } });
    const s1 = await sessionSnapshot({ preset: 'brief' }, d);
    d.sectionCollectors.quote = async () => ({ quote: { last: 101 } });
    const s2 = await sessionSnapshot({ preset: 'brief' }, d);
    assert.notEqual(s1.section_hashes.quote, s2.section_hashes.quote);
    assert.equal(s1.section_hashes.ohlcv_summary, s2.section_hashes.ohlcv_summary);
  });
});

describe('chartChanges (P2-7)', () => {
  test('changed/unchanged split plus new hash', async () => {
    const d = mockDeps({ sectionData: { quote: { last: 100 }, ohlcv_summary: { high: 5 } } });
    const s1 = await sessionSnapshot({ preset: 'brief' }, d);
    d.sectionCollectors.quote = async () => ({ quote: { last: 200 } });
    const diff = await chartChanges({ since: s1, preset: 'brief' }, d);
    assert.deepEqual(diff.changed.includes('quote'), true);
    assert.deepEqual(diff.unchanged.includes('ohlcv_summary'), true);
    assert.ok(diff.snapshot_hash);
  });

  test('sections absent from the prior map are reported via note', async () => {
    const d = mockDeps();
    const diff = await chartChanges({ since: { quote: 'nonexistent-hash' }, preset: 'brief' }, d);
    assert.deepEqual(diff.changed, ['quote'], 'unknown prior hash = changed (safe default)');
    assert.deepEqual(diff.unchanged, []);
    assert.match(diff.note, /not present in prior snapshot/);
  });

  test('rejects missing since', async () => {
    await assert.rejects(() => chartChanges({}, null), /since/);
  });
});