import { register } from '../router.js';
import { startGateway, GATEWAY_DEFAULT_PORT } from '../../gateway/http.js';

register('gateway', {
  description: 'Run the loopback HTTP gateway (read surface + SSE streams)',
  usage: 'tv gateway [--port 9223]',
  options: {
    port: { type: 'string', short: 'p', description: `HTTP port (default ${GATEWAY_DEFAULT_PORT})` },
  },
  handler: async (opts) => {
    const port = opts.port ? Number(opts.port) : GATEWAY_DEFAULT_PORT;
    const { port: bound, close } = await startGateway({ port });
    console.log(`tradingview-mcp gateway listening on http://127.0.0.1:${bound}`);
    console.log(`routes (registry-derived): /health, /state, /quote, /ohlcv, /values, /levels, /snapshot, /panes, /compat, /diagnostics, /pine/analyze, /paper/{status,account,positions,orders}, /stream/{quote|bars|values|panes}`);
    console.log('read-only: mutations are MCP/CLI-side by design. Ctrl-C to stop.');
    const shutdown = () => {
      close();
      process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    // never resolves: the gateway process owns the CDP connection while alive
    await new Promise(() => {});
  },
});