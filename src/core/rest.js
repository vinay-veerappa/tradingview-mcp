/**
 * REST data surfaces — chart-independent market/reference data over public,
 * cookie-less HTTP (docs/REST_DATA_SURFACES.md).
 *
 * The CDP path (src/connection.js) needs the desktop app running, signed in,
 * and holding a chart. These endpoints need none of that: they are
 * unauthenticated JSON hosts behind www.tradingview.com and its widgets, so
 * they answer questions about the world rather than about the current chart.
 *
 * Access mode is DIRECT HTTP from this process — never page XHR. CORS is a
 * browser rule; the hosts that look "blocked" inside ui_evaluate are reachable
 * here. The app-session path stays only for cookie-required surfaces
 * (alerts / watchlist / Pine), which live elsewhere.
 *
 * Hard rules carried from the doc (§11), all enforced below:
 *  1. No new dependency — global fetch + AbortSignal.timeout only.
 *  2. A browser User-Agent on every request; Origin additionally on the two
 *     hosts that filter on it (symbol-search, news-mediator).
 *  3. Timeouts — these are third-party endpoints and the MCP is synchronous
 *     from the client's perspective.
 *  4. `no_404=true` on every /symbol call, or unknown symbols 404.
 *  5. Row caps — /scan at range [0,1000] is a multi-MB response.
 *  6. Reuse the existing symbol search (core/chart.js symbolSearch) — no second
 *     implementation.
 *  7. A distinct error code for upstream failures so callers can tell
 *     "TV said no" from "we broke".
 *  8. Offline-testable — `_deps.fetch` is the stub seam, exactly like
 *     `_deps.evaluate` everywhere else. No test hits the network.
 *  9. SSR extraction is ONE regex + JSON.parse over the prs.init-data+json
 *     blocks. No HTML parser, no headless browser. If the payload shape
 *     changes these tools fail loudly (ssr_payload_missing) rather than
 *     silently degrading.
 * 10. news-mediator filters are sorted by id and carry the EXCHANGE: prefix —
 *     both are hard server-side validations, not cosmetics.
 */

import { readFileSync } from 'node:fs';
import { symbolSearch } from './chart.js';

// ── hosts ───────────────────────────────────────────────────────────────────

const TV_ORIGIN = 'https://www.tradingview.com';

/** A browser UA is required by scanner/news; the calendar host tolerates bare. */
export const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export const HOSTS = Object.freeze({
  scanner: 'https://scanner.tradingview.com',
  scannerBackend: 'https://scanner-backend.tradingview.com',
  calendar: 'https://chartevents-reuters.tradingview.com',
  headlines: 'https://news-headlines.tradingview.com',
  newsMediator: 'https://news-mediator.tradingview.com',
  site: TV_ORIGIN,
});

/** Hosts that reject a request without an Origin header (a CORS-style filter). */
const NEEDS_ORIGIN = new Set([HOSTS.newsMediator, 'https://symbol-search.tradingview.com']);

// ── caps (§11 rule 5) ───────────────────────────────────────────────────────

export const MAX_ROWS = 1000;
export const DEFAULT_ROWS = 100;
const DEFAULT_TIMEOUT_MS = 20_000;
const BATCH_CONCURRENCY = 5;
const MAX_BATCH_SYMBOLS = 50;

// ── error contract (§11 rule 7, §11 "Hard requirements") ─────────────────────
//
// RestError carries `reason` so the shared envelope (_format.js) emits a
// distinct code — a caller can separate "the upstream endpoint said no" from
// "the CDP transport broke".

export class RestError extends Error {
  constructor(reason, message, extra = {}) {
    super(message);
    this.name = 'RestError';
    this.reason = reason;
    Object.assign(this, extra);
  }
}

export const REST_REASONS = Object.freeze([
  'upstream_http_error',
  'upstream_invalid_json',
  'upstream_timeout',
  'upstream_unavailable',
  'ssr_payload_missing',
  'invalid_input',
  'not_found',
]);

const fail = (reason, message, extra) => { throw new RestError(reason, message, extra); };

// ── transport (§11 rules 1–4) ───────────────────────────────────────────────

function _fetch(deps) {
  const f = deps?.fetch || globalThis.fetch;
  if (typeof f !== 'function') fail('upstream_unavailable', 'no fetch implementation available');
  return f;
}

/**
 * One REST call. Returns the parsed JSON body (or text when `raw`).
 * Every failure is normalized into the RestError reason set so the MCP layer
 * never sees a bare "fetch failed".
 */
async function request(url, { method = 'GET', body, headers = {}, timeout = DEFAULT_TIMEOUT_MS, raw = false, _deps } = {}) {
  const doFetch = _fetch(_deps);
  const host = new URL(url).origin;
  const sent = {
    'User-Agent': BROWSER_UA,
    ...(NEEDS_ORIGIN.has(host) ? { Origin: TV_ORIGIN } : {}),
    ...headers,
  };
  let res;
  try {
    res = await doFetch(url, {
      method,
      headers: sent,
      ...(body != null ? { body } : {}),
      signal: AbortSignal.timeout(timeout),
    });
  } catch (err) {
    const msg = String(err?.message || err);
    if (/timed out|timeout|aborted|signal/i.test(msg)) {
      fail('upstream_timeout', `${host} timed out after ${timeout}ms`, { url });
    }
    fail('upstream_unavailable', `${host} unreachable: ${msg}`, { url });
  }

  if (!res.ok) {
    const text = typeof res.text === 'function' ? await res.text().catch(() => '') : '';
    const reason = res.status === 404 ? 'not_found' : 'upstream_http_error';
    fail(reason, `${host} returned ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`, { status: res.status, url });
  }
  if (raw) return res.text();

  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    fail('upstream_invalid_json', `${host} returned a non-JSON body`, { url });
  }
}

