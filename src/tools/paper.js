import { z } from 'zod';
import { A } from './_annotations.js';
import { jsonResult, errorResult } from './_format.js';
import * as core from '../core/paper.js';

export function registerPaperTools(server) {
  server.tool('paper_get_status', 'Report TradingView native Paper Trading status: desktop CDP, auth session, Trading Panel, connection, active broker id, and whether mutations are safe (safe_for_paper_mutation is true only when the active broker id is exactly "Paper").', {},
    A.READ, async () => {
    try { return jsonResult(await core.getStatus()); }
    catch (err) { return errorResult(err); }
  });

  server.tool('paper_open_panel', 'Open, close, or toggle the Trading Panel (bottom widget paper_trading) via the internal bottomWidgetBar API.', {
    action: z.enum(['open', 'close', 'toggle']).optional().describe('open (default), close, or toggle'),
  },
    A.MUTATE_IDEMPOTENT, async ({ action }) => {
    try { return jsonResult(await core.openPanel({ action: action || 'open' })); }
    catch (err) { return errorResult(err); }
  });

  server.tool('paper_connect', 'Connect TradingView native Paper Trading (broker id "Paper"). Fails if not logged in. Never connects other brokers.', {},
    A.MUTATE_IDEMPOTENT, async () => {
    try { return jsonResult(await core.connect()); }
    catch (err) { return errorResult(err); }
  });

  server.tool('paper_get_account', 'Get the active native Paper Trading account summary (balance, equity, PnL, margin, available funds). Requires Paper connected.', {},
    A.READ, async () => {
    try { return jsonResult(await core.getAccount()); }
    catch (err) { return errorResult(err); }
  });

  server.tool('paper_list_accounts', 'List Paper Trading accounts for the connected native Paper broker.', {},
    A.READ, async () => {
    try { return jsonResult(await core.listAccounts()); }
    catch (err) { return errorResult(err); }
  });

  server.tool('paper_switch_account', 'Switch the active native Paper Trading account by id.', {
    account_id: z.string().describe('Paper account id from paper_list_accounts'),
  },
    A.MUTATE_IDEMPOTENT, async ({ account_id }) => {
    try { return jsonResult(await core.switchAccount({ account_id })); }
    catch (err) { return errorResult(err); }
  });

  server.tool('paper_list_positions', 'List open native Paper Trading positions.', {},
    A.READ, async () => {
    try { return jsonResult(await core.listPositions()); }
    catch (err) { return errorResult(err); }
  });

  server.tool('paper_list_orders', 'List native Paper Trading orders (active by default, or order history).', {
    history: z.boolean().optional().describe('If true, return order history instead of active orders'),
  },
    A.READ, async ({ history }) => {
    try { return jsonResult(await core.listOrders({ history: !!history })); }
    catch (err) { return errorResult(err); }
  });

  server.tool('paper_place_order', 'Place an order on native Paper Trading only. Fail-closed if active broker is not Paper. Types: market, limit, stop, stop_limit. Optional TIF (DAY/WEEK/MONTH/GTD), take_profit / stop_loss brackets. Pass client_order_id to make retries safe — the same id replays the original outcome instead of placing twice. Use preview: true to validate and normalize without placing.', {
    side: z.enum(['buy', 'sell']).describe('Order side'),
    type: z.enum(['market', 'limit', 'stop', 'stop_limit']).optional().describe('Order type (default market)'),
    qty: z.coerce.number().describe('Quantity'),
    symbol: z.string().optional().describe('Symbol (defaults to active chart symbol)'),
    price: z.coerce.number().optional().describe('Limit price (limit / stop_limit)'),
    stop_price: z.coerce.number().optional().describe('Stop price (stop / stop_limit)'),
    take_profit: z.coerce.number().optional().describe('Take profit price'),
    stop_loss: z.coerce.number().optional().describe('Stop loss price'),
    tif: z.enum(['DAY', 'WEEK', 'MONTH', 'GTD']).optional().describe('Time in force (Paper default in UI is WEEK)'),
    duration_datetime: z.union([z.string(), z.coerce.number()]).optional().describe('Required for GTD: ISO date/time or unix ms'),
    client_order_id: z.string().optional().describe('STRONGLY RECOMMENDED: idempotency key — retry the SAME key after a timeout to replay the original outcome instead of duplicating the order (5 min TTL)'),
    preview: z.boolean().optional().describe('If true: validate + normalize and return the order shape WITHOUT placing'),
  },
    A.MUTATE_ORDER, async (args) => {
    try { return jsonResult(await core.placeOrder(args)); }
    catch (err) { return errorResult(err); }
  });

  server.tool('paper_cancel_order', 'Cancel an active native Paper Trading order by id.', {
    order_id: z.string().describe('Order id'),
  },
    A.MUTATE_IDEMPOTENT, async ({ order_id }) => {
    try { return jsonResult(await core.cancelOrder({ order_id })); }
    catch (err) { return errorResult(err); }
  });

  server.tool('paper_modify_order', 'Modify an active native Paper Trading order (qty / price / stop_price).', {
    order_id: z.string().describe('Order id'),
    qty: z.coerce.number().optional().describe('New quantity'),
    price: z.coerce.number().optional().describe('New limit price'),
    stop_price: z.coerce.number().optional().describe('New stop price'),
  },
    A.MUTATE_ORDER, async (args) => {
    try { return jsonResult(await core.modifyOrder(args)); }
    catch (err) { return errorResult(err); }
  });

  server.tool('paper_close_position', 'Close a native Paper Trading position (full or partial).', {
    position_id: z.string().optional().describe('Position id (often the symbol)'),
    symbol: z.string().optional().describe('Symbol if position_id omitted'),
    qty: z.coerce.number().optional().describe('Partial close quantity (omit for full close)'),
  },
    A.MUTATE_ORDER, async (args) => {
    try { return jsonResult(await core.closePosition(args)); }
    catch (err) { return errorResult(err); }
  });

  server.tool('paper_set_brackets', 'Add, change, or clear stop loss / take profit on an open native Paper position.', {
    position_id: z.string().optional().describe('Position id (often the symbol)'),
    symbol: z.string().optional().describe('Symbol if position_id omitted'),
    stop_loss: z.coerce.number().optional().describe('Stop loss price'),
    take_profit: z.coerce.number().optional().describe('Take profit price'),
    clear: z.boolean().optional().describe('If true, clear both stop loss and take profit'),
  },
    A.MUTATE_ORDER, async (args) => {
    try { return jsonResult(await core.setBrackets(args)); }
    catch (err) { return errorResult(err); }
  });
}
