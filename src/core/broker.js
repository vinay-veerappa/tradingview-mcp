/**
 * TV↔broker gateway tap — read-only broker truth from the page's own polls.
 *
 * Finding L-133: the TradingView chart page polls its broker gateway
 * (~1 Hz) at `/accounts/<id>/{state,positions,orders}` and `/quotes`. The
 * bodies are the broker's own data wrapped in TV's `{s:'ok', d:…}` envelope.
 * This module listens to those responses over CDP and caches the latest
 * body per endpoint — it NEVER issues a broker request, never reads the
 * Authorization header, and never places orders.
 *
 * Contract:
 * - Getters answer from cache and only wait (bounded) for the next poll when
 *   the cache is stale or empty.
 * - Stale data is returned with `stale: true` and its age, never invented.
 * - No data at all (broker disconnected, no traffic seen) throws
 *   `upstream_unavailable` — a monitor can distinguish "unknown" from zeros.
 *
 * Evidence: live capture on Tradovate demo gateway (tv-demo.tradovateapi.com),
 * Desktop 3.5.0 — see the login/logout exploration (L-133 register entry).
 */
import { evaluate as _evaluate, CDP_HOST, CDP_PORT } from '../connection.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_MAX_AGE_MS = 5000;
export const DEFAULT_WAIT_MS = 3000;
const POLL_INTERVAL_MS = 50;

/**
 * Broker gateway host matcher. Default: the Tradovate API family (NinjaTrader
 * connects through it). Override with TV_BROKER_HOST_RE when a different
 * broker's gateway needs tapping.
 */
export const BROKER_HOST_RE = (() => {
  const raw = process.env.TV_BROKER_HOST_RE;
  if (raw) {
    try { return new RegExp(raw, 'i'); } catch { /* fall through */ }
  }
  return /(^|\.)tradovateapi\.com$/i;
})();

// ── module cache (process-lifetime; cheap maps) ────────────────────────────

function emptyCache() {
  return {
    state: new Map(),     // accountId → { data, ts }
    positions: new Map(), // accountId → { data, ts }
    orders: new Map(),    // accountId → { data, ts }
    quotes: new Map(),    // accountId|'' → { bySymbol: Map, ts }
    accounts: new Map(),  // accountId → { name, type, prefix, ts } (from the /accounts list at connect)
    lastSeen: 0,          // ms since epoch of the last matched body
    lastAccountId: null,  // newest account id seen on any endpoint
  };
}

let cache = emptyCache();

/** Test seam: reset the process cache and detach any taps. */
export function _resetCache() {
  cache = emptyCache();
  for (const client of taps.values()) {
    try { client.close(); } catch { /* already gone */ }
  }
  taps.clear();
}

// ── pure helpers (unit-tested offline) ─────────────────────────────────────

