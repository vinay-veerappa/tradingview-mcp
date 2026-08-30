/**
 * Transport-neutral chart subscriptions (P2-12) — the F4 refactor.
 *
 * subscribe(kind, { interval, dedupe }) → AsyncIterable of events. No
 * process/signal/stdout side-effects live in core: the CLI keeps its JSONL
 * sink, the MCP layer builds resource-update notifications, and a future
 * gateway builds SSE — all three over this ONE event source, each with its
 * own cancellation.
 *
 * Poll-and-diff semantics preserved from the original stream.js: an event is
 * emitted only when the fetched payload changes (dedupe by stable-JSON hash),
 * CDP connection errors become 'connection lost' events with 2s retry (the
 * stream survives), and per-subscriber cancellation is just return()/break()
 * on the iterator.
 */
import { evaluate } from '../connection.js';

const CHART_API = 'window.TradingViewApi._activeChartWidgetWV.value()';
const MODEL = `${CHART_API}._chartWidget.model()`;
const CWC = 'window.TradingViewApi._chartWidgetCollection';

export const SUBSCRIPTION_KINDS = Object.freeze(['quote', 'bars', 'values', 'panes']);

const DEFAULT_INTERVALS = Object.freeze({ quote: 300, bars: 500, values: 500, panes: 500 });

// ── page JS per kind (one CDP evaluate per poll) ────────────────────────────

const FETCH_JS = {
  quote: `
    (function() {
      var chart = ${CHART_API};
      var m = ${MODEL};
      var bars = m.mainSeries().bars();
      var last = bars.lastIndex();
      var v = bars.valueAt(last);
      if (!v) return null;
      return {
        kind: 'quote', symbol: chart.symbol(),
        time: v[0], open: v[1], high: v[2], low: v[3], close: v[4], volume: v[5] || 0,
      };
    })()
  `,
  bars: `
    (function() {
      var chart = ${CHART_API};
      var m = ${MODEL};
      var bars = m.mainSeries().bars();
      var last = bars.lastIndex();
      var v = bars.valueAt(last);
      if (!v) return null;
      return {
        kind: 'bars', symbol: chart.symbol(), resolution: chart.resolution(),
        bar_time: v[0], open: v[1], high: v[2], low: v[3], close: v[4],
        volume: v[5] || 0, bar_index: last,
      };
    })()
  `,
  values: `
    (function() {
      var chart = ${CHART_API};
      var m = ${MODEL};
      var studies = chart.getAllStudies();
      var results = [];
      for (var i = 0; i < studies.length; i++) {
        try {
          var study = chart.getStudyById(studies[i].id);
          if (!study || !study.isVisible()) continue;
          var src = study._study || study;
          var data = src._lastBarValues || src._data;
          if (!data) continue;
          var vals = {};
          if (typeof data === 'object') {
            for (var k in data) {
              if (typeof data[k] === 'number' && !isNaN(data[k])) vals[k] = data[k];
            }
          }
          if (Object.keys(vals).length > 0) results.push({ name: studies[i].name, values: vals });
        } catch (e) {}
      }
      return { kind: 'values', symbol: chart.symbol(), study_count: results.length, studies: results };
    })()
  `,
  panes: `
    (function() {
      var cwc = ${CWC};
      var all = cwc.getAll();
      var count = cwc.inlineChartsCount;
      if (typeof count === 'object' && count && typeof count.value === 'function') count = count.value();
      var panes = [];
      for (var i = 0; i < Math.min(all.length, count || all.length); i++) {
        try {
          var c = all[i];
          var model = c.model();
          var ms = model.mainSeries();
          var bars = ms.bars();
          var last = bars.lastIndex();
          var v = bars.valueAt(last);
          if (!v) { panes.push({ index: i, symbol: ms.symbol(), error: 'no bars' }); continue; }
          panes.push({
            index: i, symbol: ms.symbol(), resolution: ms.interval(),
            time: v[0], open: v[1], high: v[2], low: v[3], close: v[4], volume: v[5] || 0,
          });
        } catch (e) { panes.push({ index: i, error: e.message }); }
      }
      return { kind: 'panes', pane_count: panes.length, panes: panes };
    })()
  `,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * subscribe(kind, { interval, dedupe, _deps, maxTicks }) → AsyncIterable<event>.
 * Event: { ...payload, _ts, _stream: kind }.
 * Guarantees:
 * - emits ONLY on change (stable-JSON hash dedupe) unless dedupe:false
 * - CDP connection errors → 'connection lost' event + 2s retry (stream survives);
 *   first successful poll afterwards emits 'connection restored'
 * - other fetch errors → 'error' event, polling continues at interval
 * - cancellation: break/return() stops polling (per-subscriber)
 * - test seam: _deps.evaluate/_deps.sleep run the loop fully offline
 */
export async function* subscribe(kind, { interval, dedupe = true, _deps = null, maxTicks = Infinity, shouldStop } = {}) {
  const js = FETCH_JS[kind];
  if (!js) {
    throw new Error(`subscribe: unknown kind '${kind}' (known: ${Object.keys(FETCH_JS).join(', ')})`);
  }
  const ev = _deps?.evaluate || evaluate;
  const wait = _deps?.sleep || sleep;
  const effInterval = interval || DEFAULT_INTERVALS[kind] || 500;

  let lastHash = null;
  let connectionLost = false;
  let ticks = 0;

  while (ticks < maxTicks) {
    if (shouldStop?.()) return; // external termination (server close, gateway stop)
    let data = null;
    try {
      data = await ev(js);
      if (connectionLost) {
        connectionLost = false;
        yield { kind: 'connection', status: 'restored', _ts: Date.now(), _stream: kind };
      }
      if (data) {
        const hash = JSON.stringify(data);
        if (!dedupe || hash !== lastHash) {
          lastHash = hash;
          ticks++;
          yield { ...data, _ts: Date.now(), _stream: kind };
        }
      }
    } catch (err) {
      if (/CDP|ECONNREFUSED/i.test(err?.message || '')) {
        if (!connectionLost) {
          connectionLost = true;
          yield { kind: 'connection', status: 'lost', _ts: Date.now(), _stream: kind, error: String(err?.message || err) };
        }
        await (_deps?.sleep || sleep)(2000);
        continue;
      }
      yield { kind: 'error', error: String(err?.message || err), _ts: Date.now(), _stream: kind };
      await (_deps?.sleep || sleep)(effInterval);
    }
    await (_deps?.sleep || sleep)(effInterval);
  }
}