import { z } from 'zod';
import { A } from './_annotations.js';
import { op } from './_registry.js';
import { toolFromRegistry } from './index.js';
import { jsonResult, errorResult } from './_format.js';
import * as core from '../core/health.js';
import { update } from '../core/update.js';

export function registerHealthTools(server, { env = process.env } = {}) {
  op('tv_health_check', 'Check CDP connection to TradingView and return current chart state', {},
    A.READ, async () => {
      try { return jsonResult(await core.healthCheck()); }
      catch (err) { return errorResult(err, { suggested: 'TradingView is not running with CDP enabled. Use the tv_launch tool to start it automatically.' }); }
    }, { http: { path: '/health', adapter: () => core.healthCheck() } });
  toolFromRegistry(server, 'tv_health_check');

  op('tv_discover', 'Report which known TradingView API paths are available and their methods', {},
    A.READ, async () => {
      try { return jsonResult(await core.discover()); }
      catch (err) { return errorResult(err); }
    });
  toolFromRegistry(server, 'tv_discover');

  op('tv_ui_state', 'Get current UI state: which panels are open, what buttons are visible/enabled/disabled', {},
    A.READ, async () => {
      try { return jsonResult(await core.uiState()); }
      catch (err) { return errorResult(err); }
    });
  toolFromRegistry(server, 'tv_ui_state');

  op('tv_launch', 'Launch TradingView Desktop with Chrome DevTools Protocol (remote debugging) enabled. Auto-detects install location on Mac, Windows, and Linux, including Windows MSIX/Store installs. If a Store install blocks the debug port, automatically relaunches from a local package copy (result then includes msix_local_copy: true; the first fallback launch copies ~330MB one time, so it can take a minute).', {
    port: z.coerce.number().optional().describe('CDP port (default 9222)'),
    kill_existing: z.coerce.boolean().optional().describe('Kill existing TradingView instances first (default true)'),
  },
    A.SYSTEM, async ({ port, kill_existing }) => {
      try { return jsonResult(await core.launch({ port, kill_existing })); }
      catch (err) { return errorResult(err); }
    });
  toolFromRegistry(server, 'tv_launch');

  op('tv_update', 'Update this MCP server to the latest version: git fast-forward of origin/main + npm ci when dependencies changed. DISABLED by default because it pulls and runs remote code; requires an explicit startup capability opt-in. Refuses on non-git installs, dirty working trees, non-main branches, or diverged history. After a successful update the MCP server must be restarted to load the new code.', {},
    A.SYSTEM, async () => {
      try { return jsonResult(await update({ _deps: { env } })); }
      catch (err) { return errorResult(err); }
    });
  toolFromRegistry(server, 'tv_update');
}