/** Route a gateway URL to { kind, accountId } or null when it is not one. */
export function routeUrl(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (!BROKER_HOST_RE.test(u.hostname)) return null;
  const m = u.pathname.match(/^\/accounts\/([^/]+)\/(state|positions|orders)$/);
  if (m) return { kind: m[2], accountId: m[1] };
  if (u.pathname === '/accounts' || u.pathname === '/accounts/') return { kind: 'accounts', accountId: '' };
  if (u.pathname === '/quotes') return { kind: 'quotes', accountId: u.searchParams.get('accountId') || '' };
  return null;
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

/** Gateway `lastModified` is unix seconds on Tradovate gateways. */
export function epochToMs(value) {
  if (!isNum(value)) return null;
  return value < 1e12 ? value * 1000 : value;
}

/** Map one gateway order row to a stable, broker-agnostic shape. */
export function normalizeOrder(raw = {}) {
  const side = typeof raw.side === 'string' ? raw.side.toLowerCase() : null;
  return {
    id: raw.id != null ? String(raw.id) : null,
    instrument: raw.instrument ?? raw.symbol ?? null,
    side,
    qty: isNum(raw.qty) ? raw.qty : null,
    type: typeof raw.type === 'string' ? raw.type.toLowerCase() : null,
    status: typeof raw.status === 'string' ? raw.status.toLowerCase() : null,
    filled_qty: isNum(raw.filledQty) ? raw.filledQty : 0,
    avg_fill_price: isNum(raw.avgPrice) ? raw.avgPrice : null,
    limit_price: isNum(raw.limitPrice) ? raw.limitPrice : null,
    stop_price: isNum(raw.stopPrice) ? raw.stopPrice : null,
    is_trailing_stop: raw.isTrailingStop === true,
    time_in_force: raw.duration?.type ?? null,
    last_modified_ms: epochToMs(raw.lastModified),
  };
}

/** Map one gateway position row defensively (shape unproven live). */
export function normalizePosition(raw = {}) {
  const qty = isNum(raw.qty) ? raw.qty : (isNum(raw.quantity) ? raw.quantity : null);
  const side = typeof raw.side === 'string'
    ? raw.side.toLowerCase()
    : (qty != null ? (qty < 0 ? 'sell' : 'buy') : null);
  return {
    instrument: raw.instrument ?? raw.symbol ?? null,
    side,
    qty,
    avg_fill_price: isNum(raw.avgPrice) ? raw.avgPrice : (isNum(raw.price) ? raw.price : null),
    unrealized_pl: isNum(raw.unrealizedPl) ? raw.unrealizedPl : (isNum(raw.openPnl) ? raw.openPnl : null),
    position_id: raw.id != null ? String(raw.id) : null,
  };
}

/** Map one gateway quote row (`{s,n,v:{lp,bid,ask,…}}`) to a flat quote. */
export function normalizeQuoteRow(row = {}) {
  const v = row.v || {};
  return {
    symbol: row.n ?? null,
    last: isNum(v.lp) ? v.lp : null,
    bid: isNum(v.bid) ? v.bid : null,
    ask: isNum(v.ask) ? v.ask : null,
    open: isNum(v.open_price) ? v.open_price : null,
    high: isNum(v.high_price) ? v.high_price : null,
    low: isNum(v.low_price) ? v.low_price : null,
    prev_close: isNum(v.prev_close_price) ? v.prev_close_price : null,
    change: isNum(v.ch) ? v.ch : null,
    change_pct: isNum(v.chp) ? v.chp : null,
    volume: isNum(v.volume) ? v.volume : null,
  };
}

/**
 * Disambiguate a glued "<label><equity> USD" string using the authoritative
 * equity from the state poll: find the split whose money part equals it.
 */
export function splitGluedLabel(text, equity) {
  const clean = String(text || '').replace(/\u00a0/g, ' ').trim();
  if (!clean || !isNum(equity)) return null;
  const money = /^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/;
  const body = clean.replace(/\s*USD$/i, '');
  for (let i = 1; i < body.length; i++) {
    const rest = body.slice(i);
    if (!money.test(rest)) continue;
    if (Number(rest.replace(/,/g, '')) !== equity) continue;
    const label = body.slice(0, i).trim();
    if (!/^[A-Za-z0-9_]+$/.test(label)) continue;
    return { label, equity };
  }
  return null;
}

/**
 * Parse the account button label. `innerText` from the manager bar renders as
 * "<label>\n<equity> USD"; single-line textContent runs them together, which is
 * ambiguous for labels that themselves end in digits — flagged low-confidence.
 */
export function parseAccountLabel(text) {
  const clean = String(text || '').replace(/\u00a0/g, ' ');
  if (!clean.trim()) return { label: null, equity: null, confidence: null };
  const lines = clean.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  if (lines.length >= 2) {
    const m = lines[1].match(/^([\d,]+(?:\.\d+)?)\s*USD$/i);
    if (m) return { label: lines[0], equity: Number(m[1].replace(/,/g, '')), confidence: 'high' };
    return { label: lines[0], equity: null, confidence: 'low' };
  }
  const joined = lines[0];
  const withSpace = joined.match(/^([A-Za-z0-9_]+)\s+([\d,]+(?:\.\d+)?)\s*USD$/i);
  if (withSpace) return { label: withSpace[1], equity: Number(withSpace[2].replace(/,/g, '')), confidence: 'high' };
  const glued = joined.match(/^([A-Za-z0-9_]+?)(\d{1,3}(?:,\d{3})+(?:\.\d+)?)\s*USD$/i);
  if (glued) return { label: glued[1], equity: Number(glued[2].replace(/,/g, '')), confidence: 'low' };
  return { label: null, equity: null, confidence: null };
}

/** Store one parsed gateway body into the cache. Exported for tests. */
export function ingest(url, body, now = Date.now()) {
  const route = routeUrl(url);
  if (!route) return false;
  const envelope = body && typeof body === 'object' ? body : null;
  if (!envelope || envelope.s !== 'ok') return false;
  const d = envelope.d;
  cache.lastSeen = now;
  if (route.accountId) cache.lastAccountId = route.accountId;

  if (route.kind === 'quotes') {
    const list = Array.isArray(d) ? d : [];
    const key = route.accountId || '';
    let entry = cache.quotes.get(key);
    if (!entry) { entry = { bySymbol: new Map(), ts: 0 }; cache.quotes.set(key, entry); }
    for (const row of list) {
      const q = normalizeQuoteRow(row);
      if (q.symbol) entry.bySymbol.set(q.symbol, q);
    }
    entry.ts = now;
    return true;
  }

  if (route.kind === 'accounts') {
    const rows = Array.isArray(d) ? d : [];
    for (const r of rows) {
      const id = r?.id != null ? String(r.id) : (r?.accountId != null ? String(r.accountId) : null);
      if (!id) continue;
      cache.accounts.set(id, {
        name: r.name ?? r.label ?? r.accountName ?? null,
        type: r.type ?? r.accountType ?? null,
        prefix: r.prefix ?? null,
        ts: now,
      });
    }
    return true;
  }

  if (route.kind === 'orders') {
    const rows = Array.isArray(d) ? d.map(normalizeOrder) : [];
    cache.orders.set(route.accountId, { data: rows, ts: now });
    return true;
  }
  if (route.kind === 'positions') {
    const rows = Array.isArray(d) ? d.map(normalizePosition) : [];
    cache.positions.set(route.accountId, { data: rows, ts: now });
    return true;
  }
  if (route.kind === 'state') {
    const data = d && typeof d === 'object' ? {
      balance: isNum(d.balance) ? d.balance : null,
      equity: isNum(d.equity) ? d.equity : null,
      unrealized_pl: isNum(d.unrealizedPl) ? d.unrealizedPl : null,
      am_data_rows: Array.isArray(d.amData) ? d.amData.length : 0,
    } : null;
    cache.state.set(route.accountId, { data, ts: now });
    return true;
  }
  return false;
}

// ── live tap ───────────────────────────────────────────────────────────────

/**
 * The page that polls the broker gateway can be either chart tab, and the
 * connection manager only holds one target — so the tap attaches its own
 * client per chart page. Clients are re-attached by target id as tabs are
 * recycled.
 */
const taps = new Map(); // targetId → client

function resolveDeps(deps) {
  return {
    evaluate: deps?.evaluate || _evaluate,
    listPages: deps?.listPages || defaultListPages,
    attach: deps?.attach || defaultAttach,
    refreshLabel: deps?.refreshLabel || null,
  };
}

async function defaultListPages() {
  const res = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
  const list = await res.json();
  return list.filter((t) => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url || ''));
}

