import { jsonResult, errorResult } from './_format.js';
import { A } from './_annotations.js';
import { paneScan } from '../core/pane_scan.js';

export function registerPaneScanTools(server) {
  server.tool('pane_scan', 'Cross-pane layout monitor: ONE read over every pane in the active layout — symbol/timeframe, last + change, current-bar range, indicator values, bar freshness — without focusing or mutating anything. One dead pane degrades its own row; the scan still returns.', {},
    A.READ, async () => {
    try { return jsonResult(await paneScan()); }
    catch (err) { return errorResult(err); }
  });
}