import { z } from 'zod';
import { A } from './_annotations.js';
import { op } from './_registry.js';
import { toolFromRegistry } from './index.js';
import { jsonResult, errorResult } from './_format.js';
import { sessionSnapshot, chartChanges, PRESETS } from '../core/snapshot.js';

export function registerSnapshotTools(server) {
  op('session_snapshot', 'One-call chart brief: identity, quote, OHLCV summary, chart state (type/studies), visible range, study values, Pine lines/labels/tables/boxes, alerts, strategy summary — with per-section status, per-section hashes, and a state-hash consistency check (retries once on mid-flight symbol/timeframe change; reports state_changed instead of mixing symbols). Use preset/include/exclude to control width.', {
    symbol: z.string().optional().describe('Temporarily switch the chart to this symbol for the snapshot (restored after)'),
    timeframe: z.string().optional().describe('Temporarily apply this timeframe for the snapshot (restored after)'),
    include: z.array(z.string()).optional().describe('Section list (quote, ohlcv_summary, chart_state, visible_range, study_values, pine_lines, pine_labels, pine_tables, pine_boxes, alerts, strategy_summary)'),
    exclude: z.array(z.string()).optional().describe('Sections to skip'),
    preset: z.enum(Object.keys(PRESETS)).optional().describe('Section preset (ignored when include is given)'),
    study_filter: z.string().optional().describe('Substring to filter Pine sections to one indicator (e.g., "Profiler")'),
    compact: z.boolean().optional().describe('Return per-section hashes instead of full payloads'),
  },
    A.READ, async (args, extra) => {
      // P2-18: MCP request cancellation — extra.signal (SDK RequestHandlerExtra)
      // flows into withChartContext; a cancelled call unwinds any chart flip.
      try { return jsonResult(await sessionSnapshot(args, { signal: extra?.signal })); }
      catch (err) { return errorResult(err); }
    }, { http: {
      path: '/snapshot',
      adapter: (url, _deps) => {
        const opts = {};
        for (const k of ['preset', 'symbol', 'timeframe', 'study_filter']) {
          const v = url.searchParams.get(k);
          if (v) opts[k] = v;
        }
        return sessionSnapshot(opts, _deps);
      },
    } });
  toolFromRegistry(server, 'session_snapshot');

  op('chart_changes', 'Diff the live chart against a prior session_snapshot without re-reading everything: pass since = prior snapshot_hash → returns changed/unchanged section lists plus a new snapshot hash.', {
    // z.object().passthrough(), NOT z.record(): SDK zod-compat cannot convert
    // record shapes (verified: tools/list throws "_zod of undefined").
    since: z.object({}).passthrough().describe('section_hashes map from a prior session_snapshot (or the prior snapshot object itself)'),
    include: z.array(z.string()).optional().describe('Restrict both collection and diff to these sections'),
    preset: z.string().optional().describe('Section preset (brief|analysis|strategy|pine_debug)'),
    study_filter: z.string().optional().describe('Filter Pine sections to one indicator'),
  },
    A.READ, async ({ since, include, exclude, preset, study_filter }) => {
      try { return jsonResult(await chartChanges({ since, include, exclude, preset, study_filter })); }
      catch (err) { return errorResult(err); }
    });
  toolFromRegistry(server, 'chart_changes');
}