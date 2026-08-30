import { z } from 'zod';
import { A } from './_annotations.js';
import { op } from './_registry.js';
import { toolFromRegistry } from './index.js';
import { jsonResult, errorResult } from './_format.js';
import * as core from '../core/data.js';

export function registerDataTools(server) {
  op('data_get_ohlcv', 'Get OHLCV bar data from the chart. Use summary=true for compact stats instead of all bars (saves context).', {
    count: z.coerce.number().optional().describe('Number of bars to retrieve (max 500, default 100)'),
    summary: z.coerce.boolean().optional().describe('Return summary stats (high, low, open, close, avg volume, range) instead of all bars — much smaller output'),
  },
    A.READ, async ({ count, summary }) => {
      try { return jsonResult(await core.getOhlcv({ count, summary })); }
      catch (err) { return errorResult(err); }
    }, { http: { path: '/ohlcv', adapter: (url, _deps) => core.getOhlcv({
      count: url.searchParams.get('count') ? Number(url.searchParams.get('count')) : undefined,
      summary: url.searchParams.get('summary') != null ? url.searchParams.get('summary') !== 'false' : undefined,
      _deps,
    }) } });
  toolFromRegistry(server, 'data_get_ohlcv');

  op('data_get_indicator', 'Get indicator/study info and input values', {
    entity_id: z.string().describe('Study entity ID (from chart_get_state)'),
  },
    A.READ, async ({ entity_id }) => {
      try { return jsonResult(await core.getIndicator({ entity_id })); }
      catch (err) { return errorResult(err); }
    });
  toolFromRegistry(server, 'data_get_indicator');

  op('data_get_strategy_results', 'Get strategy performance metrics from Strategy Tester. Auto-opens the panel and auto-unhides a hidden strategy (TradingView never computes reports for hidden strategies); result includes unhidden_strategies when that happened.', {},
    A.READ, async () => {
      try { return jsonResult(await core.getStrategyResults()); }
      catch (err) { return errorResult(err); }
    });
  toolFromRegistry(server, 'data_get_strategy_results');

  op('data_get_trades', 'Get trade list from Strategy Tester. Auto-opens the panel and auto-unhides a hidden strategy.', {
    max_trades: z.coerce.number().optional().describe('Maximum trades to return'),
  },
    A.READ, async ({ max_trades }) => {
      try { return jsonResult(await core.getTrades({ max_trades })); }
      catch (err) { return errorResult(err); }
    });
  toolFromRegistry(server, 'data_get_trades');

  op('data_get_equity', 'Get equity curve data from Strategy Tester', {},
    A.READ, async () => {
      try { return jsonResult(await core.getEquity()); }
      catch (err) { return errorResult(err); }
    });
  toolFromRegistry(server, 'data_get_equity');

  op('quote_get', 'Get real-time quote data for a symbol (price, OHLC, volume). If symbol is provided and differs from the current chart, the chart is briefly switched to fetch the quote and then restored — adds ~1-2s and serializes parallel calls.', {
    symbol: z.string().optional().describe('Symbol to quote (blank = current chart symbol). Non-blank values cause a chart switch + restore.'),
  },
    A.READ, async ({ symbol }) => {
      try { return jsonResult(await core.getQuote({ symbol })); }
      catch (err) { return errorResult(err); }
    }, { http: { path: '/quote', adapter: (url, _deps) => core.getQuote({ symbol: url.searchParams.get('symbol') || undefined, _deps }) } });
  toolFromRegistry(server, 'quote_get');

  op('depth_get', 'Get order book / DOM (Depth of Market) data from the chart', {},
    A.READ, async () => {
      try { return jsonResult(await core.getDepth()); }
      catch (err) { return errorResult(err, { suggested: 'Open the DOM panel in TradingView before using this tool.' }); }
    });
  toolFromRegistry(server, 'depth_get');

  op('data_get_pine_lines', 'Read horizontal price levels drawn by Pine Script indicators (line.new). Returns deduplicated price levels per study. Use study_filter to target a specific indicator.', {
    study_filter: z.string().optional().describe('Substring to match study name (e.g., "Profiler", "NY Levels"). Omit for all.'),
    verbose: z.coerce.boolean().optional().describe('Return raw line data with IDs, coordinates, colors (default false — returns only unique price levels)'),
  },
    A.READ, async ({ study_filter, verbose }) => {
      try { return jsonResult(await core.getPineLines({ study_filter, verbose })); }
      catch (err) { return errorResult(err); }
    });
  toolFromRegistry(server, 'data_get_pine_lines');

  op('data_get_pine_labels', 'Read text labels drawn by Pine Script indicators (label.new). Returns text and price pairs. Use study_filter to target a specific indicator.', {
    study_filter: z.string().optional().describe('Substring to match study name. Omit for all.'),
    max_labels: z.coerce.number().optional().describe('Max labels per study (default 50). Set higher if you need all.'),
    verbose: z.coerce.boolean().optional().describe('Return raw label data with IDs, colors, positions (default false — returns only text + price)'),
  },
    A.READ, async ({ study_filter, max_labels, verbose }) => {
      try { return jsonResult(await core.getPineLabels({ study_filter, max_labels, verbose })); }
      catch (err) { return errorResult(err); }
    });
  toolFromRegistry(server, 'data_get_pine_labels');

  op('data_get_pine_tables', 'Read table data drawn by Pine Script indicators (table.new). Returns formatted text rows per table. Use study_filter to target a specific indicator.', {
    study_filter: z.string().optional().describe('Substring to match study name. Omit for all.'),
  },
    A.READ, async ({ study_filter }) => {
      try { return jsonResult(await core.getPineTables({ study_filter })); }
      catch (err) { return errorResult(err); }
    });
  toolFromRegistry(server, 'data_get_pine_tables');

  op('data_get_pine_boxes', 'Read box/zone boundaries drawn by Pine Script indicators (box.new). Returns deduplicated {high, low} price zones. Use study_filter to target a specific indicator.', {
    study_filter: z.string().optional().describe('Substring to match study name. Omit for all.'),
    verbose: z.coerce.boolean().optional().describe('Return all boxes with IDs and coordinates (default false — returns unique price zones)'),
  },
    A.READ, async ({ study_filter, verbose }) => {
      try { return jsonResult(await core.getPineBoxes({ study_filter, verbose })); }
      catch (err) { return errorResult(err); }
    });
  toolFromRegistry(server, 'data_get_pine_boxes');

  op('data_get_study_values', 'Get current indicator values from the data window for all visible studies (RSI, MACD, Bollinger Bands, EMAs, custom indicators with plot()).', {},
    A.READ, async () => {
      try { return jsonResult(await core.getStudyValues()); }
      catch (err) { return errorResult(err); }
    }, { http: { path: '/values', adapter: () => core.getStudyValues() } });
  toolFromRegistry(server, 'data_get_study_values');
}