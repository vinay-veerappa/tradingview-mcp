import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { compatibilityReport, diagnostics, COMPAT_SCHEMA_VERSION } from '../src/core/reliability.js';

const ALL_OK = (js) => {
  if (/chart\.symbol\(\)/.test(js)) return { ok: true, symbol: 'CME_MINI:NQ1!', resolution: '5' };
  if (/pine-facade/.test(js)) return { ok: true, status: 200 };
  if (/dataSources/.test(js)) return { ok: true, strategy_count: 2 };
  if (/tvTrading/.test(js)) return { ok: true, broker_id: 'Paper' };
  if (/alertService/.test(js)) return { ok: true, alert_count: 3 };
  return { ok: false, error: 'unmatched probe js: ' + js.slice(0, 60) };
};

// Mock evaluator keyed on mutually-exclusive tokens in each probe's JS:
// chart probe calls chart.symbol(); strategy probe uses dataSources (no symbol());
// paper probe calls tvTrading(); pine hits pine-facade; alerts uses alertService.

describe('tv_compatibility_report (P2-15)', () => {
  test('healthy: all 5 surfaces healthy, overall healthy, no actions', async () => {
    const r = await compatibilityReport({ evaluate: async (js) => ALL_OK(js) });
    assert.equal(r.schema_version, COMPAT_SCHEMA_VERSION);
    assert.equal(r.overall, 'healthy');
    assert.deepEqual(Object.keys(r.supported).sort(), ['alerts', 'chart', 'paper', 'pine_editor', 'strategy_tester']);
    assert.equal(r.failed_probes.length, 5);
    assert.equal(r.recommended_actions.length, 0);
});

  test('broken chart path → chart unavailable, overall unavailable, targeted action', async () => {
    const report = await compatibilityReport({
      evaluate: async (js) => (/chart\.symbol\(\)/.test(js))
        ? { ok: false, error: 'path gone' }
        : ALL_OK(js),
    });
    assert.equal(report.supported.chart, 'unavailable');
    assert.equal(report.overall, 'unavailable');
    assert.ok(report.recommended_actions.some(a => a.includes('Chart API path broken')));
    const entry = report.failed_probes.find(p => p.surface === 'chart');
    assert.equal(entry.probe, 'chart_api_symbol_read');
    assert.equal(entry.critical, true);
    assert.match(entry.error, /path gone/);
  });

  test('probe THROW → unavailable entry, report still returns', async () => {
    const report = await compatibilityReport({
      evaluate: async (js) => { if (/alertService/.test(js)) throw new Error('boom'); return ALL_OK(js); },
    });
    assert.equal(report.supported.alerts, 'unavailable');
    assert.equal(report.overall, 'degraded');
    assert.match(report.failed_probes.find(p => p.surface === 'alerts').error, /boom/);
  });

  test('strategy path broken while chart healthy → degraded overall', async () => {
    const report = await compatibilityReport({
      evaluate: async (js) => (/dataSources/.test(js)) ? { ok: false, error: 'ds broken' } : ALL_OK(js),
    });
    assert.equal(report.supported.strategy_tester, 'unavailable');
    assert.equal(report.supported.chart, 'healthy');
    assert.equal(report.overall, 'degraded');
  });
});

describe('diagnostics (P2-17)', () => {
  test('dead connection still returns a structured snapshot', async () => {
    const r = await diagnostics({
      evaluate: async () => { throw new Error('no page'); },
      getTargetInfo: async () => { throw new Error('no cdp'); },
    });
    assert.equal(r.success, true);
    assert.equal(r.cdp.connected, false);
    assert.ok(r.cdp.host);
    assert.ok(r.cdp.port);
    assert.ok(r.observed_at);
    assert.ok('chart_mutation_lock' in r);
  });
});
