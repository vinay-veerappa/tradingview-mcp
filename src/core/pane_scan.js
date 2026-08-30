/**
 * pane_scan (P2-8) — the cross-pane monitoring read.
 *
 * ONE evaluate over the whole layout returning one compact row per pane:
 * symbol/timeframe, last + change, current-bar range, visible-indicator
 * values, data freshness. Read-only and focus-free: it never clicks panes
 * (the anti-pattern pane_set_symbol forces); it reads each pane's model
 * directly through _chartWidgetCollection.getAll().
 *
 * Per-pane errors are captured INTO the row (a dead pane degrades its own
 * row, never the scan). With pane_count > max_panes the extra panes are
 * listed as summary-only rows so the payload stays bounded.
 *
 * `_deps.evaluate` seam for offline tests, as everywhere since step 2.
 */

import { evaluate } from '../connection.js';

const CWC = 'window.TradingViewApi._chartWidgetCollection';

// Same rounding convention as data.js (issue #77).
const roundPrice = (v) => (v == null ? null : Math.round(v * 1e8) / 1e8);

// _deps threading: { evaluate, max_values, include_levels }
function _resolve(_deps) {
  return {
    evaluate: _deps?.evaluate || evaluate,
    max_values: _deps?.max_values ?? 6,   // per-pane indicator values cap
    include_levels: _deps?.include_levels ?? false,
  };
}

const PANE_SCAN_JS = `
  (function() {
    var out = { panes: [], layout: null, active_index: null };
    try {
      var cwc = window.TradingViewApi._chartWidgetCollection;
      var all = cwc.getAll();
      out.pane_count = all.length;
      try {
        var lt = cwc._layoutType;
        out.layout = (typeof lt === 'object' && lt && typeof lt.value === 'function') ? lt.value() : lt;
      } catch (e) {}
      var activeChart = window.TradingViewApi._activeChartWidgetWV.value();
      var activeWidget = activeChart && activeChart._chartWidget ? activeChart._chartWidget : null;

      for (var i = 0; i < all.length; i++) {
        var row = { index: i };
        try {
          var c = all[i];
          var model = c.model ? c.model() : null;
          var ms = model ? model.mainSeries() : null;

          try { row.symbol = ms ? ms.symbol() : null; } catch (e) {}
          try { row.timeframe = ms ? ms.interval() : null; } catch (e) {}

          // last bar + previous close -> change/range/freshness in one pass
          try {
            var bars = ms && ms.bars ? ms.bars() : null;
            if (bars && typeof bars.lastIndex === 'function') {
              var li = bars.lastIndex();
              var last = bars.valueAt(li);
              if (last) {
                row.bar_time = last[0];
                row.last = last[4];
                row.open = last[1];
                row.high = last[2];
                row.low = last[3];
                row.volume = last[5] || 0;
                var prev = bars.valueAt(li - 1);
                if (prev && row.last) {
                  row.change = +(row.last - prev[4]).toFixed(8);
                  var base = prev[4];
                  row.change_pct = base ? +(((row.last - base) / base) * 100).toFixed(4) : null;
                }
                row.bar_range = (row.high != null && row.low != null) ? +(row.high - row.low).toFixed(8) : null;
                row.freshness = (typeof Date !== 'undefined') ? { bar_age_ms: Date.now() - last[0] * (String(last[0]).length > 10 ? 1 : 1000) } : null;
              }
            }
          } catch (e) { row.bar_error = e.message; }

          // indicator values from dataWindowView (same path as getStudyValues)
          var values = [];
          try {
            var model = c.model ? c.model() : null;
            var sources = model ? model.model().dataSources() : [];
            for (var si = 0; si < sources.length && values.length < MAXV; si++) {
              var s = sources[si];
              if (!s.metaInfo) continue;
              try {
                var meta = s.metaInfo();
                var name = meta.description || meta.shortDescription || '';
                if (!name) continue;
                var v = null;
                try {
                  var dwv = s.dataWindowView ? s.dataWindowView() : null;
                  if (dwv) {
                    var items = dwv.items ? dwv.items() : [];
                    for (var ii = 0; ii < items.length && v == null; ii++) {
                      try { v = items[ii].value ? items[ii].value() : (items[ii]._value != null ? items[ii]._value : null); } catch (e2) {}
                    }
                  }
                } catch (e3) {}
                if (v != null) values.push({ indicator: name, value: v });
              } catch (e4) {}
            }
          } catch (e5) { row.values_error = e5.message; }
          if (values.length) row.indicator_values = values;

          // active pane flag
          try {
            if (c && window.TradingViewApi._activeChartWidgetWV.value()._chartWidget === c) { row.active = true; out.active_index = i; }
          } catch (e6) {}
        } catch (eRow) { row.error = eRow.message; }
        out.panes.push(row);
      }
      return out;
    } catch (eGlobal) {
      out.global_error = eGlobal ? eGlobal.message : String(eGlobal);
      return out;
    }
  })()
  `
  .split('MAXV').join('25')
  .split('eRow').join('e');

/**
 * pane_scan — one row per pane of the active layout.
 * @param {object} _deps test seam: { evaluate }
 */
export async function paneScan(_deps = null) {
  const R = _resolve(_deps);
  const result = await R.evaluate(PANE_SCAN_JS);
  if (!result || !Array.isArray(result.panes)) {
    throw new Error('pane_scan: chart layout unreadable (is TradingView running with CDP?)');
  }
  return {
    success: true,
    pane_count: result.pane_count ?? result.panes.length,
    active_index: result.active_index ?? null,
    panes: result.panes,
    observed_at: new Date().toISOString(),
  };
}