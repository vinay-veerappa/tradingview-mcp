import { z } from 'zod';
import { A } from './_annotations.js';
import { op } from './_registry.js';
import { toolFromRegistry } from './index.js';
import { jsonResult, errorResult } from './_format.js';
import * as core from '../core/chart.js';

export function registerChartTools(server) {
  op('chart_get_state', 'Get current chart state (symbol, timeframe, chart type, indicators)', {},
    A.READ, async () => {
      try { return jsonResult(await core.getState()); }
      catch (err) { return errorResult(err); }
    }, { http: { path: '/state', adapter: (_url, _deps) => core.getState({ _deps }) } });
  toolFromRegistry(server, 'chart_get_state');

  op('chart_set_symbol', 'Change the chart symbol', {
    symbol: z.string().describe('Symbol to set (e.g., BTCUSD, AAPL, ES1!, NYMEX:CL1!)'),
  },
    A.MUTATE_IDEMPOTENT, async ({ symbol }) => {
      try { return jsonResult(await core.setSymbol({ symbol })); }
      catch (err) { return errorResult(err); }
    });
  toolFromRegistry(server, 'chart_set_symbol');

  op('chart_set_timeframe', 'Change the chart timeframe/resolution', {
    timeframe: z.string().describe('Timeframe (e.g., 1, 5, 15, 60, D, W, M)'),
  },
    A.MUTATE_IDEMPOTENT, async ({ timeframe }) => {
      try { return jsonResult(await core.setTimeframe({ timeframe })); }
      catch (err) { return errorResult(err); }
    });
  toolFromRegistry(server, 'chart_set_timeframe');

  op('chart_set_type', 'Change chart type', {
    chart_type: z.string().describe('Chart type: Bars(0), Candles(1), Line(2), Area(3), Renko(4), Kagi(5), PointAndFigure(6), LineBreak(7), HeikinAshi(8), HollowCandles(9) — pass name or number'),
  },
    A.MUTATE_IDEMPOTENT, async ({ chart_type }) => {
      try { return jsonResult(await core.setType({ chart_type })); }
      catch (err) { return errorResult(err); }
    });
  toolFromRegistry(server, 'chart_set_type');

  op('chart_manage_indicator', 'Add or remove an indicator/study on the chart', {
    action: z.enum(['add', 'remove']).describe('Action: add or remove'),
    indicator: z.string().optional().describe('Full indicator name (required for add): "Relative Strength Index", "MACD", "Volume", "Moving Average", "Bollinger Bands", "Moving Average Exponential". Short names like RSI/EMA do NOT work. Not needed for remove.'),
    entity_id: z.string().optional().describe('Entity ID (from chart_get_state). Required for remove.'),
    inputs: z.string().optional().describe('JSON string of input overrides for the indicator (e.g., \'{"length": 20}\')'),
  },
    A.MUTATE_IDEMPOTENT, async ({ action, indicator, entity_id, inputs }) => {
      try {
        if (action === 'add' && !indicator) throw new Error('indicator name is required for add action.');
        return jsonResult(await core.manageIndicator({ action, indicator, entity_id, inputs }));
      } catch (err) { return errorResult(err); }
    });
  toolFromRegistry(server, 'chart_manage_indicator');

  op('chart_get_visible_range', 'Get the visible date range (unix timestamps) and bars range on the chart', {},
    A.READ, async () => {
      try { return jsonResult(await core.getVisibleRange()); }
      catch (err) { return errorResult(err); }
    });
  toolFromRegistry(server, 'chart_get_visible_range');

  op('chart_set_visible_range', 'Zoom the chart to a specific date range (unix timestamps)', {
    from: z.coerce.number().describe('Start of range (unix timestamp in seconds)'),
    to: z.coerce.number().describe('End of range (unix timestamp in seconds)'),
  },
    A.MUTATE_IDEMPOTENT, async ({ from, to }) => {
      try { return jsonResult(await core.setVisibleRange({ from, to })); }
      catch (err) { return errorResult(err); }
    });
  toolFromRegistry(server, 'chart_set_visible_range');

  op('chart_scroll_to_date', 'Jump the chart view to center on a specific date', {
    date: z.string().describe('ISO date string (e.g., "2024-01-15") or unix timestamp as a string'),
  },
    A.MUTATE_IDEMPOTENT, async ({ date }) => {
      try { return jsonResult(await core.scrollToDate({ date })); }
      catch (err) { return errorResult(err); }
    });
  toolFromRegistry(server, 'chart_scroll_to_date');

  op('symbol_info', 'Get detailed metadata about the current symbol (name, exchange, type, description)', {},
    A.READ, async () => {
      try { return jsonResult(await core.symbolInfo()); }
      catch (err) { return errorResult(err); }
    });
  toolFromRegistry(server, 'symbol_info');

  op('symbol_search', 'Search for symbols by name or keyword', {
    query: z.string().describe('Search query (e.g., "AAPL", "crude oil", "ES")'),
    type: z.string().optional().describe('Filter by type (e.g., "stock", "futures", "crypto", "forex")'),
  },
    A.READ, async ({ query, type }) => {
      try { return jsonResult(await core.symbolSearch({ query, type })); }
      catch (err) { return errorResult(err); }
    });
  toolFromRegistry(server, 'symbol_search');
}