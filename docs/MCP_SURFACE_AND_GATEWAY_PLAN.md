# MCP_SURFACE_AND_GATEWAY_PLAN.md

**Repo:** `vinay-veerappa/tradingview-mcp` (local: `C:\Users\vinay\tvDownloadOHLC\tradingview-mcp`)
**Status:** v2 PLAN — rewritten after external review pass 1 (2026-08-29). Not built.
**Revision history:** v1 proposed shared-core + three thin wrappers. Review found the wrapper model does not guarantee parity (finding 4), cannot share runtime state across processes (finding 3), and mis-grounded the contract shapes (findings 2, 5, 6, 8). v2 adopts the reviewer's **canonical operation registry** architecture. All factual corrections were verified against source before adoption (notes inline).
**Location of external references:** gate plan lives at `C:\Users\vinay\nt8-riskguard\docs\RISKGUARD_BROWSER_GATE_PLAN.md` (repo `vinay-veerappa/nt8-riskguard`, rev `2b76263`); Python consumers live in repo `tvDownloadOHLC` (`scripts/trader/*`, `scripts/context/compute_ict_features.py`). *(fixes finding 10)*

---

## 0. Problem statement (measured)

1. **97 tools advertised to every MCP session.** Est. serialized `tools/list` payload ≈ **40 KB** (reviewer-measured 39,959 B; my v1 draft's "44 KB source" was in the right range but this is now a *measured* baseline). Paid every session before any chart read.
2. **Multi-call workflows.** The documented analyze-chart flow is 5–7 MCP round-trips.
3. **Python ecosystem locked out** (stdio-only server; `server.js:107`).
4. **No runtime surface control.** SDK 1.27.1 has per-tool enable/disable; unused.
5. **Three transport bindings maintained by hand** (tools/*.js, cli/commands/*, +gateway) — the drift that already produced upstream tool-count bugs (#465, #486, #335-era).

**Zero-th constraint (from review "Direction"):** the architectural center is **one canonical operation registry** from which all three transports are generated/adapted — not a shared core with three hand-maintained mappings. Transport bindings are *derivations*, never hand-written twice.

---

## 1. Verified constraints (each checked against source during review)

| # | Fact | Evidence | Consequence for v2 |
|---|---|---|---|
| F1 | SDK filters `tools/list` to `tool.enabled` and rejects calls to disabled tools **before any handler runs** with `Tool <name> disabled` | `node_modules/.../server/mcp.js:69` (`.filter(([, tool]) => tool.enabled)`) and `:107` (`throw new McpError(... \`Tool ${name} disabled\`)`) | A disabled tool **cannot** return a custom "enable profile X" refusal — it is invisible+dead. Runtime escalation therefore requires a permanently-visible `profile_*` tool (§3.2), or restart-only profiles. |
| F2 | `getOhlcv({count,summary})` reads **the active chart only** — no symbol/tf parameter, no switching | `core/data.js:137` | `/api/ohlcv?symbol&tf` cannot exist against unchanged core. Either active-chart-only semantics, or a new transactional core primitive (§4.4). |
| F3 | Chart-switching ops serialize via module-level `_quoteLock` — **per-process only** | `core/data.js:369-375` | A second long-lived process (gateway) has its own lock ⇒ cross-process chart-switch races. This decides the topology (§2). |
| F4 | `core/stream.js` owns SIGINT handlers and writes stdout directly; returns only when stopped | `core/stream.js:15-56` | Not an SSE producer. Needs refactor to async-iterator/subscription first (finding 7 — accepted). |
| F5 | Paper mutations are NOT capability-gated; they fail closed on **broker identity** inside `core/paper.js` | `capabilities.js` has exactly 3 gates (page-js, replay-trades, self-update); `paper.js:496+` `assertPaperContext` | Don't conflate the four control classes (§4.3). |
| F6 | 9 read tools of the v1 "minimal" profile serialize to ≈ **4.3 KB** (SDK real schema serialization; my crude source-block measure 3.07 KB understates it) | reviewer measurement, consistent with F-block sizes | My `minimal ≤ 2 KB` budget was **unattainable**. v2 budgets are set from real serialization (§5). |
| F7 | `evaluate` has 89 inbound callers per graph; connection.js owns discovery, generation guards, deadlines | codememory graph (`C-Users-vinay-tvDownloadOHLC-tradingview-mcp`, 789 nodes / 1,549 edges) | Registry wraps *core*, never bypasses connection.js; the CDP-owning question (§2) is about process topology, not about duplicating connection logic. |

---

## 2. Topology decision: who owns CDP (review finding 3, accepted)

The v1 sketch (separate `gateway.js` process hitting CDP in parallel with the stdio MCP) is **rejected**: two long-lived processes each hold their own module state — their own `_quoteLock`, their own cached client, their own `targetInfo`. Concurrent symbol-switch-and-restore sequences from both processes race against the chart (`getQuote` switches+restores). Chosen instead:

> **One long-lived host process owns CDP and every transport hangs off it.**

`server.js` becomes **`tv-host`**: the single process that (a) owns the CDP connection manager (today's `connection.js` singleton path), (b) serves MCP over stdio, (c) serves HTTP/SSE on loopback. The gateway is a *transport module inside the host*, not a sibling process. Consequences:

- Profile state, caches, and serialization are shared by construction (one `_quoteLock`, one cache).
- No cross-process serialization protocol to design; no second connection manager.
- Failure domain is single (host crash takes down both) — acceptable for a single-user box; simpler than a CDP-broker process for v1.
- The **gate daemon** (nt8-riskguard plan) remains a separate process by design (guard independence from a crashing host) and consumes the host via HTTP/SSE — that is the intended multi-*client*, single-*owner* shape.
- A tiny `--stdio-only` flag keeps the old behavior for pure-MCP setups (tests, embedding clients).

---

## 3. Canonical operation registry (review "Direction", adopted)

```
src/registry/
  operations.js        # THE list: every operation = {name, title, description,
                       #   core handler import, input schema, accessClass, transports,
                       #   profiles, deprecation}
  access.js            # access classes (§3.3) -> enforcement fn per transport
  profiles.js          # named toolsets = filter over the registry (§3.1)
  adapters/
    mcp.js             # generically binds ops -> server.tool()
    cli.js             # generically binds ops -> CLI verbs (replaces hand maps)
    http.js            # generically binds ops -> routes + JSON schema validation
```

Rules:
- **An operation exists once.** `session_briefing` is declared in `operations.js` with its core handler and access class; MCP/CLI/HTTP bindings are *generated or adapted from that entry*. Hand-written transport code for a new operation is a review-reject.
- Migration is incremental and provable: registry adoption is done module-by-module, with a **parity test** asserting that for every registered operation, all enabled transports expose the same name/schema (this is the tool-count-drift kill switch; the census in §0.5 came from exactly this rot).
- `evaluate`-touching handlers stay in `core/*` untouched; the registry references them.

### 3.1 Profiles (exact contents — supersedes v1 pseudocode entirely)

Single source of truth (`registry/profiles.js`). Format: each profile lists **additions** on top of its parent; `base` is everything not marked `access>sensitive`.

| Profile | Tools (explicit; `+` = inherited) | Budget target (serialized, CI-measured) |
|---|---|---|
| **base** (default, ~24 tools) | `chart_get_state`, `quote_get`, `data_get_ohlcv`, `data_get_study_values`, `data_get_pine_lines`, `data_get_pine_labels`, `data_get_pine_tables`, `data_get_pine_boxes`, `data_get_trades`, `data_get_strategy_results`, `data_get_equity`, `depth_get`, `symbol_info`, `symbol_search`, `capture_screenshot`, `batch_run`, `session_briefing`, `daily_snapshot`, `tv_health_check`, `tv_discover`, `profile_get`, `profile_set`, `alert_list`, `watchlist_get` | **≤ 12 KB** serialized |
| **pine** (+12) | all `pine_*`, `indicator_*`, `chart_manage_indicator`, `chart_set_*`, `chart_scroll_to_date` | ≤ 22 KB |
| **control** (+~25) | `ui_*`, `pane_*`, `tab_*`, `layout_*`, `draw_*`, `watchlist_add*`, `watchlist_remove`, `alert_create/delete`, `chart_manage_indicator` | ≤ 40 KB |
| **paper** (+13) | all `paper_*` — **only here**; additionally requires the broker-presence precondition that already fail-closes today, and its own env-ack if ever routed through HTTP | + paper schemas |
| **devel** (= control+paper) | everything | full 40 KB |

**Default decided: `base` for this workspace** (answers plan-open-Q1; read-heavy daily use, pine dev is a deliberate session choice). Decided here means: `.mcp.json` gets `TRADINGVIEW_MCP_PROFILE=base`; upstream `control` behavior is preserved by passing `devel`.

### 3.2 Escalation, given F1 (custom refusals are unreachable)

- The registry always exposes **`profile_get`** and **`profile_set`**: `profile_get` returns active profile + the names of available profiles + what's outside; `profile_set(profile, {confirm:true})` flips enablement **in-process** via SDK `enable()/disable()` + `sendToolListChanged()` (verified available on 1.27.1).
- Consequence: **no restart needed for escalation**; the agent asks the user ("enable pine?"), calls `profile_set`, re-lists. This resolves finding 2 without inventing an unreachable refusal handler.
- All non-base tools also remain *restart-seatable* via env for deterministic CI (`TRADINGVIEW_MCP_PROFILE=pine`).
- `profile_set` is `access>governance`: logged to the journal, and pinning it is what makes the token-budget test meaningful.

---

## 4. Contract corrections carried into v2 (the five concrete defects)

### 4.1 Compound tools get transactional semantics (finding 9 — accepted whole)

`session_briefing` is not "run 7 calls and concatenate". Spec:
- **Snapshot identity:** every briefing result carries `snapshot_id` + `captured_at` + `symbol@timeframe` read *once at start*; sections that arrive with a different symbol are labeled `stale: true` rather than silently mixed.
- **Bounded concurrency:** sections run under a shared semaphore (≤3 concurrent CDP evaluations) and the whole briefing honors one deadline; sections race independently after that.
- **Partial failure model:** each section returns `{status:'ok'|'error'|'skipped', data?, error?}`; the top-level succeeds if ≥1 section ok. Alerts/drawings unavailable ⇒ `skipped`, never a failed briefing.
- **Size discipline:** labels/lines capped (`max_labels` semantics preserved), and `compact=true` shapes by default.
- **Registry note:** `session_briefing` is *read + chart-observation* access class; it never mutates chart state (no symbol switching inside a briefing — it reports for what's on screen).

### 4.2 OHLCV by-symbol honesty (finding 5 — accepted)

`getOhlcv` today = active-chart only. v2 declares two distinct operations:
- `ohlcv_active(count, summary)` — exactly today's behavior. No symbol/tf params exist on it, full stop.
- `ohlcv_snapshot(symbol, tf, count)` — **new core primitive `withChartContext(symbol, tf, fn)`**: acquires the host's global context mutex (the single-process topology makes this *actually* global now), switches symbol+tf, waits readiness via existing `waitForChartReady`, runs `fn()`, restores previous context in `finally`, returns `{data, restored:true, prior_context}`. Used by `daily_snapshot` and gateway `?symbol=` everywhere. This is additive to `core/*` (a new file `core/context.js`), not a rewrite — the "core unchanged" claim in v1 was too strong and is withdrawn.

### 4.3 Four distinct control classes (finding 6 — accepted; the doc previously merged four things)

| Control | What it answers | Where it lives |
|---|---|---|
| **Profile visibility** | is the tool *advertised*? | `registry/profiles.js` (§3.1) |
| **Dangerous-capability ack** | is the *human* on record for this class? (page-js, replay-trades, self-update — exactly the three in `capabilities.js`) | existing env-ack pattern; new ops add entries |
| **Gateway bearer auth** | may this *HTTP caller* invoke write/exec classes? | gateway middleware, per-route access class |
| **Paper broker-identity fail-closed** | is the *chart actually on the expected paper broker*? | stays in `core/paper.js` — untouched |

Paper-order routes over HTTP: **out of scope for v2 gateway** (v1 said both "discussed" and "out of scope" — the contradiction is resolved by deleting it from the route table; revisit only with an explicit ADR). Pine-write routes: likewise table-only after a written policy; they are *not* silently included.

### 4.4 Streaming refactor precondition (finding 7 — accepted)

`core/stream.js` keeps its CLI JSONL face; underneath it is refactored to `subscribe(kind, {interval}) → AsyncIterable<{data, _ts}>` with no process-side effects (signals/stdout move to the CLI sink). SSE endpoint = one more sink; per-client cancellation = `request.on('close') → unsubscribe`; host-level single poller feeds multiple clients (backpressure = drop-with-flag, documented). Sequenced *before* any SSE route ships.

### 4.5 Token-budget test, grounded (finding 8 — accepted)

- Test imports the real MCP server construction path and calls the SDK's actual `tools/list` serialization (not source-byte guesses) per profile.
- **Baseline measured first, then ceilings set at +10%**: expected ≈ 12–13 KB for `base` (24 tools incl. `session_briefing`'s schema), `pine` ≤ 24 KB, `paper` adds ~9 KB measured. The v1 "≤2 KB" number is withdrawn as fantasy.
- Budget breaches fail CI with the offending tools' schema sizes printed — the same date-stamped honesty as anchors.md.

---

## 5. Registry access classes (from review's recommended sequence, adopted verbatim)

`read` · `chart-mutation` · `destructive-mutation` · `arbitrary-execution` (`ui_evaluate`) · `paper-mutation` · `self-update` · `governance` (`profile_set`).

Each registry entry carries one. Transport adapters enforce per class: MCP = capability env-ack (unchanged semantics), CLI = same, HTTP = bearer token *and* class restriction (read-class routes need no token on loopback; every other class requires the token **and** its capability ack if applicable).

---

## 6. Implementation sequence (review's "Recommended Sequence", accepted with two merge-notes)

1. Operation **registry** + access classes (+ parity test: every registered op appears on every enabled transport — kills finding 4 structurally).
2. **Profiles** finalized exactly per §3.1 table; default `base`; `profile_get/set` shipped in the same commit (F1 keeps these permanently visible).
3. **Serialized `tools/list` measurement test** with real SDK payloads per profile (§4.4 numbers, not guesses).
4. `session_briefing` with §4.1 semantics.
5. **CDP-ownership decision ratified** (§2: single host) *before* any second long-lived consumer is green-lit — gate daemon included.
6. Read-only HTTP routes generated from the registry.
7. `subscribe()` refactor (`core/stream.js`), then JSONL + SSE sinks.
8. Gateway writes: deferred until §4.3 written as policy without contradiction (bearer + capability acks table).

*Merge-note A (this repo's own):* the 97-tool instructions block in `server.js` gets split per-profile in step 2 — it is part of the advertised-context problem and was measured with the tool schemas, not separately.
*Merge-note B (from this workspace):* once step 2 lands, this repo's `.mcp.json` entry flips to `TRADINGVIEW_MCP_PROFILE=base` and the workflows in `CLAUDE.md` are re-centered on `session_briefing` — that's the moment the context saving becomes real for every session.

---

## 7. Explicitly out of scope (unchanged from v1, restated under §4.3 rules)

- Any order placement over HTTP (paper or otherwise) without a new ADR.
- Auth beyond loopback.
- `core/*` behavior changes other than the additive `core/context.js` and the `stream.js` subscribe refactor (both demanded by specific corrections above).

## 8. Review trail

- Review pass 1 (2026-08-29): findings 1–10 accepted; F1-F7 verification table added; registry architecture adopted; v1 pseudocode/profiles/2KB-budget retracted. No code changed during review.