/**
 * Aggregated tool registration (P2-13) — one import surface for server.js,
 * the annotation coverage test, and (at step 5) the operation registry.
 */
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

export function registerAll(server) {
  registerHealthTools(server);
  registerSnapshotTools(server);
  registerChartTools(server);
  registerPineTools(server);
  registerDataTools(server);
  registerCaptureTools(server);
  registerDrawingTools(server);
  registerAlertTools(server);
  registerBatchTools(server);
  registerReplayTools(server);
  registerIndicatorTools(server);
  registerWatchlistTools(server);
  registerUiTools(server);
  registerPaneTools(server);
  registerTabTools(server);
  registerPaperTools(server);
  registerReliabilityTools(server);
}