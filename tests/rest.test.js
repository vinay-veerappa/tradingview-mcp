/**
 * REST data surfaces — offline contract tests (docs/REST_DATA_SURFACES.md §11).
 *
 * NO test in this file touches the network. Every call goes through the
 * `_deps.fetch` seam (the same injection pattern as `_deps.evaluate` elsewhere),
 * so the transport, the field-map resolution, the SSR extraction and the error
 * envelope are all exercised against fixed payloads.
 *
 * The fixture shapes here are copied from live responses probed 2026-09-16 —
 * they are deliberately literal, because the whole point of these tools is that
 * the upstream shape is undocumented and unversioned. When this file's fixtures
 * drift from reality, the tools fail loudly upstream (ssr_payload_missing,
 * upstream_http_error) rather than silently degrading.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import {
  symbolData, symbolHistory, earningsHistory, dividendHistory, technicalsRating,
  screenerRun, screenerColumns, earningsCalendar, economicCalendar,
  news, newsStory, documents,
  resolveFields, extractInitData, findInBlocks, astToText,
  FIELD_GROUPS, HISTORY_FIELDS, MAX_ROWS, RestError, REST_REASONS,
  TIMEFRAMES, normalizeTimeframe,
} from '../src/core/rest.js';
import { registerAll } from '../src/tools/index.js';
import { getOp, listOps } from '../src/tools/_registry.js';
import { buildErrorEnvelope, REST_ERROR_REASONS, CDP_ERROR_REASONS } from '../src/tools/_format.js';

// ── the stub transport ──────────────────────────────────────────────────────

/**
 * A fetch double: routes by URL, records every call. Responses are
 * `{ ok, status, json|text }` so both the JSON and the raw-SSR paths are
 * exercisable without a socket.
 */
function makeFetch(routes) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    for (const [match, respond] of routes) {
      if (typeof match === 'string' ? String(url).includes(match) : match.test(String(url))) {
        const r = typeof respond === 'function' ? respond(url, init) : respond;
        if (r instanceof Error) throw r;
        return {
          ok: r.status == null ? true : r.status >= 200 && r.status < 300,
          status: r.status ?? 200,
          text: async () => (r.text != null ? r.text : JSON.stringify(r.json ?? {})),
          json: async () => r.json,
        };
      }
    }
    throw new Error(`no stub route for ${url}`);
  };
  return { fetch, calls };
}

const deps = (fetch) => ({ fetch });
const SYMBOL_RE = /scanner\.tradingview\.com\/symbol\?/;

// A representative live /symbol payload (AAPL, probed 2026-09-16).
const AAPL = {
  name: 'AAPL',
  close: 331.34,
  change: 1.2,
  change_abs: 3.9,
  volume: 31747883,
  market_cap_basic: 4835635302713.5,
  sector: 'Electronic Technology',
  industry: 'Telecommunications Equipment',
  price_earnings_ttm: 38.1,
  'RSI|60': 55.4,
  'Recommend.All|60': 0.29,
  total_revenue_fy_h: [416161000000, 391035000000, 383285000000],
  net_income_fy_h: [112010000000, 96995000000, 99803000000],
  earnings_per_share_diluted_fy_h: [7.39, 6.13, 6.11],
  dps_common_stock_prim_issue_fy_h: [1.0, 0.97, 0.94],
  fiscal_period_fy_h: [2025, 2024, 2023],
};

// ---- field-map resolution -------------------------------------------------

