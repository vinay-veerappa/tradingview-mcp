# TradingView MCP — Claude Instructions

MCP server for reading and controlling a live TradingView Desktop chart via CDP (port 9222).
Surface is **profiled**: `base` (default, 30 tools), `pine`, `control`, `paper`; `devel` = everything
(dynamic, set via `TRADINGVIEW_MCP_PROFILE` env or `profile_set`). `system_status` always shows
what is visible/hidden and which capability gates are armed.

## Decision Tree — Which Tool When

### "What's happening on my chart?" (FIRST READS — prefer these)
1. `session_snapshot` → ONE call: quote + OHLCV summary + indicator values + Pine lines/labels/tables/boxes, with a snapshot hash for `chart_changes`
2. `pane_scan` → multi-pane layouts: one row per pane (symbol/timeframe/last/change/freshness/indicator values)
3. `system_status` → which tools this profile exposes + capability gates ("what's missing and why")

### "What changed since I last looked?"
- `chart_changes` with the prior `snapshot_hash` or section hashes → changed/unchanged without re-reading everything

### "Is TV healthy?" (tool failures, after TV updates)
1. `tv_compatibility_report` → per-version surface matrix (healthy/degraded/unavailable + recommended actions)
2. `cdp_diagnostics` → CDP connection state, chart-mutation lock owner

### "Chart identity in one call?"
- `session_snapshot` returns `identity` (symbol/timeframe/type/studies) — prefer over raw `chart_get_state` when composing with other reads

### "What's on my chart right now?" (fine-grained)
1. `chart_get_state` → symbol, timeframe, chart type, indicator list with entity IDs
2. `data_get_study_values` → current numeric values from all visible indicators
3. `quote_get` → real-time price, OHLC, volume for current symbol

### "What levels/lines/labels are showing?"
Custom Pine graphics are invisible to normal data tools. `session_snapshot` collects them all;
for targeted reads use `study_filter`:
1. `data_get_pine_lines` → horizontal price levels (deduplicated, sorted high→low)
2. `data_get_pine_labels` → text annotations with prices (e.g., "PDH 24550")
3. `data_get_pine_tables` → table data as rows (session stats, dashboards)
4. `data_get_pine_boxes` → price zones as {high, low} pairs

### "Give me price data"
- `data_get_ohlcv` with `summary: true` → compact stats (high, low, range, change%, avg volume, last 5 bars)
- `data_get_ohlcv` without summary → all bars (use `count` to limit, default 100)
- `quote_get` → single latest price snapshot

### "Analyze my chart" (full report workflow)
1. `session_snapshot` (preset `analysis`) → quote + studies + Pine surface in one read
2. `capture_screenshot` → visual confirmation

### "Change the chart"
- `chart_set_symbol` / `chart_set_timeframe` / `chart_set_type` → ticker / resolution / style
- `chart_manage_indicator` → add or remove studies (FULL names: "Relative Strength Index", not "RSI")
- `chart_scroll_to_date` → jump to a date (ISO format)

⚠️ **Chart mutations are identity-guarded**: operations that flip the chart run under
`withChartContext` (process-wide lock; concurrent ops queue). Destructive ops (`draw_clear`)
require `expected_symbol` + `confirm: true` — a `precondition_failed` error means CHART
IDENTITY MOVED: re-read with `session_snapshot` before retrying.

### "Work on Pine Script"
1. `pine_set_source` → inject code into editor
2. `pine_smart_compile` → compile with auto-detection + error check
3. `pine_get_errors` → read compilation errors
4. `pine_get_console` → read log.info() output
5. `pine_get_source` → read current code back (WARNING: can be very large for complex scripts)
6. `pine_save` → save to TradingView cloud
7. `pine_new` → create blank indicator/strategy/library
8. `pine_open` → load a saved script by name

### "Practice trading with replay"
1. `replay_start` with `date: "2025-03-01"` → enter replay mode
2. `replay_step` → advance one bar
3. `replay_autoplay` → auto-advance (set speed with `speed` param in ms)
4. `replay_trade` with `action: "buy"/"sell"/"close"` → execute trades
5. `replay_status` → check position, P&L, current date
6. `replay_stop` → return to realtime

### "Screen multiple symbols"
- `batch_run` with `symbols: ["ES1!", "NQ1!", "YM1!"]` and `action: "screenshot"` or `"get_ohlcv"`

