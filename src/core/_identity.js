/**
 * Chart identity read/compare — shared by core/context.js, snapshot tooling,
 * and mutation preconditions (P2-5). Single definition of what "the chart is
 * showing X on timeframe Y" means.
 */

// Evaluated in TradingView: returns the active chart's raw identity.
export const CHART_IDENTITY_JS = `
  (function() {
    var chart = window.TradingViewApi._activeChartWidgetWV.value();
    var symbol = '', timeframe = '';
    try { symbol = chart.symbol(); } catch (e) {}
    if (!symbol) { try { symbol = chart.symbolExt().symbol; } catch (e) {} }
    try { timeframe = chart.resolution(); } catch (e) {}
    return { symbol: symbol, timeframe: timeframe };
  })()
`;

export function extractIdentity(raw) {
  return {
    symbol: raw?.symbol != null ? String(raw.symbol) : null,
    timeframe: raw?.timeframe != null ? String(raw.timeframe) : null,
  };
}

function bare(s) {
  return (s || '').toString().split(':').pop().trim().toUpperCase();
}

/**
 * Identity comparison. Symbols compare exchange-insensitively bare-ticker up
 * (matching getQuote's existing convention); timeframes compare exactly.
 * null on either side means "unknown" — comparing unknown to anything is a
 * match (never block on a failed read), matching _getQuoteInternal behavior.
 */
export function sameIdentity(a, b, kind = 'symbol') {
  if (a == null || b == null) return true;
  if (kind === 'timeframe') return String(a) === String(b);
  return bare(a) === bare(b);
}

/**
 * P2-5 precondition check. `expected` carries expected_symbol /
 * expected_timeframe; live carries the read identity. Returns the list of
 * failed fields (empty = pass). Unknown live values NEVER fail (a flaky read
 * must not brick a mutation — but a *mismatch* must).
 */
export function checkPreconditions(expected = {}, live = {}) {
  const failures = [];
  if (expected.expected_symbol != null && !sameIdentity(live.symbol, expected.expected_symbol, 'symbol')) {
    failures.push({ field: 'expected_symbol', expected: expected.expected_symbol, actual: live.symbol });
  }
  if (expected.expected_timeframe != null && !sameIdentity(live.timeframe, expected.expected_timeframe, 'timeframe')) {
    failures.push({ field: 'expected_timeframe', expected: expected.expected_timeframe, actual: live.timeframe });
  }
  return failures;
}