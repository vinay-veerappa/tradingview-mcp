import { z } from 'zod';
import { A } from './_annotations.js';
import { op } from './_registry.js';
import { toolFromRegistry } from './index.js';
import { jsonResult, errorResult } from './_format.js';
import * as core from '../core/ui.js';

export function registerUiTools(server, { env = process.env, evaluate } = {}) {
  op('ui_click', 'Click a UI element by aria-label, data-name, text content, or class substring', {
    by: z.enum(['aria-label', 'data-name', 'text', 'class-contains']).describe('Selector strategy'),
    value: z.string().describe('Value to match against the chosen selector strategy'),
  },
    A.MUTATE_ORDER, async ({ by, value }) => {
      try { return jsonResult(await core.click({ by, value })); }
      catch (err) { return errorResult(err); }
    });
  toolFromRegistry(server, 'ui_click');

  op('ui_open_panel', 'Open, close, or toggle TradingView panels (pine-editor, strategy-tester, watchlist, alerts, trading)', {
    panel: z.enum(['pine-editor', 'strategy-tester', 'watchlist', 'alerts', 'trading']).describe('Panel name'),
    action: z.enum(['open', 'close', 'toggle']).describe('Action to perform'),
  },
    A.MUTATE_IDEMPOTENT, async ({ panel, action }) => {
      try { return jsonResult(await core.openPanel({ panel, action })); }
      catch (err) { return errorResult(err); }
    });
  toolFromRegistry(server, 'ui_open_panel');

  op('ui_fullscreen', 'Toggle TradingView fullscreen mode', {},
    A.MUTATE_IDEMPOTENT, async () => {
      try { return jsonResult(await core.fullscreen()); }
      catch (err) { return errorResult(err); }
    });
  toolFromRegistry(server, 'ui_fullscreen');

  op('layout_list', 'List saved chart layouts', {},
    A.READ, async () => {
      try { return jsonResult(await core.layoutList()); }
      catch (err) { return errorResult(err); }
    });
  toolFromRegistry(server, 'layout_list');

  op('layout_switch', 'Switch to a saved chart layout by name or ID and verify the loaded chart state', {
    name: z.string().describe('Name or ID of the layout to switch to'),
    expected_pane_signature: z.string().optional().describe('Optional exact pane signature returned by a prior verified switch (for example: 4|1D,1D,1D,1D)'),
    expected_symbol: z.string().optional().describe('Optional symbol that must be rendered in every chart pane'),
  },
    A.MUTATE_IDEMPOTENT, async ({ name, expected_pane_signature, expected_symbol }) => {
      try {
        const result = await core.layoutSwitch({ name, expected_pane_signature, expected_symbol });
        return jsonResult(result, !result.success);
      } catch (err) {
        return errorResult(err);
      }
    });
  toolFromRegistry(server, 'layout_switch');

  op('ui_keyboard', 'Press keyboard keys or shortcuts (e.g., Enter, Escape, Alt+S, Ctrl+Z)', {
    key: z.string().describe('Key to press (e.g., "Enter", "Escape", "Tab", "a", "ArrowUp")'),
    modifiers: z.array(z.enum(['ctrl', 'alt', 'shift', 'meta'])).optional().describe('Modifier keys to hold (e.g., ["ctrl", "shift"])'),
  },
    A.MUTATE_ORDER, async ({ key, modifiers }) => {
      try { return jsonResult(await core.keyboard({ key, modifiers })); }
      catch (err) { return errorResult(err); }
    });
  toolFromRegistry(server, 'ui_keyboard');

  op('ui_type_text', 'Type text into the currently focused input/textarea element', {
    text: z.string().describe('Text to type into the focused element'),
  },
    A.MUTATE_ORDER, async ({ text }) => {
      try { return jsonResult(await core.typeText({ text })); }
      catch (err) { return errorResult(err); }
    });
  toolFromRegistry(server, 'ui_type_text');

  op('ui_hover', 'Hover over a UI element by aria-label, data-name, or text content', {
    by: z.enum(['aria-label', 'data-name', 'text', 'class-contains']).describe('Selector strategy'),
    value: z.string().describe('Value to match'),
  },
    A.MUTATE_ORDER, async ({ by, value }) => {
      try { return jsonResult(await core.hover({ by, value })); }
      catch (err) { return errorResult(err); }
    });
  toolFromRegistry(server, 'ui_hover');

  op('ui_scroll', 'Scroll the chart or page up/down/left/right', {
    direction: z.enum(['up', 'down', 'left', 'right']).describe('Scroll direction'),
    amount: z.coerce.number().optional().describe('Scroll amount in pixels (default 300)'),
  },
    A.MUTATE_ORDER, async ({ direction, amount }) => {
      try { return jsonResult(await core.scroll({ direction, amount })); }
      catch (err) { return errorResult(err); }
    });
  toolFromRegistry(server, 'ui_scroll');

  op('ui_mouse_click', 'Click at specific x,y coordinates on the TradingView window', {
    x: z.coerce.number().describe('X coordinate (pixels from left)'),
    y: z.coerce.number().describe('Y coordinate (pixels from top)'),
    button: z.enum(['left', 'right', 'middle']).optional().describe('Mouse button (default left)'),
    double_click: z.coerce.boolean().optional().describe('Double click (default false)'),
  },
    A.MUTATE_ORDER, async ({ x, y, button, double_click }) => {
      try { return jsonResult(await core.mouseClick({ x, y, button, double_click })); }
      catch (err) { return errorResult(err); }
    });
  toolFromRegistry(server, 'ui_mouse_click');

  op('ui_find_element', 'Find UI elements by text, aria-label, or CSS selector and return their positions', {
    query: z.string().describe('Text content, aria-label value, or CSS selector to search for'),
    strategy: z.enum(['text', 'aria-label', 'css']).optional().describe('Search strategy (default: text)'),
  },
    A.READ, async ({ query, strategy }) => {
      try { return jsonResult(await core.findElement({ query, strategy })); }
      catch (err) { return errorResult(err); }
    });
  toolFromRegistry(server, 'ui_find_element');

  op('ui_evaluate', 'DANGEROUS: Execute arbitrary JavaScript in the TradingView page context. Disabled by default; requires an explicit startup capability opt-in.', {
    expression: z.string().min(1).describe('JavaScript expression to evaluate in the page context. Wrap in IIFE for complex logic.'),
  },
    A.OPEN_WORLD, async ({ expression }) => {
      try { return jsonResult(await core.uiEvaluate({ expression, _deps: { env, evaluate } })); }
      catch (err) { return errorResult(err); }
    });
  toolFromRegistry(server, 'ui_evaluate');
}