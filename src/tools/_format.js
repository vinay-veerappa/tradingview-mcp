/**
 * Shared MCP response formatting helpers.
 * All tool files use these instead of manually constructing MCP responses.
 *
 * jsonResult(obj, isError)
 *   Dual-form result (P2-3): the human-readable JSON text block (compat) plus
 *   `structuredContent` for schema-capable clients. Plain-serializable objects
 *   get both forms; anything else falls back to text-only.
 *
 * errorResult(err, context)
 *   Stable error envelope (P2-4): preserves CdpError fidelity (reason,
 *   outcome_unknown, transport retry evidence) instead of flattening to
 *   err.message. The reason→code mapping below is a FROZEN contract —
 *   unit-tested in tests/format.test.js; do not rename codes casually.
 */

const CDP_ERROR_REASONS = Object.freeze({
  cdp_timeout:          { retryable: true,  suggested_action: 'Retry the operation' },
  execution_context_lost: { retryable: true, suggested_action: 'Retry after reconnect; TradingView reloaded during evaluation' },
  navigation_invalidated: { retryable: true, suggested_action: 'Retry after the chart finished navigating' },
  target_replaced:      { retryable: true,  suggested_action: 'Run tv_health_check, then retry' },
  cdp_command_failed:   { retryable: false, suggested_action: 'Inspect inputs; failure was not transient' },
});

/**
 * REST-surface reasons (src/core/rest.js). Sibling table to the frozen CDP set
 * above — kept separate so the CDP contract test (tests/format.test.js) stays
 * exact while the upstream HTTP class gets its own codes. The distinction is
 * the point: "TV said no" must be separable from "the CDP transport broke".
 */
const REST_ERROR_REASONS = Object.freeze({
  upstream_http_error:  { retryable: false, suggested_action: 'The TradingView endpoint refused the request — check the symbol/params; this is not transient' },
  upstream_invalid_json:{ retryable: false, suggested_action: 'The endpoint returned a non-JSON body (likely an interstitial or a shape change); re-probe the surface' },
  upstream_timeout:     { retryable: true,  suggested_action: 'Retry; these endpoints are undocumented and may throttle' },
  upstream_unavailable: { retryable: true,  suggested_action: 'Retry; if it persists the host is down or the network is unreachable (the desktop app is NOT required for this call)' },
  ssr_payload_missing:  { retryable: false, suggested_action: 'The page SSR shape changed — this tool fails loudly rather than degrading; re-verify against docs/REST_DATA_SURFACES.md' },
  invalid_input:        { retryable: false, suggested_action: 'Fix the argument named in the message' },
  not_found:            { retryable: false, suggested_action: 'The symbol or id does not resolve; qualify it as EXCHANGE:TICKER' },
});

// Reserved for P2-5 mutation preconditions. Defined now so the error-code
// enum is stable before any caller can emit it.
const RESERVED_CODES = Object.freeze(['precondition_failed', 'state_changed']);

function buildErrorEnvelope(err, context = {}) {
  const isCdp = err && err.name === 'CdpError';
  // CdpError.reasons not in the CDAP map (e.g. the P2-5 reserved codes) flow
  // through verbatim as the code; generic errors get message classification.
  const reason = (isCdp && err.reason) || err?.reason || classifyGeneric(err);
  const reserved = RESERVED_CODES.includes(reason);
  const meta = CDP_ERROR_REASONS[reason] || REST_ERROR_REASONS[reason] || CDP_ERROR_REASONS.cdp_command_failed;
  const outcome_unknown = Boolean(err?.outcome_unknown);

  const envelope = {
    success: false,
    error: {
      code: reason,
      message: String(err?.message || err || 'Unknown error'),
      retryable: !reserved && (meta.retryable && !outcome_unknown),
      outcome_unknown,
      reconnect_attempted: Boolean(err?.transport_reconnect_attempted),
      reconnected: Boolean(err?.transport_reconnected),
      suggested_action: outcome_unknown
        ? 'Outcome unknown: verify state before retrying — a blind retry may duplicate the action'
        : (reserved
          ? (err?.suggested_fix || 'Verify current state, then retry with fresh preconditions')
          : meta.suggested_action),
    },
  };
  if (err?.live_identity) envelope.error.live_identity = err.live_identity;
  if (context.target_id) envelope.error.target_id = context.target_id;
  if (context.chart) envelope.error.chart = context.chart;
  if (context.suggested) envelope.error.suggested_action = String(context.suggested);
  if (context.source) envelope.error.source = String(context.source);
  return envelope;
}

function classifyGeneric(err) {
  const message = String(err?.message || err || '');
  if (/timed out|timeout/i.test(message)) return 'cdp_timeout';
  if (/execution context|context.*destroyed|cannot find context|contexts? cleared/i.test(message)) return 'execution_context_lost';
  if (/navigat|frame was detached|frame.*removed/i.test(message)) return 'navigation_invalidated';
  if (/target.*(?:closed|detached|destroyed)|session.*closed|websocket.*(?:closed|not open)|not connected/i.test(message)) return 'target_replaced';
  return 'cdp_command_failed';
}

/**
 * Build a failed MCP response from any thrown error.
 * CdpError properties (reason, outcome_unknown, transport retry flags) are
 * preserved; mutations must never auto-retry when outcome_unknown is true.
 */
export function errorResult(err, context = {}) {
  const envelope = buildErrorEnvelope(err, context);
  return {
    content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }],
    structuredContent: envelope,
    isError: true,
  };
}

export function jsonResult(obj, isError = false) {
  const isPlain =
    obj !== null && typeof obj === 'object' && !Array.isArray(obj) &&
    (obj.constructor === Object || obj.constructor === undefined);
  return {
    content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }],
    ...(isPlain && { structuredContent: obj }),
    ...(isError && { isError: true }),
  };
}

export { CDP_ERROR_REASONS, REST_ERROR_REASONS, RESERVED_CODES, buildErrorEnvelope };