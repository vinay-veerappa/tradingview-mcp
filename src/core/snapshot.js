/**
 * session_snapshot (P2-1) + chart_changes (P2-7) — the compound chart read.
 *
 * One operation: chart identity, quote, OHLCV summary, chart state
 * (type/studies/visible range), study values, Pine lines/labels/tables/boxes,
 * alerts, strategy summary — each section individually
 * { status: 'ok'|'error'|'skipped' } so one flaky read never fails the
 * snapshot.
 *
 * Consistency contract (stronger than sequential calls): identity is captured
 * before and after collection; a mismatch retries ONCE, then reports top-level
 * status 'state_changed' with the partial sections labeled — sections are
 * never silently mixed across symbols.
 *
 * The whole collection runs inside withChartContext (P2-2): a requested
 * { symbol, timeframe } is flipped temporarily on the process-wide lock and
 * restored regardless of outcome. With no request, collection still holds the
 * lock briefly so a concurrent flip can't interleave with a snapshot.
 *
 * Per-section FNV-1a hashes power chart_changes (P2-7) — callers diff a
 * previous snapshot's section hashes instead of re-reading everything.
 */

import { evaluate } from '../connection.js';
import { CHART_IDENTITY_JS, extractIdentity, sameIdentity } from './_identity.js';
import { createChartContext } from './context.js';
import { waitForChartReady } from '../wait.js';
import {
  getQuote, getOhlcv, getStudyValues, getStrategyResults,
  getPineLines, getPineLabels, getPineTables, getPineBoxes,
} from './data.js';
import { list as listAlerts } from './alerts.js';

// Offline-testable seam: every page-touching dep flows through _resolve(_deps),
// matching the chart.js/paper.js pattern. Production callers pass nothing.
function _resolve(_deps) {
  return {
    evaluate: _deps?.evaluate || evaluate,
    waitForChartReady: _deps?.waitForChartReady || waitForChartReady,
    collectors: _deps?.sectionCollectors || null, // test override for section data
    data: _deps?.data || {
      getQuote, getOhlcv, getStudyValues, getStrategyResults,
      getPineLines, getPineLabels, getPineTables, getPineBoxes,
    },
    alerts: _deps?.alerts || { list: listAlerts },
  };
}

export const SNAPSHOT_VERSION = 1;

// ── section selection (P2-9) ────────────────────────────────────────────────

export const SECTIONS = Object.freeze([
  'quote', 'ohlcv_summary', 'chart_state', 'visible_range',
  'study_values', 'pine_lines', 'pine_labels', 'pine_tables', 'pine_boxes',
  'alerts', 'strategy_summary',
]);

export const PRESETS = Object.freeze({
  brief: ['quote', 'ohlcv_summary'],
  analysis: ['quote', 'ohlcv_summary', 'chart_state', 'visible_range',
             'study_values', 'pine_lines', 'pine_labels', 'pine_tables', 'pine_boxes'],
  strategy: ['chart_state', 'study_values', 'strategy_summary'],
  pine_debug: ['chart_state', 'pine_lines', 'pine_labels', 'pine_tables', 'pine_boxes'],
});

export function resolveSections({ include, exclude, preset } = {}) {
  let set;
  if (Array.isArray(include) && include.length) {
    set = include.filter(s => SECTIONS.includes(s));
  } else if (preset && PRESETS[preset]) {
    set = [...PRESETS[preset]];
  } else {
    // Default: trader's analysis view without the heavyweight extras.
    set = [...PRESETS.analysis];
  }
  if (Array.isArray(exclude)) set = set.filter(s => !exclude.includes(s));
  return [...new Set(set)]; // identity is implicit; dedupe preserves order
}

// ── section collectors (read ACTIVE chart only; throw → section error) ─────

