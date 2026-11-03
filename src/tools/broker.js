/**
 * Broker surface (L-133) — read-only broker truth from the chart page's own
 * gateway polls. No broker request is issued, no authorization material is
 * read, and no order path exists here by construction.
 */
import { z } from 'zod';
import { A } from './_annotations.js';
import { op } from './_registry.js';
import { toolFromRegistry } from './index.js';
import { jsonResult, errorResult } from './_format.js';
import { requireBrokerSession } from '../capabilities.js';
import * as core from '../core/broker.js';
import * as session from '../core/broker_session.js';

const ACCOUNT_PARAM = z.string().optional()
  .describe('Broker account id (e.g. D69532036). Omit for the most recently polled account.');

const FRESHNESS_PARAMS = {
  max_age_ms: z.coerce.number().optional()
    .describe('Accept cached data up to this age without waiting (default 5000)'),
  wait_ms: z.coerce.number().optional()
    .describe('When the cache is stale, wait this long for the next poll (default 3000)'),
};

function readArgs(args) {
  return {
    accountId: args.account,
    maxAgeMs: args.max_age_ms,
    waitMs: args.wait_ms,
  };
}

export function registerBrokerTools(server) {
  op('tv_broker_state',
    'Broker account state from the chart page\'s own polls: balance, equity, unrealizedPl, account id. Read-only and cached; stale:true = last observed values with their age.',
    { account: ACCOUNT_PARAM, ...FRESHNESS_PARAMS },
    A.READ, async (args) => {
      try { return jsonResult(await core.getState(readArgs(args || {}))); }
      catch (err) { return errorResult(err); }
    }, {
      http: {
        path: '/broker/state',
        adapter: (url, _deps) => core.getState({
          accountId: url.searchParams.get('account') || undefined,
          maxAgeMs: url.searchParams.get('max_age_ms') ? Number(url.searchParams.get('max_age_ms')) : undefined,
          waitMs: url.searchParams.get('wait_ms') ? Number(url.searchParams.get('wait_ms')) : undefined,
          _deps,
        }),
      },
    });
  toolFromRegistry(server, 'tv_broker_state');

  op('tv_broker_positions',
    'Open broker positions, normalized (instrument, side, qty, avg fill, unrealized P&L). Read-only cache of the page\'s polls; empty means the broker reports flat.',
    { account: ACCOUNT_PARAM, ...FRESHNESS_PARAMS },
    A.READ, async (args) => {
      try { return jsonResult(await core.getPositions(readArgs(args || {}))); }
      catch (err) { return errorResult(err); }
    }, {
      http: {
        path: '/broker/positions',
        adapter: (url, _deps) => core.getPositions({
          accountId: url.searchParams.get('account') || undefined,
          maxAgeMs: url.searchParams.get('max_age_ms') ? Number(url.searchParams.get('max_age_ms')) : undefined,
          waitMs: url.searchParams.get('wait_ms') ? Number(url.searchParams.get('wait_ms')) : undefined,
          _deps,
        }),
      },
    });
  toolFromRegistry(server, 'tv_broker_positions');

  op('tv_broker_orders',
    'Broker orders, normalized (status, filled qty, avg fill, limit, stop). include_terminal:false = working only. Read-only: cannot place or cancel.',
    {
      account: ACCOUNT_PARAM,
      include_terminal: z.boolean().optional()
        .describe('false = only non-terminal orders (working). Default true = full list as the gateway reports it'),
      ...FRESHNESS_PARAMS,
    },
    A.READ, async (args) => {
      try {
        return jsonResult(await core.getOrders({
          ...readArgs(args || {}),
          include_terminal: args?.include_terminal !== false,
        }));
      } catch (err) { return errorResult(err); }
    }, {
      http: {
        path: '/broker/orders',
        adapter: (url, _deps) => core.getOrders({
          accountId: url.searchParams.get('account') || undefined,
          include_terminal: url.searchParams.get('include_terminal') !== 'false',
          maxAgeMs: url.searchParams.get('max_age_ms') ? Number(url.searchParams.get('max_age_ms')) : undefined,
          waitMs: url.searchParams.get('wait_ms') ? Number(url.searchParams.get('wait_ms')) : undefined,
          _deps,
        }),
      },
    });
  toolFromRegistry(server, 'tv_broker_orders');

  op('tv_broker_quotes',
    'Marks the trading panel subscribes to (last, bid, ask, OHLC, change, volume). Read-only cache; filter with symbol.',
    { symbol: z.string().optional().describe('Broker instrument, e.g. MESZ6'), account: ACCOUNT_PARAM, ...FRESHNESS_PARAMS },
    A.READ, async (args) => {
      try {
        return jsonResult(await core.getQuotes({
          ...readArgs(args || {}),
          symbol: args?.symbol || undefined,
        }));
      } catch (err) { return errorResult(err); }
    }, {
      http: {
        path: '/broker/quotes',
        adapter: (url, _deps) => core.getQuotes({
          accountId: url.searchParams.get('account') || undefined,
          symbol: url.searchParams.get('symbol') || undefined,
          maxAgeMs: url.searchParams.get('max_age_ms') ? Number(url.searchParams.get('max_age_ms')) : undefined,
          waitMs: url.searchParams.get('wait_ms') ? Number(url.searchParams.get('wait_ms')) : undefined,
          _deps,
        }),
      },
    });
  toolFromRegistry(server, 'tv_broker_quotes');

  op('tv_broker_account',
    'Broker identity: connected, label, broker, broker_account_id, equity, traffic age. Never throws for not-connected.',
    {
      refresh_pairing: z.boolean().optional()
        .describe('Open the trading panel briefly to capture the account label (one UI action, then collapse)'),
      wait_ms: z.coerce.number().optional().describe('How long to wait for the first gateway traffic (default 1500)'),
    },
    A.READ, async (args) => {
      try { return jsonResult(await core.getAccount({ refresh: args?.refresh_pairing === true, waitMs: args?.wait_ms })); }
      catch (err) { return errorResult(err); }
    }, {
      http: {
        path: '/broker/account',
        adapter: (url, _deps) => core.getAccount({
          refresh: url.searchParams.get('refresh_pairing') === 'true',
          waitMs: url.searchParams.get('wait_ms') ? Number(url.searchParams.get('wait_ms')) : undefined,
          _deps,
        }),
      },
    });
  toolFromRegistry(server, 'tv_broker_account');

  op('tv_broker_login',
    'Log in to the NinjaTrader broker through the trading panel UI. Credentials come from the NT8 launcher entry (source nt8) or TradingView\'s own store (source tv); nothing is submitted unless the form holds the typed pair. Gated by TV_BROKER_SESSION capability.',
    {
      source: z.enum(['nt8', 'tv']).optional().describe('Credential source (default nt8 = the launcher entry)'),
      account: z.string().optional().describe('Account name for source=tv (TradingView stores per account)'),
      wait_ms: z.coerce.number().optional().describe('Outcome wait after Connect (default 30000)'),
    },
    A.MUTATE_IDEMPOTENT, async (args) => {
      try {
        requireBrokerSession();
        const r = await session.login({ source: args?.source || 'nt8', account: args?.account, waitMs: args?.wait_ms });
        return jsonResult({ success: r.ok, ...r }, r.ok === false);
      } catch (err) { return errorResult(err); }
    });
  toolFromRegistry(server, 'tv_broker_login');

  op('tv_broker_logout',
    'Log out of the current broker connection through the trading panel menu. Verifies that gateway polling stops. Gated by TV_BROKER_SESSION capability.',
    {},
    A.MUTATE_IDEMPOTENT, async () => {
      try {
        requireBrokerSession();
        const r = await session.logout();
        return jsonResult({ success: r.ok, ...r }, r.ok === false);
      } catch (err) { return errorResult(err); }
    });
  toolFromRegistry(server, 'tv_broker_logout');
}