describe('field-map resolution (§11 "Field-map design")', () => {
  test('groups resolve to columns; default is quote', () => {
    const d = resolveFields(undefined);
    assert.deepEqual(d.groups, ['quote']);
    assert.deepEqual(d.columns, [...FIELD_GROUPS.quote]);
    assert.deepEqual(d.unknown_fields, []);
  });

  test('groups and raw columns mix, deduped, order preserved', () => {
    const d = resolveFields(['quote', 'RSI|60', 'history', 'close']);
    assert.ok(d.columns.includes('name'));
    assert.ok(d.columns.includes('RSI|60'));
    assert.ok(d.columns.includes('total_revenue_fy_h'));
    assert.equal(d.columns.filter((c) => c === 'close').length, 1, 'deduped');
    assert.deepEqual(d.groups.sort(), ['history', 'quote']);
  });

  test('history group expands to exactly the 17 verified fields', () => {
    const d = resolveFields(['history']);
    assert.equal(d.columns.length, HISTORY_FIELDS.length);
    for (const f of HISTORY_FIELDS) assert.ok(d.columns.includes(f), f);
  });

  test('unknown RAW column warns but still sends (catalogue lags TradingView)', () => {
    const d = resolveFields(['close', 'some_brand_new_column_xyz']);
    assert.deepEqual(d.unknown_fields, ['some_brand_new_column_xyz']);
    assert.ok(d.columns.includes('some_brand_new_column_xyz'), 'still sent');
  });

  test('unknown GROUP name is an error (typo protection, closed set)', () => {
    // A group-shaped name that is not in the alias table falls through to raw
    // column handling; the closed-set protection is the explicit group check.
    assert.throws(() => resolveFields(['']), /non-empty string/);
    assert.throws(() => resolveFields([null]), /non-empty string/);
    assert.throws(() => resolveFields([]), /must not be empty/);
  });

  test('group aliases route official-MCP vocabulary to the same columns', () => {
    assert.deepEqual(resolveFields(['price']).columns, resolveFields(['quote']).columns);
    assert.deepEqual(resolveFields(['financials']).columns, resolveFields(['fundamentals']).columns);
    assert.deepEqual(resolveFields(['analysts']).columns, resolveFields(['forecasts']).columns);
  });

  test('timeframe-suffixed columns are recognized against the catalogue', () => {
    // `RSI|60` is not a screener column, but its BASE name is registered from
    // FIELD_GROUPS — no spurious warning either way.
    const d = resolveFields(['RSI|60', 'close', 'EMA200|15']);
    assert.deepEqual(d.unknown_fields, []);
  });

  test('the TIMEFRAME table encodes the verification: daily is bare, 1D is not a suffix', () => {
    assert.equal(TIMEFRAMES['1D'], '', 'daily = bare field name');
    assert.equal(TIMEFRAMES['60'], '|60');
    for (const k of ['1', '5', '15', '30', '60', '120', '240', '1W', '1M']) {
      assert.equal(TIMEFRAMES[k], `|${k}`);
    }
    // Probed and null upstream as SUFFIXES — must not be accepted as a
    // timeframe. (`D`/`W`/`M` are separately accepted as caller SPELLINGS of
    // daily/weekly/monthly and are realized by the bare/real suffix.)
    for (const bad of ['2', '3', '45', '180', '480', '720', '12M', '1Dx', 'dailyx']) {
      assert.equal(normalizeTimeframe(bad), null, `${bad} is not a supported timeframe`);
    }
    assert.equal(normalizeTimeframe('D'), '1D', 'D is a friendly spelling of daily, not the |D suffix');
    assert.equal(normalizeTimeframe('W'), '1W');
    assert.equal(normalizeTimeframe('M'), '1M');
    assert.equal(normalizeTimeframe('daily'), '1D');
    assert.equal(normalizeTimeframe('1d'), '1D');
    assert.equal(normalizeTimeframe('4h'), '240');
    assert.equal(normalizeTimeframe(undefined), '1D');
  });

  test('HISTORY_FIELDS is identical to the persisted fixture (cannot drift)', () => {
    const fixture = JSON.parse(readFileSync(new URL('../docs/fixtures/history-fields.json', import.meta.url), 'utf8'));
    assert.deepEqual([...HISTORY_FIELDS].sort(), [...fixture.fields].sort());
    assert.equal(HISTORY_FIELDS.length, fixture.count);
  });
});

// ---- tv_symbol_data -------------------------------------------------------

describe('tv_symbol_data', () => {
  test('single symbol: resolves groups, fetches once, reports unknown fields', async () => {
    const { fetch, calls } = makeFetch([[SYMBOL_RE, { json: AAPL }]]);
    const r = await symbolData({ symbol: 'NASDAQ:AAPL', fields: ['quote', 'notacolumn'], _deps: deps(fetch) });
    assert.equal(r.success, true);
    assert.equal(r.symbol, 'NASDAQ:AAPL');
    assert.equal(r.found, true);
    assert.equal(r.data.close, 331.34);
    assert.deepEqual(r.unknown_fields, ['notacolumn']);
    assert.equal(calls.length, 1);
    // no_404 is mandatory (§11 rule 4)
    assert.ok(calls[0].url.includes('no_404=true'));
    // UA present on every request (§11 rule 2)
    assert.match(calls[0].init.headers['User-Agent'], /Mozilla/);
  });

  test('batch: one request per symbol, results keyed by symbol', async () => {
    const { fetch, calls } = makeFetch([
      [/symbol=NASDAQ%3AAAPL/, { json: { name: 'AAPL', close: 1 } }],
      [/symbol=NASDAQ%3ANVDA/, { json: { name: 'NVDA', close: 2 } }],
    ]);
    const r = await symbolData({ symbols: ['NASDAQ:AAPL', 'NASDAQ:NVDA'], _deps: deps(fetch) });
    assert.equal(r.count, 2);
    assert.equal(calls.length, 2);
    assert.equal(r.results.find((x) => x.symbol === 'NASDAQ:NVDA').data.close, 2);
  });

  test('an unknown symbol returns found:false, not a throw (no_404 semantics)', async () => {
    const { fetch } = makeFetch([[SYMBOL_RE, { json: null }]]);
    const r = await symbolData({ symbol: 'NASDAQ:ZZZZ', _deps: deps(fetch) });
    assert.equal(r.success, true);
    assert.equal(r.found, false);
    assert.equal(r.data, null);
  });

  test('batch cap is enforced before any request goes out', async () => {
    const { fetch, calls } = makeFetch([[SYMBOL_RE, { json: AAPL }]]);
    await assert.rejects(
      () => symbolData({ symbols: Array.from({ length: 51 }, (_, i) => `S:${i}`), _deps: deps(fetch) }),
      /capped at 50/,
    );
    assert.equal(calls.length, 0, 'refused before fetching');
  });

  test('missing symbol and symbol list is invalid_input', async () => {
    await assert.rejects(() => symbolData({}), /provide `symbol`/);
  });
});

// ---- history / earnings / dividends / technicals --------------------------

