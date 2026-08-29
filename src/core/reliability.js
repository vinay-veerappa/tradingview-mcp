/**
 * Compatibility report (P2-15) + CDP diagnostics (P2-17) — reliability
 * surfaces answering "what broke after the TV update" (per-surface
 * healthy/degraded/unavailable with probe names + recommended actions) and
 * "is this slow because of TV, CDP, transport, or the agent?" from one place.
 *
 * Both are read-only, bounded, and never throw — a dead CDP yields an
 * all-unavailable report (that IS the compat answer in that state).
 */

import { evaluate, CDP_HOST, CDP_PORT, getTargetInfo } from '../connection.js';
import { chartContextOwner } from './data.js';

export const COMPAT_SCHEMA_VERSION = 1;

// Per-surface probes: one bounded evaluate each, no side effects, no panel
// opens. Names are the shared vocabulary with the browser gate plan (§8.3).
// `_deps.evaluate` seam: tests inject scripted probe results (chart.js pattern).
function _resolve(_deps) {
  return { evaluate: _deps?.evaluate || evaluate };
}

const PROBES = [
  {
    surface: 'chart',
    probe: 'chart_api_symbol_read',
    critical: true,
    run: async (evaluate) => evaluate(`
      (function() {
        try {
          var chart = window.TradingViewApi._activeChartWidgetWV.value();
          var sym = null, res = null;
          try { sym = chart.symbol(); } catch (e) {}
          try { res = chart.resolution(); } catch (e) {}
          return { ok: !!chart, symbol: sym, resolution: res };
        } catch (e) { return { ok: false, error: e.message }; }
      })()
    `),
  },
  {
    surface: 'pine_editor',
    probe: 'pine_facade_reachable',
    critical: false,
    run: async (evaluate) => evaluate(`
      (function() {
        try {
          var x = new XMLHttpRequest();
          x.open('HEAD', 'https://pine-facade.tradingview.com/pine-facade/list/?filter=saved', false);
          x.send();
          return { ok: x.status === 200, status: x.status };
        } catch (e) { return { ok: false, error: e.message }; }
      })()
    `),
  },
  {
    surface: 'strategy_tester',
    probe: 'strategy_sources_enumerable',
    critical: false,
    run: async (evaluate) => evaluate(`
      (function() {
        try {
          var chart = window.TradingViewApi._activeChartWidgetWV.value();
          var sources = chart._chartWidget.model().model().dataSources();
          var strategies = (sources || []).filter(function(s) {
            try { var mi = s.metaInfo(); return !!(mi && (mi.isTVScriptStrategy || mi.is_strategy)); } catch (e) { return false; }
          });
          return { ok: true, strategy_count: strategies.length };
        } catch (e) { return { ok: false, error: e.message }; }
      })()
    `),
  },
  {
    surface: 'paper',
    probe: 'trading_api_broker_readable',
    critical: false,
    run: async (evaluate) => evaluate(`
      (function() {
        try {
          var t = tvTrading();
          var ab = t ? tvBroker(t) : null;
          var broker = null;
          try { broker = ab && ab._brokerMetainfo && ab._brokerMetainfo.id || null; } catch (e) {}
          return { ok: !!t, broker_id: broker };
        } catch (e) { return { ok: false, error: e.message }; }
      })()
    `),
  },
  {
    surface: 'alerts',
    probe: 'alert_service_readable',
    critical: false,
    run: async (evaluate) => evaluate(`
      (function() {
        try {
          var svc = window.TradingViewApi._alertService;
          var count = null;
          try { if (svc && svc.alerts && typeof svc.alerts.value === 'function') count = (svc.alerts.value() || []).length; } catch (e) {}
          return { ok: !!svc, alert_count: count };
        } catch (e) { return { ok: false, error: e.message }; }
      })()
    `),
  },
];