let _CDP = null;
async function defaultAttach(targetId) {
  if (!_CDP) {
    const mod = await import('chrome-remote-interface');
    _CDP = mod.default || mod;
  }
  return _CDP({ host: CDP_HOST, port: CDP_PORT, target: targetId });
}

/**
 * Attach the response tap to every chart page. Idempotent per target id;
 * detached tabs drop out and are re-attached on the next call.
 */
async function ensureTap(deps) {
  let pages;
  try {
    pages = await deps.listPages();
  } catch {
    return; // CDP discovery unavailable — callers fall back to the cache
  }
  const ids = new Set(pages.map((p) => p.id));
  for (const id of [...taps.keys()]) {
    if (!ids.has(id)) taps.delete(id);
  }
  for (const page of pages) {
    if (taps.has(page.id)) continue;
    try {
      const client = await deps.attach(page.id);
      taps.set(page.id, client);
      if (typeof client.on === 'function') {
        client.on('Network.responseReceived', (params) => {
          if (taps.get(page.id) !== client) return; // stale after reset or recycle
          void captureResponse(client, params);
        });
        client.on('disconnect', () => { if (taps.get(page.id) === client) taps.delete(page.id); });
      }
      await client.Network.enable();
    } catch {
      // One page failing to attach must not stop the others.
    }
  }
}

