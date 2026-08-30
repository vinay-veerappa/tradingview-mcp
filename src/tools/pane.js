import { z } from 'zod';
import { A } from './_annotations.js';
import { op } from './_registry.js';
import { toolFromRegistry } from './index.js';
import { jsonResult, errorResult } from './_format.js';
import * as core from '../core/pane.js';

export function registerPaneTools(server) {
  op('pane_list', 'List all chart panes in the current layout with their symbols and active state', {},
    A.READ, async () => {
      try { return jsonResult(await core.list()); }
      catch (err) { return errorResult(err); }
    });
  toolFromRegistry(server, 'pane_list');

  op('pane_set_layout', 'Change the chart grid layout (e.g., single, 2x2, 2h, 3v)', {
    layout: z.string().describe('Layout code: s (single), 2h, 2v, 2-1, 1-2, 3h, 3v, 4 (2x2), 6, 8. Also accepts: single, 2x1, 1x2, 2x2, quad'),
  },
    A.MUTATE_IDEMPOTENT, async ({ layout }) => {
      try { return jsonResult(await core.setLayout({ layout })); }
      catch (err) { return errorResult(err); }
    });
  toolFromRegistry(server, 'pane_set_layout');

  op('pane_focus', 'Focus a specific chart pane by index (0-based)', {
    index: z.coerce.number().describe('Pane index (0-based, from pane_list)'),
  },
    A.MUTATE_IDEMPOTENT, async ({ index }) => {
      try { return jsonResult(await core.focus({ index })); }
      catch (err) { return errorResult(err); }
    });
  toolFromRegistry(server, 'pane_focus');

  op('pane_set_symbol', 'Set the symbol on a specific pane by index', {
    index: z.coerce.number().describe('Pane index (0-based)'),
    symbol: z.string().describe('Symbol to set (e.g., NQ1!, ES1!, AAPL)'),
  },
    A.MUTATE_ORDER, async ({ index, symbol }) => {
      try { return jsonResult(await core.setSymbol({ index, symbol })); }
      catch (err) { return errorResult(err); }
    });
  toolFromRegistry(server, 'pane_set_symbol');
}