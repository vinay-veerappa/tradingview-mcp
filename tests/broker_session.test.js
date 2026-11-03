/**
 * Broker session control (login/logout) — offline tests with a scripted client.
 * No CDP: the client object records clicks and answers evaluations.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { login, logout, readCredential } from '../src/core/broker_session.js';
import { requireBrokerSession, BROKER_SESSION_ENV, BROKER_SESSION_ACK } from '../src/capabilities.js';

const ACCOUNT = 'LTT2TH7A0Q6';
const PASSWORD = 'secret13char';

function makeClient(script = {}) {
  const state = { cardClicked: false };
  const clicks = [];
  const client = {
    clicks,
    state,
    Input: {
      dispatchMouseEvent: async (ev) => { if (ev.type === 'mousePressed') { clicks.push({ x: ev.x, y: ev.y }); state.cardClicked = true; } },
      dispatchKeyEvent: async () => {},
    },
    Runtime: {
      evaluate: async ({ expression }) => {
        const value = route(expression, state, script);
        return { result: { value } };
      },
    },
  };
  return client;
}

function route(expr, state, script) {
  const s = String(expr);
  if (s.includes('set.call')) {
    return script.typed != null ? script.typed : JSON.stringify({ user: ACCOUNT, passLen: PASSWORD.length });
  }
  if (s.includes('passLen: idx >= 0')) {
    return script.recheck != null ? script.recheck : JSON.stringify({ user: ACCOUNT, passLen: PASSWORD.length });
  }
  if (s.includes('aria-pressed')) {
    return script.tabs || JSON.stringify({ live: { aria: false, clsActive: false }, demo: { aria: true, clsActive: true } });
  }
  if (s.includes('Trade with your broker')) return script.catalog === false ? false : true;
  if (s.includes('warning-dialog')) return false;
  if (s.includes("type === 'password'") && s.includes('width > 0')) return state.cardClicked;
  if (s.includes('Broker card - NinjaTrader')) return JSON.stringify({ x: 10, y: 20 });
  if (s.includes("=== 'Connect'")) return JSON.stringify({ x: 30, y: 40 });
  if (s.includes('Manage settings and connection')) return JSON.stringify({ x: 50, y: 60 });
  if (s.includes('Log out')) return JSON.stringify({ x: 70, y: 80 });
  if (s.includes('Close account manager')) return script.panelOpen === true;
  if (s.includes('Open account manager') || (s.includes('NinjaTrader') && s.includes('y > 1900'))) return JSON.stringify({ x: 90, y: 100 });
  if (s.includes('incorrect|wrong')) return script.errorText || null;
  return null;
}

const SESSION_DEPS = (client, accountState) => ({
  client,
  sleep: async () => {},
  credential: async () => ({ account: ACCOUNT, password: PASSWORD, target: 'test' }),
  account: async () => accountState,
});

describe('readCredential', () => {
  it('requires an account name for the tv source', async () => {
    await assert.rejects(() => readCredential({ source: 'tv' }), /requires an account name/);
  });
});

describe('login', () => {
  it('logs in through the form and reports the pairing', async () => {
    const client = makeClient();
    const r = await login({
      _deps: SESSION_DEPS(client, { connected: true, label: 'LDI02559938020001', broker_account_id: 'D68853007', pairing_source: 'ui' }),
    });
    assert.equal(r.ok, true);
    assert.equal(r.broker_account_id, 'D68853007');
    assert.equal(client.clicks.length, 2, 'card click + Connect click');
    assert.ok(r.steps.some((s) => s.includes('tap attached before connect')));
    assert.ok(!JSON.stringify(r).includes(PASSWORD), 'result must never contain the password');
  });

  it('refuses to submit when the form does not hold the typed pair', async () => {
    const client = makeClient({ typed: JSON.stringify({ user: 'OTHER', passLen: 2 }), recheck: JSON.stringify({ user: 'OTHER', passLen: 2 }) });
    const r = await login({ _deps: SESSION_DEPS(client, { connected: false }) });
    assert.equal(r.ok, false);
    assert.equal(r.error_kind, 'form_not_held');
    assert.equal(client.clicks.length, 1, 'only the card click; nothing submitted');
  });

  it('reports auth_failed when the broker shows an error', async () => {
    const client = makeClient({ errorText: 'Error! Incorrect username or password. Please try again.' });
    const r = await login({ _deps: SESSION_DEPS(client, { connected: false }) });
    assert.equal(r.ok, false);
    assert.equal(r.error_kind, 'auth_failed');
    assert.match(r.message, /Incorrect username or password/);
  });

  it('refuses when the Live tab appears selected', async () => {
    const client = makeClient({ tabs: JSON.stringify({ live: { aria: true, clsActive: false }, demo: { aria: false, clsActive: false } }) });
    const r = await login({ _deps: SESSION_DEPS(client, { connected: false }) });
    assert.equal(r.ok, false);
    assert.match(r.message, /Live tab appears selected/);
    assert.equal(client.clicks.length, 1);
  });
});

describe('logout', () => {
  it('opens the panel, logs out, and confirms polling stopped', async () => {
    const client = makeClient({ panelOpen: false });
    let connected = true;
    const deps = SESSION_DEPS(client, {});
    deps.account = async () => ({ connected });
    // after the Log out click, polling stops
    const orig = client.Input.dispatchMouseEvent;
    client.Input.dispatchMouseEvent = async (ev) => { await orig(ev); if (ev.type === 'mousePressed') connected = false; };
    const r = await logout({ _deps: deps });
    assert.equal(r.ok, true);
    assert.equal(r.connected, false);
    assert.ok(client.clicks.length >= 3, 'panel + menu + log out clicks');
  });

  it('fails closed when the connection never drops', async () => {
    const client = makeClient({ panelOpen: true });
    const deps = SESSION_DEPS(client, { connected: true });
    deps.account = async () => ({ connected: true });
    const r = await logout({ waitMs: 50, _deps: deps });
    assert.equal(r.ok, false);
    assert.match(r.message, /still connected/);
  });
});

describe('capability gate', () => {
  it('is closed by default and opens only with the ack value', () => {
    assert.throws(() => requireBrokerSession({}), /disabled/);
    assert.doesNotThrow(() => requireBrokerSession({ [BROKER_SESSION_ENV]: BROKER_SESSION_ACK }));
  });
});