const qs = (params) => new URLSearchParams(params).toString();

// ── the /symbol workhorse (§2.2) ────────────────────────────────────────────

/**
 * Layer 1 — named groups. What callers use 95% of the time; stable and short.
 * Every field here was re-verified live 2026-09-16 (non-null on NASDAQ:AAPL).
 */
export const FIELD_GROUPS = Object.freeze({
  quote: Object.freeze([
    'name', 'close', 'change', 'change_abs', 'volume', 'market_cap_basic',
    'sector', 'industry', 'price_earnings_ttm',
  ]),
  technicals: Object.freeze([
    'RSI|60', 'Stoch.K|60', 'Stoch.D|60', 'CCI20|60', 'ADX|60', 'MACD.macd|60',
    'Mom|60', 'AO|60', 'EMA10|60', 'EMA200|60', 'SMA200|60', 'VWMA|60',
    'HullMA9|60', 'Recommend.All|60', 'Recommend.MA|60', 'Recommend.Other|60',
  ]),
  fundamentals: Object.freeze([
    'total_revenue', 'net_income', 'ebitda', 'gross_margin', 'return_on_equity', 'debt_to_equity',
  ]),
  forecasts: Object.freeze([
    'recommendation_mark', 'price_target_average', 'price_target_high', 'price_target_low',
    'recommendation_buy', 'recommendation_hold', 'recommendation_sell', 'recommendation_total',
    'earnings_per_share_forecast_next_fq', 'earnings_per_share_forecast_next_fy',
  ]),
  dividends: Object.freeze([
    'dividends_yield', 'dividend_payout_ratio_ttm', 'dividend_amount_recent',
    'dividend_ex_date_recent', 'dividend_payment_date_recent',
  ]),
  profile: Object.freeze([
    'number_of_employees', 'total_shares_outstanding', 'beta_1_year',
  ]),
  earnings_dates: Object.freeze([
    'earnings_release_date', 'earnings_release_next_date',
  ]),
});

/**
 * Layer 2 — the array-valued history fields.
 *
 * A LITERAL, deliberately not derived from the 547-name catalogue: the
 * catalogue contains look-alikes (`earnings_per_share_fq_h`, `eps_estimates_fq_h`)
 * that are listed and return null. This list is the answer, not a guess
 * (§2.2.1). tests/rest.test.js asserts it stays identical to
 * docs/fixtures/history-fields.json so the two cannot drift.
 */
export const HISTORY_FIELDS = Object.freeze([
  'total_revenue_fy_h', 'total_revenue_fq_h',
  'net_income_fy_h', 'net_income_fq_h',
  'total_assets_fy_h', 'total_assets_fq_h',
  'total_debt_fy_h', 'total_debt_fq_h',
  'free_cash_flow_fy_h', 'free_cash_flow_fq_h',
  'earnings_per_share_diluted_fy_h', 'earnings_per_share_diluted_fq_h',
  'earnings_per_share_basic_fy_h',
  'dps_common_stock_prim_issue_fy_h',
  'fiscal_period_fy_h',
  'gross_profit_fy_h', 'ebitda_fy_h',
]);

/** Group name aliases so a caller reaching for the official tool's vocabulary lands. */
export const GROUP_ALIASES = Object.freeze({
  price: 'quote', snapshot: 'quote',
  technical: 'technicals', rating: 'technicals', technical_rating: 'technicals',
  fund: 'fundamentals', financials: 'fundamentals',
  forecast: 'forecasts', analysts: 'forecasts', analyst: 'forecasts',
  dividend: 'dividends',
  company: 'profile', company_profile: 'profile',
  earnings: 'earnings_dates', dates: 'earnings_dates',
  history: 'history', financial_history: 'history',
});

/**
 * Columns that are verified working but absent from the harvested catalogue
 * (it is a screener-column list; these are scanner-native or timeframe-suffixed).
 * Present so `unknown_fields` stays a real signal instead of constant noise.
 *
 * Every group column's BASE name is added automatically — `RSI|60` is a
 * timeframe-suffixed form whose base `RSI` the catalogue does not carry either.
 */
const CORE_COLUMNS = new Set([
  'name', 'close', 'change', 'change_abs', 'volume', 'open', 'high', 'low',
  'update_mode', 'unit', 'currency', 'description', 'type', 'exchange',
  'logoid', 'pricescale', 'minmov', 'Recommend.All', 'Recommend.MA', 'Recommend.Other',
  'recommendation', 'recommendation_mark', 'recommendation_total',
  'price_target_average', 'price_target_high', 'price_target_low',
  'price_target_1y', 'target_price_1y', 'recommendation_buy',
  'recommendation_hold', 'recommendation_sell',
  ...HISTORY_FIELDS,
]);
for (const group of Object.values(FIELD_GROUPS)) {
  for (const f of group) CORE_COLUMNS.add(f.includes('|') ? f.slice(0, f.lastIndexOf('|')) : f);
}

/**
 * Timeframe suffix on a column name: `RSI|60` = RSI on the 1h (§2.2).
 *
 * CORRECTED 2026-09-16 by live probe + independent verification: the BARE field
 * name is the DAILY value, and `|1D` / `|D` return **null for every field**.
 * The doc's suffix list originally included `1D` as working — it is not.
 * Verification: Wilder RSI(14) computed from Yahoo daily closes for AAPL = 61.3086
 * and the scanner's bare `RSI` = 61.30858354729889 (exact match); `RSI|1D` = null.
 * Verified working suffixes: 1, 5, 15, 30, 60, 120, 240, 1W, 1M.
 * Probed and null: 2, 3, 45, 180, 480, 720, 1D, D, W, M, 12M.
 *
 * The caller may still SAY "1D"/"daily" — that is the friendly synonym and it
 * is realized by emitting the bare field name, never `|1D`.
 */