### "Draw on the chart"
- `draw_shape` → horizontal_line, trend_line, rectangle, text (pass point + optional point2)
- `draw_list` → see what's drawn
- `draw_remove_one` → remove by ID
- `draw_clear` → destructive-gated: requires `expected_symbol` (current chart symbol) + `confirm: true`; env opt-out `TV_DRAW_CLEAR_PRECONDITIONS=off`

### "Manage alerts"
- `alert_create` / `alert_list` / `alert_delete`

### "Order placement & trading safety"
- Paper orders accept `client_order_id` — replaying the same id returns the original result
  (`deduplicated: true`) instead of double-filling; `preview: true` returns the computed order
  without placing it
- All errors return the stable envelope: `{ success: false, error: { code, message, retryable,
  outcome_unknown, suggested_action, ... } }` — check `retryable`/`outcome_unknown` before automation retries

### "Navigate the UI"
- `ui_open_panel` → open/close pine-editor, strategy-tester, watchlist, alerts, trading
- `ui_click` → click buttons by aria-label, text, or data-name
- `layout_switch` → load a saved layout by name
- `ui_fullscreen` → toggle fullscreen
- `capture_screenshot` → take a screenshot (regions: "full", "chart", "strategy_tester")

### "TradingView isn't running"
- `tv_launch` → auto-detect and launch TradingView with CDP on Mac/Win/Linux
- `tv_health_check` → verify connection is working

### "What MCP resources exist?" (observation surface)
- `tradingview://chart/state` / `tradingview://chart/quote` / `tradingview://capabilities`
- Read-through to the same handlers as their tool twins; `chart/quote` subscribers receive
  `notifications/resources/updated` when quote content changes (server live-notifier)

### "Switch toolsets mid-session"
- `profile_set` with `confirm: true` → rebroadcasts the advertised tool list
  (client must re-fetch tools/list; some hosts need reconnect)

### "What's the Paper Trading state?" / "Trade on Paper"
Native Paper Trading only (stable broker id `"Paper"`). Never other brokers.
1. `paper_get_status` → session, panel, connect status/label, broker id, `safe_for_paper_mutation`
2. `paper_connect` → connect broker id `Paper` if disconnected
3. `paper_get_account` / `paper_list_accounts` / `paper_switch_account` / `paper_list_positions` / `paper_list_orders`
4. Mutations (fail closed unless active broker is Paper): `paper_place_order` (optional `tif` DAY|WEEK|MONTH|GTD), `paper_cancel_order`, `paper_modify_order`, `paper_close_position`, `paper_set_brackets` (`clear: true` to remove SL/TP)
5. `paper_open_panel` → open/close Trading Panel (`paper_trading` widget)
Use `TV_CDP_PORT` if multiple Desktops exist. See `docs/PAPER_TRADING_DISCOVERY.md`.

## Context Management Rules

These tools can return large payloads. Follow these rules to avoid context bloat:

1. **Prefer `session_snapshot` over multi-tool fan-out** — one read replaces 5-7 individual calls
2. **Always use `summary: true` on `data_get_ohlcv`** unless you specifically need individual bars
3. **Always use `study_filter`** on pine tools when you know which indicator you want
4. **Never use `verbose: true`** on pine tools unless the user specifically asks for raw drawing data
5. **Avoid `pine_get_source`** on complex scripts (200KB+). If needed, read only the parts you edit.
6. **Avoid `data_get_indicator`** on protected/encrypted indicators — use `data_get_study_values`
7. **`chart_changes` with a prior hash instead of re-reading** — pass `since` from the last snapshot
8. **Cap OHLCV requests** — `count: 20` quick, `100` deeper, `500` only when specifically needed
9. **`pane_scan` for multi-pane layouts** — never click panes (`pane_set_symbol` changes the chart)

### Output Size Estimates (compact mode)
| Tool | Typical Output |
|------|---------------|
| `quote_get` | ~200 bytes |
| `data_get_study_values` | ~500 bytes (all indicators) |
| `data_get_pine_lines` | ~1-3 KB per study (deduplicated levels) |
| `data_get_pine_labels` | ~2-5 KB per study (capped at 50) |
| `data_get_pine_tables` | ~1-4 KB per study (formatted rows) |
| `data_get_pine_boxes` | ~1-2 KB per study (deduplicated zones) |
| `data_get_ohlcv` (summary) | ~500 bytes |
| `data_get_ohlcv` (100 bars) | ~8 KB |
| `capture_screenshot` | ~300 bytes (returns file path, not image data) |