function makeCollectors(deps) {
  const R = _resolve(deps);
  const { evaluate: _pageEval } = R;
  const { data, alerts } = R;
  let chartStateCache = null;
  async function chartState() {
    if (chartStateCache) return chartStateCache;
    chartStateCache = await _pageEval(`
      (function() {
        try {
          var chart = window.TradingViewApi._activeChartWidgetWV.value();
          var out = {};
          try { out.chart_type = chart.chartType(); } catch (e) {}
          try { out.visible_range = chart.getVisibleRange(); } catch (e) {}
          try { out.bars_range = chart.getVisibleBarsRange(); } catch (e) {}
          var studies = [];
          try {
            var allStudies = chart.getAllStudies();
            studies = allStudies.map(function(s) {
              return { id: s.id, name: s.name || s.title || 'unknown' };
            });
          } catch (e) {}
          out.studies = studies;
          return out;
        } catch (e) { return { _failed: true, error: String(e.message || e) }; }
      })()
    `);
    return chartStateCache;
  }

  return {
    quote: () => data.getQuote(),
    ohlcv_summary: async () => {
      const r = await data.getOhlcv({ count: 100, summary: true });
      return r?.bars ? r : r; // summarized shape (full object; hash covers it)
    },
    chart_state: async () => {
      const s = await chartState();
      return { chart_type: s?.chart_type, studies: s?.studies };
    },
    visible_range: async () => {
      const s = await chartState();
      return { visible_range: s?.visible_range, bars_range: s?.bars_range };
    },
    study_values: () => data.getStudyValues(),
    pine_lines: ({ study_filter }) => data.getPineLines({ study_filter }),
    pine_labels: ({ study_filter }) => data.getPineLabels({ study_filter }),
    pine_tables: ({ study_filter }) => data.getPineTables({ study_filter }),
    pine_boxes: ({ study_filter }) => data.getPineBoxes({ study_filter }),
    alerts: () => alerts.list({}),
    strategy_summary: async () => {
      const r = await data.getStrategyResults();
      if (!r?.success) return { success: false, ...(r?.error && { error: r.error }) };
      const m = r.metrics || {};
      return {
        success: true,
        strategy: r.strategy,
        currency: r.currency,
        net_profit: m.net_profit, net_profit_percent: m.net_profit_percent,
        profit_factor: m.profit_factor, total_trades: m.total_trades,
        percent_profitable: m.percent_profitable, max_drawdown: m.max_drawdown,
      };
    },
  };
}

// ── hashing (section diff = chart_changes) ─────────────────────────────────

// FNV-1a 32-bit over a stable serialization (sorted keys, explicit nulls).
export function stableStringify(value) {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ('00000000' + (h >>> 0).toString(16)).slice(-8);
}

export function hashSection(data) {
  return fnv1a(stableStringify(data ?? null));
}

// ── orchestration ───────────────────────────────────────────────────────────

const SNAPSHOT_DEADLINE_MS = 30_000;

async function collectSections(names, args, deadlineAt, deps) {
  const collectors = deps?.sectionCollectors || makeCollectors(deps);
  const sections = {};
  for (const name of names) {
    if (Date.now() > deadlineAt) {
      for (const rest of names.slice(names.indexOf(name))) {
        sections[rest] = { status: 'skipped', reason: 'deadline_exceeded' };
      }
      break;
    }
    try {
      const data = await collectors[name](args);
      sections[name] = { status: 'ok', data };
    } catch (err) {
      sections[name] = {
        status: 'error',
        error: String(err?.message || err),
        code: err?.reason || undefined,
      };
    }
  }
  return sections;
}

/**
 * session_snapshot — options:
 *   symbol/timeframe : optional temporary chart context (restored after)
 *   include/exclude/preset / study_filter / compact: P2-9 section choice
 * Returns: { status, identity, snapshot_hash, sections{...}, observed_at,
 *            external_change, prior_context, warnings[] }
 */
