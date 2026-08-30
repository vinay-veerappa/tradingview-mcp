import { z } from 'zod';
import { A } from './_annotations.js';
import { op } from './_registry.js';
import { toolFromRegistry } from './index.js';
import { jsonResult, errorResult } from './_format.js';
import * as core from '../core/tab.js';

export function registerTabTools(server) {
  op('tab_list', 'List all open TradingView chart tabs', {},
    A.READ, async () => {
      try { return jsonResult(await core.list()); }
      catch (err) { return errorResult(err); }
    });
  toolFromRegistry(server, 'tab_list');

  op('tab_new', 'Open a new chart tab. Optionally pick what to load in it: layout "new" creates a named blank layout, or pass a saved layout name to open it.', {
    layout: z.string().optional().describe('"new" for a blank new layout, or a saved layout name (substring match). Omit to leave the tab on the layout picker.'),
    name: z.string().optional().describe('Name for the new layout (used with layout: "new"; default "New layout")'),
  },
    A.MUTATE_IDEMPOTENT, async ({ layout, name }) => {
      try { return jsonResult(await core.newTab({ layout, name })); }
      catch (err) { return errorResult(err); }
    });
  toolFromRegistry(server, 'tab_new');

  op('layout_new', 'Create a new named blank chart layout (opens in a new tab)', {
    name: z.string().optional().describe('Layout name (default "New layout")'),
  },
    A.MUTATE_IDEMPOTENT, async ({ name }) => {
      try { return jsonResult(await core.newTab({ layout: 'new', name })); }
      catch (err) { return errorResult(err); }
    });
  toolFromRegistry(server, 'layout_new');

  op('tab_close', 'Close the current chart tab', {},
    A.DESTRUCTIVE, async () => {
      try { return jsonResult(await core.closeTab()); }
      catch (err) { return errorResult(err); }
    });
  toolFromRegistry(server, 'tab_close');

  op('tab_switch', 'Switch to a chart tab by index', {
    index: z.coerce.number().describe('Tab index (0-based, from tab_list)'),
  },
    A.MUTATE_IDEMPOTENT, async ({ index }) => {
      try { return jsonResult(await core.switchTab({ index })); }
      catch (err) { return errorResult(err); }
    });
  toolFromRegistry(server, 'tab_switch');
}