import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildErrorEnvelope, errorResult } from '../src/tools/_format.js';

describe('precondition_failed envelope (P2-5)', () => {
  const preErr = (() => {
    const e = new Error('Chart identity changed since inspection: expected_symbol: expected "AAPL", chart shows "MSFT"');
    e.name = 'CdpError';
    e.reason = 'precondition_failed';
    e.live_identity = { symbol: 'MSFT', timeframe: '5' };
    return e;
  })();

  test('reserved code flows through verbatim', () => {
    const env = buildErrorEnvelope(preErr);
    assert.equal(env.error.code, 'precondition_failed');
  });

  test('is not retryable as-is (agent must re-read first)', () => {
    const env = buildErrorEnvelope(preErr);
    assert.equal(env.error.retryable, false);
  });

  test('live identity is attached', () => {
    const env = buildErrorEnvelope(preErr);
    assert.deepEqual(env.error.live_identity, { symbol: 'MSFT', timeframe: '5' });
  });

  test('suggested action guides re-read + fresh preconditions', () => {
    const env = buildErrorEnvelope(preErr);
    assert.match(env.error.suggested_action, /fresh preconditions|re-read|Verify current state/i);
  });

  test('passes through errorResult intact (dual form)', () => {
    const r = errorResult(preErr);
    assert.equal(r.isError, true);
    assert.equal(r.structuredContent.error.code, 'precondition_failed');
    assert.deepEqual(JSON.parse(r.content[0].text), r.structuredContent);
  });

  test('generic errors are NOT swallowed by the reserved-code branch', () => {
    const env = buildErrorEnvelope(new Error('Request timed out after 10s'));
    assert.equal(env.error.code, 'cdp_timeout');
    assert.equal(env.error.retryable, true);
  });
});