export const TIMEFRAMES = Object.freeze({
  '1': '|1', '5': '|5', '15': '|15', '30': '|30', '60': '|60',
  '120': '|120', '240': '|240', '1W': '|1W', '1M': '|1M',
  '1D': '', // daily — bare field name
});

/** Caller spelling → canonical key in TIMEFRAMES. */
const TIMEFRAME_ALIASES = Object.freeze({
  '1d': '1D', d: '1D', daily: '1D', day: '1D',
  '1w': '1W', w: '1W', weekly: '1W',
  '1m': '1M', m: '1M', monthly: '1M',
  '1h': '60', '4h': '240',
});

/** Normalize a caller timeframe to a canonical key, or null when unsupported. */
export function normalizeTimeframe(tf) {
  const raw = String(tf == null ? '1D' : tf).trim();
  if (TIMEFRAMES[raw] != null) return raw;
  const alias = TIMEFRAME_ALIASES[raw.toLowerCase()];
  return alias && TIMEFRAMES[alias] != null ? alias : null;
}

/** Suffix strings that are real for this endpoint (empty = daily/bare). */
const SUFFIX_VALUES = new Set(Object.values(TIMEFRAMES));

/**
 * Base name of a timeframe-suffixed column, or null when the `|` tail is not a
 * real suffix. `RSI|60` → `RSI`; `close|1D` → null (not a real suffix), which
 * keeps validation honest rather than silently accepting a null-returning name.
 */
const stripTimeframe = (f) => {
  const i = f.lastIndexOf('|');
  if (i < 0) return null;
  const tail = f.slice(i);
  return SUFFIX_VALUES.has(tail) ? f.slice(0, i) : null;
};

// The catalogue ships as a fixture, loaded once at startup for VALIDATION ONLY
// (a typo warning), never fetched inline and never treated as proof a field
// returns data (§11 field-map rules, §2.5).
let _catalogue = null;
function catalogue() {
  if (_catalogue) return _catalogue;
  try {
    const p = new URL('../../docs/fixtures/screener-columns.json', import.meta.url);
    _catalogue = new Set(JSON.parse(readFileSync(p, 'utf8')).fields || []);
  } catch {
    _catalogue = new Set(); // fixture absent → validation degrades to no-warning
  }
  return _catalogue;
}

/**
 * Resolve a caller's `fields` into columns + an advisory unknown list.
 *
 * Accepts group names and raw column names, mixed (§11): groups error on a
 * typo (they are a closed set), raw columns only WARN — the catalogue lags
 * TradingView, so a miss must not block a valid new field.
 */
export function resolveFields(fields) {
  const requested = fields == null ? ['quote'] : (Array.isArray(fields) ? fields : [fields]);
  if (!requested.length) fail('invalid_input', 'fields must not be empty');
  const columns = new Set();
  const groups = [];
  const unknown = [];
  const cat = catalogue();
  const known = (f) => {
    if (cat.has(f) || CORE_COLUMNS.has(f)) return true;
    const base = stripTimeframe(f);
    return base != null && (cat.has(base) || CORE_COLUMNS.has(base));
  };

  for (const raw of requested) {
    if (typeof raw !== 'string' || !raw.trim()) {
      fail('invalid_input', `fields entries must be non-empty strings (got ${JSON.stringify(raw)})`);
    }
    const name = raw.trim();
    const groupName = GROUP_ALIASES[name.toLowerCase()] || (FIELD_GROUPS[name] ? name : null);
    if (groupName === 'history') {
      groups.push('history');
      for (const f of HISTORY_FIELDS) columns.add(f);
      continue;
    }
    if (groupName) {
      groups.push(groupName);
      for (const f of FIELD_GROUPS[groupName]) columns.add(f);
      continue;
    }
    columns.add(name);
    if (!known(name)) unknown.push(name);
  }
  return { columns: [...columns], groups, unknown_fields: unknown };
}

/** GET /symbol — one symbol, flat object keyed by the requested fields. */
async function fetchSymbol(symbol, columns, _deps) {
  const url = `${HOSTS.scanner}/symbol?${qs({
    symbol,
    fields: columns.join(','),
    no_404: 'true', // §11 rule 4 — without it an unknown symbol 404s
  })}`;
  const body = await request(url, { _deps });
  // no_404=true returns null (observed) or {} for an unknown symbol.
  const found = body != null && typeof body === 'object' && Object.keys(body).length > 0;
  return { symbol, found, data: found ? body : null };
}

/** Split symbols into chunks and run them with a bounded concurrency (§11 rule 3). */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * tv_symbol_data — the field-map tool that covers quote, technicals,
 * fundamentals, forecasts, dividends, profile, earnings dates and history.
 *
 * Batch is one request per symbol (`/symbol` is single-symbol) under a
 * concurrency cap. For many symbols in ONE request use tv_screener_run
 * instead: screen for the list, then come back here for the detail.
 */
export async function symbolData({ symbol, symbols, fields, _deps } = {}) {
  const list = symbols?.length ? symbols : (symbol ? [symbol] : []);
  if (!list.length) fail('invalid_input', 'provide `symbol` or a non-empty `symbols` array');
  if (list.length > MAX_BATCH_SYMBOLS) {
    fail('invalid_input', `symbols is capped at ${MAX_BATCH_SYMBOLS} per call (got ${list.length}); use tv_screener_run for bulk scans`);
  }
  const { columns, groups, unknown_fields } = resolveFields(fields);
  const results = await mapLimit(list, BATCH_CONCURRENCY, (s) => fetchSymbol(s, columns, _deps));
  const base = { success: true, fields: columns, groups, ...(unknown_fields.length ? { unknown_fields } : {}) };
  if (list.length === 1) return { ...base, ...results[0] };
  return { ...base, count: results.length, results };
}