## Tool Conventions

- All tools return `{ success: true/false, ... }`; failures carry the stable error envelope
  (codes: `cdp_timeout`, `execution_context_lost`, `navigation_invalidated`, `target_replaced`,
  `cdp_command_failed`, `precondition_failed`, `state_changed` + `evaluation_failed`)
- Structured outputs: plain-object results also ship as `structuredContent`
- Entity IDs are session-specific — don't cache across sessions
- Pine indicators must be **visible** on chart for pine graphics tools to read their data
- `chart_manage_indicator` requires **full indicator names**: "Relative Strength Index" not "RSI", "Moving Average Exponential" not "EMA", "Bollinger Bands" not "BB"
- Screenshots save to `screenshots/` directory with timestamps
- OHLCV capped at 500 bars, trades at 20 per request
- Pine labels capped at 50 per study by default (pass `max_labels` to override)

## Architecture

```
MCP Client ←→ MCP Server (stdio, profiled 30-tool base) ←→ CDP (localhost:9222) ←→ TradingView Desktop (Electron)
                 │
                 ├─ subscribe(kind) → AsyncIterable  (CLI JSONL sinks · MCP resource notifications · gateway SSE)
                  └─ resources: tradingview://chart/{state,quote}, capabilities
```

Pine graphics path: `study._graphics._primitivesCollection.dwglines.get('lines').get(false)._primitivesDataById`

## Operation registry (P2-19)

Every tool is ONE registry op (`src/tools/_registry.js op()`): name, description,
input schema, annotations (access class DERIVED from them), handler, transports.
The MCP table mirrors it (`toolFromRegistry`); the loopback gateway's route table
is GENERATED from the same set (`httpRoutes()`), and only read ops can carry an
`http` transport (`{ method, path, adapter(url, _deps) }`) — mutations are
structurally unbindable until an ADR says otherwise. 102 ops;
`system_status`/`profile_set` sit outside deliberately (they describe the registry).
Contract tests: `tests/registry.test.js`.

## Named levels (P2-10)

`src/core/named_levels.js` — pure grammar parser over Pine label text:
recognized tokens (PDH/PDL/OR/settlement/ICH/FVG/OB, 39 frozen patterns, 4
categories) → `{name, price, category, confidence, raw_text}`. Exact
whole-token match only; unrecognized text is NEVER coerced into a level.
Opt-in via `normalize: true` (+ optional `categories` denylist) on
`data_get_pine_labels` / `session_snapshot` — raw `labels` always preserved;
`named_levels` augments. Gateway: `GET /levels` (normalization implied,
`?categories=csv`). Tests: `tests/named_levels.test.js`.

## Mutation routes (ADR 0001)

The gateway is READ-ONLY unless **both** gates arm: the op declares
`meta.mutation_adr: '0001-mutation-routes'` (checked by `op()` — without it, any
non-GET/non-read http binding is refused at registration) AND the gateway runs
with `TV_GATEWAY_MUTATIONS=on` (`startGateway({ _env })`; unset or any other
value → mutation routes 404, `http_mutations_disabled`). Only then are paper
mutation routes served: `POST /paper/connect`, `POST /paper/orders` (**requires
`client_order_id` in the body — no opt-out over HTTP**), `POST
/paper/orders/cancel`, `PATCH /paper/orders/modify`, `POST
/paper/positions/close`, `PATCH /paper/brackets`. Mutation adapters receive
`(url, _deps, body, req)`; bodies are JSON, 1 MB cap. Non-loopback peers get
403 even with the flag on; `destructive`/`open-world` ops stay MCP-only. See
`docs/adr/0001-mutation-routes.md`. Tests: `tests/registry.test.js` (meta
gate), `tests/gateway.test.js` (posture), `tests/order_idem.test.js` (HTTP
replay).

Rationale (don't "simplify" this away): loopback is NOT an identity check —
any local process can connect, and browser tabs can POST to
`http://127.0.0.1:<port>` regardless of CORS (drive-by/CSRF-localhost). The
flag is the only auth between "read-only loopback service" and "order-capable
loopback service"; read/write asymmetry is why it isn't default-on. The flag
gates everything else on the machine, not the user — MCP/CLI mutations need no
flag. If it proves too heavy, the graduated fallback (idempotent mutates under
`on`, place/close under a second value) is a one-line ADR amendment — see the
ADR's alternatives section before proposing it.