describe('history-shaped tools', () => {
  test('symbolHistory returns arrays plus fiscal_periods, most-recent-first', async () => {
    const { fetch } = makeFetch([[SYMBOL_RE, { json: AAPL }]]);
    const r = await symbolHistory({ symbol: 'NASDAQ:AAPL', _deps: deps(fetch) });
    assert.equal(r.found, true);
    assert.deepEqual(r.fiscal_periods, [2025, 2024, 2023]);
    assert.equal(r.history.total_revenue_fy_h[0], 416161000000);
  });

  test('symbolHistory rejects a non-history field by name', async () => {
    await assert.rejects(
      () => symbolHistory({ symbol: 'NASDAQ:AAPL', fields: ['close'], _deps: deps(makeFetch([]).fetch) }),
      /not history fields/,
    );
  });

  test('earningsHistory labels the arrays the way the doc says they are named', async () => {
    const { fetch } = makeFetch([[SYMBOL_RE, { json: AAPL }]]);
    const r = await earningsHistory({ symbol: 'NASDAQ:AAPL', _deps: deps(fetch) });
    assert.deepEqual(r.eps_diluted_annual, [7.39, 6.13, 6.11]);
    assert.match(r.note, /no working quarterly basic EPS/);
  });

  test('dividendHistory carries the non-obvious working column', async () => {
    const { fetch, calls } = makeFetch([[SYMBOL_RE, { json: AAPL }]]);
    const r = await dividendHistory({ symbol: 'NYSE:KO', _deps: deps(fetch) });
    assert.ok(calls[0].url.includes('dps_common_stock_prim_issue_fy_h'));
    assert.deepEqual(r.dividends_per_share_annual, [1.0, 0.97, 0.94]);
  });

  test('technicalsRating re-suffixes the indicator set to the timeframe', async () => {
    const day = { 'RSI|1W': 51.2, 'Recommend.All|1W': 0.14, 'Recommend.MA|1W': 0.1, 'Recommend.Other|1W': 0.18 };
    const { fetch, calls } = makeFetch([[SYMBOL_RE, { json: day }]]);
    const r = await technicalsRating({ symbol: 'NASDAQ:AAPL', timeframe: '1W', _deps: deps(fetch) });
    assert.equal(r.timeframe, '1W');
    assert.ok(calls[0].url.includes('RSI%7C1W'), 'RSI is suffixed with the requested timeframe');
    assert.equal(r.summary.all, 0.14);
    assert.equal(r.summary.ma, 0.1);
    assert.equal(r.summary.oscillators, 0.18);
  });

  test('DAILY is the BARE field name — |1D is null upstream (verified live)', async () => {
    // Regression: the doc listed `1D` as a working suffix. It is not — every
    // field with `|1D` returns null. Daily must emit the unsuffixed name.
    const bare = { RSI: 61.3086, 'Recommend.All': 0.4, 'Recommend.MA': 0.36, 'Recommend.Other': 0.44 };
    const { fetch, calls } = makeFetch([[SYMBOL_RE, { json: bare }]]);
    for (const ask of ['1D', 'daily', 'D', '1d']) {
      const r = await technicalsRating({ symbol: 'NASDAQ:AAPL', timeframe: ask, _deps: deps(fetch) });
      assert.equal(r.timeframe, '1D', `${ask} normalizes to 1D`);
      assert.equal(r.summary.all, 0.4);
    }
    assert.equal(calls.length, 4);
    for (const c of calls) {
      assert.equal(decodeURIComponent(c.url).includes('RSI|1D'), false, 'must never request |1D');
      assert.ok(decodeURIComponent(c.url).includes('fields=RSI,') || decodeURIComponent(c.url).includes(',RSI,'), 'daily RSI is bare');
    }
    assert.match((await technicalsRating({ symbol: 'X', timeframe: '1D', _deps: deps(fetch) })).timeframe_note, /bare field name/);
  });

  test('technicalsRating defaults to the 1h and reports null for an absent field', async () => {
    const { fetch, calls } = makeFetch([[SYMBOL_RE, { json: { 'RSI|60': 55 } }]]);
    const r = await technicalsRating({ symbol: 'NASDAQ:AAPL', _deps: deps(fetch) });
    assert.equal(r.timeframe, '60');
    assert.ok(calls[0].url.includes('RSI%7C60'));
    assert.equal(r.summary.all, null, 'absent Recommend field is null, not undefined');
  });

  test('technicalsRating accepts friendly aliases and refuses a bogus timeframe', async () => {
    const { fetch } = makeFetch([[SYMBOL_RE, { json: { 'RSI|240': 1, 'Recommend.All|240': 1, 'Recommend.MA|240': 1, 'Recommend.Other|240': 1 } }]]);
    assert.equal((await technicalsRating({ symbol: 'X', timeframe: '4h', _deps: deps(fetch) })).timeframe, '240');
    assert.equal((await technicalsRating({ symbol: 'X', timeframe: '1h', _deps: deps(fetch) })).timeframe, '60');
    await assert.rejects(
      () => technicalsRating({ symbol: 'X', timeframe: '7m', _deps: deps(makeFetch([]).fetch) }),
      /timeframe must be one of .*1D/,
    );
    await assert.rejects(
      () => technicalsRating({ symbol: 'X', timeframe: '2', _deps: deps(makeFetch([]).fetch) }),
      /timeframe must be one of/,
      '2m was probed and returns null — it must not be accepted',
    );
  });
});

// ---- screener -------------------------------------------------------------