/**
 * tv_symbol_history — the `_h` array fields, plus the fiscal-year labels that
 * index-align the `_fy_h` arrays.
 */
export async function symbolHistory({ symbol, fields, _deps } = {}) {
  if (!symbol) fail('invalid_input', 'symbol is required');
  let wanted = HISTORY_FIELDS;
  if (fields?.length) {
    const bad = fields.filter((f) => !HISTORY_FIELDS.includes(f));
    if (bad.length) {
      fail('invalid_input', `not history fields: ${bad.join(', ')} — known: ${HISTORY_FIELDS.join(', ')}`);
    }
    wanted = fields;
  }
  const { found, data } = await fetchSymbol(symbol, wanted, _deps);
  if (!found) return { success: true, symbol, found: false, history: null, note: 'no history data for this symbol (ETFs return null; non-payers return zeros)' };
  const history = {};
  for (const f of wanted) history[f] = data[f] ?? null;
  return {
    success: true,
    symbol,
    found: true,
    fiscal_periods: data.fiscal_period_fy_h ?? null,
    history,
    note: 'arrays are most-recent-first; fiscal_periods index-aligns every *_fy_h array',
  };
}

/** tv_earnings_history — EPS per period (§2.2.1). No surprise or per-quarter date fields exist. */
export async function earningsHistory({ symbol, _deps } = {}) {
  if (!symbol) fail('invalid_input', 'symbol is required');
  const cols = ['earnings_per_share_diluted_fy_h', 'earnings_per_share_diluted_fq_h', 'earnings_per_share_basic_fy_h', 'fiscal_period_fy_h'];
  const { found, data } = await fetchSymbol(symbol, cols, _deps);
  if (!found) return { success: true, symbol, found: false, note: 'no earnings history for this instrument class' };
  return {
    success: true,
    symbol,
    found: true,
    fiscal_years: data.fiscal_period_fy_h ?? null,
    eps_diluted_annual: data.earnings_per_share_diluted_fy_h ?? null,
    eps_diluted_quarterly: data.earnings_per_share_diluted_fq_h ?? null,
    eps_basic_annual: data.earnings_per_share_basic_fy_h ?? null,
    note: 'no working quarterly basic EPS; no earnings-surprise fields exist upstream',
  };
}

/** tv_dividend_history — 20 years, per share (§2.2.1: the working name is not the obvious one). */
export async function dividendHistory({ symbol, _deps } = {}) {
  if (!symbol) fail('invalid_input', 'symbol is required');
  const cols = ['dps_common_stock_prim_issue_fy_h', 'fiscal_period_fy_h', 'dividends_yield', 'dividend_payout_ratio_ttm'];
  const { found, data } = await fetchSymbol(symbol, cols, _deps);
  if (!found) return { success: true, symbol, found: false, note: 'no dividend history for this instrument class' };
  return {
    success: true,
    symbol,
    found: true,
    fiscal_years: data.fiscal_period_fy_h ?? null,
    dividends_per_share_annual: data.dps_common_stock_prim_issue_fy_h ?? null,
    current_yield: data.dividends_yield ?? null,
    payout_ratio_ttm: data.dividend_payout_ratio_ttm ?? null,
    note: 'zeros are a genuine non-payer; null means no fundamental data for this instrument class',
  };
}

/**
 * tv_technicals_rating — the fixed Recommend.* family (bare `recommendation` is unreliable).
 *
 * The timeframe is applied as a field SUFFIX, and daily is the BARE name (see
 * TIMEFRAMES): asking for 1D emits `Recommend.All`, never `Recommend.All|1D`
 * which is null upstream.
 */
export async function technicalsRating({ symbol, timeframe, _deps } = {}) {
  if (!symbol) fail('invalid_input', 'symbol is required');
  const key = normalizeTimeframe(timeframe == null ? '60' : timeframe);
  if (!key) {
    fail('invalid_input', `timeframe must be one of ${Object.keys(TIMEFRAMES).join(', ')} (got ${JSON.stringify(timeframe)})`);
  }
  const suffix = TIMEFRAMES[key];
  const cols = FIELD_GROUPS.technicals.map((f) => `${f.split('|')[0]}${suffix}`);
  const { found, data } = await fetchSymbol(symbol, cols, _deps);
  if (!found) return { success: true, symbol, timeframe: key, found: false };
  const at = (base) => data[`${base}${suffix}`] ?? null;
  return {
    success: true,
    symbol,
    timeframe: key,
    ...(key === '1D' ? { timeframe_note: 'daily is the bare field name on this endpoint (|1D returns null upstream)' } : {}),
    summary: { all: at('Recommend.All'), ma: at('Recommend.MA'), oscillators: at('Recommend.Other') },
    values: data,
    note: 'Recommend.* is the reliable family; bare `recommendation` returns null',
  };
}

// ── screener (§2.1) ─────────────────────────────────────────────────────────

/** Slug-shaped guard — an unverified market list would reject valid slugs, so shape-check only. */
const MARKET_RE = /^[a-z][a-z0-9_-]{0,24}$/;

export const FILTER_OPERATORS = Object.freeze([
  'greater', 'less', 'egreater', 'eless', 'in_range', 'equal', 'not_equal', 'match',
  'above', 'below', 'in',
]);

