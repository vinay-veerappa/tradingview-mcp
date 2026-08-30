/**
 * Loopback HTTP gateway (gateway plan §2; P2-19-generated).
 *
 * The route table is DERIVED from the canonical operation registry
 * (_registry.js): only ops with an `http` transport binding appear. Read ops
 * bind GET; mutation-class ops bind POST/PATCH/DELETE but ONLY when the op
 * cites ADR 0001 (registry refuses otherwise) AND the server-level env gate
 * TV_GATEWAY_MUTATIONS=on is armed — otherwise mutation routes are NOT
 * INSTALLED (a request 404s, it does not 405). See docs/adr/0001-mutation-routes.md.
 *
 * Each op's http ADAPTER turns (url, _deps) into the same core call the MCP
 * handler makes — one source of truth per op, no per-transport handlers. The
 * `_deps` seam (failing injected evaluate) reaches core exactly as it did in
 * the first-slice hardcoded ROUTES table. Mutation adapters receive the
 * parsed JSON body as the 3rd argument.
 *
 * Hard rules:
 * - Binds 127.0.0.1 only. No auth beyond loopback (ADR 0001 §3: refusing
 *   non-loopback peers is the entire escalation story; no tokens introduced).
 * - Mutations require BOTH the ADR-cited op binding and TV_GATEWAY_MUTATIONS=on.
 * - Non-loopback peers cannot mutate even when the flag is on (http_forbidden).
 * - Every JSON response is the stable envelope ({success, ...} or
 *   {success:false, error:{code, message, retryable, ...}}).
 */
import http from 'http';
import { subscribe, SUBSCRIPTION_KINDS } from '../core/subscribe.js';
import { getActiveProfile } from '../tools/_profiles.js';
import { listCapabilities } from '../capabilities.js';
import { buildErrorEnvelope } from '../tools/_format.js';
import { httpRoutes } from '../tools/_registry.js';

/**
 * ADR 0001 gate — server-level mutation posture. Pure function over (env,
 * addresses) so tests can exercise it without sockets: mutations are bindable
 * only when TV_GATEWAY_MUTATIONS is exactly 'on' AND the peer is loopback.
 */
export function mutationsAuthorized(env, remoteAddress) {
  return env?.TV_GATEWAY_MUTATIONS === 'on'
    && (remoteAddress === '127.0.0.1' || remoteAddress === '::1' || remoteAddress === '::ffff:127.0.0.1');
}

/** Non-loopback peers are refused mutation access even with the flag on. */
export function isLoopback(remoteAddress) {
  return remoteAddress === '127.0.0.1' || remoteAddress === '::1' || remoteAddress === '::ffff:127.0.0.1';
}

function json(res, status, payload, extraHeaders = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...extraHeaders });
  res.end(JSON.stringify(payload));
}

/** Read + parse a JSON request body (mutation routes only). */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 1_000_000) { // 1 MB cap — no legit order needs this
        reject(Object.assign(new Error('request body too large'), { code: 'http_bad_request' }));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!body.trim()) return resolve({});
      try { resolve(JSON.parse(body)); }
      catch { reject(Object.assign(new Error('invalid JSON body'), { code: 'http_bad_request' })); }
    });
    req.on('error', () => reject(Object.assign(new Error('request aborted'), { code: 'http_bad_request' })));
  });
}

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

