/**
 * REST data surface tools (docs/REST_DATA_SURFACES.md §11).
 *
 * Chart-independent market/reference data over public cookie-less HTTP — no
 * desktop app, no chart, no login. Twelve read-only ops, one core module
 * (core/rest.js), each with a derived GET binding so the loopback gateway
 * serves the same surface (access 'read' is structural: op() refuses anything
 * else on an http binding, and httpRoutes() generates the route table).
 *
 * Why one tv_symbol_data rather than one tool per capability (§11
 * "Field-map design"): every /symbol capability is the same call with
 * different `fields`. Separate tools would duplicate the fetch, the headers,
 * the error envelope and the tests four-plus times. Groups cover the common
 * case; raw column names are the escape hatch to all 547 catalogue columns.
 *
 * Context budget: history is opt-in, screener rows are capped, news is
 * headline-only — the same compact-by-default rule as the chart tools.
 */

import { z } from 'zod';
import { A } from './_annotations.js';
import { op } from './_registry.js';
import { toolFromRegistry } from './index.js';
import { jsonResult, errorResult } from './_format.js';
import * as core from '../core/rest.js';

/** `?a,b,c` → ['a','b','c'] (gateway adapters only). */
const csv = (url, key) => {
  const raw = url.searchParams.get(key);
  if (raw == null) return undefined;
  const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return list.length ? list : undefined;
};