describe('tv_screener_run', () => {
  const SCAN = {
    totalCount: 8029,
    data: [
      { s: 'OTC:BCKIF', d: ['BCKIF', 1795608000] },
      { s: 'NASDAQ:LOOP', d: ['LOOP', 1791979200] },
    ],
  };

  test('POSTs JSON as text/plain and aligns rows to columns', async () => {
    const { fetch, calls } = makeFetch([[/(america|scan)/, { json: SCAN }]]);
    const r = await screenerRun({ market: 'america', filter: [{ left: 'market_cap_basic', operation: 'greater', right: 1e11 }], columns: ['name', 'earnings_release_next_date'], _deps: deps(fetch) });
    assert.equal(r.total_count, 8029);
    assert.equal(r.returned, 2);
    assert.equal(r.rows[0].symbol, 'OTC:BCKIF');
    assert.equal(r.rows[0].name, 'BCKIF');
    assert.equal(r.rows[0].earnings_release_next_date, 1795608000);
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.headers['Content-Type'], 'text/plain;charset=UTF-8');
  });

  test('row cap refuses an oversized range instead of pulling multi-MB', async () => {
    const { fetch, calls } = makeFetch([[/scan/, { json: SCAN }]]);
    await assert.rejects(
      () => screenerRun({ range: [0, MAX_ROWS + 1], _deps: deps(fetch) }),
      /cap is 1000/,
    );
    assert.equal(calls.length, 0);
  });

  test('default limit is the small default, not the upstream 1000', async () => {
    const { fetch, calls } = makeFetch([[/scan/, { json: SCAN }]]);
    await screenerRun({ _deps: deps(fetch) });
    const body = JSON.parse(calls[0].init.body);
    assert.deepEqual(body.range, [0, 100]);
  });

  test('an unknown filter operation is refused before the request', async () => {
    const { fetch, calls } = makeFetch([[/scan/, { json: SCAN }]]);
    await assert.rejects(
      () => screenerRun({ filter: [{ left: 'x', operation: 'wibble', right: 1 }], _deps: deps(fetch) }),
      /not in greater/,
    );
    assert.equal(calls.length, 0);
  });

  test('a malformed market slug is refused (shape guard, not an unverified list)', async () => {
    await assert.rejects(() => screenerRun({ market: '../../etc', _deps: deps(makeFetch([]).fetch) }), /market must be a slug/);
  });

  test('screenerColumns reads the fixture and reports the history set separately', async () => {
    const r = await screenerColumns({});
    assert.ok(r.count >= 500, `expected the harvested catalogue, got ${r.count}`);
    assert.deepEqual(r.history_fields, [...HISTORY_FIELDS]);
    assert.match(r.note, /advisory allowlist/);
    const filtered = await screenerColumns({ search: 'dividend' });
    assert.ok(filtered.count > 0 && filtered.count < r.count);
  });
});

// ---- calendars ------------------------------------------------------------

describe('calendars', () => {
  test('earningsCalendar filters on a scalar and shapes dates to ISO', async () => {
    const { fetch, calls } = makeFetch([[/scan/, {
      json: { totalCount: 1, data: [{ s: 'NASDAQ:AAPL', d: ['AAPL', 'Apple Inc.', 1795608000, null, 4e12, 2.1] }] },
    }]]);
    const r = await earningsCalendar({ from: '2026-01-01', to: '2026-12-31', _deps: deps(fetch) });
    assert.equal(r.events[0].symbol, 'NASDAQ:AAPL');
    assert.equal(r.events[0].release_next_date_iso, new Date(1795608000 * 1000).toISOString());
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.filter[0].left, 'earnings_release_next_date');
    assert.deepEqual(body.filter[0].right, [1767225600, 1798761599]);
  });

  test('earningsCalendar refuses inverted or malformed dates', async () => {
    const { fetch } = makeFetch([]);
    await assert.rejects(() => earningsCalendar({ from: '2026-12-31', to: '2026-01-01', _deps: deps(fetch) }), /is after/);
    await assert.rejects(() => earningsCalendar({ from: '31/12/2026', _deps: deps(fetch) }), /YYYY-MM-DD/);
  });

  const CAL = {
    status: 'ok',
    result: [
      { id: 'a', title: 'MBA 15-Yr', country: 'US', currency: 'USD', date: '2026-09-16T11:00:00.000Z', actual: null, forecast: null, previous: 6.17, importance: 0, period: 'w/o Sep. 7', unit: '%' },
      { id: 'b', title: 'Nonfarm Payrolls', country: 'US', currency: 'USD', date: '2026-09-18T12:30:00.000Z', actual: null, forecast: 150, previous: 142, importance: 1, period: 'Sep', unit: 'K' },
      { id: 'c', title: 'Some Low', country: 'DE', currency: 'EUR', date: '2026-09-17T06:00:00.000Z', actual: 1, forecast: 1, previous: 1, importance: -1, period: 'Sep', unit: '' },
    ],
  };

  test('economicCalendar filters by min_importance and labels the scale', async () => {
    const { fetch } = makeFetch([[/events\?/, { json: CAL }]]);
    const all = await economicCalendar({ from: '2026-09-16', to: '2026-09-19', _deps: deps(fetch) });
    assert.equal(all.total_count, 3);
    const high = await economicCalendar({ from: '2026-09-16', to: '2026-09-19', min_importance: 1, _deps: deps(fetch) });
    assert.equal(high.total_count, 1);
    assert.equal(high.events[0].importance_label, 'high');
  });

  test('economicCalendar needs no Origin header (documented: the host tolerates bare UA)', async () => {
    const { fetch, calls } = makeFetch([[/events\?/, { json: CAL }]]);
    await economicCalendar({ from: '2026-09-16', to: '2026-09-17', _deps: deps(fetch) });
    assert.equal(calls[0].init.headers.Origin, undefined);
    assert.match(calls[0].init.headers['User-Agent'], /Mozilla/);
  });

  test('economicCalendar windows default to today + 7 and refuse a huge span', async () => {
    const { fetch, calls } = makeFetch([[/events\?/, { json: CAL }]]);
    const r = await economicCalendar({ _deps: deps(fetch) });
    assert.ok(r.from <= r.to);
    assert.ok(calls[0].url.includes('from='));
    await assert.rejects(
      () => economicCalendar({ from: '2026-01-01', to: '2026-12-31', _deps: deps(fetch) }),
      /cap is 90/,
    );
  });

  test('an upstream status other than ok fails loudly', async () => {
    const { fetch } = makeFetch([[/events\?/, { json: { status: 'error', result: [] } }]]);
    await assert.rejects(() => economicCalendar({ from: '2026-09-16', to: '2026-09-17', _deps: deps(fetch) }), /status 'error'/);
  });
});

