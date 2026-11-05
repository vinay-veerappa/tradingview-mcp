/**
 * Broker surface (src/core/broker.js + src/tools/broker.js) — offline tests.
 *
 * The tap itself is CDP plumbing; what must hold is: URL routing, envelope
 * handling, normalization, cache freshness semantics, and the identity
 * pairing. All exercised here with injected bodies — no browser needed.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

// Keep pairing persistence out of the real home directory during tests.
process.env.TV_BROKER_STATE_DIR = path.join(os.tmpdir(), 'tv-broker-test-' + process.pid);

import {
  routeUrl,
  epochToMs,
  normalizeOrder,
  normalizePosition,
  normalizeQuoteRow,
  parseAccountLabel,
  splitGluedLabel,
  ingest,
  getState,
  getPositions,
  getOrders,
  getQuotes,
  getAccount,
  _resetCache,
} from '../src/core/broker.js';

const STATE_URL = 'https://tv-demo.tradovateapi.com/accounts/D69532036/state?locale=en';
const POSITIONS_URL = 'https://tv-demo.tradovateapi.com/accounts/D69532036/positions?locale=en';
const ORDERS_URL = 'https://tv-demo.tradovateapi.com/accounts/D69532036/orders?locale=en';
const QUOTES_URL = 'https://tv-demo.tradovateapi.com/quotes?locale=en&symbols=MESZ6&accountId=D69532036';

const DOWN_DEPS = {
  listPages: async () => [], // never touch a real CDP endpoint from tests
  evaluate: async () => { throw new Error('CDP down'); },
};

function stateBody(overrides = {}) {
  return { s: 'ok', d: { balance: 50895.79, unrealizedPl: 0, equity: 50895.79, amData: [[['6.88', '0.00']]], ...overrides } };
}

const ORDER_ROWS = [
  { id: '698454582356', instrument: 'MESZ6', qty: 1, side: 'sell', type: 'market', status: 'filled',
    lastModified: 1793724304, filledQty: 1, avgPrice: 7600.25, duration: { type: 'GTC' }, isTrailingStop: false },
  { id: '698454582350', instrument: 'MESZ6', qty: 1, side: 'buy', type: 'stop', status: 'cancelled',
    lastModified: 1793724485, stopPrice: 7604.25, duration: { type: 'GTC' }, isTrailingStop: false },
];

describe('routeUrl', () => {
  it('routes the four polling endpoints and the accounts list', () => {
    assert.deepEqual(routeUrl(STATE_URL), { kind: 'state', accountId: 'D69532036' });
    assert.deepEqual(routeUrl(POSITIONS_URL), { kind: 'positions', accountId: 'D69532036' });
    assert.deepEqual(routeUrl(ORDERS_URL), { kind: 'orders', accountId: 'D69532036' });
    assert.deepEqual(routeUrl(QUOTES_URL), { kind: 'quotes', accountId: 'D69532036' });
    assert.deepEqual(routeUrl('https://tv-demo.tradovateapi.com/accounts'), { kind: 'accounts', accountId: '' });
    assert.deepEqual(routeUrl('https://tv-demo.tradovateapi.com/accounts?locale=en'), { kind: 'accounts', accountId: '' });
  });

  it('refuses other hosts, other paths, and garbage', () => {
    assert.equal(routeUrl('https://www.tradingview.com/accounts/D1/state'), null);
    assert.equal(routeUrl('https://tv-demo.tradovateapi.com/markets'), null);
    assert.equal(routeUrl('not a url'), null);
    assert.equal(routeUrl('https://evil.example.com/accounts/D1/state?x='), null);
  });
});

describe('normalization', () => {
  it('maps a filled market order', () => {
    const o = normalizeOrder(ORDER_ROWS[0]);
    assert.equal(o.instrument, 'MESZ6');
    assert.equal(o.side, 'sell');
    assert.equal(o.type, 'market');
    assert.equal(o.status, 'filled');
    assert.equal(o.filled_qty, 1);
    assert.equal(o.avg_fill_price, 7600.25);
    assert.equal(o.time_in_force, 'GTC');
    assert.equal(o.is_trailing_stop, false);
    assert.ok(o.last_modified_ms > 1e12, 'unix seconds converted to ms');
  });

  it('keeps stop price on a cancelled stop', () => {
    const o = normalizeOrder(ORDER_ROWS[1]);
    assert.equal(o.stop_price, 7604.25);
    assert.equal(o.limit_price, null);
    assert.equal(o.status, 'cancelled');
  });

  it('tolerates ms timestamps and missing fields', () => {
    assert.equal(epochToMs(1793724304000), 1793724304000);
    assert.equal(epochToMs(null), null);
    const o = normalizeOrder({});
    assert.equal(o.id, null);
    assert.equal(o.filled_qty, 0);
  });

  it('derives position side from signed qty when side is absent', () => {
    assert.equal(normalizePosition({ instrument: 'MESZ6', qty: -2 }).side, 'sell');
    assert.equal(normalizePosition({ instrument: 'MESZ6', qty: 3 }).side, 'buy');
    assert.equal(normalizePosition({ symbol: 'MESZ6', avgPrice: 7600, openPnl: 12.5 }).avg_fill_price, 7600);
  });

  it('flattens quote rows', () => {
    const q = normalizeQuoteRow({ s: 'ok', n: 'MESZ6', v: { lp: 7612, bid: 7611.75, ask: 7612, ch: 37.5, chp: 0.49, high_price: 7618.25, low_price: 7546, open_price: 7585.5, prev_close_price: 7574.5, volume: 794177 } });
    assert.equal(q.symbol, 'MESZ6');
    assert.equal(q.last, 7612);
    assert.equal(q.bid, 7611.75);
    assert.equal(q.change_pct, 0.49);
    assert.equal(q.volume, 794177);
  });
});

describe('parseAccountLabel', () => {
  it('parses the two-line innerText form with high confidence', () => {
    assert.deepEqual(parseAccountLabel('APEX10121500000184\n50,895.79 USD'), { label: 'APEX10121500000184', equity: 50895.79, confidence: 'high' });
  });

  it('parses the single-line spaced form', () => {
    assert.deepEqual(parseAccountLabel('APEX10121500000184 50,895.79 USD'), { label: 'APEX10121500000184', equity: 50895.79, confidence: 'high' });
  });

  it('flags glued digit labels as low confidence', () => {
    const r = parseAccountLabel('PAAPEX101215000004225,042.86USD');
    assert.equal(r.confidence, 'low');
    assert.ok(r.label.startsWith('PAAPEX1012150000'));
  });

  it('disambiguates a glued label with the state equity', () => {
    // 25,589.25 from the state poll splits the run-together bar text exactly
    assert.deepEqual(splitGluedLabel('LDI0255993802000125,589.25USD', 25589.25), { label: 'LDI02559938020001', equity: 25589.25 });
    // a non-matching equity cannot disambiguate
    assert.equal(splitGluedLabel('LDI0255993802000125,589.25USD', 999), null);
    // an already-spaced string splits harmlessly to the same label/equity
    assert.deepEqual(splitGluedLabel('APEX10121500000184 50,895.79 USD', 50895.79), { label: 'APEX10121500000184', equity: 50895.79 });
  });

  it('returns nulls for unrelated text', () => {
    assert.deepEqual(parseAccountLabel('NinjaTrader'), { label: null, equity: null, confidence: null });
  });
});

describe('cache + getters', () => {
  it('answers from a fresh ingest without touching CDP', async () => {
    _resetCache();
    ingestedState();
    const r = await getState({ _deps: DOWN_DEPS });
    assert.equal(r.success, true);
    assert.equal(r.balance, 50895.79);
    assert.equal(r.unrealized_pl, 0);
    assert.equal(r.account_id, 'D69532036');
    assert.equal(r.stale, false);
    assert.equal(r.source, 'page-poll');
  });

  it('ignores non-ok envelopes', async () => {
    _resetCache();
    assert.equal(ingest(STATE_URL, { s: 'error', d: null }), false);
    await assert.rejects(() => getState({ waitMs: 50, _deps: DOWN_DEPS }), /No state traffic/);
  });

  it('returns stale data with its true age when the tap is down', async () => {
    _resetCache();
    ingest(STATE_URL, stateBody(), Date.now() - 60_000);
    const r = await getState({ waitMs: 50, _deps: DOWN_DEPS });
    assert.equal(r.stale, true);
    assert.ok(r.age_ms >= 59_000);
  });

  it('normalizes positions, orders and quotes end to end', async () => {
    _resetCache();
    ingest(POSITIONS_URL, { s: 'ok', d: [{ instrument: 'MESZ6', qty: 1, avgPrice: 7600.25, unrealizedPl: 12.5 }] });
    ingest(ORDERS_URL, { s: 'ok', d: ORDER_ROWS });
    ingest(QUOTES_URL, { s: 'ok', d: [{ n: 'MESZ6', v: { lp: 7612, bid: 7611.75, volume: 794177 } }] });

    const p = await getPositions({ _deps: DOWN_DEPS });
    assert.equal(p.count, 1);
    assert.equal(p.positions[0].side, 'buy');

    const o = await getOrders({ _deps: DOWN_DEPS });
    assert.equal(o.count, 2);
    assert.equal(o.orders[0].status, 'filled');

    const working = await getOrders({ include_terminal: false, _deps: DOWN_DEPS });
    assert.equal(working.count, 0, 'filled and cancelled are terminal');

    const q = await getQuotes({ _deps: DOWN_DEPS });
    assert.equal(q.count, 1);
    assert.equal(q.quotes[0].last, 7612);

    const filtered = await getQuotes({ symbol: 'NOPE', _deps: DOWN_DEPS });
    assert.equal(filtered.count, 0);
  });

  it('filters by account id', async () => {
    _resetCache();
    ingest(STATE_URL, stateBody({ equity: 1 }), Date.now());
    const other = 'https://tv-demo.tradovateapi.com/accounts/D999/state';
    ingest(other, stateBody({ equity: 2 }), Date.now() + 1);
    const r = await getState({ accountId: 'D999', _deps: DOWN_DEPS });
    assert.equal(r.equity, 2);
    assert.equal(r.account_id, 'D999');
  });
});

function ingestedState() {
  ingest(STATE_URL, stateBody());
}

describe('getAccount', () => {
  it('pairs the display label with the polled broker account id', async () => {
    _resetCache();
    ingestedState();
    const deps = {
      listPages: async () => [], // never attach in tests
      evaluate: async () => ({ label: null, equity: null, broker: 'NinjaTrader', manager_open: true, raw: 'APEX10121500000184\n50,895.79 USD' }),
    };
    const r = await getAccount({ _deps: deps });
    assert.equal(r.connected, true);
    assert.equal(r.label, 'APEX10121500000184');
    assert.equal(r.broker_account_id, 'D69532036');
    assert.equal(r.broker, 'NinjaTrader');
    assert.equal(r.pairing_confidence, 'high');
    assert.equal(r.equity, 50895.79);
  });

  it('knows the account id from quotes before any state poll lands', async () => {
    _resetCache();
    ingest(QUOTES_URL, { s: 'ok', d: [{ n: 'MESZ6', v: { lp: 7612 } }] });
    const deps = { listPages: async () => [], evaluate: async () => { throw new Error('no dom'); } };
    const r = await getAccount({ waitMs: 10, _deps: deps });
    assert.equal(r.connected, true);
    assert.equal(r.broker_account_id, 'D69532036');
  });

  it('prefers the accounts-endpoint name over a missing UI label', async () => {
    _resetCache();
    const ACCOUNTS_URL = 'https://tv-demo.tradovateapi.com/accounts?locale=en';
    ingest(ACCOUNTS_URL, { s: 'ok', d: [{ id: 'D69532036', name: 'APEX10121500000184', type: 'live', prefix: 'NINJATRADER' }] });
    ingest(QUOTES_URL, { s: 'ok', d: [{ n: 'MESZ6', v: { lp: 7612 } }] });
    const deps = { listPages: async () => [], evaluate: async () => { throw new Error('panel closed'); } };
    const r = await getAccount({ waitMs: 10, _deps: deps });
    assert.equal(r.label, 'APEX10121500000184');
    assert.equal(r.pairing_source, 'accounts-endpoint');
    assert.equal(r.broker_account_id, 'D69532036');
    assert.deepEqual(r.broker_accounts.map((a) => a.label), ['APEX10121500000184']);
  });

  it('the accounts-endpoint name beats a truncated UI label, and the conflict is reported', async () => {
    _resetCache();
    const ACCOUNTS_URL = 'https://tv-demo.tradovateapi.com/accounts?locale=en';
    ingest(ACCOUNTS_URL, { s: 'ok', d: [{ id: 'D69532036', name: 'APEX10121500000184', type: 'live', prefix: 'NINJATRADER' }] });
    ingest(QUOTES_URL, { s: 'ok', d: [{ n: 'MESZ6', v: { lp: 7612 } }] });
    const deps = {
      listPages: async () => [],
      // the manager bar text lost its last digit
      evaluate: async () => ({ label: null, equity: null, broker: 'NinjaTrader', manager_open: true, raw: 'APEX1012150000018\n50,895.79 USD' }),
    };
    const r = await getAccount({ waitMs: 10, _deps: deps });
    assert.equal(r.label, 'APEX10121500000184');
    assert.equal(r.pairing_source, 'accounts-endpoint');
    assert.equal(r.pairing_confidence, 'high');
    assert.equal(r.label_conflict, true);
    assert.equal(r.ui_label, 'APEX1012150000018');
    assert.equal(r.pairs.find((p) => p.broker_account_id === 'D69532036').label, 'APEX10121500000184');
  });

  it('answers not-connected without throwing when nothing is known', async () => {
    _resetCache();
    const deps = { listPages: async () => [], evaluate: async () => { throw new Error('CDP down'); } };
    const r = await getAccount({ waitMs: 50, _deps: deps });
    assert.equal(r.connected, false);
    assert.equal(r.label, null);
    assert.equal(r.broker_account_id, null);
    assert.match(r.cdp_error, /CDP down/);
  });
});
