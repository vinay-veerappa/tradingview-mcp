import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerLiveResources } from '../src/resources/live.js';
import { getActiveProfile } from '../src/tools/_profiles.js';

// boot(): register + connect; BOTH ends closed and the notifier stopped before
// the test returns — otherwise the poll loop's pending sleep timer keeps the
// node event loop alive and the test runner never exits.
async function boot(opts = {}) {
  const server = new McpServer({ name: 't', version: '0' });
  const client = new Client({ name: 'c', version: '0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const handle = registerLiveResources(server, {
    intervalMs: 50,
    _deps: { evaluate: async () => null, ...(opts || {}) },
  });
  await Promise.all([server.connect(a), client.connect(b)]);
  return {
    server, client,
    async shutdown() {
      handle.stop?.();
      await Promise.allSettled([server.close?.(), client.close?.()]);
    },
  };
}

describe('live resources (P2-11/P2-12)', () => {
  test('three observables registered: state, quote, capabilities', async () => {
    const { client, shutdown } = await boot({ evaluate: async () => null });
    const { resources } = await client.listResources();
    const uris = resources.map((r) => r.uri).sort();
    assert.deepEqual(uris, ['tradingview://capabilities', 'tradingview://chart/quote', 'tradingview://chart/state']);
    await shutdown();
  });

  test('capabilities resource reads through without CDP', async () => {
    const { client, shutdown } = await boot({ evaluate: async () => null });
    const res = await client.readResource({ uri: 'tradingview://capabilities' });
    const body = JSON.parse(res.contents[0].text);
    assert.equal(body.success, true);
    assert.ok(Array.isArray(body.capabilities), 'capability inventory attached');
    assert.ok(typeof body.profile === 'string');
    await shutdown();
  });

  test('unknown resource read fails cleanly', async () => {
    const { client, shutdown } = await boot({ evaluate: async () => null });
    await assert.rejects(
      () => client.readResource({ uri: 'tradingview://bogus' }),
      /not found/,
    );
    await shutdown();
  });

  test('notifier survives TV offline (subscribe retries, server stays healthy)', async () => {
    const server = new McpServer({ name: 't', version: '0' });
    const client = new Client({ name: 'c', version: '0' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const handle = registerLiveResources(server, {
      intervalMs: 10,
      _deps: {
        evaluate: async () => { throw new Error('ECONNREFUSED'); },
        sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20))),
      },
    });
    await Promise.all([server.connect(a), client.connect(b)]);
    await new Promise((r) => setTimeout(r, 120));
    const { resources } = await client.listResources();
    assert.equal(resources.length, 3, 'server healthy after notifier ran against dead CDP');
    handle.stop(); // terminate the notifier loop explicitly
    await Promise.allSettled([server.close?.(), client.close?.()]);
  });

  test('notifier sends resource-updated when quote content changes', async () => {
    const server = new McpServer({ name: 't', version: '0' });
    const client = new Client({ name: 'c', version: '0' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    // Fake market: mutating price each poll (~ deterministic emission) at
    // 20ms effective interval; evaluate returns the last value of the
    // quote FETCH_JS — notifier dedupes on the whole payload, so a fresh
    // close forces a change event.
    let seq = 0;
    const handle = registerLiveResources(server, {
      intervalMs: 20,
      _deps: {
        evaluate: async () => ({ close: 7724 + (seq++) * 0.25, symbol: 'TEST', time: Date.now() }),
        sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20))),
      },
    });
    const uris = [];
    client.fallbackNotificationHandler = (n) => {
      if (n?.method === 'notifications/resources/updated') uris.push(n.params.uri);
    };
    await Promise.all([server.connect(a), client.connect(b)]);
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(uris.includes('tradingview://chart/quote'), `expected quote notifications, got ${uris.join(', ')}`);
    handle.stop();
    const count = uris.length;
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(uris.length, count, 'notifications stop after handle.stop()');
    await Promise.allSettled([server.close?.(), client.close?.()]);
  });
});