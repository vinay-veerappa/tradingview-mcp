import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { subscribe, SUBSCRIPTION_KINDS } from '../src/core/subscribe.js';

const noSleep = async () => {};

/** Scripted evaluate: yields payloads in order, then repeats the last. */
function script(payloads) {
  let i = 0;
  return async () => (i < payloads.length ? payloads[i++] : payloads[payloads.length - 1]);
}

describe('subscribe primitive (P2-12, F4 refactor)', () => {
  test('dedupe: unchanged payload emits once; changed payload re-emits', async () => {
    const events = [];
    for await (const ev of subscribe('quote', {
      interval: 1,
      _deps: { evaluate: script([{ close: 100 }, { close: 100 }, { close: 101 }]), sleep: noSleep },
      maxTicks: 2,
    })) {
      events.push(ev);
    }
    assert.equal(events.length, 2);
    assert.equal(events[0].close, 100);
    assert.equal(events[1].close, 101);
    assert.equal(events[0]._stream, 'quote');
  });

  test('connection-lost on CDP error, recovery event when the page returns', async () => {
    let healthy = false;
    const events = [];
    for await (const ev of subscribe('quote', {
      interval: 1,
      _deps: {
        evaluate: async () => {
          if (events.length >= 1) { healthy = true; return { close: 55 }; }
          throw new Error('CDP WebSocket is not open');
    },
        sleep: noSleep,
      },
      maxTicks: 2,
      dedupe: false,
    })) {
      events.push(ev);
      if (events.length >= 2) break;
    }
    assert.equal(events[0].kind, 'connection');
    assert.equal(events[0].status, 'lost');
    assert.match(events[0].error, /WebSocket/);
    assert.equal(events[1].kind, 'connection');
    assert.equal(events[1].status, 'restored');
  });

  test('per-subscriber cancellation: break() exits cleanly with finite polls', async () => {
    let polls = 0;
    for await (const ev of subscribe('quote', {
      interval: 1,
      _deps: { evaluate: async () => { polls++; return { close: 1, n: polls }; }, sleep: noSleep },
      maxTicks: 100,
    })) {
      void ev;
      break;
    }
    assert.ok(polls <= 2, `exactly the events consumed, got ${polls} polls`);
  });

  test('SUBSCRIPTION_KINDS are exactly the four page-backed kinds', () => {
    assert.deepEqual([...SUBSCRIPTION_KINDS], ['quote', 'bars', 'values', 'panes']);
  });
});