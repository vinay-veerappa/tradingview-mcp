# MCP_SURFACE_AND_GATEWAY_PLAN.md

**Repo:** `vinay-veerappa/tradingview-mcp` (local: `C:\Users\vinay\tvDownloadOHLC\tradingview-mcp`)
**Status:** v1 PLAN — not built. Document-first per house convention.
**Created:** 2026-08-29.
**Companion docs:** `docs/RISKGUARD_BROWSER_GATE_PLAN.md` (§4b — daemon vs MCP division; §13.x use-case catalog), upstream `CLAUDE.md` (context-management rules).
**Related:** `mt8-riskguard` gate daemon (planned) — will be a *consumer* of this gateway; `scripts/trader/*`, `scripts.context.compute_ict_features`, briefing/narrative pipeline — Python consumers with **zero chart access today**.

---

## 0. Problem statement (measured, 2026-08-29)

1. **97 tools × name + description + inputSchema are advertised to every MCP client session.** Verified: 97 registered tools across 15 modules (`server.tool(...)` blocks ≈ 44 KB of source that becomes per-session tool context through the stdio transport). The agent pays this **every session, before reading a single bar**.
2. **The tool surface rewards many tiny calls.** The documented "analyze my chart" workflow (repo `CLAUDE.md`) is 5–7 sequential tool calls — each with request JSON, envelope, and response overhead. For an LLM session, `quote_get` + `data_get_ohlcv(summary)` + `data_get_pine_lines` + `data_get_pine_labels` + `data_get_study_values` = 5 MCP round-trips where one payload would do.
3. **Python ecosystem is locked out.** `scripts/trader/*`, narrative engine, ICT features, prop-sim tooling — none can touch the live chart. The only transports are stdio MCP and the CLI (`tv`), neither of which Python integrates with cleanly as a *live data* source.
4. **No runtime surface control.** The SDK (1.27.1, verified by probe on this box) exposes per-tool `enable()/disable()/remove()` + `sendToolListChanged()` — but nothing uses it. The capability-gate work just merged (#429) gates *execution*, not *visibility*: all 97 schemas are advertised even when gated off.

**Goal:** one shared core, two delivery surfaces (slim MCP + HTTP gateway), context cost cut by ~70% per session, Python consumers enabled with zero MCP overhead.

---

## 1. Verified facts this plan rests on

| Fact | Evidence | Consequence |
|---|---|---|
| Server is stdio-only | `server.js:107` `StdioServerTransport` — no HTTP | Gateway must be new code (or a transport flag) |
| SDK = 1.27.1 | `node_modules/...` probed directly | `server.tool()` / `registerTool` / per-tool `enabled` + `enable()/disable()` + `sendToolListChanged()` all exist — **profile-gated surface is implementable today, no SDK upgrade** |
| `core/*` is transport-agnostic | `core/data.js`, `core/chart.js` etc. export plain functions taking options objects | Gateway = thin router over the same functions; zero logic duplication |
| CLI already maps ~70 tools to subcommands | `src/cli/index.js` header comment | CLI is the existence proof that core reuses well; gateway follows the same pattern |
| `core/stream.js` exists (JSONL `stream quote/bars`) | `commands/stream.js` | Long-poll streams translate directly to SSE endpoints |
| Core already exports `getDepth` (DOM) | `core/data.js` | No MCP tool exposes it — freebie re-expose |
| Paper-trading tools are capability-gated (#434/#440 work) | `src/capabilities.js` `requireSelfUpdate` etc. tested in `tests/replay.test.js` | Governance pattern for auth on the gateway already exists — extend, don't invent |

Tool census (from live source scan): chart 10 · data 12 · pine 12 · ui 12 · paper 13 · health 5 · tab 5 · replay 6 · drawing 5 · pane 4 · indicators 4+1 · watchlist 4 · alerts 2 · capture 1 · batch 1.

---

## 2. Design: one core, three faces

```
                    src/core/*  (unchanged — the single source of truth)
                     /          \
        ┌────────────────┐    ┌─────────────────────┐
        │  MCP (stdio)   │    │  HTTP gateway        │
        │  slim profile  │    │  :8491 loopback      │
        │  ~25 tools     │    │  full core + SSE     │
        └────────────────┘    └─────────────────────┘
             ▲ agents                ▲ Python scripts / gate daemon / cron
```

Both transports call **the same core functions**. This is the uniform abstraction the user asked for: `core.getQuote(opts)` is exposed as MCP tool `quote_get`, as `GET /api/quote`, and as `tv quote get` CLI — three doors, one room. New capabilities (see §5) get exposed on both surfaces at definition time.

### 1.1 MCP surface slimming (the profile system)

**Mechanism, verified on the installed SDK:** every `server.tool()` registration returns an entry holding `enabled`, `enable()`, `disable()`. A **profile gate** after registration:

```js
// src/profiles.js (new)
const PROFILES = {
  minimal: ['chart_get_state','quote_get','data_get_ohlcv','data_get_study_values',
            'data_get_pine_lines','data_get_pine_labels','data_get_pine_tables',
            'capture_screenshot','session_briefing','tv_health_check'],            // 10
  analysis: [...min, 'data_get_pine_boxes','data_get_trades','data_get_strategy_results',
             'data_get_equity','depth_get','symbol_info','symbol_search',
             'chart_set_symbol','chart_set_timeframe','batch_run','session_snapshot'], // ~20
  pine:     [...analysis, all 12 pine_*, 'indicator_*','chart_manage_indicator'],    // dev sessions
  control:  [...all, 'ui_*','pane_*','tab_*','layout_*','draw_*','watchlist_*','alert_*'], // full
  paper:    [...control, all 13 paper_*],                                            // gated behind env ack (existing)
};
```

- **Profile is chosen at startup** (env `TRADINGVIEW_MCP_PROFILE=slim|analysis|pine|control|paper`, default `slim`) via `entry.disable()` on the non-members + `sendToolListChanged()`. The stdio session advertises **10–20 tool schemas instead of 97**.
- **Runtime escalation without restart** (the broker-gates pattern the MCP already has): a tool that arrives when its profile section is off answers with the *name of the profile to enable*, mirroring `capabilities.js` messages — the agent can then ask the user to restart with the profile. This is the same "honest refusal names its unlock path" discipline as `requireSelfUpdate`.
- **Non-tool context also shrinks:** the giant `instructions:` block in `server.js` (the 84-tool selection guide) becomes profile-specific — the slim profile carries ~15 lines, not 84.
- Extension hook (V1.5): `tools/list` handler could honor per-session filtering via `_meta`, but startup profiles cover 90% of the win at zero risk. Do not over-engineer.
- **Session-briefing dependency:** adding `session_briefing` (§2) makes `minimal` genuinely self-sufficient for daily read use — the agent rarely needs more.

### 1.2 HTTP gateway

New standalone `src/gateway.js` (`node src/gateway.js --port 8491`), loopback-bound (127.0.0.1) by design:

| Route | Maps to core | Notes |
|---|---|---|
| `GET /api/quote?symbol=` | `getQuote` | JSON; optional symbol = chart-switch-and-restore semantics inherited |
| `GET /api/ohlcv?symbol&tf&count&summary` | `getOhlcv` | `summary=1` default — same token discipline for HTTP |
| `GET /api/state` | `getState` + `symbolInfo` | merged chart snapshot |
| `GET /api/study?name=&kind=lines\|labels\|tables\|boxes` | `getPine*` | one endpoint, kind switch |
| `GET /api/alerts`, `GET /api/trades`, `GET /api/depth`, `GET /api/equity` | direct | read plane |
| `GET /api/stream/quote`, `/api/stream/bars` | `core/stream.js` | **SSE** — the JSONL streams already do 80% of the work |
| `POST /api/chart/symbol\|timeframe`, `POST /api/draw`, `POST /api/alerts` | core write fns | **token-gated** (`TRADINGVIEW_MCP_GATEWAY_TOKEN`), consistent with capabilities governance; reads un-gated on loopback |
| `GET/POST /api/profile` | profile switch | reads current, switches (writes listChanged) |
| `GET /api/health` | `healthCheck` | the gate daemon's "is TV reachable" signal |

**Auth posture:** loopback bind + bearer token for writes. Reads unauthenticated *on loopback only* — same trust model as the CDP port itself (anything on this box can already drive the chart via 9222). Anything beyond that explicitly raises the bar and is a later, deliberate step.

**Python contract:** minimal client snippet documented in `docs/GATEWAY.md`; `requests`/`urllib` only, no SDK. The narrative pipeline's `premarket → open → intraday` modes gain a `--chart` flag that pulls live state from the gateway instead of parquet-only.

### 1.3 Compound tools (the token-weight lever *inside* the MCP too)

The gateway removes Python-side tokens; these reduce *agent* tokens:

1. **`session_briefing`** — `session_briefing(study_filter?)` → one payload: chart state, quote, OHLCV summary (20 bars), all pine drawings for one study (lines+labels+tables+boxes), alert list, health. Replaces the 5-–7-call "analyze chart" workflow in `CLAUDE.md`. Estimated 70-80% fewer tokens for the most common agent workflow. **This single tool justifies the minimal profile.**
2. **`daily_snapshot(symbol, tf)`** — OHLCV summary + H/L vs yesterday + today range status + visible range. For scans.
3. **`compact=true` flag** on read tools — return `{lines:[1234.25, 1236.5], labels:{'PDH':45412}}` instead of verbose object arrays. Schema fields the caller doesn't need are context expense.
4. **`since`/`stub` params on pine tools** — if a study's last-read state hash is unchanged, return `{unchanged: true}` (2 tokens) instead of the full payload. Cache lives in-process (TTL bounded); invalidated on chart-symbol change.

### 1.4 Cache layer
- In-process TTL cache (quote 250 ms, ohlcv 1 s, state 1 s, pine reads 2 s) — invalidated by symbol/timeframe change events the core already can detect. Gateway and MCP share it. Regulates both token weight and CDP load when the agent polls.

---

## 3. Implementation plan (sequenced, each step shippable)

| # | Deliverable | Why this order | Effort |
|---|---|---|---|
| 1 | `profiles.js` + startup profile gating + `profile` tool + instructions slimming | pure win, no behavior change at default (`control` profile = today), unblocks context math | S |
| 2 | `gateway.js` read routes + `/api/health` + tests (`node --test tests/gateway.test.js`, supertest-style) | unlocks Python; read-only = low risk | M |
| 3 | `session_briefing` + `daily_snapshot` (MCP + gateway parity) | closes the common-workflow token cost; also the hook for `minimal` profile | M |
| 4 | SSE stream endpoints (`/api/stream/*`) via `core/stream.js` | gate daemon's PnL/fill feed depends on this (gate plan §3) | S |
| 5 | Write routes + token gate + `capabilities`-style acks | complete the surface; least urgent (agent does writes via MCP anyway) | S |
| 6 | `compact=true` + `since-hash` caching on pine tools | once consumers prove they want it | S |
| 7 | Docs: `CLAUDE.md` decision-tree rewrite around `session_briefing`; tool-count reconciliation everywhere (the count 97→~60 default know this trap: tool-count docs rotted upstream before, PR #465/#486 were exactly this cleanup) | keep the docs honest | S |

---

## 4. Governance & kill-switches (repo posture consistency)

- **Paper-order + Pine-write routes:** behind the same `capabilities.js` opt-in (env-ack) as `replay_trade` — one more entry (`requireGatewayWrites`).
- **Gateway binds 127.0.0.1 only, checked at startup and refused otherwise** (no `0.0.0.0` "just for testing" foot-gun).
- **Profile invariant:** tools disabled by profile must refuse with a message naming the required profile — never silently succeed.
- Every new compound tool/shim gets: unit test + `check_*.py` gate wiring + a `CLAUDE.md` line — the same day it ships. (House rule, applied to the last three features; kept.)
- **Token cost is a test:** `tests/token_budget.test.js` — asserts the *serialized tools/list payload* for each profile stays under a ceiling (e.g. minimal ≤ 2 KB, slim ≤ 8 KB, control ≤ 20 KB). Regression = red CI. This is the metric the whole plan exists to move.

## 5. Open questions (bring answers at build kickoff)

1. Default profile for `.mcp.json` here: `slim` (10 tools + briefing) or `analysis`? (Current usage in this workspace is read-heavy + occasional pine dev — the answer is probably `analysis`, but it's the user's call.)
2. Gateway port + token: pick and freeze (8491 default, loops back to the gate daemon plan).
3. Keep `paper_*` out of every profile except `paper`? (Recommended — it's 13 tools ≈ 13% of the surface for a capability most sessions never touch; profile-gating it is the single biggest schema saving.)
4. `stream` CLI JSONL compat: keep as-is (consumers may exist) and have SSE duplicate it — or deprecate JSONL once SSE exists?

## 6. Explicitly out of scope for this plan

- Any order placement over the gateway (deny-only posture — see gate plan §13.5; paper-order routes remain MCP-only pending review).
- Auth beyond loopback (nginx/mtls etc.) — unnecessary for a single-user box; revisit only if the gateway ever leaves localhost.
- Changing `core/*` semantics — this plan is strictly transport/profile surface work.