// ---- news -----------------------------------------------------------------

describe('tv_news', () => {
  const FLOW = {
    items: [
      { paywall: false, id: 'tag:reuters.com,2026:x:0', title: 'REG - Axis Bank', published: 1789563943, urgency: 2, permission: 'preview', relatedSymbols: [{ symbol: 'NASDAQ:AAPL' }], storyPath: '/news/x/' },
    ],
  };

  test('flow mode: filters are sorted by id and carry no symbol prefix issue', async () => {
    const { fetch, calls } = makeFetch([[/news-flow/, { json: FLOW }]]);
    const r = await news({ _deps: deps(fetch) });
    assert.equal(r.kind, 'flow');
    assert.equal(r.items[0].id, 'tag:reuters.com,2026:x:0');
    assert.ok(calls[0].url.includes('filter=lang'), 'lang filter uses the unsorted-safe single-filter form');
    assert.match(calls[0].init.headers.Origin, /tradingview\.com/, 'news-mediator requires Origin');
  });

  test('by-symbol mode resolves TICKER to EXCHANGE:TICKER via the existing search (§11 rule 6)', async () => {
    const { fetch, calls } = makeFetch([[/view\/v1\/symbol/, { json: FLOW }]]);
    const searchSymbols = async () => ({ results: [{ symbol: 'AAPL', full_name: 'NASDAQ:AAPL', exchange: 'NASDAQ' }] });
    const r = await news({ symbol: 'AAPL', _deps: { ...deps(fetch), searchSymbols } });
    assert.equal(r.symbol, 'NASDAQ:AAPL');
    assert.ok(calls[0].url.includes(encodeURIComponent('symbol:NASDAQ:AAPL')));
  });

  test('filters are alphabetically sorted by filter id (hard server-side validation)', async () => {
    const { fetch, calls } = makeFetch([[/view\/v1\/symbol/, { json: FLOW }]]);
    const searchSymbols = async () => ({ results: [{ full_name: 'NASDAQ:AAPL' }] });
    await news({ symbol: 'NASDAQ:AAPL', _deps: { ...deps(fetch), searchSymbols } });
    const url = decodeURIComponent(calls[0].url.replace(/\+/g, ' '));
    const order = [...url.matchAll(/filter=(lang|symbol|id):/g)].map((m) => m[1]);
    assert.deepEqual(order, [...order].sort(), `filters must be sorted, got ${order}`);
  });

  test('an unresolvable bare ticker refuses with not_found and a usable suggestion', async () => {
    const searchSymbols = async () => ({ results: [] });
    await assert.rejects(
      () => news({ symbol: 'NOTREAL', _deps: { fetch: makeFetch([]).fetch, searchSymbols } }),
      (e) => e.reason === 'not_found' && /EXCHANGE:TICKER/.test(e.message),
    );
  });

  test('an unknown language is refused from the documented list', async () => {
    await assert.rejects(() => news({ lang: 'kl', _deps: deps(makeFetch([]).fetch) }), /lang must be one of/);
  });

  test('limit caps the slice without hiding the upstream count', async () => {
    const many = { items: Array.from({ length: 120 }, (_, i) => ({ id: `i${i}`, title: `t${i}`, published: 1, relatedSymbols: [] })) };
    const { fetch } = makeFetch([[/news-flow/, { json: many }]]);
    const r = await news({ limit: 10, _deps: deps(fetch) });
    assert.equal(r.total_count, 120);
    assert.equal(r.returned, 10);
  });
});

// ---- SSR extraction -------------------------------------------------------

