import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { lookup, record, size, clear, normalizeOrderPreview } from '../src/core/_order_dedup.js';

beforeEach(() => clear());

describe('dedup store (P2-6)', () => {
  test('miss → record → identical hit', () => {
    clear();
    assert.equal(lookup('k1'), undefined);
    const outcome = { success: true, action: 'place_order', result: { order_id: 'X1' } };
    record('k1', outcome);
    assert.deepEqual(lookup('k1'), outcome);
  });

  test('null/empty key never records', () => {
    clear();
    record(null, { success: true });
    record('', { success: true });
    assert.equal(size(), 0);
  });

  test('non-object result never records', () => {
    clear();
    record('kx', 'not-an-object');
    assert.equal(size(), 0);
  });

  test('store is bounded (oldest evicted past cap)', () => {
    clear();
    for (let i = 0; i < 600; i++) record('bulk' + i, { n: i });
    assert.ok(size() <= 500, `bounded, got ${size()}`);
  });
});

describe('normalizeOrderPreview', () => {
  test('market order minimal shape', () => {
    const p = normalizeOrderPreview({ symbol: 'NQ1!', side: 'buy', qty: 2 });
    assert.deepEqual(p, { symbol: 'NQ1!', side: 'buy', type: 'market', qty: 2, tif: 'DAY' });
  });

  test('limit/stop fields only on relevant types', () => {
    const p = normalizeOrderPreview({ symbol: 'S', side: 'sell', type: 'limit', qty: 1, price: 5000 });
    assert.equal(p.price, 5000);
    assert.equal(p.stop_price, undefined);
    const q = normalizeOrderPreview({ symbol: 'S', side: 'sell', type: 'stop_limit', qty: 1, price: 5000, stop_price: 4990 });
    assert.equal(q.price, 5000);
    assert.equal(q.stop_price, 4990);
  });

  test('brackets + tif preserved, numbers coerced', () => {
    const p = normalizeOrderPreview({ symbol: 'S', side: 'buy', qty: '1', take_profit: '10', stop_loss: '5', tif: 'WEEK' });
    assert.equal(p.take_profit, 10);
    assert.equal(p.stop_loss, 5);
    assert.equal(p.tif, 'WEEK');
    assert.equal(p.qty, 1);
  });

  test('context fills missing symbol, no clobber when provided', () => {
    assert.equal(normalizeOrderPreview({ side: 'buy', qty: 1 }, { symbol: 'CHARTSYM' }).symbol, 'CHARTSYM');
    assert.equal(normalizeOrderPreview({ symbol: 'EXPLICIT', side: 'buy', qty: 1 }, { symbol: 'OTHER' }).symbol, 'EXPLICIT');
  });
});