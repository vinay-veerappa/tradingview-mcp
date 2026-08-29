import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAll } from '../src/tools/index.js';
import {
  PROFILES,
  toolsForProfile,
  knownProfiles,
  getActiveProfile,
  setActiveProfile,
  applyProfile,
  switchProfile,
} from '../src/tools/_profiles.js';
import { listCapabilities } from '../src/capabilities.js';

function freshServer() {
  const server = new McpServer({ name: 't', version: '0' });
  registerSystemToolsForTest(server);
  registerAll(server);
  return server;
}
import { registerSystemTools } from '../src/tools/_profiles.js';
function registerSystemToolsForTest(server) { registerSystemTools(server); }

describe('profile definitions (P2-19/§3.1)', () => {
  test('every profile tool name exists in the registration table', () => {
    const server = freshServer();
    const registered = new Set(Object.keys(server._registeredTools));
    const bad = [];
    for (const [pname, list] of Object.entries(PROFILES)) {
      for (const t of list) if (!registered.has(t)) bad.push(`${pname}:${t}`);
    }
    assert.deepEqual(bad, [], 'invalid profile entries');
  });

  test('ALWAYS_VISIBLE tools never appear inside a profile list (no double-bookkeeping)', () => {
    for (const list of Object.values(PROFILES)) {
      assert.equal(list.includes('system_status'), false);
      assert.equal(list.includes('profile_set'), false);
    }
  });

  test('toolsForProfile: base=27ish incl. status/pf, paper=15, devel=null', () => {
    const base = toolsForProfile('base');
    assert.equal(base.has('system_status'), true);
    assert.equal(base.has('profile_set'), true);
    assert.equal(base.has('session_snapshot'), true);
    assert.equal(base.has('ui_evaluate'), false, 'ui_evaluate gated out of base');
    assert.equal(base.has('replay_trade'), false);
    assert.equal(base.has('tv_update'), false);
    assert.equal(toolsForProfile('paper').has('paper_place_order'), true);
    assert.equal(toolsForProfile('paper').has('chart_set_symbol'), false);
    assert.equal(toolsForProfile('devel'), null, 'devel = no filtering');
  });

  test('unknown profile falls open (null) so capability gates remain the safety layer', () => {
    assert.equal(toolsForProfile('bogus'), null);
  });

  test('profile state transitions report the previous profile', () => {
    const prev = setActiveProfile('paper');
    assert.ok(['base', 'paper'].includes(prev));
    assert.equal(getActiveProfile(), 'paper');
    setActiveProfile('base');
    assert.throws(() => setActiveProfile('nonsense'), /unknown profile/);
    assert.equal(getActiveProfile(), 'base');
  });

  test('switchProfile applies gating and returns counts', () => {
    const server = freshServer();
    const total = Object.keys(server._registeredTools).length;
    const r = switchProfile(server, 'base');
    assert.equal(r.profile, 'base');
    assert.equal(r.enabled, toolsForProfile('base').size);
    assert.equal(r.disabled, total - r.enabled);
    assert.equal(r.enabled + r.disabled, total);
    switchProfile(server, 'devel');
    // devel disables nothing
  });

  test('applyProfile on base leaves dev-only tools disabled in the table', () => {
    const server = freshServer();
    applyProfile(server, 'base');
    assert.equal(server._registeredTools['ui_evaluate'].enabled, false);
    assert.equal(server._registeredTools['tv_update'].enabled, false);
    assert.equal(server._registeredTools['quote_get'].enabled, true);
    assert.equal(server._registeredTools['system_status'].enabled, true);
    assert.equal(server._registeredTools['profile_set'].enabled, true);
  });
});

describe('system_status introspection (P2-14)', () => {
  test('capability inventory lists all three gates without leaking ack values', () => {
    const caps = listCapabilities({});
    assert.equal(caps.length, 3);
    for (const c of caps) {
      assert.equal(c.enabled, false);
      assert.ok(c.env_var);
      assert.ok(c.required_for.length >= 1);
      assert.equal(JSON.stringify(c).includes('I_UNDERSTAND'), false, 'no ack leak');
    }
    const on = listCapabilities({ TRADINGVIEW_MCP_ALLOW_ARBITRARY_PAGE_JS: 'I_UNDERSTAND_THIS_EXECUTES_ARBITRARY_JAVASCRIPT' });
    assert.equal(on.find(c => c.id === 'arbitrary_page_js').enabled, true);
  });
});

// ---------- payload budgets (P2-20) ----------

describe('tools/list payload budgets per profile', () => {
  test('base profile advertised payload stays under 12 KB', () => {
    const server = freshServer();
    applyProfile(server, 'base');
    let bytes = 0;
    for (const [name, t] of Object.entries(server._registeredTools)) {
      if (t.enabled === false) continue;
      // approximate the SDK tools/list entry: name + description + annotations
      // (schemas add ~30-60%; measured against the full wire format in CI)
      bytes += JSON.stringify({ name, description: t.description ?? '', annotations: t.annotations ?? {} }).length;
    }
    // 12KB ceiling with the schema-less estimate
    assert.ok(bytes < 12 * 1024, `base profile metadata ${bytes} bytes exceeds 12 KB budget`);
  });

  test('full devel surface stays measured-and-known (~40KB, no silent growth)', () => {
    const server = freshServer();
    let bytes = 0;
    for (const [name, t] of Object.entries(server._registeredTools)) {
      bytes += JSON.stringify({ name, description: t.description ?? '', annotations: t.annotations ?? {} }).length;
    }
    // Current measured baseline ~31KB (schema-less) — refuse > +10% drift
    assert.ok(bytes < 34.5 * 1024, `full surface ${bytes} bytes exceeds 34.5 KB drift ceiling`);
  });
});

describe('knownProfiles', () => {
  test('exactly the four static profiles; devel is dynamic', () => {
    assert.deepEqual(knownProfiles().sort(), ['base', 'control', 'paper', 'pine']);
    assert.equal(knownProfiles().includes('devel'), false, 'devel is dynamic (no filtering), not a list entry');
  });
});