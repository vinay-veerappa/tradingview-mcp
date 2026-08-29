/**
 * Tool annotations (P2-13) — the MCP safety vocabulary, centralized so the
 * registry migration (step 5) can lift them from one table.
 *
 * Access classes mirror the plan's access taxonomy:
 *   read        → observable, idempotent, no side effects
 *   mutate      → changes chart/account UI state, idempotent where noted
 *   destructive → removes/overwrites prior state (default-deny for clients)
 *   open-world  → arbitrary page JS; most dangerous surface
 *
 * The SDK passes annotations through to tools/list verbatim (probed on
 * SDK 1.27.1); clients use them for confirmation/safety policy.
 */

export const A = {
  READ: Object.freeze({
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  }),
  // Chart identity flips: re-applying the same value is a no-op.
  MUTATE_IDEMPOTENT: Object.freeze({
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  }),
  // Place/modify: NOT idempotent unless the caller supplies client_order_id.
  MUTATE_ORDER: Object.freeze({
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  }),
  DESTRUCTIVE: Object.freeze({
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  }),
  OPEN_WORLD: Object.freeze({
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  }),
  // Launch/update: touches the host machine, not just the page.
  SYSTEM: Object.freeze({
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  }),
};