/**
 * tv_screener_run — POST /{market}/scan. Many symbols in ONE request, with a
 * server-side `totalCount` that makes counting free.
 */
export async function screenerRun({ market = 'america', filter, columns, sort, range, limit, _deps } = {}) {
  if (!MARKET_RE.test(String(market))) {
    fail('invalid_input', `market must be a slug like 'america' (got ${JSON.stringify(market)})`);
  }
  const requested = columns?.length ? columns : ['name', 'close', 'change', 'volume'];
  const { columns: cols, unknown_fields } = resolveFields(requested);
  const filters = filter == null ? [] : (Array.isArray(filter) ? filter : [filter]);
  for (const f of filters) {
    if (!f || typeof f !== 'object' || !f.left || !f.operation) {
      fail('invalid_input', 'each filter needs { left, operation, right }');
    }
    if (!FILTER_OPERATORS.includes(f.operation)) {
      fail('invalid_input', `filter operation '${f.operation}' not in ${FILTER_OPERATORS.join(', ')}`);
    }
  }

  let span;
  if (Array.isArray(range) && range.length === 2) span = [Number(range[0]) || 0, Number(range[1]) || 0];
  else {
    const n = Math.min(Math.max(Number(limit) || DEFAULT_ROWS, 1), MAX_ROWS);
    span = [0, n];
  }
  if (span[1] - span[0] > MAX_ROWS) {
    fail('invalid_input', `range spans ${span[1] - span[0]} rows; the cap is ${MAX_ROWS} (raise it only deliberately — /scan at 1000 rows is multi-MB)`);
  }

  const payload = {
    filter: filters,
    columns: cols,
    ...(sort ? { sort } : {}),
    range: span,
  };
  const url = `${HOSTS.scanner}/${market}/scan`;
  const body = await request(url, {
    method: 'POST',
    body: JSON.stringify(payload),
    headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
    _deps,
  });

  const data = Array.isArray(body?.data) ? body.data : [];
  const rows = data.map((r) => {
    const row = { symbol: r.s };
    cols.forEach((c, i) => { row[c] = r.d?.[i] ?? null; });
    return row;
  });
  return {
    success: true,
    market,
    total_count: body?.totalCount ?? null,
    returned: rows.length,
    range: span,
    columns: cols,
    ...(unknown_fields.length ? { unknown_fields } : {}),
    rows,
    note: 'total_count is the unpaged match count; range is [offset, offset+limit]. You cannot filter ON a history field — filter on a scalar and carry the _h column in `columns`.',
  };
}

/** tv_screener_columns — the harvested accepted-name allowlist (§2.5). */
export async function screenerColumns({ search } = {}) {
  const cat = [...catalogue()].sort();
  if (!cat.length) fail('ssr_payload_missing', 'docs/fixtures/screener-columns.json is missing — run `npm run harvest:rest`');
  const fields = search ? cat.filter((f) => f.includes(String(search).toLowerCase())) : cat;
  return {
    success: true,
    count: fields.length,
    ...(search ? { search, total_catalogue: cat.length } : {}),
    fields,
    history_fields: HISTORY_FIELDS,
    note: 'advisory allowlist only: it is harvested, so it lags TradingView AND it is not proof a field returns data — see history_fields for the ones that do.',
  };
}

// ── earnings calendar (§2.1, bulk scan) ─────────────────────────────────────

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const toEpoch = (day, end = false) => {
  const d = new Date(`${day}T00:00:00Z`).getTime() / 1000;
  if (!Number.isFinite(d)) fail('invalid_input', `bad date '${day}' — use YYYY-MM-DD`);
  return end ? d + 86_399 : d;
};

/**
 * tv_earnings_calendar — the bulk calendar via a scan on
 * `earnings_release_next_date` (2,014 rows over all time in the probe).
 */
export async function earningsCalendar({ from, to, market = 'america', limit, _deps } = {}) {
  if (!MARKET_RE.test(String(market))) fail('invalid_input', `market must be a slug like 'america' (got ${JSON.stringify(market)})`);
  for (const [name, v] of [['from', from], ['to', to]]) {
    if (v != null && !DAY_RE.test(String(v))) fail('invalid_input', `${name} must be YYYY-MM-DD (got ${JSON.stringify(v)})`);
  }
  const lo = from ? toEpoch(from) : 0;
  const hi = to ? toEpoch(to, true) : 9_999_999_999;
  if (lo > hi) fail('invalid_input', `from (${from}) is after to (${to})`);
  const n = Math.min(Math.max(Number(limit) || DEFAULT_ROWS, 1), MAX_ROWS);

  const payload = {
    filter: [{ left: 'earnings_release_next_date', operation: 'in_range', right: [lo, hi] }],
    columns: ['name', 'description', 'earnings_release_next_date', 'earnings_release_date', 'market_cap_basic', 'earnings_per_share_forecast_next_fq'],
    sort: { sortBy: 'earnings_release_next_date', sortOrder: 'asc' },
    range: [0, n],
  };
  const body = await request(`${HOSTS.scanner}/${market}/scan`, {
    method: 'POST',
    body: JSON.stringify(payload),
    headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
    _deps,
  });
  const rows = (Array.isArray(body?.data) ? body.data : []).map((r) => {
    const d = r.d || [];
    return {
      symbol: r.s,
      name: d[0],
      description: d[1],
      release_next_date: d[2],
      release_next_date_iso: d[2] ? new Date(d[2] * 1000).toISOString() : null,
      release_date: d[3],
      market_cap_basic: d[4],
      eps_forecast_next_fq: d[5],
    };
  });
  return { success: true, market, from: from ?? null, to: to ?? null, total_count: body?.totalCount ?? null, returned: rows.length, events: rows };
}

