/**
 * MCP resources (P2-11) + live update notifier (P2-12).
 *
 * Resources = observation; tools = action/parameters. Each resource reads
 * through to the SAME core handler as its tool twin (one source of truth).
 * A single live-notifier consumes subscribe('quote') and pings
 * sendResourceUpdated when quote content changes; connection lost/restored
 * also touch chart/state. One notifier per server; the poll loop dies with
 * the process — server-level, so clients receive notifications only while
 * connected.
 */
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { subscribe } from '../core/subscribe.js';
import { listCapabilities } from '../capabilities.js';
import { getActiveProfile } from '../tools/_profiles.js';

// Lazy read-through handlers — one per resource URI, mirroring the tool twins.
const READERS = {
  'tradingview://chart/state': async () => {
    const { getState } = await import('../core/chart.js');
    return getState();
  },
  'tradingview://chart/quote': async () => {
    const { getQuote } = await import('../core/data.js');
    return getQuote();
  },
  'tradingview://capabilities': async () => ({
    profile: (await import('../tools/_profiles.js')).getActiveProfile(),
    capabilities: listCapabilities(),
  }),
};

function readByUri(uri) {
  const read = READERS[uri];
  if (!read) throw new McpError(-32602, `unknown resource ${uri} (known: ${Object.keys(READERS).join(', ')})`);
  return read();
}

/**
 * Register resource endpoints + ONE shared live-notifier per server.
 * The notifier consumes subscribe('quote') (dedup'd); quote-content changes
 * notify tradingview://chart/quote subscribers, and connection lost/restored
 * additionally touch chart/state. Server close ends the loop; TV being
 * offline means no notifications — never a crashed server.
 */
export function registerLiveResources(server, { intervalMs = 500, _deps = null } = {}) {
  // MCP resources = observation surface. Registered through the SDK's typed
  // registerResource API (raw setRequestHandler needs protocol schemas).
  server.registerResource('chart-state', 'tradingview://chart/state', {
    description: 'Chart state (symbol/timeframe/type/studies) — read-only observable',
    mimeType: 'application/json',
  }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify({ success: true, ...(await readByUri('tradingview://chart/state')) }) }],
  }));

  server.registerResource('chart-quote', 'tradingview://chart/quote', {
    description: 'Current quote (last bar + change) — updated live via notifications',
    mimeType: 'application/json',
  }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify({ success: true, ...(await readByUri('tradingview://chart/quote')) }) }],
  }));

  server.registerResource('capabilities', 'tradingview://capabilities', {
    description: 'MCP capabilities + active profile — static except profile_set',
    mimeType: 'application/json',
  }, async (uri) => ({
    contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify({ success: true, ...(await readByUri('tradingview://capabilities')) }) }],
  }));

  // Shared notifier loop (one per server). Terminates on server close (the
  // SDK Server emits 'close') or via the returned stop() — a dead CDP means
  // no notifications, never a crashed server or a hot loop.
  const notify = (uri) => { server.server.sendResourceUpdated({ uri }); };
  let disposed = false;
  try { server.server.on?.('close', () => { disposed = true; }); } catch { /* no emitter */ }
  (async () => {
    try {
      for await (const event of subscribe('quote', {
        interval: intervalMs,
        dedupe: true,
        _deps,
        shouldStop: () => disposed,
      })) {
        if (event.kind === 'connection') notify('tradingview://chart/state');
        else notify('tradingview://chart/quote');
      }
    } catch { /* shutting down */ }
  })();

  return {
    started: true,
    stop: () => { disposed = true; },
  };
}