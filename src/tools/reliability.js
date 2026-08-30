import { z } from 'zod';
import { A } from './_annotations.js';
import { op } from './_registry.js';
import { toolFromRegistry } from './index.js';
import { jsonResult, errorResult } from './_format.js';
import { compatibilityReport, diagnostics, COMPAT_SCHEMA_VERSION } from '../core/reliability.js';

export function registerReliabilityTools(server) {
  op('tv_compatibility_report', 'Per-TV-build compatibility matrix: probes each TradingView surface (chart, pine_editor, strategy_tester, paper, alerts) and reports healthy/degraded/unavailable with probe names and recommended actions. Answers "what exactly broke after the TradingView update" instead of unrelated tool failures.', {
    refresh: z.boolean().optional().describe('Reserved: re-run probes even when a fresh report is cached'),
  },
    A.READ, async ({ refresh }) => {
      try { return jsonResult(await compatibilityReport({ refresh })); }
      catch (err) { return errorResult(err); }
    }, { http: { path: '/compat', adapter: (_url, _deps) => compatibilityReport(_deps) } });
  toolFromRegistry(server, 'tv_compatibility_report');

  op('cdp_diagnostics', 'CDP connection diagnostics: connected target, desktop version, chart-mutation lock owner, timing counters. Answers "slow because TradingView, CDP, transport, or repeated calls?" — read-only.', {},
    A.READ, async ({}) => {
      try { return jsonResult(await diagnostics()); }
      catch (err) { return errorResult(err); }
    }, { http: { path: '/diagnostics', adapter: (_url, _deps) => diagnostics(_deps) } });
  toolFromRegistry(server, 'cdp_diagnostics');
}

export { COMPAT_SCHEMA_VERSION };