// ── economic calendar (§3) ──────────────────────────────────────────────────

/** Official scale: -1 low, 0 medium, 1 high. Upstream also emits 2 (undocumented). */
export const IMPORTANCE_LABELS = Object.freeze({ '-1': 'low', 0: 'medium', 1: 'high' });
const DEFAULT_ECON_DAYS = 7;
const MAX_ECON_DAYS = 90;

/**
 * tv_economic_calendar — the best find in the doc: no Origin, no Referer, no
 * cookie. `importance` matches the official tool's min_importance scale.
 */
export async function economicCalendar({ from, to, countries, min_importance, limit, _deps } = {}) {
  for (const [name, v] of [['from', from], ['to', to]]) {
    if (v != null && !DAY_RE.test(String(v))) fail('invalid_input', `${name} must be YYYY-MM-DD (got ${JSON.stringify(v)})`);
  }
  let start = from;
  let end = to;
  if (!start) {
    start = new Date().toISOString().slice(0, 10);
    end = end || new Date(Date.now() + DEFAULT_ECON_DAYS * 86_400_000).toISOString().slice(0, 10);
  }
  if (!end) end = start;
  const spanDays = (toEpoch(end, true) - toEpoch(start)) / 86_400;
  if (spanDays < 0) fail('invalid_input', `from (${start}) is after to (${end})`);
  if (spanDays > MAX_ECON_DAYS) {
    fail('invalid_input', `window spans ${Math.round(spanDays)} days; the cap is ${MAX_ECON_DAYS} (the payload is ~78–236 KB per week)`);
  }

  const params = { from: start, to: end };
  if (countries?.length) params.countries = (Array.isArray(countries) ? countries : String(countries).split(',')).map((c) => String(c).trim().toUpperCase()).filter(Boolean).join(',');
  const body = await request(`${HOSTS.calendar}/events?${qs(params)}`, { _deps });

  if (body?.status && body.status !== 'ok') {
    fail('upstream_http_error', `calendar host returned status '${body.status}'`);
  }
  let events = Array.isArray(body?.result) ? body.result : [];
  if (min_importance != null) {
    const min = Number(min_importance);
    if (!Number.isFinite(min)) fail('invalid_input', 'min_importance must be a number (-1 low, 0 medium, 1 high)');
    events = events.filter((e) => Number(e.importance) >= min);
  }
  const n = Math.min(Math.max(Number(limit) || DEFAULT_ROWS, 1), MAX_ROWS);
  const total = events.length;
  const sliced = events.slice(0, n).map((e) => ({
    date: e.date,
    title: e.title,
    country: e.country,
    currency: e.currency,
    importance: e.importance,
    importance_label: IMPORTANCE_LABELS[String(e.importance)] ?? null,
    actual: e.actual,
    forecast: e.forecast,
    previous: e.previous,
    period: e.period,
    unit: e.unit,
    id: e.id,
  }));
  return {
    success: true,
    from: start,
    to: end,
    ...(params.countries ? { countries: params.countries } : {}),
    total_count: total,
    returned: sliced.length,
    events: sliced,
    note: 'forward-looking calendar: actual/forecast are null for future events. `id` is a composite string, not a stable key.',
  };
}

// ── news (§4) ───────────────────────────────────────────────────────────────

const NEWS_LANGS = Object.freeze([
  'en', 'ru', 'de', 'fr', 'es', 'pt', 'it', 'pl', 'tr', 'ar', 'he', 'ko', 'ja',
  'vi', 'th', 'ms', 'id', 'zh-Hans', 'zh-Hant', 'ro', 'en_IN',
]);

/**
 * Resolve `TICKER` to `EXCHANGE:TICKER`. news-mediator rejects a bare ticker
 * with a 422 and the documents slug needs `EXCHANGE-TICKER`; §11 rule 6 says
 * reuse the existing symbol search rather than adding a second one.
 */
async function resolveExchange(symbol, _deps) {
  const raw = String(symbol || '').trim();
  if (!raw) fail('invalid_input', 'symbol is required');
  if (raw.includes(':')) return raw.toUpperCase();
  // `_deps.searchSymbols` lets offline tests stub resolution.
  const search = _deps?.searchSymbols || symbolSearch;
  let result;
  try {
    result = await search({ query: raw });
  } catch (err) {
    fail('upstream_unavailable', `could not resolve '${raw}' to EXCHANGE:TICKER: ${err?.message || err}`);
  }
  const hit = (result?.results || []).find((r) => r.full_name) || (result?.results || [])[0];
  if (!hit?.full_name || !String(hit.full_name).includes(':')) {
    fail('not_found', `could not resolve '${raw}' to an EXCHANGE:TICKER pair; pass the qualified symbol (e.g. NASDAQ:${raw.toUpperCase()})`);
  }
  return String(hit.full_name).toUpperCase();
}

/**
 * tv_news — headlines for one symbol (news-headlines, per-symbol, ~100–200
 * items) or the general flow (news-mediator). Headlines only: no endpoint in
 * this class carries body text.
 */