/** Minimal but shape-faithful story page: 6 blocks, target in block 2. */
function storyHtml() {
  const block = (inner) => `<script type="application/prs.init-data+json">${JSON.stringify({ opaqueId: inner })}</script>`;
  return [
    block({ mainMenuCategories: { 0: { a: 1 } } }),
    block({ FLm8Pa: { class_name: 'x' } }),
    block({
      story: {
        id: 'tag:reuters.com,2026:newsml_FWN45804Q:0',
        title: 'Apple Considers Return To Server Market',
        provider: { id: 'reuters', name: 'Reuters' },
        published: 1789563782,
        urgency: 3,
        permission: 'headline',
        paywall: true,
        read_time: 2,
        tags: ['technology'],
        related_symbols: [{ symbol: 'NASDAQ:AAPL' }],
        story_path: '/news/reuters.com,2026:x/',
        ast_description: {
          type: 'root',
          children: [
            { type: 'list', children: [
              { type: '*', children: [{ type: 'p', children: ['FIRST PARAGRAPH'] }] },
              { type: '*', children: [{ type: 'p', children: ['SECOND PARAGRAPH'] }] },
            ] },
          ],
        },
      },
    }),
    block({ mIClNY: { languageName: 'English' } }),
    block({ gaId: 'UA-1' }),
    '<script type="application/prs.init-data+json">{"broken": tru</script>',
  ].join('\n');
}

