# ADR 0001 — Mutation routes over HTTP (lifting the gateway's structural read-only gate)

**Status:** Proposed
**Date:** 2026-08-29
**Supersedes:** none
**Related:** `docs/MCP_SURFACE_AND_GATEWAY_PLAN.md` §4.3 (out of scope), P2-4 (error contract),
P2-5 (mutation preconditions), P2-6 (paper idempotency), P2-19 (operation registry)

## Context

The loopback HTTP gateway is **read-only by design**, and since the P2-19 registry landed
this rule is *structural*, not conventional:

- `op()` in `src/tools/_registry.js` **refuses** an `http` transport on any op whose
  derived access is not `read` ("requires an authorizing ADR").
- It **refuses** non-GET methods outright ("mutations are unbindable for now").
- The plan's out-of-scope list (§5, carried from v2 §7) names the escape hatch:
  "Order placement over HTTP (paper or otherwise) without a new ADR".

This ADR is that new ADR. It decides whether — and under which constraints — mutation-class
operations (access `mutate`, `order`, `destructive`) may carry HTTP transport bindings at all.

## Decision

Mutations become HTTP-bindable **only under ALL of the following conditions**, enforced
in code once implemented.

### 1. Scope: paper-only, idempotent classes first

- Allowed access classes, in adoption order:
  1. `mutate` (idempotent mutations: connect/disconnect, bracket set/clear, order modify/cancel
     — P2-6's idempotency already covers replay)
  2. `order` (paper order placement) — only WITH the P2-6 idempotency contract:
     `client_order_id` required for every HTTP order (no opt-out over HTTP, unlike MCP where
     it is "strongly recommended"), `preview: true` supported as a first-class verb.
  3. `destructive` (`draw_clear`, account resets): **NOT authorized over HTTP, period.**
     Destructive ops keep MCP-only transports. A future ADR must revisit with a stronger
     guard design (e.g. two-phase confirm challenge).
- Never bindable regardless of class: anything that leaves the Paper broker (`paper` ops
  are already fail-closed on broker identity), chart identity flips, `replay_*` trading.

### 2. Method authorization stays per-op

`op()` keeps refusing non-GET http bindings unless the entry ALSO carries a machine-readable
ADR reference in its `extra.meta`: `{ mutation_adr: '0001-mutation-routes' }`. The refusal
message names the ADR. This makes the escape hatch explicit per op — no bulk unlock, no
silent widening. The registry test (`tests/registry.test.js`) flips its "mutations refused"
expectation into: refused WITHOUT the meta key, accepted WITH it, and accepted entries must
be POST/PATCH/PUT/DELETE with access ≥ `mutate`.

### 3. Auth beyond loopback

The gateway binds 127.0.0.1 only; that stays the transport's entire security story.
Mutations bind only under an explicit opt-in env flag, `TV_GATEWAY_MUTATIONS=on`
(default off):

- Off → mutated ops' POST routes are not installed at all (404, like now).
- On → still loopback-only; a mutation attempt from a non-loopback peer is refused
  before handler dispatch (`http_forbidden`), same class as today's 405.

No tokens/API keys are introduced; this server is a local-personal harness and the ADR
deliberately does not pretend otherwise. If that changes, it needs a new ADR.

### 4. Preconditions and error contract are mandatory on every mutation route

- P2-5 preconditions (`expected_symbol`, `confirm`) are REQUIRED fields on mutating ops
  over HTTP — the adapter must pass them through; a 4xx `precondition_failed` is the
  expected rejection shape (P2-4 envelope, `retryable: false` where `outcome_unknown`
  is false).
- `outcome_unknown` responses must be surfaced verbatim; clients dedupe by
  `client_order_id`, never blind-retry.

### 5. Audit surface

Every HTTP mutation logs one line to the existing structured-logs stream:
`{ ts, op, via: 'http', client: 'loopback', args_redacted }` — mirroring what MCP tool
calls already emit. No new log destination.

## Consequences

- The registry becomes the single point where the read-only rule relaxes — the ADR's
  authorization is checked in exactly one place (`op()`), tests assert it, and the
  gateway's route table keeps being *derived* (it still cannot invent routes).
- SSE/stream and resource surfaces remain read-only sinks regardless — no decision here
  changes the subscription model.
- Rollout order if accepted: (1) registry `meta.mutation_adr` gate, (2) env-flag gate +
  loopback guard, (3) paper idempotent ops, (4) paper order placement with required
  `client_order_id`. Each step lands with its own contract tests before the next.
- Out of scope stays out of scope: real brokers, remote (non-loopback) exposure,
  credentials. §5 of the plan is not amended by this document beyond mutation binding.

## Alternatives considered

- **Keep HTTP strictly read-only** (status quo): safest; cost is that the gateway can't
  drive replay/paper workflows that MCP can, which was a stated consumer need. Rejected
  as a permanent posture, retained as the default posture (env opt-in).
- **Authorize mutations per-route ad hoc** (each tool file decides): loses the single
  choke point; an `op()`-level refusal is one testable invariant, N route-level checks
  are N chances to forget. Rejected.
- **Token-authenticated remote mutations**: real security work with real threat modeling
  for a single-user harness; disproportionate now. Rejected without prejudice.

## Verification hooks (what proves each step landed)

1. `tests/registry.test.js`: meta-keyed mutation acceptance + refusal without it.
2. `tests/gateway.test.js`: absent env → mutation routes 404; present → POST reaches the
   adapter and returns the P2-4 envelope; non-loopback is untestable in CI but the guard
   is a pure function tested directly.
3. `tests/order_idem.test.js` extended: HTTP-shaped duplicate `client_order_id` replay
   returns `deduplicated: true`.