export async function sessionSnapshot(opts = {}, _deps = null) {
  const {
    symbol, timeframe, include, exclude, preset, study_filter, compact,
  } = opts;
  const R = _resolve(_deps);
  const sectionNames = resolveSections({ include, exclude, preset });
  const deadlineAt = Date.now() + SNAPSHOT_DEADLINE_MS;

  const collectOnce = async () => {
    const identityAtStart = extractIdentity(await R.evaluate(CHART_IDENTITY_JS));
    const sections = await collectSections(sectionNames, { study_filter }, deadlineAt, _deps);
    const identityAtEnd = extractIdentity(await R.evaluate(CHART_IDENTITY_JS));
    return { identityAtStart, identityAtEnd, sections };
  };

  const _ctx = createChartContext({ evaluate: R.evaluate, evaluateAsync: R.evaluate, waitForChartReady: R.waitForChartReady });
  const runUnder = (op) => _ctx.withChartContext(
    { symbol: symbol ?? null, timeframe: timeframe ?? null },
    op,
    { label: 'session_snapshot' },
  );

  let outcome = await runUnder(collectOnce);

  // Consistency: identity moved mid-collection → retry once under the lock.
  const moved = (r) =>
    !sameIdentity(r.identityAtStart.symbol, r.identityAtEnd.symbol, 'symbol') ||
    !sameIdentity(r.identityAtStart.timeframe, r.identityAtEnd.timeframe, 'timeframe');

  if (moved(outcome.result)) {
    const retry = await runUnder(collectOnce);
    if (moved(retry.result)) {
      // Still shifting: report state_changed with whatever we hold.
      return {
        status: 'state_changed',
        identity: retry.result.identityAtEnd,
        snapshot_hash: null,
        sections: retry.result.sections,
        observed_at: new Date().toISOString(),
        prior_context: retry.prior_context,
        external_change: retry.external_change,
        warning: 'Chart identity changed twice during collection; sections may span two states.',
      };
    }
    outcome = retry;
  }

  const identity = outcome.result.identityAtEnd;
  const sections = outcome.result.sections;

  // Section hashes + top-level snapshot hash.
  const hashes = {};
  for (const [name, sec] of Object.entries(sections)) {
    hashes[name] = sec.status === 'ok' ? hashSection(sec.data) : null;
  }
  const snapshot_hash = fnv1a(
    stableStringify({ v: SNAPSHOT_VERSION, identity, hashes })
  );

  return {
    status: 'ok',
    identity: {
      symbol: identity.symbol,
      timeframe: identity.timeframe,
      ...(sections.chart_state?.status === 'ok' && {
        chart_type: sections.chart_state.data.chart_type,
        studies: sections.chart_state.data.studies,
      }),
    },
    snapshot_hash,
    section_hashes: hashes,
    sections: compact ? sectionSummaries(sections) : sections,
    observed_at: new Date().toISOString(),
    prior_context: outcome.prior_context,
    external_change: outcome.external_change,
    ...(outcome.restore_error && { restore_error: outcome.restore_error }),
  };
}

// compact=true: one line per section instead of full payloads.
function sectionSummaries(sections) {
  const out = {};
  for (const [name, sec] of Object.entries(sections)) {
    if (sec.status !== 'ok') { out[name] = sec; continue; }
    out[name] = { status: 'ok', hash: hashSection(sec.data) };
  }
  return out;
}

/**
 * chart_changes (P2-7) — diff the live chart against a prior snapshot.
 * Accepts `since` as either a previous snapshot { section_hashes } or a bare
 * map { quote: 'abc123', pine_labels: 'def456', ... }.
 */
export async function chartChanges({ since, ...snapshotArgs } = {}, _deps = null) {
  const priorHashes = since?.section_hashes || since;
  if (!priorHashes || typeof priorHashes !== 'object') {
    throw new Error('chart_changes: `since` must be a prior snapshot with section_hashes (or a section-hash map).');
  }
  const snap = await sessionSnapshot({ ...snapshotArgs, compact: false }, _deps);
  if (snap.status !== 'ok') return snap; // state_changed passes through

  const changed = [], unchanged = [];
  let unknownCount = 0;
  for (const [name, hash] of Object.entries(snap.section_hashes)) {
    const prior = priorHashes[name];
    if (prior == null) { unknownCount++; continue; }
    if (prior === hash) unchanged.push(name);
    else changed.push(name);
  }

  return {
    status: 'ok',
    changed,
    unchanged,
    ...(unknownCount > 0 && { note: `${unknownCount} section(s) not present in prior snapshot — treat as changed` }),
    snapshot_hash: snap.snapshot_hash,
    section_hashes: snap.section_hashes,
    identity: snap.identity,
    observed_at: snap.observed_at,
  };
}