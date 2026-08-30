/**
 * Transactional chart context (P2-2) — the process-wide chart-mutation lock.
 *
 * Generalizes the _quoteLock pattern in core/data.js: any operation that
 * mutates chart identity (symbol/timeframe) acquires ONE process-wide lock,
 * records the prior identity, applies requested state, waits for chart
 * readiness, runs the operation, detects external identity changes, and
 * restores the prior state in `finally` — win, lose, or throw.
 *
 * Every symbol-switching consumer migrates here (getQuote first; gateway
 * `?symbol=`, compound snapshots, and future callers follow). One lock per
 * process means no two consumers can interleave mutations of one chart.
 *
 * Identity is read via a caller-supplied deps object (evaluate/evaluateAsync/
 * waitForChartReady) so tests run fully offline — same seams the #449 manager
 * refactor established for connection.js consumers.
 */

import { CHART_IDENTITY_JS, extractIdentity, sameIdentity } from './_identity.js';

export function createChartContext({ evaluate, evaluateAsync, waitForChartReady } = {}) {
  if (typeof evaluate !== 'function') throw new Error('createChartContext: evaluate dep required');

  let _lock = Promise.resolve();
  let _owner = null; // diagnostic: current mutation owner label

  function ownerInfo() {
    return _owner ? { locked: true, owner: _owner } : { locked: false, owner: null };
  }

  /**
   * Read current chart identity { symbol, timeframe }. Best-effort: evaluate
   * failures yield nulls rather than throwing (restore must never depend on
   * a flaky read).
   */
  async function readIdentity() {
    try {
      return extractIdentity(await evaluate(CHART_IDENTITY_JS));
    } catch {
      return { symbol: null, timeframe: null };
    }
  }

  /**
   * Set chart symbol and/or timeframe. Timeframe first (cheaper), then
   * symbol — setSymbol triggers the heavier reload. Pass null to skip one.
   */
  async function applyIdentity({ symbol, timeframe }) {
    if (timeframe != null) {
      await evaluateAsync(`
        (function() {
          var chart = window.TradingViewApi._activeChartWidgetWV.value();
          return new Promise(function(resolve) {
            chart.setResolution(${JSON.stringify(String(timeframe))}, {});
            setTimeout(resolve, 500);
          });
        })()
      `);
      await waitForChartReady(null, timeframe);
    }
    if (symbol != null) {
      await evaluateAsync(`
        (function() {
          var chart = window.TradingViewApi._activeChartWidgetWV.value();
          return new Promise(function(resolve) {
            chart.setSymbol(${JSON.stringify(String(symbol))}, {});
            setTimeout(resolve, 500);
          });
        })()
      `);
      await waitForChartReady(symbol);
    }
  }

  /**
   * Run `op` while the chart temporarily shows { symbol, timeframe }.
   * Returns op's result plus { prior_context, external_change, restore_error }.
   *
   * Guarantees:
   * - restore touches ONLY what this transaction actually changed (a request
   *   that matches the live chart writes nothing);
   * - restore runs even when op throws (the flip may already have happened);
   * - the next queued transaction starts only after our restore completes;
   * - restore failures never mask the op result (reported as restore_error),
   *   and never mask the op error (swallowed on the failure path).
   */
  async function withChartContext(requested, op, { label = 'unnamed', signal } = {}) {
    return new Promise((resolve) => {
      // P2-18 slice: caller cancellation. The op races against the signal;
      // abort rejects the CALLER while the restore path still runs (the flip
      // may already have happened), so the chart is never left mutated by a
      // cancelled call. Nothing can kill a page-side evaluate mid-flight —
      // the op body may finish in the background — so this is caller-visible
      // cancellation, not op termination.
      const abortError = new Error(`withChartContext(${label}): aborted by caller`);
      abortError.name = 'AbortError';

      // Closure state shared by the op body and both restore paths:
      const txn = { prior: null, appliedSymbol: null, appliedTf: null };

      async function restoreIdentity() {
        if (txn.appliedSymbol == null && txn.appliedTf == null) return;
        await applyIdentity({
          symbol: txn.appliedSymbol != null ? txn.prior.symbol : null,
          timeframe: txn.appliedTf != null ? txn.prior.timeframe : null,
        });
      }

      const run = _lock.then(async () => {
        _owner = label;
        try {
          if (signal?.aborted) throw abortError;
          txn.prior = await readIdentity();
          const requestedIdentity = {
            symbol: requested?.symbol ?? null,
            timeframe: requested?.timeframe ?? null,
          };

          // Only mutate what differs; nothing requested => pure read, no flip.
          const needsSymbol = requestedIdentity.symbol != null &&
            !sameIdentity(txn.prior.symbol, requestedIdentity.symbol, 'symbol');
          const needsTf = requestedIdentity.timeframe != null &&
            !sameIdentity(txn.prior.timeframe, requestedIdentity.timeframe, 'timeframe');
          const flipped = needsTf || needsSymbol;

          if (needsTf) {
            txn.appliedTf = requestedIdentity.timeframe;
            await applyIdentity({ symbol: null, timeframe: requestedIdentity.timeframe });
          }
          if (needsSymbol) {
            txn.appliedSymbol = requestedIdentity.symbol;
            await applyIdentity({ symbol: requestedIdentity.symbol, timeframe: null });
          }

          // P2-18: race the op against caller abort. The op body may still
          // complete in the background (nothing can kill a running evaluate),
          // but the CALLER sees the rejection and restore runs immediately.
          const opP = Promise.resolve(op({ prior: txn.prior, applied: flipped }));
          let result;
          if (signal) {
            const abortP = new Promise((_, rej) => {
              if (signal.aborted) { rej(abortError); return; }
              signal.addEventListener('abort', () => rej(abortError), { once: true });
            });
            result = await Promise.race([opP, abortP]);
          } else {
            result = await opP;
          }

          // Post-op identity: detect whether anything else moved the chart
          // while we held it (agent UI interaction, a second TV window, etc.)
          let external_change = null;
          if (flipped) {
            const after = await readIdentity();
            const expectedAfter = {
              symbol: needsSymbol ? requestedIdentity.symbol : txn.prior.symbol,
              timeframe: needsTf ? requestedIdentity.timeframe : txn.prior.timeframe,
            };
            const moved =
              !sameIdentity(after.symbol, expectedAfter.symbol, 'symbol') ||
              !sameIdentity(after.timeframe, expectedAfter.timeframe, 'timeframe');
            if (moved) external_change = { expected: expectedAfter, observed: after };
          }

          return { result, external_change };
        } finally {
          _owner = null;
        }
      });

      // Restore path: runs whether the op succeeded or failed.
      let restore_error = null;
      const restore = run.then(
        async (outcome) => {
          try {
            await restoreIdentity();
          } catch (e) {
            restore_error = String(e?.message || e);
          }
          return {
            ...outcome,
            ...(restore_error && { restore_error }),
            prior_context: { ...txn.prior },
          };
        },
        async (err) => {
          try { await restoreIdentity(); } catch { /* op error takes precedence */ }
          throw err;
        }
      );
      restore.catch(() => {}); // consumed by caller via resolve(restore)

      _lock = _lock.then(() => {}, () => {}) // op done...
        .then(() => restore.catch(() => {})); // ...and restore done before next mutation

      resolve(restore);
    });
  }

  return { withChartContext, readIdentity, ownerInfo };
}

/**
 * Convenience wrapper for the common one-shot case: fresh context per call.
 * Note: callers that issue multiple context-scoped operations should create
 * ONE context (module scope) so they share the process-wide lock.
 */
export async function runWithContext(deps, requested, op, opts) {
  const ctx = createChartContext(deps);
  return ctx.withChartContext(requested, op, opts);
}