export async function news({ symbol, lang = 'en', limit = 50, _deps } = {}) {
  const language = String(lang);
  if (!NEWS_LANGS.includes(language)) {
    fail('invalid_input', `lang must be one of ${NEWS_LANGS.join(', ')} (got ${language})`);
  }
  const n = Math.min(Math.max(Number(limit) || 50, 1), 200);

  if (symbol) {
    const qualified = await resolveExchange(symbol, _deps);
    // Filters must be SORTED BY ID and carry the EXCHANGE: prefix (§4.2) —
    // both are hard server-side validations ("filters must be sorted").
    const filters = [['lang', language], ['symbol', qualified]].sort((a, b) => a[0].localeCompare(b[0]));
    const params = new URLSearchParams();
    for (const [id, value] of filters) params.append('filter', `${id}:${value}`);
    params.set('client', 'web');
    params.set('user_prostatus', 'non_pro');
    const body = await request(`${HOSTS.newsMediator}/public/view/v1/symbol?${params}`, { _deps });
    return shapeNews(body, { symbol: qualified, lang: language, kind: 'by_symbol', limit: n });
  }

  const params = new URLSearchParams();
  params.append('filter', `lang:${language}`);
  params.set('client', 'web');
  params.set('user_prostatus', 'non_pro');
  const body = await request(`${HOSTS.newsMediator}/public/news-flow/v2/news?${params}`, { _deps });
  return shapeNews(body, { lang: language, kind: 'flow', limit: n });
}

function shapeNews(body, { symbol, lang, kind, limit }) {
  const items = Array.isArray(body?.items) ? body.items : [];
  const shaped = items.slice(0, limit).map((i) => ({
    id: i.id,
    title: i.title,
    published: i.published,
    published_iso: i.published ? new Date(i.published * 1000).toISOString() : null,
    provider: i.provider,
    urgency: i.urgency,
    permission: i.permission,
    paywall: i.paywall ?? null,
    story_path: i.storyPath || null,
    related_symbols: (i.relatedSymbols || []).map((s) => s.symbol).filter(Boolean),
  }));
  return {
    success: true,
    kind,
    ...(symbol ? { symbol } : {}),
    lang,
    total_count: items.length,
    returned: shaped.length,
    items: shaped,
    note: 'headlines only — no endpoint in this class returns body text. Pass `id` or `story_path` to tv_news_story for the text.',
  };
}

// ── SSR init-data (§5, §7.1) ────────────────────────────────────────────────
//
// Several pages embed data as SSR JSON with no API. ONE regex + JSON.parse —
// no HTML parser, no headless browser.

const INIT_DATA_RE = /<script type="application\/prs\.init-data\+json">([\s\S]*?)<\/script>/g;

/**
 * Return the unwrapped value of every prs.init-data+json block.
 *
 * Rules learned the hard way (§7.1): there are multiple blocks (6 on a story
 * page, 7 on a symbol page) and the target is rarely the first; each block is
 * keyed by an opaque id, so take Object.values(block)[0]; unparsable trailing
 * blocks exist and must be skipped, not thrown on.
 */
export function extractInitData(html) {
  const out = [];
  for (const m of String(html || '').matchAll(INIT_DATA_RE)) {
    let parsed;
    try { parsed = JSON.parse(m[1]); } catch { continue; }
    if (parsed && typeof parsed === 'object') {
      for (const v of Object.values(parsed)) if (v && typeof v === 'object') out.push(v);
    }
  }
  return out;
}

/** Depth-bounded search for the first block matching a shape marker. */
export function findInBlocks(blocks, predicate, depth = 8, seen = new Set()) {
  const walk = (node, d) => {
    if (!node || typeof node !== 'object' || d > depth || seen.has(node)) return null;
    seen.add(node);
    if (predicate(node)) return node;
    for (const v of Object.values(node)) {
      const hit = walk(v, d + 1);
      if (hit) return hit;
    }
    return null;
  };
  for (const b of blocks) {
    const hit = walk(b, 0);
    if (hit) return hit;
  }
  return null;
}

/** Flatten an AST node (`{type, children}` / string / array) into plain text. */
export function astToText(node) {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map((n) => astToText(n)).join('');
  if (typeof node !== 'object') return String(node);
  const inner = (node.children || []).map((c) => astToText(c)).join('');
  // Block-level nodes get a trailing newline; inline wrappers concatenate.
  const block = new Set(['p', 'list', '*', 'root', 'blockquote', 'div', 'section', 'h1', 'h2', 'h3', 'h4']);
  if (node.type && !block.has(node.type)) return inner;
  return inner ? `${inner}\n` : '';
}

/**
 * tv_news_story — full story text. The story is NOT block 0 (the first block
 * is the site menu), so a naive "take block 0" fails; walk for the marker
 * `title` + (`ast_description` | `short_description`).
 */
