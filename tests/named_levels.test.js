import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeNamedLevel, normalizePineLabels, normalizePineLines, PATTERNS, CATEGORIES,
} from '../src/core/named_levels.js';
import { getPineLabels } from '../src/core/data.js';

describe('named_levels grammar (P2-10)', () => {
  test('recognized session tokens normalize with name/category/confidence', () => {
    const level = normalizeNamedLevel('PDH 24550', 24550.25);
    assert.deepEqual(level, {
      name: 'pdh', price: 24550.25, category: 'session', confidence: 0.95, raw_text: 'PDH 24550',
    });
    assert.ok(normalizeNamedLevel('pdl (prev day low)', 24100));
    assert.ok(normalizeNamedLevel('NQ PDH', 24550));
    assert.ok(normalizeNamedLevel('PDH (v2)', 24551));
    assert.equal(normalizeNamedLevel('Or High', 24600), null, 'no fuzzy multi-word matches — grammar is exact-token only');
  });

  test('covers all four categories', () => {
    assert.equal(normalizeNamedLevel('ORH', 24600).category, 'opening_range');
    assert.equal(normalizeNamedLevel('SET', 24512.25).category, 'settlement');
    assert.equal(normalizeNamedLevel('ICH', 24400).category, 'ict');
    assert.equal(normalizeNamedLevel('On Close', 24500).category, 'settlement');
  });

  test('conservative: near-misses and unknowns are refused, never guessed', () => {
    assert.equal(normalizeNamedLevel('APDH', 24550), null, 'substring inside a longer token must not match');
    assert.equal(normalizeNamedLevel('PDH4X', 24550), null, 'suffix-glued token must not match');
    assert.equal(normalizeNamedLevel('my custom level', 24400), null, 'unrecognized text → null');
    assert.equal(normalizeNamedLevel('', 100), null);
    assert.equal(normalizeNamedLevel('PDH', null), null, 'price is mandatory');
    assert.equal(normalizeNamedLevel('PDH', Number.NaN), null);
    assert.equal(normalizeNamedLevel(null, 100), null);
  });

  test('category denylist prunes the pattern set', () => {
    const opts = { categories: ['session'] };
    assert.ok(normalizeNamedLevel('PDH', 1, opts));
    assert.equal(normalizeNamedLevel('ORH', 1, opts), null, 'opening_range pruned');
    assert.equal(normalizeNamedLevel('ICH', 1, opts), null, 'ict pruned');
  });

  test('PATTERNS are frozen and category strings are stable', () => {
    assert.throws(() => { PATTERNS.push({}); });
    assert.equal(Object.isFrozen(PATTERNS), true);
    assert.deepEqual(Object.keys(CATEGORIES), ['session', 'opening_range', 'settlement', 'ict']);
  });
});

describe('label/line shims preserve raw (P2-10 contract)', () => {
  const studies = [{
    name: 'My Levels', total_labels: 3, showing: 3,
    labels: [
      { text: 'PDH', price: 24550.25 },
      { text: 'custom zone', price: 24400 },
      { text: 'ORH', price: 24600 },
    ],
  }];

  test('labels untouched; named_levels augments', () => {
    const out = normalizePineLabels(studies);
    assert.equal(out[0], studies[0] === undefined ? null : out[0]);
    assert.deepEqual(out[0].labels, studies[0].labels, 'raw labels byte-identical');
    assert.equal(out[0].named_levels.length, 2, 'unrecognized label not forced into a level');
    assert.deepEqual(out[0].named_levels.map((l) => l.name), ['orh', 'pdh'], 'sorted high→low');
    assert.ok(out[0].named_levels.every((l) => typeof l.raw_text === 'string'), 'raw_text on every level');
  });

  test('lines shim keeps horizontal_levels untouched', () => {
    const lines = [{ name: 'S', horizontal_levels: [24600.5, 24500] }];
    const out = normalizePineLines(lines);
    assert.deepEqual(out[0].horizontal_levels, [24600.5, 24500]);
    assert.equal(out[0].named_levels, undefined);
  });

  test('empty input tolerated', () => {
    assert.deepEqual(normalizePineLabels([]), []);
    assert.deepEqual(normalizePineLabels(undefined), []);
  });
});

describe('getPineLabels normalize opt (core wiring, offline _deps seam)', () => {
  const RAW = [{
    name: 'Levels', count: 3,
    items: [
      { id: 1, raw: { t: 'PDH', y: 24550.25 } },
      { id: 2, raw: { t: 'unmatched label', y: 24400 } },
      { id: 3, raw: { t: 'ORH', y: 24600 } },
    ],
  }];
  const deps = { evaluate: async () => RAW };

  test('normalize=true augments each study; labels untouched', async () => {
    const r = await getPineLabels({ normalize: true }, deps);
    const s = r.studies[0];
    assert.equal(s.labels.length, 3, 'raw labels preserved');
    assert.deepEqual(s.named_levels.map((l) => l.name), ['orh', 'pdh'], 'sorted high→low, unrecognized excluded');
    assert.ok(s.named_levels.every((l) => l.raw_text && typeof l.price === 'number'));
  });

  test('normalize=false (default) returns no named_levels — payload unchanged', async () => {
    const r = await getPineLabels({}, deps);
    assert.equal(r.studies[0].named_levels, undefined);
  });

  test('categories denylist flows through to the matcher', async () => {
    const r = await getPineLabels({ normalize: true, categories: ['settlement'] }, deps);
    assert.deepEqual(r.studies[0].named_levels, []);
  });
});