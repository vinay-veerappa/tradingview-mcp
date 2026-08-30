import { z } from 'zod';
import { A } from './_annotations.js';
import { op } from './_registry.js';
import { toolFromRegistry } from './index.js';
import { jsonResult, errorResult } from './_format.js';
import * as core from '../core/drawing.js';
import { evaluate } from '../connection.js';
import { CHART_IDENTITY_JS, extractIdentity, checkPreconditions } from '../core/_identity.js';

// Destructive ops REQUIRE preconditions by default (P2-5): the caller must
// prove it knows which chart it is about to wipe. Overridable via env for
// backwards compatibility in trusted automation contexts.
const DRAW_CLEAR_REQUIRE_PRECONDITIONS =
  process.env.TV_DRAW_CLEAR_PRECONDITIONS !== 'off';

async function preconditionFailure(expected, env) {
  const live = extractIdentity(await evaluate(env?.CHART_IDENTITY_JS || CHART_IDENTITY_JS));
  const failures = checkPreconditions(expected, live);
  if (!failures.length) return null;
  const err = new Error(
    `Chart identity changed since inspection: ` +
    failures.map(f => `${f.field}: expected ${JSON.stringify(f.expected)}, chart shows ${JSON.stringify(f.actual)}`).join('; ') +
    `. Re-read chart state and retry with fresh preconditions.`
  );
  err.name = 'CdpError';
  err.reason = 'precondition_failed';
  err.live_identity = live;
  return err;
}

const preconditionShape = {
  expected_symbol: z.string().optional().describe('Refuse unless the chart currently shows this symbol (use what a prior read returned)'),
  expected_timeframe: z.string().optional().describe('Refuse unless the chart timeframe matches (e.g. "5", "D")'),
};

export function registerDrawingTools(server) {
  op('draw_shape', 'Draw a shape/line on the chart', {
    shape: z.string().describe('Shape type: horizontal_line, vertical_line, trend_line, rectangle, text'),
    point: z.object({ time: z.coerce.number(), price: z.coerce.number() }).describe('{ time: unix_timestamp, price: number }'),
    point2: z.object({ time: z.coerce.number(), price: z.coerce.number() }).optional().describe('Second point for two-point shapes (trend_line, rectangle)'),
    overrides: z.string().optional().describe('JSON string of style overrides (e.g., \'{"linecolor": "#ff0000", "linewidth": 2}\')'),
    text: z.string().optional().describe('Text content for text shapes'),
  },
    A.MUTATE_IDEMPOTENT, async ({ shape, point, point2, overrides, text }) => {
      try { return jsonResult(await core.drawShape({ shape, point, point2, overrides, text })); }
      catch (err) { return errorResult(err); }
    });
  toolFromRegistry(server, 'draw_shape');

  op('draw_list', 'List all shapes/drawings on the chart', {},
    A.READ, async () => {
      try { return jsonResult(await core.listDrawings()); }
      catch (err) { return errorResult(err); }
    });
  toolFromRegistry(server, 'draw_list');

  op('draw_clear', 'Remove all drawings from the chart. DESTRUCTIVE: requires expected_symbol (and optionally expected_timeframe) to confirm which chart is being wiped — refuses if the chart moved since your last read.', {
    ...preconditionShape,
    confirm: z.boolean().optional().describe('Must be true — double-tap for a destructive, chart-wide action'),
  },
    A.DESTRUCTIVE, async ({ expected_symbol, expected_timeframe, confirm }) => {
      try {
        if (DRAW_CLEAR_REQUIRE_PRECONDITIONS && (!expected_symbol || confirm !== true)) {
          const err = new Error(
            'draw_clear requires expected_symbol (identity precondition) and confirm: true. ' +
            'Read chart state first, then pass expected_symbol from that read.'
          );
          err.name = 'CdpError';
          err.reason = 'precondition_failed';
          err.suggested_fix = 'chart_get_state → re-submit with { expected_symbol, confirm: true }';
          return errorResult(err);
        }
        const preErr = await preconditionFailure({ expected_symbol, expected_timeframe });
        if (preErr) throw preErr;
        return jsonResult(await core.clearAll());
      }
      catch (err) { return errorResult(err); }
    });
  toolFromRegistry(server, 'draw_clear');

  op('draw_remove_one', 'Remove a specific drawing by entity ID', {
    entity_id: z.string().describe('Entity ID of the drawing to remove (from draw_list)'),
  },
    A.DESTRUCTIVE, async ({ entity_id }) => {
      try { return jsonResult(await core.removeOne({ entity_id })); }
      catch (err) { return errorResult(err); }
    });
  toolFromRegistry(server, 'draw_remove_one');

  op('draw_get_properties', 'Get properties and points of a specific drawing', {
    entity_id: z.string().describe('Entity ID of the drawing (from draw_list)'),
  },
    A.READ, async ({ entity_id }) => {
      try { return jsonResult(await core.getProperties({ entity_id })); }
      catch (err) { return errorResult(err); }
    });
  toolFromRegistry(server, 'draw_get_properties');
}