export async function newsStory({ id, include_ast = false, _deps } = {}) {
  const raw = String(id || '').trim();
  if (!raw) fail('invalid_input', 'id is required (a story id or a story_path from tv_news)');
  // Accept an id, a /news/... path, or a full URL.
  let path;
  if (/^https?:\/\//i.test(raw)) path = new URL(raw).pathname;
  else if (raw.startsWith('/news/')) path = raw;
  else path = `/news/${encodeURIComponent(raw)}/`;
  if (!path.endsWith('/')) path += '/';

  const html = await request(`${HOSTS.site}${path}`, { raw: true, _deps });
  const blocks = extractInitData(html);
  if (!blocks.length) {
    fail('ssr_payload_missing', `no prs.init-data+json blocks on ${path} — the page shape changed`, { url: path });
  }
  const story = findInBlocks(
    blocks,
    (o) => typeof o.title === 'string' && (o.ast_description || o.short_description),
  );
  if (!story) {
    fail('ssr_payload_missing', `story marker (title + ast_description) not found in any of the ${blocks.length} init-data blocks on ${path}`, { url: path });
  }
  const body = story.ast_description ? astToText(story.ast_description).trim() : String(story.short_description || '').trim();
  return {
    success: true,
    id: story.id ?? raw,
    title: story.title,
    provider: story.provider ?? null,
    published: story.published ?? null,
    urgency: story.urgency ?? null,
    read_time: story.read_time ?? null,
    tags: story.tags ?? null,
    related_symbols: (story.related_symbols || []).map((s) => s.symbol).filter(Boolean),
    story_path: story.story_path ?? path,
    permission: story.permission ?? null,
    paywall: story.paywall ?? null,
    ...(story.paywall ? { paywall_notice: 'This provider sets paywall: true. The platform marker is preserved, not stripped — do not redistribute the text.' } : {}),
    body_text: body,
    body_chars: body.length,
    ...(include_ast ? { ast: story.ast_description ?? null } : {}),
    note: 'Extracted from the page SSR payload — if the shape changes this fails loudly rather than degrading.',
  };
}

/**
 * tv_documents — filings & transcripts LIST. Body text of a filing is NOT
 * solved upstream (`get_document_view` open gap, §10): the views[].id values
 * are Quartr URNs and no accepting endpoint was found.
 */
export async function documents({ symbol, category, limit, include_earnings = false, _deps } = {}) {
  const qualified = await resolveExchange(symbol, _deps);
  const [exchange, ticker] = qualified.split(':');
  // The slug is EXCHANGE-TICKER; NYSE-TSLA 404s. Derive the exchange from
  // symbol_search rather than guessing it (§5 caveat).
  const slug = `${exchange}-${ticker}`;
  const html = await request(`${HOSTS.site}/symbols/${encodeURIComponent(slug)}/documents/`, { raw: true, _deps });
  const blocks = extractInitData(html);
  if (!blocks.length) {
    fail('ssr_payload_missing', `no prs.init-data+json blocks on /symbols/${slug}/documents/ — the page shape changed`);
  }
  // The filings block hangs off the symbol-page object (documents + earnings +
  // currency), NOT the bare {items,total} — matching the child would lose the
  // sibling earnings map.
  const symbolPage = findInBlocks(blocks, (o) => o.documents && Array.isArray(o.documents.items) && o.documents.total != null);
  if (!symbolPage) {
    fail('ssr_payload_missing', `filings block (documents.items + total) not found in any of the ${blocks.length} init-data blocks for ${slug}`);
  }
  const page = symbolPage;
  const docs = page.documents;

  const filters = flattenFilters(docs.meta?.items || []);
  let items = docs.items;
  if (category) {
    const wanted = String(category).toLowerCase();
    const valid = new Set(filters.map((f) => f.id));
    if (!valid.has(wanted)) {
      fail('invalid_input', `unknown category '${category}'; valid: ${[...valid].sort().join(', ')}`);
    }
    const catIds = collectCategoryIds(docs.meta?.items || [], wanted);
    items = items.filter((i) => catIds.has(i.category?.id));
  }
  const n = limit == null ? items.length : Math.min(Math.max(Number(limit) || 0, 1), items.length);
  const shaped = items.slice(0, n).map((d) => ({
    id: d.id,
    title: d.title,
    category: d.category?.id ?? null,
    category_title: d.category?.title ?? null,
    fiscal_period: d.fiscal_period ?? null,
    fiscal_year: d.fiscal_year ?? null,
    provider: d.provider?.id ?? null,
    provider_name: d.provider?.name ?? null,
    reported: d.reported ?? null,
    reported_iso: d.reported ? new Date(d.reported * 1000).toISOString() : null,
    event: d.event ?? null,
    status: d.status ?? null,
    views: (d.views || []).map((v) => ({ id: v.id, type: v.type })),
  }));

  return {
    success: true,
    symbol: qualified,
    slug,
    total: docs.total,
    returned: shaped.length,
    ...(category ? { category } : {}),
    filters,
    documents: shaped,
    ...(include_earnings ? { earnings: shapeEarnings(page.earnings) } : {}),
    note: 'List, categories, dates and view ids only — filing BODY TEXT is an open upstream gap (views[].id are Quartr URNs with no accepting endpoint).',
  };
}

/** Flatten the UI filter tree into a validated id list. */
function flattenFilters(nodes, out = []) {
  for (const n of nodes || []) {
    out.push({
      id: n.id,
      title: n.attrs?.title ?? n.id,
      available: n.available === true,
      categories: n.categories ?? null,
      events: n.events ?? null,
    });
    if (n.children?.length) flattenFilters(n.children, out);
  }
  return out;
}

/** A filter id's category set — itself when it names categories, else its subtree's. */
function collectCategoryIds(nodes, wanted, found = new Set()) {
  for (const n of nodes || []) {
    if (n.id === wanted) {
      const gather = (m) => {
        for (const c of m.categories || []) found.add(c);
        for (const ch of m.children || []) gather(ch);
      };
      gather(n);
    }
    if (n.children?.length) collectCategoryIds(n.children, wanted, found);
  }
  return found;
}

/** `page.earnings` is a date-keyed map, not an array (§7.1 rule 3). */
function shapeEarnings(earnings) {
  if (!earnings || typeof earnings !== 'object') return [];
  return Object.values(earnings)
    .filter((e) => e && typeof e === 'object')
    .sort((a, b) => (b.date ?? 0) - (a.date ?? 0))
    .map((e) => ({
      date: e.date ?? null,
      date_iso: e.date ? new Date(e.date * 1000).toISOString() : null,
      period: e.period ? new Date(e.period * 1000).toISOString().slice(0, 10) : null,
      standardized: e.standardized ?? null,
      estimate: e.estimate ?? null,
      reported: e.reported ?? null,
      revenue_estimate: e.revenueEstimate ?? null,
      revenue_value: e.revenueValue ?? null,
    }));
}

export { fetchSymbol, resolveExchange, request as restRequest };
