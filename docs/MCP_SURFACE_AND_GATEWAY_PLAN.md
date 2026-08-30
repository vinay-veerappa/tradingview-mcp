# MCP_SURFACE_AND_GATEWAY_PLAN.md

**Repo:** `vinay-veerappa/tradingview-mcp` (local: `C:\Users\vinay\tvDownloadOHLC\tradingview-mcp`)
**Status:** v3 **BUILT** — all 8 priority steps implemented and tested (tag `v2.3.0-surface-v3`, battery 432/432). This document is now the *reference spec*; behavioral truth lives in the code + tests.
**Revision history:**
- v1 — shared core + three thin wrappers (retracted).
- v2 (post-review-1, `46390f48`) — canonical operation registry, single CDP-owning host, exact profile table + measured budgets, contract corrections.
- v3 (this revision) — folds review pass 2's 20 findings. Key shifts: `session_briefing` is replaced by the stronger `session_snapshot` with state-hash consistency (P2-1, P2-7); structured outputs + stable error contract become **step 1** (P2-3, P2-4) because they are the foundation everything else validates against; mutation preconditions + paper idempotency enter the plan (P2-5, P2-6); MCP resources/subscriptions/annotations adopted (P2-11..14); the v1-era `compact=true` + `since` scattered params are **replaced** by `chart_changes` and selective compound reads (P2-9 supersedes v2 §4.1's looser design).

**External references:** gate plan → repo `vinay-veerappa/nt8-riskguard`, `docs/RISKGUARD_BROWSER_GATE_PLAN.md` rev `2b76263`; Python consumers → repo `tvDownloadOHLC` (`scripts/trader/*`, `scripts/context/compute_ict_features.py`).

**Central principle (review pass 2, adopted verbatim as the test for any future proposal):** *fewer agent-visible operations, richer composable results, stronger guarantees around chart identity and mutation safety.* Any proposal that adds many narrow tools instead of enriching existing capabilities is rejected on sight.

---

## 0. Problem statement (standing)

Measured at v1 and still true: 97 advertised tools ≈ 40 KB `tools/list` payload per session · 5–7-call analyze workflows · Python locked out (stdio-only) · no runtime surface control · three hand-maintained transport bindings. v2's registry answers the structural rot; v3's catalog makes each interaction *fewer, richer, and safer*.

---

## 1. Verified constraints (code-checked)

