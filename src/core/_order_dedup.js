/**
 * Paper-order idempotency (P2-6) — short-TTL dedup store keyed on
 * client_order_id, plus order preview normalization.
 *
 * Why: a timed-out CDP mutation (outcome_unknown=true) left the client
 * unable to distinguish "order placed" from "order lost". With an idempotency
 * key, a retry carries the SAME key and the store replies with the ORIGINAL
 * outcome instead of placing twice. The store is process-local and
 * deliberately simple: orders on paper cannot be reconciled on restart, so
 * the TTL only bounds memory — durability comes from the client passing a
 * stable key.
 */

const TTL_MS = 5 * 60 * 1000;         // 5 minutes
const MAX_ENTRIES = 500;              // hard cap; oldest evicted when full

const _store = new Map(); // client_order_id → { at, result }

function _prune(now) {
  for (const [k, v] of _store) {
    if (now - v.at > TTL_MS) _store.delete(k);
  }
  // `size` must stay <= MAX_ENTRIES *after* the caller's insert; deleting down
  // to exactly MAX_ENTRIES here keeps that invariant regardless of call order.
  while (_store.size >= MAX_ENTRIES) {
    _store.delete(_store.keys().next().value); // oldest insertion
  }
}

/**
 * Look up an existing outcome for a client_order_id.
 * Returns undefined when the key is fresh (no prior submission).
 */
export function lookup(client_order_id) {
  if (!client_order_id) return undefined;
  const hit = _store.get(String(client_order_id));
  if (!hit) return undefined;
  const now = Date.now();
  if (now - hit.at > TTL_MS) {
    _store.delete(String(client_order_id));
    return undefined;
  }
  return hit.result;
}

/**
 * Record the outcome of a submission with the given key.
 * Call AFTER the CDP round-trip resolves (success or known failure).
 * outcome_unknown paths must NOT record — the retry decides.
 */
export function record(client_order_id, result) {
  if (!client_order_id || !result || typeof result !== 'object') return;
  _prune(Date.now());
  _store.set(String(client_order_id), { at: Date.now(), result });
}

/** Test hook and diagnostics: number of live keys. */
export function size() { return _store.size; }
export function clear() { _store.clear(); }

/**
 * Normalized order preview — the exact shape returned by preview:true and the
 * `preview` field on every successful placement. Pure: no page access.
 */
export function normalizeOrderPreview({
  symbol = null, side, type = 'market', qty,
  price = null, stop_price = null, take_profit = null, stop_loss = null, tif = null,
}, context = {}) {
  const p = {
    symbol: symbol ?? context.symbol ?? null,
    side: String(side).toLowerCase(),
    type: String(type).toLowerCase(),
    qty: Number(qty),
  };
  if (p.type === 'limit' || p.type === 'stop_limit') p.price = Number(price);
  if (p.type === 'stop' || p.type === 'stop_limit') p.stop_price = Number(stop_price);
  if (take_profit != null) p.take_profit = Number(take_profit);
  if (stop_loss != null) p.stop_loss = Number(stop_loss);
  p.tif = tif || 'DAY';
  return p;
}