/** Attach the tap to every chart page and return the page clients (session UI use). */
export async function attachTaps({ _deps } = {}) {
  const deps = resolveDeps(_deps);
  await ensureTap(deps);
  return [...taps.values()];
}

async function captureResponse(client, params) {
  const url = params?.response?.url;
  if (!url || !routeUrl(url)) return;
  try {
    const body = await client.Network.getResponseBody({ requestId: params.requestId });
    const text = body?.base64Encoded
      ? Buffer.from(body.body, 'base64').toString('utf8')
      : body?.body;
    if (!text) return;
    ingest(url, JSON.parse(text));
  } catch {
    // A body can expire before it is fetched; the next poll supersedes it.
  }
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function brokerUnavailable(kind) {
  return Object.assign(
    new Error(`No ${kind} traffic observed from the broker gateway yet. Is a broker connected in the TradingView trading panel?`),
    { reason: 'upstream_unavailable' },
  );
}

/**
 * Shared read path: fresh cache answers immediately; otherwise wait up to
 * `waitMs` for the next poll. Falls back to stale cache if the tap is down.
 */
async function read(kind, { accountId, maxAgeMs = DEFAULT_MAX_AGE_MS, waitMs = DEFAULT_WAIT_MS, _deps } = {}) {
  const deps = resolveDeps(_deps);
  const map = cache[kind];
  const pick = () => {
    if (accountId) {
      const entry = map.get(accountId);
      return entry ? { accountId, ...entry } : null;
    }
    let best = null;
    for (const [id, entry] of map) {
      if (!best || entry.ts > best.ts) best = { accountId: id, ...entry };
    }
    return best;
  };

  let entry = pick();
  const now = Date.now();
  if (entry && now - entry.ts <= maxAgeMs) {
    return { entry, ageMs: now - entry.ts, stale: false };
  }

  try {
    await ensureTap(deps);
  } catch (err) {
    if (entry) return { entry, ageMs: now - entry.ts, stale: true, tap_error: String(err.message || err) };
    throw brokerUnavailable(kind);
  }

  const started = Date.now();
  const baseline = entry?.ts ?? 0;
  while (Date.now() - started < waitMs) {
    await sleep(POLL_INTERVAL_MS);
    const fresh = pick();
    if (fresh && fresh.ts > baseline) {
      return { entry: fresh, ageMs: Date.now() - fresh.ts, stale: false };
    }
  }

  entry = pick();
  if (entry) return { entry, ageMs: Date.now() - entry.ts, stale: true };
  throw brokerUnavailable(kind);
}

function meta(kind, route, res) {
  return {
    source: 'page-poll',
    endpoint: route,
    account_id: res.entry.accountId ?? null,
    age_ms: res.ageMs,
    stale: res.stale,
    ...(res.tap_error ? { tap_error: res.tap_error } : {}),
  };
}

function routeFor(kind, accountId) {
  if (kind === 'quotes') return accountId ? `/quotes?accountId=${accountId}` : '/quotes';
  return `/accounts/${accountId || '<id>'}/${kind}`;
}

// ── public getters (the five tool surfaces) ────────────────────────────────

/** Balance / equity / unrealizedPl for one broker account. */
export async function getState({ accountId, maxAgeMs, waitMs, _deps } = {}) {
  const res = await read('state', { accountId, maxAgeMs, waitMs, _deps });
  const d = res.entry.data || {};
  return {
    success: true,
    ...d,
    ...meta('state', routeFor('state', res.entry.accountId), res),
  };
}

/** Normalized open positions for one broker account. */
export async function getPositions({ accountId, maxAgeMs, waitMs, _deps } = {}) {
  const res = await read('positions', { accountId, maxAgeMs, waitMs, _deps });
  return {
    success: true,
    positions: res.entry.data || [],
    count: (res.entry.data || []).length,
    ...meta('positions', routeFor('positions', res.entry.accountId), res),
  };
}

/**
 * Normalized order list. `include_terminal: false` keeps only working orders
 * (anything not filled/cancelled/expired/rejected).
 */
export async function getOrders({ accountId, include_terminal = true, maxAgeMs, waitMs, _deps } = {}) {
  const res = await read('orders', { accountId, maxAgeMs, waitMs, _deps });
  const all = res.entry.data || [];
  const TERMINAL = new Set(['filled', 'cancelled', 'canceled', 'expired', 'rejected']);
  const orders = include_terminal ? all : all.filter((o) => !TERMINAL.has(o.status));
  return {
    success: true,
    orders,
    count: orders.length,
    ...meta('orders', routeFor('orders', res.entry.accountId), res),
  };
}

/** Latest marks for the symbols the trading panel subscribes to. */
export async function getQuotes({ accountId, symbol, maxAgeMs, waitMs, _deps } = {}) {
  const res = await read('quotes', { accountId, maxAgeMs, waitMs, _deps });
  const bySymbol = res.entry.bySymbol || new Map();
  const quotes = [];
  for (const [sym, q] of bySymbol) {
    if (symbol && sym !== symbol) continue;
    quotes.push(q);
  }
  return {
    success: true,
    quotes,
    count: quotes.length,
    ...meta('quotes', routeFor('quotes', res.entry.accountId || accountId), res),
  };
}

const ACCOUNT_DOM_JS = `(function() {
  var out = { label: null, equity: null, broker: null, manager_open: false, raw: null };
  var closeBtn = document.querySelector('button[aria-label="Close account manager"]');
  var openBtn = document.querySelector('button[aria-label="Open account manager"]');
  out.manager_open = !!closeBtn;
  if (closeBtn) out.broker = (closeBtn.textContent || '').replace(/\\s+/g, ' ').trim() || null;
  else if (openBtn) out.broker = null;
  var found = null;
  var cands = document.querySelectorAll('button');
  for (var i = 0; i < cands.length; i++) {
    var b = cands[i];
    var it = typeof b.innerText === 'string' ? b.innerText : '';
    var t = it && it.indexOf('USD') >= 0 ? it : (b.textContent || '');
    if (!/USD\\s*$/.test(t.trim())) continue;
    if (!/^[A-Za-z0-9_]+/.test(t.trim())) continue;
    found = t.trim();
    break;
  }
  out.raw = found;
  return out;
})()`;

// ── pairing persistence ────────────────────────────────────────────────────
// The label lives only in the panel DOM; the id lives in the traffic. The
// mapping is remembered so a monitor keeps the pairing across panel-closed
// periods and across calls in a fresh process.

function stateDir() {
  return process.env.TV_BROKER_STATE_DIR || path.join(os.homedir(), '.tradingview-mcp');
}
function pairsFile() { return path.join(stateDir(), 'broker-pairings.json'); }

/** The persisted id→label table ({} when none). Exported for diagnostics. */
export function loadPairs() {
  try { return JSON.parse(fs.readFileSync(pairsFile(), 'utf8')); } catch { return {}; }
}

/** Remember one pairing (best effort; a read must never fail on disk). */
export function rememberPair(accountId, label, source = 'ui') {
  if (!accountId || !label) return false;
  try {
    const all = loadPairs();
    all[accountId] = { label, source, seen_at: new Date().toISOString() };
    fs.mkdirSync(stateDir(), { recursive: true });
    fs.writeFileSync(pairsFile(), JSON.stringify(all, null, 1));
    return true;
  } catch { return false; }
}

function recallPair(accountId) {
  if (!accountId) return null;
  const all = loadPairs();
  return all[accountId] || null;
}

function pairsList(limit = 20) {
  const all = loadPairs();
  return Object.entries(all)
    .map(([id, p]) => ({ broker_account_id: id, label: p.label, source: p.source, seen_at: p.seen_at }))
    .sort((a, b) => String(b.seen_at).localeCompare(String(a.seen_at)))
    .slice(0, limit);
}

/** Read the panel DOM through a tapped page client (no manager client needed). */
async function labelFromClient(client) {
  try {
    const r = await client.Runtime.evaluate({ expression: ACCOUNT_DOM_JS, returnByValue: true });
    return r?.result?.value || null;
  } catch {
    return null;
  }
}

/** Locate the panel toggle (open or close state) on one page. */
const PANEL_BUTTON_JS = `(() => {
  var b = document.querySelector('button[aria-label="Close account manager"]')
       || document.querySelector('button[aria-label="Open account manager"]');
  if (b) {
    var r = b.getBoundingClientRect();
    if (r.width > 0) return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2, action: b.getAttribute('aria-label') });
  }
  var spans = document.querySelectorAll('span');
  for (var i = 0; i < spans.length; i++) {
    var s = spans[i];
    if ((s.textContent || '').trim() !== 'NinjaTrader') continue;
    var sr = s.getBoundingClientRect();
    if (sr.y < 1900) continue;
    var host = s.closest('button') || s.parentElement;
    if (!host) continue;
    var q = host.getBoundingClientRect();
    return JSON.stringify({ x: q.x + q.width / 2, y: q.y + q.height / 2, action: 'collapsed-bar' });
  }
  return 'null';
})()`;

async function clickAt(client, x, y) {
  await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x, y, button: 'none' });
  await sleep(120);
  await client.Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await sleep(70);
  await client.Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
}

