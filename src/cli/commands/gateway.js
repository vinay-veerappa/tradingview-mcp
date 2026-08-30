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
    const mutationsArmed = process.env.TV_GATEWAY_MUTATIONS === 'on';
    console.log(`tradingview-mcp gateway listening on http://127.0.0.1:${bound}`);
    console.log(`routes (registry-derived): /health, /state, /quote, /ohlcv, /values, /levels, /snapshot, /panes, /compat, /diagnostics, /pine/analyze, /paper/{status,account,positions,orders}, /stream/{quote|bars|values|panes}`);
    if (mutationsArmed) {
      console.log('mutations (ADR 0001): ARMED — POST/PATCH paper routes live (/paper/orders, /orders/cancel, /positions/close, /paper/connect, PATCH /orders/modify, /brackets).');
      console.log('  place/close require client_order_id; non-loopback peers get 403; destructive ops stay MCP-only.');
      console.log('  SECURITY.md § HTTP Gateway Mutations: loopback is NOT auth — browser tabs can POST to localhost. Run armed only on a machine you trust.');
    } else {
      console.log('mutations (ADR 0001): DISABLED — paper mutation routes do not exist (404). Start with TV_GATEWAY_MUTATIONS=on to arm (see README "Why TV_GATEWAY_MUTATIONS exists").');
      console.log('  mutations remain available over MCP/CLI without any flag.');
    }
    console.log('Ctrl-C to stop.');
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