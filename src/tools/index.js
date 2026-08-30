/**
 * Tool registration surface (P2-19).
 *
 * Each tool file registers its ops into the canonical operation registry
 * (_registry.js op()) AND mirrors them into the SDK registration table via
 * toolFromRegistry(). One definition per op; both transports derive from it.
 */
import { _resetForTest, getOp } from './_registry.js';
import { registerHealthTools } from './health.js';
import { registerSnapshotTools } from './snapshot.js';
import { registerChartTools } from './chart.js';
import { registerPineTools } from './pine.js';
import { registerDataTools } from './data.js';
import { registerCaptureTools } from './capture.js';
import { registerDrawingTools } from './drawing.js';
import { registerAlertTools } from './alerts.js';
import { registerBatchTools } from './batch.js';
import { registerReplayTools } from './replay.js';
import { registerIndicatorTools } from './indicators.js';
import { registerWatchlistTools } from './watchlist.js';
import { registerUiTools } from './ui.js';
import { registerPaneTools } from './pane.js';
import { registerTabTools } from './tab.js';
import { registerPaperTools } from './paper.js';
import { registerReliabilityTools } from './reliability.js';
import { registerPaneScanTools } from './pane_scan.js';

/**
 * Mirror one registry op into the SDK registration table. Used by the
 * registerXxxTools files (they pass their own server instance).
 */
export function toolFromRegistry(server, name) {
  const e = getOp(name);
  if (!e) throw new Error(`toolFromRegistry: op '${name}' not registered`);
  server.tool(name, e.description, e.inputSchema, e.annotations, e.handler);
}

export { _resetForTest };

export function registerAll(server, opts = {}) {
  // Fresh process → fresh registry (and a clean slate for re-registration in
  // tests): duplicate-op registration is the registry's own hard error.
  _resetForTest();
  registerHealthTools(server, opts);
  registerSnapshotTools(server, opts);
  registerChartTools(server, opts);
  registerPineTools(server, opts);
  registerDataTools(server, opts);
  registerCaptureTools(server, opts);
  registerDrawingTools(server, opts);
  registerAlertTools(server, opts);
  registerBatchTools(server, opts);
  registerReplayTools(server, opts);
  registerIndicatorTools(server, opts);
  registerWatchlistTools(server, opts);
  registerUiTools(server, opts);
  registerPaneTools(server, opts);
  registerTabTools(server, opts);
  registerPaperTools(server, opts);
  registerReliabilityTools(server, opts);
  registerPaneScanTools(server, opts);
}