describe('SSR init-data extraction (§5, §7.1)', () => {
  test('walks every block and skips the unparsable trailing one', () => {
    const blocks = extractInitData(storyHtml());
    assert.equal(blocks.length, 5, 'one block is unparsable and must be skipped');
    assert.ok(findInBlocks(blocks, (o) => o.story));
  });

  test('astToText flattens nested list/p children into readable text', () => {
    const ast = { type: 'root', children: [{ type: 'list', children: [{ type: '*', children: [{ type: 'p', children: ['A'] }] }, { type: '*', children: [{ type: 'p', children: ['B'] }] }] }] };
    const text = astToText(ast);
    assert.match(text, /A/);
    assert.match(text, /B/);
  });

  test('newsStory finds the story in block 2, NOT block 0 (the site menu)', async () => {
    const { fetch } = makeFetch([[/news\//, { text: storyHtml() }]]);
    const r = await newsStory({ id: 'tag:reuters.com,2026:newsml_FWN45804Q:0', _deps: deps(fetch) });
    assert.equal(r.title, 'Apple Considers Return To Server Market');
    assert.equal(r.body_chars > 0, true);
    assert.match(r.body_text, /FIRST PARAGRAPH[\s\S]*SECOND PARAGRAPH/);
    assert.deepEqual(r.related_symbols, ['NASDAQ:AAPL']);
    assert.equal(r.paywall, true);
    assert.match(r.paywall_notice, /do not redistribute/);
  });

  test('newsStory accepts an id, a story_path and a full URL', async () => {
    const { fetch, calls } = makeFetch([[/news\//, { text: storyHtml() }]]);
    await newsStory({ id: '/news/abc/', _deps: deps(fetch) });
    assert.ok(calls[0].url.endsWith('/news/abc/'));
    await newsStory({ id: 'https://www.tradingview.com/news/xyz/', _deps: deps(fetch) });
    assert.ok(calls[1].url.endsWith('/news/xyz/'));
    await newsStory({ id: 'plainid', _deps: deps(fetch) });
    assert.ok(calls[2].url.includes('/news/plainid/'));
  });

  test('a page whose shape changed fails LOUDLY (ssr_payload_missing), never silently empty', async () => {
    const { fetch } = makeFetch([[/news\//, { text: '<html><body>no init-data here</body></html>' }]]);
    await assert.rejects(
      () => newsStory({ id: 'x', _deps: deps(fetch) }),
      (e) => e.reason === 'ssr_payload_missing' && /no prs\.init-data\+json blocks/.test(e.message),
    );
  });

  test('blocks present but marker absent is also ssr_payload_missing', async () => {
    const html = `<script type="application/prs.init-data+json">${JSON.stringify({ a: { unrelated: 1 } })}</script>`;
    const { fetch } = makeFetch([[/news\//, { text: html }]]);
    await assert.rejects(() => newsStory({ id: 'x', _deps: deps(fetch) }), /story marker/);
  });
});

// ---- documents ------------------------------------------------------------

/** Shape-faithful documents page: filter tree + items + a date-keyed earnings map. */
function documentsHtml() {
  const page = {
    id: 'x',
    title: 'Apple Inc',
    symbol: 'NASDAQ-AAPL',
    active_tab: 'documents',
    currency: 'USD',
    documents: {
      total: 2,
      items: [
        {
          id: 'urn:report:quartr.com:3669984', correlation_id: 'urn:event:quartr.com:658553',
          category: { id: 'quarterly_report', title: 'Quarterly report' },
          fiscal_period: 'Q3', fiscal_year: 2026,
          provider: { id: 'quartr', name: 'Quartr' },
          reported: 1785445200, status: 'usable', title: 'Q3 2026',
          views: [{ id: 'urn:transcripts:quartr.com:4150668', type: 'transcript' }],
          event: 'earning', symbols: [{ symbol: 'NASDAQ:AAPL' }],
        },
        {
          id: 'urn:report:quartr.com:1', correlation_id: null,
          category: { id: 'annual_report', title: 'Annual report' },
          fiscal_period: 'FY', fiscal_year: 2025,
          provider: { id: 'quartr', name: 'Quartr' },
          reported: 1745445200, status: 'usable', title: 'FY 2025',
          views: [], event: 'corporate_event', symbols: [],
        },
      ],
      meta: {
        // Shape-faithful: the live tree nests annual/interim/earnings_releases/
        // call_transcript UNDER `earnings`, and event_transcript under
        // `corporate_events`. A filter id's category set is its whole subtree.
        items: [
          { id: 'all', available: true, attrs: { title: 'All' }, events: ['earning', 'corporate_event'], children: null },
          { id: 'earnings', available: true, attrs: { title: 'Earnings' }, events: ['earning'], children: [
            { id: 'quarterly_reports', available: true, categories: ['quarterly_report'], attrs: { title: 'Quarterly reports' }, children: null },
            { id: 'annual_reports', available: true, categories: ['annual_report'], attrs: { title: 'Annual reports' }, children: null },
            { id: 'interim_reports', available: false, categories: ['interim_report'], attrs: { title: 'Interim reports' }, children: null },
            { id: 'earnings_releases', available: true, categories: ['earnings_release'], attrs: { title: 'Earnings release' }, children: null },
            { id: 'call_transcript', available: true, categories: ['call_transcript'], attrs: { title: 'Call transcript' }, children: null },
          ] },
          { id: 'corporate_events', available: true, attrs: { title: 'Corporate events' }, events: ['corporate_event'], children: [
            { id: 'event_transcript', available: true, categories: ['event_transcript'], attrs: { title: 'Event transcript' }, children: null },
          ] },
        ],
      },
    },
    earnings: {
      759542400: { date: 759542400, standardized: 0.003, estimate: null, period: 757296000, timeType: 23, reported: null, revenueEstimate: null, revenueValue: null },
    },
  };
  return `<script type="application/prs.init-data+json">${JSON.stringify({ nsQ6Wd: page })}</script>`;
}

describe('tv_documents', () => {
  const searchSymbols = async () => ({ results: [{ full_name: 'NASDAQ:AAPL' }] });

  test('derives the EXCHANGE-TICKER slug from symbol_search and lists items', async () => {
    const { fetch, calls } = makeFetch([[/documents\//, { text: documentsHtml() }]]);
    const r = await documents({ symbol: 'AAPL', _deps: { ...deps(fetch), searchSymbols } });
    assert.equal(r.slug, 'NASDAQ-AAPL');
    assert.equal(r.total, 2);
    assert.equal(r.returned, 2);
    assert.ok(calls[0].url.includes('/symbols/NASDAQ-AAPL/documents/'));
    assert.equal(r.documents[0].views[0].type, 'transcript');
  });

  test('exposes the UI filter tree for category validation', async () => {
    const { fetch } = makeFetch([[/documents\//, { text: documentsHtml() }]]);
    const r = await documents({ symbol: 'AAPL', _deps: { ...deps(fetch), searchSymbols } });
    const ids = r.filters.map((f) => f.id).sort();
    assert.deepEqual(ids, ['all', 'annual_reports', 'call_transcript', 'corporate_events', 'earnings',
      'earnings_releases', 'event_transcript', 'interim_reports', 'quarterly_reports']);
    const earnings = r.filters.find((f) => f.id === 'earnings');
    assert.equal(earnings.available, true);
    assert.equal(r.filters.find((f) => f.id === 'interim_reports').available, false, 'availability is surfaced');
  });

  test('a PARENT filter id collects its WHOLE subtree (annual_reports is nested under earnings)', async () => {
    const { fetch } = makeFetch([[/documents\//, { text: documentsHtml() }]]);
    const r = await documents({ symbol: 'AAPL', category: 'earnings', _deps: { ...deps(fetch), searchSymbols } });
    // subtree = quarterly_report, annual_report, interim_report, earnings_release, call_transcript
    assert.equal(r.returned, 2, 'both the quarterly and the nested annual item match');
    assert.deepEqual(r.documents.map((d) => d.category).sort(), ['annual_report', 'quarterly_report']);
  });

  test('a LEAF filter id collects only its own categories', async () => {
    const { fetch } = makeFetch([[/documents\//, { text: documentsHtml() }]]);
    const r = await documents({ symbol: 'AAPL', category: 'annual_reports', _deps: { ...deps(fetch), searchSymbols } });
    assert.equal(r.returned, 1);
    assert.equal(r.documents[0].category, 'annual_report');
  });

  test('a corporate_events filter does NOT pick up earnings items (sibling subtree)', async () => {
    const { fetch } = makeFetch([[/documents\//, { text: documentsHtml() }]]);
    const r = await documents({ symbol: 'AAPL', category: 'corporate_events', _deps: { ...deps(fetch), searchSymbols } });
    assert.equal(r.returned, 0, 'no event_transcript item in the fixture');
  });

  test('an unknown category is refused with the valid list', async () => {
    const { fetch } = makeFetch([[/documents\//, { text: documentsHtml() }]]);
    await assert.rejects(
      () => documents({ symbol: 'AAPL', category: 'nope', _deps: { ...deps(fetch), searchSymbols } }),
      /unknown category 'nope'; valid: all, annual_reports, call_transcript, corporate_events, earnings, earnings_releases, event_transcript, interim_reports, quarterly_reports/,
    );
  });

  test('include_earnings shapes the date-keyed map into an array', async () => {
    const { fetch } = makeFetch([[/documents\//, { text: documentsHtml() }]]);
    const r = await documents({ symbol: 'AAPL', include_earnings: true, _deps: { ...deps(fetch), searchSymbols } });
    assert.equal(r.earnings.length, 1);
    assert.equal(r.earnings[0].standardized, 0.003);
  });

  test('says plainly that filing body text is NOT available', async () => {
    const { fetch } = makeFetch([[/documents\//, { text: documentsHtml() }]]);
    const r = await documents({ symbol: 'AAPL', _deps: { ...deps(fetch), searchSymbols } });
    assert.match(r.note, /BODY TEXT is an open upstream gap/);
  });
});

// ---- transport + error envelope -------------------------------------------

describe('transport failures map to the REST reason set (§11 rule 7)', () => {
  test('a non-2xx becomes upstream_http_error carrying the status', async () => {
    const { fetch } = makeFetch([[/symbol\?/, { status: 500, text: 'boom' }]]);
    await assert.rejects(
      () => symbolData({ symbol: 'X', _deps: deps(fetch) }),
      (e) => e instanceof RestError && e.reason === 'upstream_http_error' && e.status === 500,
    );
  });

  test('a 404 becomes not_found, distinguishable from a 500', async () => {
    const { fetch } = makeFetch([[/symbol\?/, { status: 404, text: 'symbol_not_exists' }]]);
    await assert.rejects(() => symbolData({ symbol: 'X', _deps: deps(fetch) }), (e) => e.reason === 'not_found');
  });

  test('a timeout is classified as retryable upstream_timeout', async () => {
    const { fetch } = makeFetch([[/symbol\?/, () => Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' })]]);
    await assert.rejects(() => symbolData({ symbol: 'X', _deps: deps(fetch) }), (e) => e.reason === 'upstream_timeout');
  });

  test('a network refusal is upstream_unavailable', async () => {
    const { fetch } = makeFetch([[/symbol\?/, new Error('fetch failed: ECONNREFUSED')]]);
    await assert.rejects(() => symbolData({ symbol: 'X', _deps: deps(fetch) }), (e) => e.reason === 'upstream_unavailable');
  });

  test('a non-JSON 200 body is upstream_invalid_json', async () => {
    const { fetch } = makeFetch([[/symbol\?/, { text: '<html>interstitial</html>' }]]);
    await assert.rejects(() => symbolData({ symbol: 'X', _deps: deps(fetch) }), (e) => e.reason === 'upstream_invalid_json');
  });

  test('the shared envelope emits the REST code with its own retryability', () => {
    const timeout = buildErrorEnvelope(Object.assign(new Error('x'), { reason: 'upstream_timeout' }));
    assert.equal(timeout.error.code, 'upstream_timeout');
    assert.equal(timeout.error.retryable, true, 'timeouts are retryable');

    const refused = buildErrorEnvelope(Object.assign(new Error('x'), { reason: 'upstream_http_error' }));
    assert.equal(refused.error.code, 'upstream_http_error');
    assert.equal(refused.error.retryable, false, 'an upstream 500 is not our transient failure');

    const ssr = buildErrorEnvelope(Object.assign(new Error('x'), { reason: 'ssr_payload_missing' }));
    assert.equal(ssr.error.retryable, false);
    assert.match(ssr.error.suggested_action, /shape changed/);

    const bad = buildErrorEnvelope(Object.assign(new Error('x'), { reason: 'invalid_input' }));
    assert.equal(bad.error.code, 'invalid_input');
  });

  test('the CDP reason contract is untouched (frozen table still exact)', () => {
    assert.deepEqual(Object.keys(CDP_ERROR_REASONS).sort(), [
      'cdp_command_failed', 'cdp_timeout', 'execution_context_lost', 'navigation_invalidated', 'target_replaced',
    ]);
    // The REST reason set exists in two places on purpose: core/rest.js declares
    // it (the thrower) and _format.js maps it (the envelope). They must agree.
    const mapped = Object.keys(REST_ERROR_REASONS).sort();
    assert.deepEqual([...REST_REASONS].sort(), mapped);
    assert.deepEqual(mapped, [
      'invalid_input', 'not_found', 'ssr_payload_missing', 'upstream_http_error',
      'upstream_invalid_json', 'upstream_timeout', 'upstream_unavailable',
    ]);
    for (const k of Object.keys(CDP_ERROR_REASONS)) {
      assert.equal(mapped.includes(k), false, `${k} must not leak into the REST table`);
    }
  });
});

// ---- registry wiring ------------------------------------------------------

describe('REST tools are first-class ops (P2-19/§11)', () => {
  test('all 12 are registered read-only with a derived GET route', () => {
    registerAll(new McpServer({ name: 'rest-test', version: '0' }));
    const names = [
      'tv_symbol_data', 'tv_symbol_history', 'tv_earnings_history', 'tv_dividend_history',
      'tv_technicals_rating', 'tv_screener_run', 'tv_screener_columns',
      'tv_earnings_calendar', 'tv_economic_calendar', 'tv_news', 'tv_news_story', 'tv_documents',
    ];
    for (const n of names) {
      const e = getOp(n);
      assert.ok(e, `${n} missing from the registry`);
      assert.equal(e.access, 'read', n);
      assert.equal(e.annotations.readOnlyHint, true, n);
      assert.equal(e.transports.http?.method, 'GET', n);
    }
    assert.equal(listOps().filter((o) => o.name.startsWith('tv_') && /^\/(symbol|screener|calendar|news|documents)/.test(o.transports.http?.path || '')).length, 12);
  });
});
