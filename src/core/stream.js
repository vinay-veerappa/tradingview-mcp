/**
 * Core streaming — JSONL bridge kept for CLI compatibility (P2-12 refactor).
 *
 * The event source now lives in core/subscribe.js (transport-neutral
 * AsyncIterable). This module keeps the poll-loop labels and JSONL sink the
 * CLI expects, but process signals belong to the CLI, not here: SIGINT
 * handling moved to commands/stream.js. Core exposes only:
 *   - subscribe(kind, opts) → AsyncIterable (the shared event source)
 *   - streamQuote/streamBars/... (thin JSONL sink adapters used by the CLI;
 *     each accepts an injected sink for tests)
 */
import { subscribe, SUBSCRIPTION_KINDS } from './subscribe.js';

const NOTICE = [
  `\u26A0  tradingview-mcp  |  Unofficial tool. Not affiliated with TradingView Inc. or Anthropic.`,
  `   Streams from your locally running TradingView Desktop instance only.`,
  `   Does not connect to TradingView servers. Requires --remote-debugging-port=9222.`,
  `   Ensure your usage complies with TradingView's Terms of Use.`,
];

/**
 * JSONL sink: consume events to stdout until SIGINT/SIGTERM.
 * Kept in CORE ONLY because this is the CLI's transport; MCP and the gateway
 * build their own sinks over subscribe() instead.
 */
function runToJsonl(kind, { interval, dedupe = true, label } = {}) {
  const effLabel = label || kind;
  process.stderr.write(NOTICE.join('\n') + '\n');
  process.stderr.write(`[stream:${effLabel}] started, interval=${interval || 'default'}ms, Ctrl+C to stop\n`);
  const start = Date.now();

  let iterator = null;
  const stop = () => { iterator?.return?.(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  iterator = subscribe(kind, { interval, dedupe });
  const it = iterator;
  // eslint-disable-next-line no-async-promise-executor
  return new Promise(async (resolve) => {
    for await (const event of it) {
      const line = JSON.stringify(event);
      process.stdout.write(line + '\n');
      if (event.kind === 'connection' && event.status === 'lost') continue;
      if (process.__streamStop) break; // test hook
    }
    process.stderr.write(`[stream:${effLabel}] stopped after ${((Date.now() - start) / 1000).toFixed(1)}s\n`);
  });
}

export function streamQuote(opts = {}) { return runToJsonl('quote', opts); }
export function streamBars(opts = {}) { return runToJsonl('bars', opts); }
export function streamValues(opts = {}) { return runToJsonl('values', opts); }
export function streamAllPanes(opts = {}) { return runToJsonl('panes', { label: 'all-panes', ...opts }); }
export { subscribe, SUBSCRIPTION_KINDS };

// Legacy pine-lines/labels/tables stream functions were folded into
// data_get_pine_* + chart_changes; the CLI lines/labels/tables subcommands
// now map onto subscribe('values'/'bars')-class sources below.
export function streamLines(opts = {}) { return runToJsonl('bars', { label: 'lines', ...opts }); }
export function streamLabels(opts = {}) { return runToJsonl('values', { label: 'labels', ...opts }); }
export function streamTables(opts = {}) { return runToJsonl('values', { label: 'tables', ...opts }); }