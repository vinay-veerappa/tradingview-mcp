import { z } from 'zod';
import { A } from './_annotations.js';
import { op } from './_registry.js';
import { toolFromRegistry } from './index.js';
import { jsonResult, errorResult } from './_format.js';
import * as core from '../core/capture.js';

export function registerCaptureTools(server) {
  op('capture_screenshot', 'Take a screenshot of the TradingView chart', {
    region: z.string().optional().describe('Region to capture: full, chart, strategy_tester (default full)'),
    filename: z.string().optional().describe('Custom filename (without extension)'),
    method: z.string().optional().describe('Capture method: cdp (Page.captureScreenshot) or api (chartWidgetCollection.takeScreenshot) (default cdp)'),
    wait_for_render: z.boolean().optional().describe('Wait for the chart canvas to stabilize before capturing. Use after chart_set_symbol or chart_set_timeframe to avoid stale frames.'),
  },
    A.READ, async ({ region, filename, method, wait_for_render }) => {
      try { return jsonResult(await core.captureScreenshot({ region, filename, method, waitForRender: wait_for_render })); }
      catch (err) { return errorResult(err); }
    });
  toolFromRegistry(server, 'capture_screenshot');
}