const ACTIONS = {
  chart: 'Chart API path broken after a TradingView update — all chart_* tools will fail. Capture tv_health_check output and record the desktop version.',
  pine_editor: 'Pine facade unreachable (offline or blocked) — pine_save/pine_list_scripts will fail.',
  strategy_tester: 'Strategy dataSources path broken — data_get_strategy_results/trades/equity will fail.',
  paper: 'Paper/trading API unreachable — paper_* tools will fail (desktop has no trading connection).',
  alerts: 'Alert service path broken — alert_* tools will fail.',
};

/**
 * Compatibility report: schema-versioned per-TV-build matrix.
 * { schema_version, generated_at, desktop_version, overall,
 *   supported{surface: healthy|degraded|unavailable}, failed_probes[],
 *   recommended_actions[] }
 */
export async function compatibilityReport(_deps = null) {
  const report = {
    schema_version: COMPAT_SCHEMA_VERSION,
    generated_at: new Date().toISOString(),
    desktop_version: null,
    overall: 'unknown',
    supported: {},
    failed_probes: [],
    recommended_actions: [],
  };

  for (const def of PROBES) {
    const entry = { surface: def.surface, probe: def.probe, critical: def.critical || false, status: 'unavailable' };
    try {
      const r = await def.run(_resolve(_deps).evaluate);
      if (r?.ok) {
        entry.status = 'healthy';
        if (def.surface === 'chart' && r.symbol) entry.chart_symbol = r.symbol;
        if (def.surface === 'paper' && r.broker_id) entry.broker_id = r.broker_id;
        if (def.surface === 'strategy_tester') entry.strategy_count = r.strategy_count ?? 0;
        if (def.surface === 'pine_editor' && r.error) { entry.status = 'degraded'; entry.error = r.error; }
      } else {
        entry.status = 'unavailable';
        entry.error = String(r?.error || 'probe returned not-ok');
      }
    } catch (err) {
      entry.status = 'unavailable';
      entry.error = String(err?.reason || err?.message || err);
    }
    report.supported[def.surface] = entry.status;
    report.failed_probes.push(entry);
  }

  // Overall: chart is load-bearing; surfaces degrade independently.
  const chartOk = report.supported.chart === 'healthy';
  if (!chartOk && report.supported.chart !== 'degraded') report.overall = 'unavailable';
  else if (Object.values(report.supported).includes('unavailable')) report.overall = 'degraded';
  else if (Object.values(report.supported).includes('degraded')) report.overall = 'degraded';
  else report.overall = 'healthy';

  for (const p of report.failed_probes) {
    if (p.status === 'unavailable' && ACTIONS[p.surface]) {
      report.recommended_actions.push(ACTIONS[p.surface]);
    }
  }
  return report;
}

/**
 * CDP diagnostics (P2-17): connection snapshot + chart-mutation lock owner.
 * Read-only, bounded, safe on a dead connection.
 */
export async function diagnostics(_deps = null) {
  const R = _resolve(_deps);
  const getTarget = _deps?.getTargetInfo || getTargetInfo;
  const out = {
    success: true,
    cdp: { connected: false, host: CDP_HOST, port: CDP_PORT, target_id: null, target_type: null, desktop_version: null },
    chart_mutation_lock: chartContextOwner() ?? { locked: false, owner: null },
    observed_at: new Date().toISOString(),
  };

  try {
    const info = await getTarget();
    if (info) {
      out.cdp.connected = true;
      out.cdp.target_id = info.id ?? null;
      out.cdp.target_type = info.type ?? null;
      if (info.url) out.cdp.target_url = String(info.url).slice(0, 120);
    }
  } catch (err) {
    out.cdp.error = String(err?.reason || err?.message || err).slice(0, 160);
  }

  // Desktop version: UA regex in page (page-free fallback comes via healthCheck).
  try {
    out.cdp.desktop_version = await R.evaluate(`
      (function() {
        try { var m = /TradingView\\/([0-9.]+)/.exec(navigator.userAgent || ''); return m ? m[1] : null; } catch (e) { return null; }
      })()
    `);
  } catch { /* stays null */ }

  return out;
}