export async function handleRequest(req, res, _deps = null, _env = process.env) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const pathMatch = url.pathname.match(/^\/stream\/([a-z]+)$/);
  const routes = httpRoutes();
  const route = routes.find((r) => r.path === url.pathname && r.method === req.method);
  // Route exists under a DIFFERENT method → 405; no route at all → 404.
  const methodMatchesAnother = !route && routes.some((r) => r.path === url.pathname);
  const knownPath = Boolean(pathMatch) || Boolean(route) || methodMatchesAnother
    || url.pathname === '/health' || url.pathname === '/capabilities';

  if (req.method === 'GET') {
    if (!knownPath) {
      json(res, 404, { success: false, error: { code: 'http_not_found', message: `no route ${url.pathname}`, retryable: false } });
      return;
    }
    if (pathMatch) {
      await handleStream(req, res, pathMatch[1], url, _deps);
      return;
    }
    if (url.pathname === '/health') {
      json(res, 200, { success: true, gateway: 'up', profile: getActiveProfile() });
      return;
    }
    // /capabilities: not an op (no CDP); static introspection over the registry
    // + profile state. Kept as a gateway-native route beside the derived table.
    if (url.pathname === '/capabilities') {
      json(res, 200, {
        success: true,
        profile: getActiveProfile(),
        capabilities: listCapabilities(),
        ops_registered: routes.length,
      });
      return;
    }
    // GET on a registered read route → derived read adapter. A known path
    // whose routes are all POST/PATCH/DELETE (mutation-only, ADR 0001) falls
    // through to the shared 405 branch below.
    if (!route) {
      // fall through: handled by the mutation-posture 405 branch below
    } else {
      try {
        const data = await route.adapter(url, _deps);
        json(res, 200, data ?? { success: true });
      } catch (err) {
        // P2-4: same stable error envelope as the MCP layer — CdpError
        // fidelity (reason → code, retryable, outcome_unknown) is preserved.
        json(res, 502, buildErrorEnvelope(err));
      }
      return;
    }
  }

  // ── Mutation dispatch (ADR 0001) ─────────────────────────────────────────
  // Only POST/PATCH/DELETE reach here, and only on ops whose registry entry
  // carries meta.mutation_adr (op() refuses the binding otherwise). Absent
  // the env gate the response is 404 (route not installed), per ADR §3;
  // a non-loopback peer gets 403 even with the flag on.
  if (route) {
    if (!mutationsAuthorized(_env, req.socket?.remoteAddress)) {
      const loopback = isLoopback(req.socket?.remoteAddress);
      json(res, loopback ? 404 : 403, {
        success: false,
        error: {
          code: loopback ? 'http_mutations_disabled' : 'http_forbidden',
          message: loopback
            ? 'mutations over HTTP are disabled (start the gateway with TV_GATEWAY_MUTATIONS=on; ADR 0001)'
            : 'mutations are loopback-only (ADR 0001 §3)',
          retryable: false,
        },
      });
      return;
    }
    try {
      const body = await readBody(req);
      const data = await route.adapter(url, _deps, body, req);
      json(res, 200, data ?? { success: true });
    } catch (err) {
      // Malformed body → 400; adapter/core failures → P2-4 envelope.
      if (err?.code === 'http_bad_request') {
        json(res, 400, { success: false, error: { code: 'http_bad_request', message: err.message, retryable: false } });
      } else {
        json(res, 502, buildErrorEnvelope(err));
      }
    }
    return;
  }

  // Known path, wrong method (e.g. GET on a POST-only mutation route, or
  // POST on a read route): 405 with Allow naming what WOULD work.
  if (knownPath) {
    const allowed = routes.filter((r) => r.path === url.pathname).map((r) => r.method);
    const extra = allowed.length ? { Allow: [...new Set([...allowed, 'GET' /* stream/health reads */])].join(', ') } : {};
    json(res, 405, {
      success: false,
      error: {
        code: 'http_method_not_allowed',
        message: req.method === 'GET' && methodMatchesAnother
          ? `route exists but expects ${routes.find((r) => r.path === url.pathname).method}`
          : 'gateway serves GET for reads; mutations only when TV_GATEWAY_MUTATIONS=on (ADR 0001)',
        retryable: false,
      },
    }, extra);
    return;
  }

  json(res, 404, { success: false, error: { code: 'http_not_found', message: `no route ${url.pathname}`, retryable: false } });
}

/**
 * Start the gateway. Returns { port, server, close } — close() terminates all
 * SSE subscribers (shouldStop) and the listener.
 * @param {object} opts { port, host, _deps }
 * @param {object} _env ADR 0001 test seam: the env the mutation gate reads
 *   (defaults to process.env). TV_GATEWAY_MUTATIONS === 'on' arms mutations.
 */
export function startGateway({ port = GATEWAY_DEFAULT_PORT, host = '127.0.0.1', _deps = null, _env = process.env } = {}) {
  // _deps threads into every CDP-backed handler + subscribe (house seam):
  // offline tests inject a failing evaluate so no real connection is made.
  const server = http.createServer((req, res) => handleRequest(req, res, _deps, _env));
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