# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in this project, please report it responsibly.

**Email:** Open a private security advisory via [GitHub Security Advisories](https://github.com/tradesdontlie/tradingview-mcp/security/advisories/new).

**Do not** open a public issue for security vulnerabilities.

## Scope

This project connects to a locally running TradingView Desktop instance via Chrome DevTools Protocol on `localhost:9222`. Security concerns in scope include:

- Code injection via crafted tool inputs
- Unintended data exposure through tool outputs
- Credential or session token leakage
- Vulnerabilities in the MCP server or CLI that could be exploited locally

## Out of Scope

- TradingView's own security (report to TradingView directly)
- Chrome DevTools Protocol security (report to Google/Chromium)
- Claude Code or MCP SDK security (report to Anthropic)

## Best Practices for Users

- Only run TradingView with `--remote-debugging-port=9222` on localhost
- Do not expose port 9222 to your network or the internet
- Do not pipe `tv stream` output to external services without reviewing the data
- Keep your TradingView Desktop and Node.js installations up to date

## Capability Boundaries

`ui_evaluate` can execute arbitrary JavaScript with the privileges of the active TradingView page. It is denied before any CDP call unless the MCP server or CLI is deliberately started with:

```text
TRADINGVIEW_MCP_ALLOW_ARBITRARY_PAGE_JS=I_UNDERSTAND_THIS_EXECUTES_ARBITRARY_JAVASCRIPT
```

`replay_trade` changes only TradingView's internal Bar Replay simulated position. It is independently denied before any CDP call unless the server or CLI is started with:

```text
TRADINGVIEW_MCP_ALLOW_REPLAY_TRADES=I_UNDERSTAND_THIS_CHANGES_SIMULATED_REPLAY_POSITIONS
```

`tv_update` fast-forwards the checkout to `origin/main` and runs `npm ci`, executing whatever remote code and dependencies arrive from the repository. It is denied before any git, network, or npm side effect unless the server or CLI is started with:

```text
TRADINGVIEW_MCP_ALLOW_SELF_UPDATE=I_UNDERSTAND_THIS_PULLS_AND_RUNS_REMOTE_CODE
```

Replay navigation (`replay_start`, `replay_step`, `replay_autoplay`, `replay_status`, and `replay_stop`) does not require this capability.

`alert_delete` with `delete_all` performs an irreversible bulk deletion of every price alert on the account. It is not env-gated (creating and deleting individual alerts is routine), but a bare `delete_all` is refused: the caller must pass `confirm: "DELETE_ALL_ALERTS"` so an assistant or injected prompt cannot wipe every alert from a single casual flag.

## HTTP Gateway Mutations (ADR 0001)

The optional loopback gateway (`tv gateway`, port 9223) is **read-only unless you opt in**. Paper-order mutations over HTTP exist only when the gateway is started with:

```text
TV_GATEWAY_MUTATIONS=on
```

Any other value — including `1`, `true`, or `yes` — leaves the routes unset (`404 http_mutations_disabled`). The exact value is deliberate: this flag is the *only* auth the gateway has.

Why the flag matters even though the gateway binds 127.0.0.1 only:

- **Loopback is not an identity check.** Every local process can reach the port, and browser tabs can SEND requests to `http://127.0.0.1:<port>/...` regardless of CORS (CORS blocks reading responses, not firing POSTs — the drive-by/CSRF-against-localhost pattern). With mutations armed, a struck webpage could POST paper orders, cancel working orders, or close positions unauthenticated. The flag keeps that surface nonexistent until you asked for it, this session, deliberately.
- **Read/write asymmetry.** Unauthenticated reads leak data; unauthenticated writes silently corrupt replays or scripted strategy runs.
- **It does not gate you.** All mutations remain available over MCP and the CLI without any flag. The flag only creates an order-capable HTTP surface, which is an opt-in.

When armed: paper-only routes (`POST /paper/orders`, `/paper/connect`, `/paper/orders/cancel`, `/paper/positions/close`, `PATCH /paper/orders/modify`, `/paper/brackets`); order placement REQUIRES `client_order_id` (idempotent retries — replay after a timeout returns the original outcome instead of duplicating); non-loopback peers are refused (`http_forbidden`) even with the flag on; `destructive` and `open-world` tools are never bindable over HTTP. Full rationale and the graduated fallback if this proves too strict for your machine: [docs/adr/0001-mutation-routes.md](docs/adr/0001-mutation-routes.md).

Do not enable dangerous capabilities for routine use. Other tools still control the TradingView UI, modify chart or cloud state, create alerts, launch a local process, and self-update this checkout. Treat MCP clients and prompts as trusted code, and review every state-changing request.

This repository has no broker-order integration. The Replay trade gate does not inspect account type, broker connectivity, or every TradingView UI state, so it cannot prove demo/paper isolation. Keep real brokers disconnected and do not use generic UI automation around order-entry surfaces. Paper trading over HTTP (ADR 0001, above) targets TradingView's native Paper provider only and fail-closes on any other active broker — but the same "cannot prove isolation" caveat applies: verify broker identity with `paper_get_status` before arming anything.