| # | Fact | Evidence |
|---|---|---|
| F1 | SDK 1.27.1: disabled tools are filtered from `tools/list` (`:69`) and calls die with `Tool <name> disabled` (`:107`) before handlers run | `node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js` — verified by probe |
| F2 | `getOhlcv({count,summary})` = active chart only | `core/data.js:137` |
| F3 | Chart-switch serialization is a module-level promise (`_quoteLock`) — process-local | `core/data.js:369-375` |
| F4 | `core/stream.js` owns SIGINT + stdout; not an SSE producer until refactored | `core/stream.js:15-56` |
| F5 | `capabilities.js` gates exactly 3 things (page-js, replay-trades, self-update); paper safety = broker-identity fail-closed inside `core/paper.js` | source read |
| F6 | SDK tool entries carry `enabled/enable()/disable()/update()/remove()` and support `sendToolListChanged()` | probed live |
| F7 | **`jsonResult()` is text-only** — `content:[{type:'text',text:JSON.stringify}]`, zero `structuredContent`/`outputSchema` usage anywhere | `tools/_format.js:5-11`; zero grep hits |
| F8 | **Zero MCP annotations registered today** (no `readOnlyHint` anywhere); zero resources/prompts registered | grep across `src/` |
| F9 | `CdpError` already carries `reason` + `outcome_unknown` (+ transport_reconnect_attempted/transport_reconnected from the #449 work) | `connection.js` |
| F10 | `pane_list/focus/setSymbol/setLayout` exist; **no cross-pane batch read exists** | `core/pane.js` |

---

## 2. Architecture (unchanged from v2 — one sentence)

Single long-lived host process owns CDP; **canonical operation registry** (§P2-19) generates MCP/CLI/HTTP/SSE adapters; profiles filter the registry into advertised toolsets; loopback HTTP + SSE and MCP resource-subscriptions are sinks over one shared subscription primitive (§P2-12).

---

## 3. The enhancement catalog (pass 2, adopted — 20 items, tracked by ID)

### P2-1 · Consistent chart snapshot — `session_snapshot` *(supersedes v2 §4.1 `session_briefing`)*

One compound operation returning: chart identity (symbol/timeframe/type) · quote · OHLCV summary · visible indicators + values · Pine lines/labels/tables/boxes · visible range · optional alerts + strategy summary · **snapshot timestamp + state hash** · per-section status.

**Consistency contract (stronger than sequential calls):** capture identity → collect → re-capture identity → if symbol/timeframe changed mid-flight, **retry once** → if still changed, return `status:'state_changed'` with the sections labeled by their partial identity. Never silently mix symbols. Sections fail independently (`{status:'ok'|'error'|'skipped'}`); top level succeeds on ≥1 ok. Bounded concurrency (≤3 CDP evaluations), one deadline, `compact=true` shapes, size caps. Selective sections via `include:[...]` + presets `brief|analysis|strategy|pine_debug` (P2-9).

### P2-2 · Transactional chart context — `core/context.js` *(graded V1-blocker before any gateway or compound-mutation work)*

```js
await withChartContext({ symbol, timeframe }, async () => getOhlcv({count:100, summary:true}));
```

Acquires the **process-wide chart-mutation lock** (generalizing `_quoteLock`, F3) → records original symbol/timeframe → applies state → waits ready (`waitForChartReady`) → runs op → **detects external changes before restoring** → restores in `finally` → returns `{data, prior_context, restored}`. Every symbol-switching consumer (`getQuote` internals, `daily_snapshot`, gateway `?symbol=`, `ohlcv_snapshot`) migrates onto it. Verified requirement before exposing any second consumer of chart-mutating reads.

### P2-3 · Standard structured results *(`_format.js` is the single choke point — cheap and total)*

`jsonResult()` (currently text-only, F7) becomes dual-form, default-on:

```jsonc
{
  content: [{ type: 'text', text: '<compact summary — small>' }],
  structuredContent: { /* the object */ },     // SDK-validated against outputSchema
}
```

Every registry operation declares an `outputSchema` (P2-20 enforces it). Compound tools become machine-consumable without text JSON parsing; output contracts become regression-testable. Migration: `_format.js` change + per-op schemas land with the registry, module by module.

### P2-4 · Stable error contract (uses what `CdpError` already has — F9)

Standard failure envelope replacing `{success:false, error: msg}`:

```json
{ "success": false,
  "error": { "code": "execution_context_lost", "message": "...", "retryable": true,
             "outcome_unknown": false, "reconnect_attempted": true,
             "suggested_action": "Retry — no side effects were confirmed",
             "target_id": "…", "chart": {"symbol":"…","timeframe":"…"} } }
```

- Map `CdpError.reason` → stable `code` set (`RECOVERABLE_REASONS` already defines four); `outcome_unknown` never forcibly retried (the property from the #449 work).
- **Mutations never auto-retry on unknown-outcome** — the contract exists precisely so the *agent* can decide.
- Unit-test the mapping table (`reason → code/retryable/suggested_action`) as a frozen contract.

### P2-5 · Mutation preconditions (optimistic concurrency)

State-changing ops accept optional `expected_symbol / expected_timeframe / expected_state_hash`; paper ops accept `expected_account_id / expected_broker_id`. Mismatch ⇒ refuse **without side effects**, error=`precondition_failed` naming the live values. Prevents acting on the wrong chart/account after the world moved between the agent's read and its write. Enforcement inside `withChartContext`/registry middleware, not per-tool re-implementation. Default behavior when absent for a *destructive* op (e.g. `draw_clear`): require preconditions there explicitly (config, default Require).

### P2-6 · Paper-order idempotency + preview

`paper_place_order` gains: strongly-recommended `client_order_id` (required unless explicitly disabled per-profile), short-TTL dedup store keyed on it, and `preview:true` returning the validated+normalized order without placing. `outcome_unknown` (F9) surfaces after CDP interruption so the *client* decides whether to re-submit with the same idempotency key (safe) versus a new one. Optional max-qty/max-notional policy knobs. Bounded to paper; stays out of HTTP (§4.3 of v2).

### P2-7 · `chart_changes(since: hash, include: [...])` *(replaces v2's scattered `since` param idea)*

Prior snapshot hash in, changed-sections list out (`changed / unchanged / snapshot: new-hash`). Section hashes come from the host cache (§P2-16's freshness layer). One smarter op instead of five parameter tweaks; pairs with `session_snapshot`.

### P2-8 · `pane_scan` — cross-pane rows(building on `pane_list` + per-pane reads)

One compact row per pane: symbol/timeframe, last + change, bar range, distance from named Pine levels, indicator conditions, freshness, per-pane errors. **Read-only**; it never focuses panes to read them (that's the anti-pattern the existing tools force). Registry access `read`; profile: `base`.

### P2-9 · Selective compound presets (absorbed into P2-1)

`session_snapshot{include, exclude, preset: brief|analysis|strategy|pine_debug, study_filter, compact}` — one op, caller-chosen width. No separately-featured "briefing" tool.

### P2-10 · Analysis-ready named levels (formatting shim, raw always preserved)

Optional normalization layer over Pine labels/lines: `{raw_text, name, price, category, confidence}` for recognized patterns (PDH/PDL/OR levels/settlement/ASN…). Parser is conservative (exact token grammar, high-confidence-only), configurable, and *never* replaces the raw payload — it augments. Consumed by narrative/ICT pipelines via gateway without regex re-writing.

### P2-11 · MCP resources (read-only observables)

First resources in the repo (verified none exist, F8-inline): `tradingview://chart/state`, `chart/quote`, `chart/studies`, `paper/status`, `capabilities` — implemented as read-through to the same core handlers as their tool twins (registry marks each op `expose: ['tool','resource']`). The tool/resource split clarifies for clients what is observation vs action.

### P2-12 · Resource subscriptions (after the F4 refactor)

`core/stream.js` refactored to `subscribe(kind, {interval}) → AsyncIterable` (no process/signal/stdout side-effects in core — the CLI keeps its sink). Over it: resource-update notifications (quote/bars, symbol-change, pine-drawings, paper changes, connection lost/recovered) **and** the JSONL sink **and** gateway SSE — one event source, three sinks, per-subscriber cancellation.

### P2-13 · Tool annotations (zero today, F-inventory counts verified)

Registry carries `annotations` per op; MCP adapter passes them through: `quote_get` read-only+idempotent · `chart_set_symbol` mutating-but-idempotent · `alert_delete` destructive · `ui_evaluate` open-world · `paper_place_order` mutating, idempotent **only with `client_order_id`**. Clients get real safety signals; the registry's access-class ↔ annotation coherence is testable (P2-20).

### P2-14 · `system_status` (introspection; supersedes v2's `profile_get/set` — merges with it)

One always-visible tool: active profile, enabled/disabled **capabilities** (ids + `required_for` lists — no ack secrets), tool-group map, CDP status (connected/target/desktop version), cache and mutation-lock owner. `profile_set(profile, {confirm:true})` keeps SDK `enable/disable` + `sendToolListChanged()` semantics (the F1-verified mechanism). This is the single reliable introspection surface for agents.

### P2-15 · Compatibility report — `tv_discover` v2

Versioned per-TV-build matrix: `{desktop_version, supported: {chart, pine_editor, strategy_tester, paper, alerts}, failed_probes, recommended_actions}` with per-surface probe name + last-ok date. Direct answer to "what exactly broke after the TV update" (the gate plan's compat probe §8.3 shares this vocabulary and, where probes overlap, shares implementation).

### P2-16 · State freshness metadata on every chart-derived response

`{observed_at, symbol, timeframe, bar_time, age_ms, source:'active_chart'}` — a structurally-successful response that is stale or from a prior symbol is the trading-data failure mode; these fields make it detectable everywhere (host cache stamps it, registry middleware attaches it).

### P2-17 · CDP observability — `cdp_diagnostics`

Connection age, target, eval/timeout/reconnect counters, avg+p95 latency, last failure reason, cache hit rates, **chart-mutation lock owner** (P2-2), subscriber counts. Answers "slow because TV, CDP, transport, or agent?" from one place. Profile `debug` or always-visible-by-default (decided at build: always-visible, small).

### P2-18 · Cancellation & deadlines

Compound ops and streams honor MCP request cancellation (`RequestHandlerExtra.signal`), caller deadline, HTTP client disconnect; temporary symbol/tf mutations always unwind via `withChartContext`'s `finally` (P2-2 is the load-bearing piece here). Extends the existing bounded-ops discipline in `connection.js` to workflows.

### P2-19 · Canonical operation registry *(the structural spine — carried from review 1, unchanged; each operation declares: name, handler, input+output schema, access, profiles, transports, annotations — one definition; all bindings derived; §4's queue stays the sequence arbiter)*

### P2-20 · Contract & payload-budget tests

Per-operation outputSchema presence; cross-transport same-handler/same-validation; profile-membership validity; mutation-annotation coherence; **`tools/list` serialized budgets per profile** (real SDK payload measure — ~40 KB today / ~12 KB base target); compact-response ceilings; error-code freezes; **generated** docs/tool-counts (no handwritten counts anywhere after this ships — the upstream drift that produced PRs #465/#486 stays dead).

---

## 4. Priority queue (review pass 2's suggested order, adopted with rationale)

| # | Deliverable | Depends on |
|---|---|---|
| 1 | `jsonResult` dual-form + error contract (P2-3, P2-4) + their tests | none — smallest, everything validates against it |
| 2 | `withChartContext` (P2-2) + precondition plumbing (P2-5) | none (core-side) |
| 3 | `session_snapshot` incl. `chart_changes` (P2-1, P2-7, P2-9) | 1+2 |
| 4 | Paper idempotency + preview (P2-6); annotations pass (P2-13) | 1 |
| 5 | Operation registry + profile slimming (P2-19 + v2 §3.1 table) | 1 (schemas), 4 (annotations as registry fields) |
| 6 | Compatibility report (P2-15) + freshness metadata (P2-16) + CDP obs (P2-17) + `system_status` (P2-14) | 5 |
| 7 | `chart_changes` consumer side + `pane_scan` (P2-8) | 3, 5 |
| 8 | Streaming refactor → subscriptions → SSE (P2-12; F4 refactor first) | 2 |
| — | named-levels normalization (P2-10), cancellation-from-workflows (P2-18) | piggybacks on the steps above; not urgent alone |

Note on sequencing vs review pass 1's v2 doc: registry dropped from step 1 to step 5 *deliberately* — structured outputs and the error contract must exist first so every later addition (registry included) is born against a stable result/error contract instead of being retrofitted. (`profiles` remain cheap-env-gated until step 5 flips them into registry fields; nothing in v2's profile table changes.)

---

## 5. Explicitly out of scope (carried from v2 §7, restated)

Order placement over HTTP (paper or otherwise) without a new ADR · auth beyond loopback · `core/*` rewrites beyond the additive items the catalog demands (`core/context.js`, subscription refactor of `stream.js`) · any narration/journaling/review-mode expansion (owned by the gate plan §13.x; MCP never grows toward it).

## 6. Review trail

- Pass 1 (2026-08-29): F1-F7 verification table; registry + host topology adopted; v1 pseudocode/budget retracted. `46390f48`.
- Pass 2 (2026-08-29): 20-item catalog adopted with P2-n IDs; `session_briefing` superseded by `session_snapshot`; priority queue reordered per pass 2. Verified before adoption: `jsonResult` text-only (`_format.js:5`), zero annotation/resource usage in `src/`, `CdpError`'s existing fields, pane-tool surface.
- Build (2026-08-29): all 8 queue steps landed → tag `v2.3.0-surface-v3`. Build-order deltas worth knowing:
  - P2-19 landed **partially** (profiles + `system_status`/`profile_set` + budget CI): per-op registry generation deferred — `_annotations.js` access-class table + per-file registration remain the mapping until the full registry lands in the HTTP/gateway phase.
  - P2-16 freshness metadata ships *inside* snapshot/scan payloads (`observed_at`, bar freshness) rather than as universal middleware — full P2-16 attaches at registry time.
  - P2-18 cancellation: `subscribe()` honors `shouldStop`/`break`; MCP request-cancellation plumbing (`RequestHandlerExtra.signal`) still pending.
  - Notable latent defects found by the wire checks: `z.record()` breaks SDK zod-compat (tools/list throws), annotation double-inserts from the codemod, and a dropped-stash incident (recovered via `git fsck --unreachable`).
  - Housekeeping: `CLAUDE.md` decision tree rewrite for the profiles era and the `TRADINGVIEW_MCP_PROFILE` note in `.mcp.json` — **done** (`11c21cce`). Health update-check now anchors git to the repo root (it previously read whatever cwd the MCP client used, producing a phantom update banner — `80c8fb3f`).
  - **Gateway first slice landed** (`294285f3`): loopback HTTP read surface (`/health /state /quote /snapshot /panes /capabilities /compat /diagnostics`) + SSE at `/stream/{quote,bars,values,panes}` — sinks over the same `subscribe()`. Read-only by design (§4.3); SSE disconnect cancellation = the first P2-18 slice. `tv gateway` CLI command. The ROUTES table is the embryonic registry for this transport — full per-op registry (P2-19) remains the next gateway增量.
  - **P2-18 deepened** (`6b4a8d20`): `withChartContext` honors `AbortSignal` (caller rejects, restore still runs); `session_snapshot` passes MCP `extra.signal` through.
  - **Full P2-19 registry landed** (this working tree): `src/tools/_registry.js` — one `op(name, description, schema, annotations, handler, extra)` definition per operation across all 18 tool files (102 ops; `system_status`/`profile_set` stay outside as P2-14 always-visible system tools, by design — they describe the registry). Key properties:
    - `access` is DERIVED from the annotation object (`ACCESS_BY_CLASS`), so P2-13 ↔ P2-19 coherence holds by construction and is re-tested (`tests/registry.test.js`); unknown annotation shapes are refused at registration.
    - Transport bindings declare ON the op: the `http` transport carries `{ method, path, adapter(url, _deps) }` — the adapter is the same core call the MCP handler makes, so the gateway gained no per-op knowledge and the offline `_deps` seam reaches core unchanged (the first-slice hardcoded ROUTES table is gone).
    - The gateway route table is GENERATED (`httpRoutes()`); read-only-by-design became structural: `op()` refuses `http` on non-read access and refuses non-GET methods outright — mutations need an authorizing ADR to even become declarable (§4.3, until then unbindable).
    - HTTP errors reuse the MCP layer's `buildErrorEnvelope` verbatim (P2-4 over HTTP — CdpError fidelity survives the transport hop, tested).
    - `registerAll()` resets + fills the registry then mirrors every op into the SDK table (`toolFromRegistry`) — one source of truth, bijectivity-tested (every SDK tool ↔ exactly one op).
  - **P2-10 named levels landed** (this working tree): `src/core/named_levels.js` — pure grammar parser (39 frozen `PATTERNS` across session/opening_range/settlement/ict; exact whole-token match, case-insensitive; unrecognized text NEVER becomes a level — conservative, high-confidence-only per §P2-10). Wired as an OPTIONAL formatting shim: `normalize` + `categories` opts on `data_get_pine_labels` (and `data_get_pine_lines` accepts the flag for symmetry; its levels are text-free already) plus a `session_snapshot` pass-through; every study's raw `labels` array stays byte-identical — `named_levels` `{name, price, category, confidence, raw_text}` AUGMENTS, never replaces. Gateway gains `/levels` (normalization implied, `?categories=csv` prunes) so consumers skip regex re-writing. `getPineLabels`/`getPineLines` grew the `_deps` offline seam (matching snapshot.js). `tests/named_levels.test.js` (11 tests: grammar refusals, raw-preserved guarantee, denylist, core wiring offline).
  - **Mutation ADR drafted** (this working tree): `docs/adr/0001-mutation-routes.md` (PROPOSED) — the authorization the registry's refusal gates name. Posture if accepted: mutations stay refused by default; become declarable only with `extra.meta.mutation_adr` on the op AND the read-only posture flips only via explicit `TV_GATEWAY_MUTATIONS=on` (mutation routes absent from the table otherwise — 404, not 405); `destructive` stays MCP-only; paper-only scope (`order` class requires the P2-6 idempotency contract, `client_order_id` mandatory over HTTP); P2-5 preconditions + verbatim `outcome_unknown` mandatory on every HTTP mutation. NOT yet implemented — this document is the gate; the code changes it authorizes are follow-up work.
  - What remains: ADR implementation steps 1–3 (registry meta gate, env-flag gate, HTTP order-idem test) if ADR 0001 is accepted. P2-10 is complete.