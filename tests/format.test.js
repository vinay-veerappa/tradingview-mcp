import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  jsonResult,
  errorResult,
  buildErrorEnvelope,
  CDP_ERROR_REASONS,
  RESERVED_CODES,
} from '../src/tools/_format.js';
import { CdpError } from '../src/connection.js';

// ---------- jsonResult dual-form (P2-3) ----------

test('jsonResult: plain object gets dual form', () => {
  const r = jsonResult({ success: true, price: 100 });
  assert.equal(r.content[0].type, 'text');
  assert.deepEqual(JSON.parse(r.content[0].text), { success: true, price: 100 });
  assert.deepEqual(r.structuredContent, { success: true, price: 100 });
  assert.equal(r.isError, undefined);
});

test('jsonResult: isError flag preserved', () => {
  const r = jsonResult({ success: false }, true);
  assert.equal(r.isError, true);
  assert.deepEqual(r.structuredContent, { success: false });
});

test('jsonResult: array payload falls back to text-only', () => {
  const r = jsonResult([1, 2, 3]);
  assert.deepEqual(JSON.parse(r.content[0].text), [1, 2, 3]);
  assert.equal(r.structuredContent, undefined);
});

test('jsonResult: class instance falls back to text-only (not plain)', () => {
  class Foo { constructor() { this.x = 1; } }
  const r = jsonResult(Object.assign(new Foo(), { extra: 2 }));
  assert.equal(r.structuredContent, undefined);
  assert.ok(r.content[0].text.includes('"extra": 2'));
});

// ---------- error envelope mapping table (P2-4, frozen contract) ----------

test('mapping table: exactly the frozen reason set', () => {
  assert.deepEqual(Object.keys(CDP_ERROR_REASONS).sort(), [
    'cdp_command_failed',
    'cdp_timeout',
    'execution_context_lost',
    'navigation_invalidated',
    'target_replaced',
  ]);
});

test('reserved codes are defined and stable', () => {
  assert.deepEqual([...RESERVED_CODES], ['precondition_failed', 'state_changed']);
});

for (const [reason, meta] of Object.entries(CDP_ERROR_REASONS)) {
  test(`envelope for CdpError reason=${reason}`, () => {
    const err = new CdpError(reason, `label failed: ${reason}`);
    const r = errorResult(err);
    assert.equal(r.isError, true);
    const e = r.structuredContent.error;
    assert.equal(r.structuredContent.success, false);
    assert.equal(e.code, reason);
    assert.equal(e.retryable, meta.retryable);
    assert.equal(e.outcome_unknown, false);
    assert.equal(e.suggested_action, meta.suggested_action);
    // dual form: text is valid JSON carrying the same envelope
    assert.deepEqual(JSON.parse(r.content[0].text), r.structuredContent);
  });
}

test('outcome_unknown suppresses retryability and tells the agent to reconcile', () => {
  const err = new CdpError('cdp_timeout', 'op failed', { outcomeUnknown: true });
  const env = buildErrorEnvelope(err);
  assert.equal(env.error.outcome_unknown, true);
  assert.equal(env.error.retryable, false);
  assert.match(env.error.suggested_action, /Outcome unknown/);
});

test('transport retry evidence is preserved', () => {
  const err = new CdpError('target_replaced', 'gone');
  err.transport_reconnect_attempted = true;
  err.transport_reconnected = false;
  const env = buildErrorEnvelope(err);
  assert.equal(env.error.reconnect_attempted, true);
  assert.equal(env.error.reconnected, false);
});

test('plain Errors are classified by message backstop', () => {
  assert.equal(buildErrorEnvelope(new Error('Request timed out after 10s')).error.code, 'cdp_timeout');
  assert.equal(buildErrorEnvelope(new Error('Execution context was destroyed')).error.code, 'execution_context_lost');
  assert.equal(buildErrorEnvelope(new Error('WebSocket is not open')).error.code, 'target_replaced');
  assert.equal(buildErrorEnvelope(new Error('something odd')).error.code, 'cdp_command_failed');
});

test('cdp_command_failed is not retryable', () => {
  const env = buildErrorEnvelope(new CdpError('cdp_command_failed', 'bad request'));
  assert.equal(env.error.retryable, false);
});

test('context extras: suggested overrides, target_id and chart attach', () => {
  const env = buildErrorEnvelope(new Error('nope'), {
    target_id: 'T1',
    chart: { symbol: 'CME_MINI:NQ1!', timeframe: '5' },
    suggested: 'Open the DOM panel first.',
  });
  assert.equal(env.error.target_id, 'T1');
  assert.deepEqual(env.error.chart, { symbol: 'CME_MINI:NQ1!', timeframe: '5' });
  assert.equal(env.error.suggested_action, 'Open the DOM panel first.');
});

test('errorResult never throws on garbage input', () => {
  const r = errorResult(undefined);
  assert.equal(r.isError, true);
  assert.equal(r.structuredContent.success, false);
  assert.ok(r.structuredContent.error.message.length > 0);
});