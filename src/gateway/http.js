/**
 * Loopback HTTP gateway (gateway plan §2; P2-19-generated).
 *
 * The route table is DERIVED from the canonical operation registry
 * (_registry.js): only ops with an `http` transport binding appear, and only
 * read-access ops can carry one (op() refuses otherwise). Mutations are
 * structurally excluded, so the §4.3 read-only rule holds by construction
 * until an ADR authorizes HTTP placements.
 *
 * Each op's http ADAPTER turns (url, _deps) into the same core call the MCP
 * handler makes — one source of truth per op, no per-transport handlers. The
 * `_deps` seam (failing injected evaluate) reaches core exactly as it did in
 * the first-slice hardcoded ROUTES table.
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
import { subscribe, SUBSCRIPTION_KINDS } from '../core/subscribe.js';
import { getActiveProfile } from '../tools/_profiles.js';
import { listCapabilities } from '../capabilities.js';
import { buildErrorEnvelope } from '../tools/_format.js';
import { httpRoutes } from '../tools/_registry.js';

export const GATEWAY_DEFAULT_PORT = 9223;

// SSE route: /stream/<kind> — subscribe() sink with disconnect cancellation.
const STREAM_KINDS = new Set(SUBSCRIPTION_KINDS);

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
  // Panel finding (r1): validate interval BEFORE the SSE handshake —
  // NaN falls back safely (falsy), but NEGATIVE values are truthy and feed
  // setTimeout a negative delay (hot loop). Bad values → 400 with envelope.
  let interval;
  const rawInterval = url.searchParams.get('interval');
  if (rawInterval != null) {
    interval = Number(rawInterval);
    if (!Number.isFinite(interval) || interval < 50) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: { code: 'http_bad_request', message: 'interval must be a number >= 50 (ms)', retryable: false } }));
      return;
    }
  }
  sseHead(res);
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
  } catch (err) {
    // Panel finding (r1): a subscriber exception must reach the client as an
    // error event, not a silently truncated stream.
    try {
      res.write(`event: error\ndata: ${JSON.stringify({ success: false, error: { code: 'upstream_failed', message: String(err?.message || err), retryable: true } })}\n\n`);
    } catch { /* socket gone */ }
  }
  try { res.end(); } catch { /* socket already closed */ }
}

export async function handleRequest(req, res, _deps = null) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const pathMatch = url.pathname.match(/^\/stream\/([a-z]+)$/);
  const routes = httpRoutes();

  // ONE guard that keeps the 404-vs-405 distinction — known routes (derived
  // read ops + /stream/<kind> + /health) get 405 on non-GET; unknown paths
  // 404 regardless of method. Allow header only when it names a usable method.
  const knownPath = Boolean(pathMatch) || routes.some((r) => r.path === url.pathname) || url.pathname === '/health' || url.pathname === '/capabilities';
  if (req.method !== 'GET') {
    // Mutations over HTTP are excluded by plan §4.3 until an ADR exists;
    // the registry makes non-read ops unbindable in the first place.
    // (Panel r2: omit Allow rather than sending Allow: undefined.)
    const headers = { 'Content-Type': 'application/json', ...(knownPath && { Allow: 'GET' }) };
    res.writeHead(knownPath ? 405 : 404, headers);
    res.end(JSON.stringify(knownPath
      ? { success: false, error: { code: 'http_method_not_allowed', message: 'gateway is read-only (mutations are MCP/CLI-only by design)', retryable: false } }
      : { success: false, error: { code: 'http_not_found', message: `no route ${url.pathname}`, retryable: false } }));
    return;
  }
  if (!knownPath) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: { code: 'http_not_found', message: `no route ${url.pathname}`, retryable: false } }));
    return;
  }

  if (pathMatch) {
    await handleStream(req, res, pathMatch[1], url, _deps);
    return;
  }

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true, gateway: 'up', profile: getActiveProfile() }));
    return;
  }

  // /capabilities: not an op (no CDP); static introspection over the registry
  // + profile state. Kept as a gateway-native route beside the derived table.
  if (url.pathname === '/capabilities') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      success: true,
      profile: getActiveProfile(),
      capabilities: listCapabilities(),
      ops_registered: httpRoutes().length,
    }));
    return;
  }

  const route = routes.find((r) => r.path === url.pathname);
  try {
    // Adapter = the op's HTTP transport binding (declared beside the op in the
    // registry): turns (url, _deps) into the same core call the MCP handler
    // makes, returning the raw payload. The offline _deps seam flows through.
    const data = await route.adapter(url, _deps);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data ?? { success: true }));
  } catch (err) {
    // P2-4: same stable error envelope as the MCP layer — CdpError fidelity
    // (reason → code, retryable, outcome_unknown) is preserved, not flattened.
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(buildErrorEnvelope(err)));
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