/**
 * Explicit UI capture: open the trading panel briefly, read the account bar,
 * and collapse it again. This is the only UI action this module performs, and
 * only when a caller asks for it.
 */
export async function capturePairingNow({ _deps } = {}) {
  const deps = resolveDeps(_deps);
  await ensureTap(deps);
  for (const client of [...taps.values()]) {
    try {
      let dom = await labelFromClient(client);
      if (dom?.manager_open && dom?.raw) return dom;
      const btn = await client.Runtime.evaluate({ expression: PANEL_BUTTON_JS, returnByValue: true }).catch(() => null);
      const raw = btn?.result?.value;
      if (!raw || raw === 'null') continue;
      const t = JSON.parse(raw);
      await clickAt(client, t.x, t.y);
      await sleep(1300);
      dom = await labelFromClient(client);
      if (dom?.manager_open && dom?.raw) {
        await clickAt(client, t.x, t.y); // restore the collapsed state
        return dom;
      }
    } catch {
      // try the next page
    }
  }
  return null;
}

/** Account identity: display label (from the manager UI) paired with the
 * broker's account id (from the gateway URLs the same page polls).
 * Never throws for "not connected" — a monitor needs the negative answer. */
export async function getAccount({ waitMs = 1500, refresh = false, _deps } = {}) {
  const deps = resolveDeps(_deps);

  // Attach the tap and give the poll a moment, so a first call in a fresh
  // process reports the live connection instead of "unknown".
  await ensureTap(deps);
  const started = Date.now();
  while (!cache.lastSeen && Date.now() - started < waitMs) {
    await sleep(POLL_INTERVAL_MS);
  }

  let dom = null;
  let domError = null;
  if (refresh) {
    try { dom = await (deps.refreshLabel ? deps.refreshLabel() : capturePairingNow({ _deps })); }
    catch (err) { domError = String(err.message || err); }
  }
  if (!dom) {
    try { dom = await deps.evaluate(ACCOUNT_DOM_JS); }
    catch (err) { domError = domError || String(err.message || err); }
  }

  let freshest = null;
  for (const [accountId, entry] of cache.state) {
    if (!freshest || entry.ts > freshest.ts) freshest = { accountId, ts: entry.ts, data: entry.data };
  }
  const age = cache.lastSeen ? Date.now() - cache.lastSeen : null;
  const connected = age != null && age <= DEFAULT_MAX_AGE_MS;
  const parsed = parseAccountLabel(dom?.raw || '');
  const equity = dom?.equity ?? parsed.equity ?? (freshest?.data?.equity ?? null);
  const brokerAccountId = freshest?.accountId ?? cache.lastAccountId ?? null;
  const acctMeta = brokerAccountId ? cache.accounts.get(brokerAccountId) : null;

  // The accounts endpoint is the broker's own id -> name table; the panel label is scraped text that
  // can be glued to the balance or truncated (it once persisted "APEX1012150000018" for ...183). So
  // the endpoint name wins whenever it was captured, and the UI label only cross-checks it.
  const endpointName = acctMeta?.name || null;
  let uiLabel = parsed.label || null;
  if (parsed.confidence === 'low' && uiLabel && equity != null) {
    // The bar glued "<label><equity>"; the state poll's equity disambiguates.
    const split = splitGluedLabel(dom?.raw || '', equity);
    if (split) uiLabel = split.label;
  }
  const uiConfidence = parsed.confidence === 'low' && uiLabel !== parsed.label ? 'high' : parsed.confidence;
  let label;
  let confidence;
  let pairingSource;
  let labelConflict = false;
  if (endpointName) {
    label = endpointName;
    confidence = 'high';
    pairingSource = 'accounts-endpoint';
    labelConflict = Boolean(uiLabel) && uiLabel.toUpperCase() !== endpointName.toUpperCase();
  } else {
    label = uiLabel;
    confidence = uiConfidence;
    pairingSource = uiLabel ? 'ui' : null;
  }
  if (!label && brokerAccountId) {
    const mem = recallPair(brokerAccountId);
    if (mem?.label) { label = mem.label; pairingSource = 'memory'; confidence = 'memory'; }
  }
  if (label && brokerAccountId && pairingSource !== 'memory') {
    rememberPair(brokerAccountId, label, pairingSource);
  }

  return {
    success: true,
    connected,
    broker: dom?.broker || null,
    label,
    equity,
    broker_account_id: brokerAccountId,
    pairing_source: pairingSource,
    pairing_confidence: confidence,
    // Set when the panel text disagrees with the broker's own name for this id; trust `label`.
    ...(labelConflict && { ui_label: uiLabel, label_conflict: true }),
    manager_open: Boolean(dom?.manager_open),
    last_seen_ms_ago: age,
    broker_accounts: [...cache.accounts.entries()].map(([id, m]) => ({
      broker_account_id: id, label: m.name, type: m.type, prefix: m.prefix,
    })),
    pairs: pairsList(),
    ...(domError && { cdp_error: domError }),
    note: connected
      ? 'pairing: broker_account_id from the gateway traffic; label from the accounts endpoint when captured, else the panel UI, else the remembered mapping'
      : 'no recent broker traffic; a broker may not be connected in the trading panel',
  };
}
