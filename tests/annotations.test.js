import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAll } from '../src/tools/index.js';

// Inspect the registration table directly (annotations stored verbatim).
const server = new McpServer({ name: 't', version: '0' });
registerAll(server);

describe('tool annotations coverage (P2-13)', () => {
  const tools = server._registeredTools;

  test('every registered tool carries a complete annotation set', () => {
    const bad = Object.entries(tools)
      .filter(([, t]) =>
        typeof t.annotations?.readOnlyHint !== 'boolean' ||
        typeof t.annotations?.destructiveHint !== 'boolean' ||
        typeof t.annotations?.idempotentHint !== 'boolean' ||
        typeof t.annotations?.openWorldHint !== 'boolean')
      .map(([name]) => name);
    assert.deepEqual(bad, [], 'tools lacking complete annotations');
  });

  test('~99 tools registered (sanity)', () => {
    assert.ok(Object.keys(tools).length >= 95, `got ${Object.keys(tools).length}`);
  });

  test('reads are readOnly + idempotent', () => {
    for (const name of ['quote_get', 'session_snapshot', 'chart_get_state', 'paper_get_status', 'pane_list']) {
      const a = tools[name]?.annotations;
      assert.equal(a?.readOnlyHint, true, name);
      assert.equal(a?.idempotentHint, true, name);
      assert.equal(a?.destructiveHint, false, name);
    }
  });

  test('chart mutations are mutating but idempotent', () => {
    for (const name of ['chart_set_symbol', 'chart_set_timeframe', 'chart_set_type']) {
      const a = tools[name]?.annotations;
      assert.equal(a?.readOnlyHint, false, name);
      assert.equal(a?.idempotentHint, true, name);
    }
  });

  test('destructive set: draw_remove_one, draw_clear, alert_delete, tab_close, watchlist_remove', () => {
    for (const name of ['draw_remove_one', 'draw_clear', 'alert_delete', 'tab_close', 'watchlist_remove']) {
      assert.equal(tools[name]?.annotations?.destructiveHint, true, name);
    }
  });

  test('open-world set: ui_evaluate, replay_trade, tv_update', () => {
    for (const name of ['ui_evaluate', 'replay_trade', 'tv_update']) {
      assert.equal(tools[name]?.annotations?.openWorldHint, true, name);
      assert.equal(tools[name]?.annotations?.readOnlyHint, false, name);
    }
  });

  test('orders are non-idempotent (idempotency comes from client_order_id)', () => {
    for (const name of ['paper_place_order', 'paper_modify_order', 'paper_close_position']) {
      const a = tools[name]?.annotations;
      assert.equal(a?.idempotentHint, false, name);
      assert.equal(a?.readOnlyHint, false, name);
    }
    // cancel IS idempotent (cancelling a cancelled order is a no-op)
    assert.equal(tools.paper_cancel_order?.annotations?.idempotentHint, true);
  });
});