const num = (url, key) => {
  const raw = url.searchParams.get(key);
  if (raw == null || raw === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
};

const bool = (url, key) => {
  const raw = url.searchParams.get(key);
  return raw == null ? undefined : raw !== 'false';
};

export function registerRestTools(server) {
  // ── the /symbol workhorse ─────────────────────────────────────────────────

  op('tv_symbol_data',
    'Symbol data WITHOUT a chart or the desktop app (public HTTP): quote, technicals, fundamentals, forecasts, dividends, profile, earnings dates, multi-year history — one call. `fields` takes group names and raw screener columns mixed. Batch = one request per symbol; for many symbols in one request use tv_screener_run.',
    {
      symbol: z.string().optional().describe('Single symbol, e.g. NASDAQ:AAPL (EXCHANGE:TICKER preferred)'),
      symbols: z.array(z.string()).optional().describe('Batch: up to 50 symbols (one request each, concurrency-capped)'),
      fields: z.array(z.string()).optional().describe('Groups and/or raw column names, mixed. Groups: quote, technicals, fundamentals, forecasts, dividends, profile, earnings_dates, history. Default: quote'),
    },
    A.READ, async ({ symbol, symbols, fields }) => {
      try { return jsonResult(await core.symbolData({ symbol, symbols, fields })); }
      catch (err) { return errorResult(err); }
    }, {
      http: {
        path: '/symbol/data',
        adapter: (url, _deps) => core.symbolData({
          symbol: url.searchParams.get('symbol') || undefined,
          symbols: csv(url, 'symbols'),
          fields: csv(url, 'fields'),
          _deps,
        }),
      },
    });
  toolFromRegistry(server, 'tv_symbol_data');

  op('tv_symbol_history',
    'Multi-year financial history for one symbol: the 17 array-valued `_h` fields (revenue, income, assets, debt, cash flow, EPS, dividends), most-recent-first, plus fiscal-year labels that align the annual arrays. Stocks only — ETFs return null; zeros mean a real non-payer.',
    {
      symbol: z.string().describe('Symbol, e.g. NASDAQ:AAPL'),
      fields: z.array(z.string()).optional().describe(`Subset of the history fields. Known: ${core.HISTORY_FIELDS.join(', ')}`),
    },
    A.READ, async ({ symbol, fields }) => {
      try { return jsonResult(await core.symbolHistory({ symbol, fields })); }
      catch (err) { return errorResult(err); }
    }, {
      http: {
        path: '/symbol/history',
        adapter: (url, _deps) => core.symbolHistory({
          symbol: url.searchParams.get('symbol') || undefined,
          fields: csv(url, 'fields'),
          _deps,
        }),
      },
    });
  toolFromRegistry(server, 'tv_symbol_history');

  op('tv_earnings_history',
    'EPS history per period for one symbol: diluted annual + quarterly and basic annual, aligned to fiscal years. No earnings-surprise or per-quarter date fields exist upstream.',
    { symbol: z.string().describe('Symbol, e.g. NASDAQ:AAPL') },
    A.READ, async ({ symbol }) => {
      try { return jsonResult(await core.earningsHistory({ symbol })); }
      catch (err) { return errorResult(err); }
    }, {
      http: {
        path: '/symbol/earnings-history',
        adapter: (url, _deps) => core.earningsHistory({ symbol: url.searchParams.get('symbol') || undefined, _deps }),
      },
    });
  toolFromRegistry(server, 'tv_earnings_history');

  op('tv_dividend_history',
    '20 years of dividends per share for one symbol, plus current yield and payout ratio.',
    { symbol: z.string().describe('Symbol, e.g. NYSE:KO') },
    A.READ, async ({ symbol }) => {
      try { return jsonResult(await core.dividendHistory({ symbol })); }
      catch (err) { return errorResult(err); }
    }, {
      http: {
        path: '/symbol/dividend-history',
        adapter: (url, _deps) => core.dividendHistory({ symbol: url.searchParams.get('symbol') || undefined, _deps }),
      },
    });
  toolFromRegistry(server, 'tv_dividend_history');

  op('tv_technicals_rating',
    'TradingView technical rating for one symbol on a chosen timeframe: oscillator/MA summary plus RSI, Stoch, CCI, ADX, MACD, Mom, AO, EMAs, SMAs, VWMA, HullMA.',
    {
      symbol: z.string().describe('Symbol, e.g. NASDAQ:AAPL'),
      timeframe: z.string().optional().describe('1, 5, 15, 30, 60, 120, 240, 1D, 1W, 1M (default 60 = 1h)'),
    },
    A.READ, async ({ symbol, timeframe }) => {
      try { return jsonResult(await core.technicalsRating({ symbol, timeframe })); }
      catch (err) { return errorResult(err); }
    }, {
      http: {
        path: '/symbol/technicals',
        adapter: (url, _deps) => core.technicalsRating({
          symbol: url.searchParams.get('symbol') || undefined,
          timeframe: url.searchParams.get('timeframe') || undefined,
          _deps,
        }),
      },
    });
  toolFromRegistry(server, 'tv_technicals_rating');

  // ── screener ──────────────────────────────────────────────────────────────

  op('tv_screener_run',
    'Run the TradingView screener server-side: many symbols in ONE request with a free unpaged total_count, plus server-side filter and sort. Markets: america, crypto, forex, futures, bonds, cfd, uk, germany, india, japan. You cannot filter ON a history field — filter on a scalar and carry the `_h` column.',
    {
      market: z.string().optional().describe('Market slug (default america)'),
      filter: z.array(z.object({
        left: z.string(),
        operation: z.enum(core.FILTER_OPERATORS),
        right: z.union([z.string(), z.number(), z.array(z.number())]),
      })).optional().describe('Server-side filters, e.g. [{left:"market_cap_basic",operation:"greater",right:1e11}]'),
      columns: z.array(z.string()).optional().describe('Columns to return (groups and raw names both accepted)'),
      sort: z.object({ sortBy: z.string(), sortOrder: z.enum(['asc', 'desc']) }).optional(),
      range: z.array(z.number()).optional().describe('[offset, offset+limit] — not a limit'),
      limit: z.coerce.number().optional().describe(`Row count when no range given (default 100, cap ${core.MAX_ROWS})`),
    },
    A.READ, async ({ market, filter, columns, sort, range, limit }) => {
      try { return jsonResult(await core.screenerRun({ market, filter, columns, sort, range, limit })); }
      catch (err) { return errorResult(err); }
    }, {
      http: {
        path: '/screener',
        adapter: (url, _deps) => {
          const rawFilter = url.searchParams.get('filter');
          let filter;
          if (rawFilter) {
            try { filter = JSON.parse(rawFilter); }
            catch { throw Object.assign(new Error('filter must be JSON (or use POST semantics via MCP)'), { reason: 'invalid_input' }); }
          }
          const rawSort = url.searchParams.get('sort');
          let sort;
          if (rawSort) {
            const [sortBy, sortOrder] = rawSort.split(':');
            if (sortBy) sort = { sortBy, sortOrder: sortOrder === 'asc' ? 'asc' : 'desc' };
          }
          const rawRange = url.searchParams.get('range');
          return core.screenerRun({
            market: url.searchParams.get('market') || undefined,
            filter,
            columns: csv(url, 'columns'),
            sort,
            range: rawRange ? rawRange.split(',').map(Number) : undefined,
            limit: num(url, 'limit'),
            _deps,
          });
        },
      },
    });
  toolFromRegistry(server, 'tv_screener_run');

  op('tv_screener_columns',
    'The harvested screener column allowlist (547 accepted names) for discovery, plus the 17 history fields that actually return arrays. Advisory only.',
    { search: z.string().optional().describe('Substring filter (case-insensitive)') },
    A.READ, async ({ search }) => {
      try { return jsonResult(await core.screenerColumns({ search })); }
      catch (err) { return errorResult(err); }
    }, {
      http: {
        path: '/screener/columns',
        adapter: (url) => core.screenerColumns({ search: url.searchParams.get('search') || undefined }),
      },
    });
  toolFromRegistry(server, 'tv_screener_columns');

  // ── calendars ─────────────────────────────────────────────────────────────

  op('tv_earnings_calendar',
    'Bulk earnings calendar for a market: every symbol with a release in the date window, one request. Omit dates for the whole set.',
    {
      from: z.string().optional().describe('YYYY-MM-DD (default: all past and future)'),
      to: z.string().optional().describe('YYYY-MM-DD (default: all past and future)'),
      market: z.string().optional().describe('Market slug (default america)'),
      limit: z.coerce.number().optional().describe(`Max rows (default 100, cap ${core.MAX_ROWS})`),
    },
    A.READ, async ({ from, to, market, limit }) => {
      try { return jsonResult(await core.earningsCalendar({ from, to, market, limit })); }
      catch (err) { return errorResult(err); }
    }, {
      http: {
        path: '/calendar/earnings',
        adapter: (url, _deps) => core.earningsCalendar({
          from: url.searchParams.get('from') || undefined,
          to: url.searchParams.get('to') || undefined,
          market: url.searchParams.get('market') || undefined,
          limit: num(url, 'limit'),
          _deps,
        }),
      },
    });
  toolFromRegistry(server, 'tv_earnings_calendar');

  op('tv_economic_calendar',
    'Macro economic calendar (actual / forecast / previous) for a date window and country list — no chart needed. `min_importance`: -1 low, 0 medium, 1 high. Forward-looking.',
    {
      from: z.string().optional().describe('YYYY-MM-DD (default: today)'),
      to: z.string().optional().describe('YYYY-MM-DD (default: from + 7 days)'),
      countries: z.array(z.string()).optional().describe('ISO-2 country codes, e.g. ["US","EU"] — omit for all'),
      min_importance: z.coerce.number().optional().describe('-1 low, 0 medium, 1 high'),
      limit: z.coerce.number().optional().describe('Max events (default 100, cap 1000)'),
    },
    A.READ, async ({ from, to, countries, min_importance, limit }) => {
      try { return jsonResult(await core.economicCalendar({ from, to, countries, min_importance, limit })); }
      catch (err) { return errorResult(err); }
    }, {
      http: {
        path: '/calendar/economic',
        adapter: (url, _deps) => core.economicCalendar({
          from: url.searchParams.get('from') || undefined,
          to: url.searchParams.get('to') || undefined,
          countries: csv(url, 'countries'),
          min_importance: num(url, 'min_importance'),
          limit: num(url, 'limit'),
          _deps,
        }),
      },
    });
  toolFromRegistry(server, 'tv_economic_calendar');

  // ── news ──────────────────────────────────────────────────────────────────

  op('tv_news',
    'News headlines without a chart: per-symbol when `symbol` is given (exchange resolved automatically), otherwise the general market flow. Headlines only — pass the returned `id` to tv_news_story for text.',
    {
      symbol: z.string().optional().describe('Symbol for per-symbol headlines; omit for the general flow'),
      lang: z.string().optional().describe('Language code (default en)'),
      limit: z.coerce.number().optional().describe('Max items (default 50, cap 200)'),
    },
    A.READ, async ({ symbol, lang, limit }) => {
      try { return jsonResult(await core.news({ symbol, lang, limit })); }
      catch (err) { return errorResult(err); }
    }, {
      http: {
        path: '/news',
        adapter: (url, _deps) => core.news({
          symbol: url.searchParams.get('symbol') || undefined,
          lang: url.searchParams.get('lang') || undefined,
          limit: num(url, 'limit'),
          _deps,
        }),
      },
    });
  toolFromRegistry(server, 'tv_news');

  op('tv_news_story',
    'Full text of a news story by id (or a story_path from tv_news). Honours provider paywall/permission markers. Fails loudly (ssr_payload_missing) if the page shape changes.',
    {
      id: z.string().describe('Story id (e.g. "tag:reuters.com,2026:newsml_...") or a /news/... story_path'),
      include_ast: z.coerce.boolean().optional().describe('Also return the raw description AST'),
    },
    A.READ, async ({ id, include_ast }) => {
      try { return jsonResult(await core.newsStory({ id, include_ast })); }
      catch (err) { return errorResult(err); }
    }, {
      http: {
        path: '/news/story',
        adapter: (url, _deps) => core.newsStory({
          id: url.searchParams.get('id') || undefined,
          include_ast: bool(url, 'include_ast'),
          _deps,
        }),
      },
    });
  toolFromRegistry(server, 'tv_news_story');

  op('tv_documents',
    'Filings, reports and transcripts list for one symbol (no paging — the whole set ships in the page), with the UI filter tree, dates, categories and view ids. Optional earnings history from the same page. Filing BODY TEXT is an open upstream gap — list/dates/categories only.',
    {
      symbol: z.string().describe('Symbol; the exchange is resolved automatically (the slug is EXCHANGE-TICKER)'),
      category: z.string().optional().describe('Filter id from the returned `filters` (e.g. earnings, quarterly_reports, annual_reports)'),
      limit: z.coerce.number().optional().describe('Max documents (default: all)'),
      include_earnings: z.coerce.boolean().optional().describe('Also return the page earnings history (date-keyed upstream)'),
    },
    A.READ, async ({ symbol, category, limit, include_earnings }) => {
      try { return jsonResult(await core.documents({ symbol, category, limit, include_earnings })); }
      catch (err) { return errorResult(err); }
    }, {
      http: {
        path: '/documents',
        adapter: (url, _deps) => core.documents({
          symbol: url.searchParams.get('symbol') || undefined,
          category: url.searchParams.get('category') || undefined,
          limit: num(url, 'limit'),
          include_earnings: bool(url, 'include_earnings'),
          _deps,
        }),
      },
    });
  toolFromRegistry(server, 'tv_documents');
}
