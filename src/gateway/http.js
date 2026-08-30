/**
 * Loopback HTTP gateway (gateway plan §2, first slice).
 *
 * The read surface exposed over localhost HTTP with JSON responses, plus SSE
 * streams as sinks over the SAME subscribe() primitive the MCP resources and
 * CLI use (P2-12). Read-only BY DESIGN: mutations stay MCP/CLI-side until an
 * ADR authorizes HTTP placement (plan §4.3 exclusion).
 *
 * ROUTES is the embryonic registry for this transport: one table declaring
 * {method, path, handler, stream?}; every binding derives from it. Handlers
 * are the same core handlers the tool twins call — one source of truth.
 *
 * Hard rules:
 * - Binds 127.0.0.1 only. No auth beyond loopback (plan exclusion).
 * - No mutations: any non-GET → 405 with the error envelope.
 * - SSE cancellation on client disconnect (P2-18 slice): the subscriber's
 *   shouldStop fires on 'close' — no orphaned poll loops.
 * - Every JSON response is the stable envelope ({success, ...} or
 *   {success:false, error:{code, message, retryable, ...}}).
 */
import http from 'http';
import { getState } from '../core/chart.js';
import { getQuote } from '../core/data.js';
import { sessionSnapshot } from '../core/snapshot.js';
import { paneScan } from '../core/pane_scan.js';
import { compatibilityReport, diagnostics } from '../core/reliability.js';
import { subscribe, SUBSCRIPTION_KINDS } from '../core/subscribe.js';
import { getActiveProfile } from '../tools/_profiles.js';
import { listCapabilities } from '../capabilities.js';

export const GATEWAY_DEFAULT_PORT = 9223;

const ROUTES = [
  { method: 'GET', path: '/state', handler: (_req, _url, _deps) => getState({ _deps }) },
  { method: 'GET', path: '/quote', handler: (_req, _url, _deps) => getQuote({}, _deps) },
  { method: 'GET', path: '/snapshot', handler: (_req, url, _deps) => {
    const opts = {};
    if (url.searchParams.get('preset')) opts.preset = url.searchParams.get('preset');
    if (url.searchParams.get('symbol')) opts.symbol = url.searchParams.get('symbol');
    if (url.searchParams.get('timeframe')) opts.timeframe = url.searchParams.get('timeframe');
    return sessionSnapshot(opts, _deps);
  } },
  { method: 'GET', path: '/panes', handler: (_req, _url, _deps) => paneScan(_deps) },
  { method: 'GET', path: '/capabilities', handler: () => ({
      success: true,
      profile: getActiveProfile(),
      capabilities: listCapabilities(),
    }) },
  { method: 'GET', path: '/compat', handler: (_req, _url, _deps) => compatibilityReport(_deps) },
  { method: 'GET', path: '/diagnostics', handler: (_req, _url, _deps) => diagnostics(_deps) },
];

// SSE route: /stream/<kind> — subscribe() sink with disconnect cancellation.
const STREAM_KINDS = new Set(['quote', 'bars', 'values', 'panes']);

function sseHead(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write(':ok\n\n');
}

async function handleStream(req, res, kind, url, _deps = null) {
  if (!STREAM_KINDS.has(kind)) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: { code: 'http_not_found', message: `unknown stream kind '${kind}' (known: ${[...STREAM_KINDS].join(', ')})`, retryable: false } }));
    return;
  }
  sseHead(res);
  const interval = url.searchParams.get('interval') ? Number(url.searchParams.get('interval')) : undefined;
  const disconnected = { stop: false };
  // P2-18 slice: disconnect cancels the poll loop — BOTH ends (req for client
  // abort, res for server-side finish), so no orphaned subscriber survives.
  req.on('close', () => { disconnected.stop = true; });
  res.on('close', () => { disconnected.stop = true; });
  try {
    for await (const event of subscribe(kind, { interval, _deps, shouldStop: () => disconnected.stop })) {
      if (event.kind === 'connection') {
        res.write(`event: connection\ndata: ${JSON.stringify({ status: event.status })}\n\n`);
      } else {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
      if (disconnected.stop) break;
    }
  } catch {
    // client gone mid-write or subscriber error — nothing to do; loop already stopped
  }
  try { res.end(); } catch { /* socket already closed */ }
}

export async function handleRequest(req, res, _deps = null) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const pathMatch = url.pathname.match(/^\/stream\/([a-z]+)$/);

  if (pathMatch) {
    await handleStream(req, res, pathMatch[1], url, _deps);
    return;
  }

  if (!ROUTES.some((r) => r.path === url.pathname) && url.pathname !== '/health') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: { code: 'http_not_found', message: `no route ${url.pathname}`, retryable: false } }));
    return;
  }
  if (req.method !== 'GET') {
    // Mutations over HTTP are excluded by plan §4.3 until an ADR exists.
    res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'GET' });
    res.end(JSON.stringify({ success: false, error: { code: 'http_method_not_allowed', message: 'gateway is read-only (mutations are MCP/CLI-only by design)', retryable: false } }));
    return;
  }

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, gateway: 'up', profile: getActiveProfile() }));
    return;
  }

  const route = ROUTES.find((r) => r.path === url.pathname);
  try {
    const data = await route.handler(req, url, _deps);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data ?? { success: true }));
  } catch (err) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: { code: 'upstream_failed', message: String(err?.message || err), retryable: true } }));
  }
}

/**
 * Start the gateway. Returns { port, server, close } — close() terminates all
 * SSE subscribers (shouldStop) and the listener.
 */
export function startGateway({ port = GATEWAY_DEFAULT_PORT, host = '127.0.0.1', _deps = null } = {}) {
  // _deps threads into every CDP-backed handler + subscribe (house seam):
  // offline tests inject a failing evaluate so no real connection is made.
  const server = http.createServer((req, res) => handleRequest(req, res, _deps));
  const connections = new Set();
  server.on('connection', (conn) => {
    connections.add(conn);
    conn.on('close', () => connections.delete(conn));
  });
  const stopAll = () => { for (const c of connections) try { c.destroy(); } catch { /* done */ } };
  const closeServer = () => {
    stopAll(); // kill lingering SSE sockets so server.close() completes
    try { server.close(); } catch { /* already closed */ }
  };
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve({
      // Report the ACTUAL bound port — callers pass 0 for an ephemeral choice.
      port: server.address().port,
      server,
      close: closeServer,
    }));
  });
}