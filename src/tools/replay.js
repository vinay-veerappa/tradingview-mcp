import { z } from 'zod';
import { jsonResult } from './_format.js';
import * as core from '../core/replay.js';

// deps injection (from #429) lets tests drive the SDK boundary with a fake
// env/evaluate/getReplayApi; omitted in production so core falls back to the
// real connection plumbing.
export function registerReplayTools(server, _deps = null) {
  const d = () => _deps || undefined;

  server.tool('replay_start', 'Start bar replay mode, optionally at a specific date and exact time', {
    date: z.string().optional().describe('Date to start replay from (YYYY-MM-DD or YYYY-MM-DDTHH:mm:ss format). If omitted, selects first available date.'),
    time: z.string().optional().describe('Optional exact time string in HH:mm or HH:mm:ss format (e.g. 09:30:00)'),
    timestamp: z.number().optional().describe('Optional Unix timestamp in seconds or milliseconds')
  }, async ({ date, time, timestamp }) => {
    try { return jsonResult(await core.start({ date, time, timestamp, _deps: d() })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('replay_step', 'Advance one bar in replay mode', {}, async () => {
    try { return jsonResult(await core.step(d())); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('replay_autoplay', 'Toggle autoplay in replay mode, optionally set speed', {
    speed: z.coerce.number().optional().describe('Autoplay delay in ms (lower = faster). Valid values: 100, 143, 200, 300, 1000, 2000, 3000, 5000, 10000. Leave empty to just toggle.'),
  }, async ({ speed }) => {
    try { return jsonResult(await core.autoplay({ speed, _deps: d() })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('replay_stop', 'Stop replay and return to realtime', {}, async () => {
    try { return jsonResult(await core.stop(d())); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('replay_trade', 'Execute a trade action in replay mode (buy, sell, or close position)', {
    // z.unknown(): validation belongs to core.trade's gate+enum order (capability
    // check BEFORE action validation, #429) — a typed schema here would reject at
    // the SDK layer and hide which guard fired.
    action: z.unknown().optional().describe('Simulated Bar Replay action: buy, sell, or close'),
  }, async ({ action }) => {
    try { return jsonResult(await core.trade({ action, _deps: d() })); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });

  server.tool('replay_status', 'Get current replay mode status', {}, async () => {
    try { return jsonResult(await core.status(d())); }
    catch (err) { return jsonResult({ success: false, error: err.message }, true); }
  });
}