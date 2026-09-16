# REST Data Surfaces — Discovery

Status: **implemented** (2026-09-16). Endpoint evidence captured and verified
2026-09-15 from live probes (Node 24.11 and the repo venv Python). **11 of 13
target capabilities solved; 2 open** (§10). **§11's proposed 12 tools are now
BUILT**: `src/core/rest.js` (transport, field maps, SSR extraction, shaping) +
`src/tools/rest.js` (12 read-only ops, each with a derived GET binding in the
loopback gateway), in the `base` profile, with offline contract tests in
`tests/rest.test.js` (58 cases — no test touches the network). Every endpoint
shape below was re-verified live against the implementation the day it landed.
All requests below are unauthenticated and cookie-less.

## Purpose and scope

The MCP today reaches TradingView exclusively through **CDP → TradingView
Desktop** (`src/connection.js`). That path requires the desktop app to be
running, signed in, and to hold a chart. It cannot answer questions that have
nothing to do with the current chart — "what is the P/E of AAPL", "which US
stocks are up >5% on volume", "what macro events are today".

TradingView also exposes **public, cookie-less HTTP JSON endpoints** behind the
site and its embeddable widgets. This document records every one verified
reachable, what it returns, and what it would take to expose it as an MCP tool.

Scope is **read-only market/reference data**. Account-scoped surfaces (alerts,
watchlist CRUD) are covered in §8 because they need a different mechanism.

## Non-goals

- No trading, order, or alert mutation over these endpoints. (Alerts already
  exist via the app-session path — `src/core/alerts.js`.)
- No scraping of rendered pages. **Widgets are a discovery channel, not a
  transport** — see §7.
- No credential handling. These endpoints need no auth, and this document must
  never contain cookies, tokens or authorization headers (see §9).

## 1. Mechanism summary

| Host | Auth | Headers required | Used for |
|------|------|------------------|----------|
| `scanner.tradingview.com` | none | `User-Agent` only | Screener, quotes, technicals, fundamentals, financial history, earnings scan |
| `scanner-backend.tradingview.com` | none | `User-Agent` only | Enum/ordered catalogues (§2.4) |
| `chartevents-reuters.tradingview.com` | none | **none beyond UA** | Economic calendar |
| `news-headlines.tradingview.com` | none | `User-Agent` only | News headlines (per-symbol) |
| `news-mediator.tradingview.com` | none | `User-Agent` **+ `Origin`** | News flow / by symbol (§4.2) |
| `symbol-search.tradingview.com` | none | `User-Agent` **+ `Origin`** | Symbol resolution |
| `www.tradingview.com/symbols/...` | none | `User-Agent` only | Documents & story text via SSR init-data (§5) |
| `pricealerts.tradingview.com` | **session cookie** | app session | Alerts (existing path) |

A browser `User-Agent` is required everywhere. Two hosts (`symbol-search`,
`news-mediator`) additionally need `Origin: https://www.tradingview.com`.
`chartevents-reuters` tolerates no headers at all.

`Origin`/`Referer` are CORS-style filters on some hosts, not auth. Requests
with no UA (or a non-browser UA) are rejected or throttled.

> **Not every `*.tradingview.com` host is callable.** Probed and found **dead**
> (DNS failure or absent): `documents.tradingview.com`,
> `earnings.tradingview.com`, `papertrading.tradingview.com` (widget-only),
> `crud-storage.tradingview.com`, `contest.tradingview.com`. Do not invent
> hostnames — see §7 for how hosts were actually found.

### 1.1 Two access modes — and why both matter

The same endpoints are reachable two ways:

| Mode | How | When to use |
|------|-----|-------------|
| **Direct HTTP** (preferred) | Node `fetch` from the MCP process | Always, for everything in §2–§6 |
| **App-session XHR** | `evaluateAsync` inside the desktop page | Only for §8 (account-scoped) |

Direct HTTP does **not** need the desktop app, a chart, or a login. It is
strictly better for market data. The app-session path remains necessary only
where a session cookie is required.

> Correction to an earlier assumption: CORS is a **browser** rule. The hosts
> that appear "blocked" when called via page XHR are reachable from Node and
> Python with no issue. Do not conclude an endpoint is unreachable from a
> failure inside `ui_evaluate`.

## 2. Screener & quotes — `scanner.tradingview.com`

### 2.1 `POST /{market}/scan` — full screener

```
POST https://scanner.tradingview.com/america/scan
Content-Type: text/plain;charset=UTF-8

{
  "filter":  [{"left":"market_cap_basic","operation":"greater","right":100000000000}],
  "columns": ["name","close","volume","RSI|60"],
  "sort":    {"sortBy":"market_cap_basic","sortOrder":"desc"},
  "range":   [0, 100]
}
```

Response: `{ "totalCount": 360, "data": [ { "s": "NASDAQ:NVDA", "d": ["NVDA", 212.17, ...] } ] }`

- `s` is the full `EXCHANGE:TICKER`; `d` is the row aligned to `columns` order.
- `totalCount` is the **unpaged** match count — a cheap way to screen without
  pulling rows.
- `range` is `[offset, offset+limit]`, not a limit.

**Verified market slugs** (all 200):

| slug | totalCount (probe) |
|------|--------------------|
| `america` | 19,939 |
| `crypto` | 62,368 |
| `forex` | 6,310 |
| `futures` | 53,518 |
| `bonds` | 1,159 |
| `cfd` | 650 |

Others per the official MCP docs: `uk`, `germany`, `india`, `japan`.

Filter operators observed: `greater`, `less`, `egreater`, `eless`, `in_range`,
`equal`, `not_equal`, `match`. Special filter keys `index`, `sector`,
`industry`, `analyst_rating` take a string, not a `[min,max]` pair.

### 2.2 `GET /symbol` — per-symbol snapshot (the workhorse)

```
GET https://scanner.tradingview.com/symbol?symbol=NASDAQ%3AAAPL&fields=<csv>&no_404=true
```

`no_404=true` is required — without it an unknown symbol 404s instead of
returning `{}`. Response is a flat object keyed by the requested field:

```json
{"close":331.34,"market_cap_basic":4835635302713.473,"name":"AAPL","volume":31747883}
```

Every capability below is **the same endpoint with different `fields`**. This is
the single highest-leverage thing in this document — one tool with a field
allowlist covers five of the official MCP's tools.

| Capability | Fields (verified 200) |
|---|---|
| Quote / symbol data | `name,close,change,change_abs,volume,market_cap_basic,price_earnings_ttm,sector,industry` |
| Technicals rating | `RSI\|60,Stoch.K\|60,Stoch.D\|60,CCI20\|60,ADX\|60,MACD.macd\|60,Mom\|60,AO\|60,EMA10\|60,EMA200\|60,SMA200\|60,VWMA\|60,HullMA9\|60,Recommend.All\|60,Recommend.MA\|60,Recommend.Other\|60` |
| Fundamentals | `total_revenue,net_income,ebitda,gross_margin,return_on_equity,debt_to_equity` |
| Analysts / forecasts | `recommendation_mark,price_target_1y,target_price_1y,earnings_per_share_forecast_next_fy` |
| Dividend schedule | `dividends_yield,dividend_payout_ratio_ttm,dividend_ex_date_upcoming,dividend_amount_upcoming,dividend_payment_date_upcoming` |
| Dividend history | `dps_common_stock_prim_issue_fy_h` → 20 years, per share (§2.2.1) |
| Earnings dates | `earnings_release_date,earnings_release_next_date` (unix seconds) |
| Company profile | `number_of_employees,total_shares_outstanding,beta_1_year,business_description,ceo,founded` |
| Analyst targets | `price_target_average,price_target_high,price_target_low,recommendation_buy,recommendation_hold,recommendation_sell,recommendation_total` |
| Financial **history** | `total_revenue_fy_h,total_revenue_fq_h,net_income_fy_h,free_cash_flow_fy_h,total_assets_fy_h` → **arrays** |
| **EPS history** | `earnings_per_share_diluted_fy_h`,`earnings_per_share_diluted_fq_h`,`earnings_per_share_basic_fy_h` → **arrays** (§2.2.1) |
| **Dividend history** | `dps_common_stock_prim_issue_fy_h` → **array** (20y) (§2.2.1) |
| Fiscal-year labels | `fiscal_period_fy_h` → `[2025,2024,...]`, index-aligns the `_fy_h` arrays |

Timeframe is a suffix on the field name: `RSI|60` = RSI on the 1h.

**CORRECTED 2026-09-16 (implementation finding — the original list below was
wrong).** Verified working suffixes: `1, 5, 15, 30, 60, 120, 240, 1W, 1M`.
**`|1D` returns `null` for every field** and so do `|D`, `|W`, `|M`, `|2`, `|3`,
`|45`, `|180`, `|480`, `|720`, `|12M`. The **DAILY value is the BARE field
name** — `RSI` is daily RSI, `Recommend.All` is the daily rating. Proof: Wilder
RSI(14) computed from Yahoo daily closes for AAPL = `61.3086`, and the scanner's
bare `RSI` = `61.30858354729889` (exact match), while `RSI|1D` = `null`.

`tv_technicals_rating` therefore accepts `1D`/`daily`/`D` and realizes it by
emitting the unsuffixed name, never `|1D` (`TIMEFRAMES` in `src/core/rest.js`).

> `recommendation|60` returned `null` for AAPL while `Recommend.All|60` returned
> a value. Prefer the `Recommend.*` field family; treat bare `recommendation` as
> unreliable.

**Financial history (`_fy_h` / `_fq_h`)** returns an array of historical values,
most-recent-first, not a scalar:

```
GET .../symbol?symbol=NASDAQ%3AAAPL&fields=free_cash_flow_fy_h,total_revenue_fq_h&no_404=true
→ {"free_cash_flow_fy_h":[98767000000,108807000000,99584000000, ...20+ values]}
```

This is `get_financial_history` (§10, solved). The plain (no `_h`) variants
`total_revenue_fy`, `net_income_fq`, `ebitda_fy` return **scalars** for the
current period. Use `_h` for series, bare for the latest snapshot.

#### 2.2.1 The 15 verified history fields

Exhaustively probed (192 candidate fields). Only these return arrays — **all
others in the 547-field catalogue return `null`**:

| Field | Length | Unit | Notes |
|---|---|---|---|
| `total_revenue_fy_h` / `_fq_h` | 20 / 32 | currency | |
| `net_income_fy_h` / `_fq_h` | 20 / 32 | currency | |
| `total_assets_fy_h` / `_fq_h` | 20 / 32 | currency | |
| `total_debt_fy_h` / `_fq_h` | 20 / 32 | currency | |
| `free_cash_flow_fy_h` / `_fq_h` | 20 / 32 | currency | |
| `earnings_per_share_diluted_fy_h` / `_fq_h` | 20 / 32 | per share | **EPS history** |
| `earnings_per_share_basic_fy_h` | 20 | per share | annual only — `_fq_h` is `null` |
| `dps_common_stock_prim_issue_fy_h` | 20 | per share | **dividend history** |
| `fiscal_period_fy_h` | 20 | year int | `[2025,2024,...]` — index-aligns the `_fy_h` arrays |
| `gross_profit_fy_h`, `ebitda_fy_h` | 20 | currency | |

**Naming traps — the working name is not the obvious one.** All of these are
`null`, despite looking correct:

| Looks right | Actually needed |
|---|---|
| `earnings_per_share_fq_h` | `earnings_per_share_**diluted**_fq_h` |
| `earnings_per_share_fy_h` | `earnings_per_share_**diluted**_fy_h` or `_**basic**_fy_h` |
| `earnings_per_share_basic_fq_h` | *(no working quarterly basic EPS)* |
| `dividend_amount_h`, `dividends_fy_h`, `dividend_amount_fy_h` | `dps_common_stock_prim_issue_fy_h` |
| `eps_fq_h`, `eps_fy_h`, `diluted_eps_fy_h` | *(do not exist)* |

> **Membership in the 547-field catalogue does NOT mean a field returns data.**
> `eps_estimates_fq_h`, `revenue_estimates_fq_h`, `dps_estimates_fy_h`,
> `earnings_release_date_fq_h` and `earnings_release_date_fy_h` are all in the
> catalogue and all return `null`. Probe before relying on any `_h` field.

**No earnings *surprise* or per-quarter *date* fields exist.**
`earnings_release_date_fq_h`/`_fy_h` are `null`; only the forward-looking
scalars `earnings_release_date` / `earnings_release_next_date` work. Earnings
history is EPS-per-period only — pair it with `fiscal_period_fy_h` for annual
labels; quarterly periods have no label field.

#### 2.2.2 History in bulk scans

History columns work in `/scan` and return per-symbol arrays — this is what
makes them usable for screening:

```json
POST /america/scan
{"filter":[], "columns":["name","dps_common_stock_prim_issue_fy_h","earnings_per_share_diluted_fy_h"],
 "sort":{"sortBy":"market_cap_basic","sortOrder":"desc"}, "range":[0,4]}
→ {"data":[{"s":"NASDAQ:NVDA","d":["NVDA",[0.04,0.034,...],[4.8979,2.9382,...]]}, ...]}
```

> **You cannot filter on a history field.**
> `{"left":"dps_common_stock_prim_issue_fy_h","operation":"greater","right":1}`
> returns `totalCount: 0` — the engine does not compare array-valued columns.
> **Filter on a scalar, then read the array.** The working pattern is to filter
> on `dividends_yield` / `earnings_release_next_date` and carry the `_h` column
> in `columns` for the rows you get back.

**Availability varies by instrument** — correct, not an error:

| Symbol | `*_fy_h` | Why |
|---|---|---|
| `NASDAQ:AAPL`, `NVDA`, `NYSE:KO` | arrays | dividend payers |
| `NASDAQ:TSLA` | `dps` = `[0,0,0,...]` | real zeros — non-payer |
| `AMEX:SPY` (ETF) | all `null` | ETFs have no company fundamentals |

Zeros and `null` mean different things: `[0,0,...]` is a genuine non-payer,
`null` is no fundamental data for that instrument class.

> Some profile fields return `null` for AAPL (`business_description`, `ceo`,
> `founded`, `dividend_ex_date_upcoming`) while others populate. Null is a real
> answer — do not treat it as a failed call.

### 2.3 Economic indicator series

Same endpoint, `ECONOMICS:` symbols:

```
GET .../symbol?symbol=ECONOMICS%3AUSIRYY&fields=name,close,unit,currency,update_mode&no_404=true
→ {"close":3.4,"currency":null,"name":"USIRYY","unit":null,"update_mode":"streaming"}
```

Ticker form is `ECONOMICS:<COUNTRY><INDICATOR>`. `USIRYY` = US 10Y real yield.
Note `unit`/`currency` came back `null` here — do not assume they populate.

**No catalogue endpoint found** (see §10) — `get_economic_symbols` has no public
equivalent. Codes must be supplied by the caller.

### 2.4 `GET /enum/ordered` — catalogue endpoint

```
GET https://scanner-backend.tradingview.com/enum/ordered?id=<enum_id>
```

Returns `{"<enum_id>":[{id,name,options}, ...]}`. Verified working ids:

| `id` | Returns |
|---|---|
| `metrics_full_name` | 915 B of `{id,name}` metric definitions |
| `metrics` | 761 B, short-name variants |

**Every other id returns `{}`** (200 with empty object). Probed and empty:
`screener_columns`, `columns`, `fields`, `markets`, `exchanges`, `countries`,
`sectors`, `industries`, `symbol_types`, `indicators`, `screener_presets`,
`documents_categories`, `financials_periods`, `economic_indicators`,
`news_categories`, `technical_ratings`.

> An empty `{}` is not a 404 — do not read it as "endpoint missing". The enum
> ids are not guessable; only these two are confirmed.

### 2.5 Screener column catalogue — from the bundle (547 fields)

The full accepted-column list is **embedded in a widget bundle**, not served by
an endpoint. Harvested from
`https://www.tradingview-widget.com/static/bundles/embed/74255.*.js`:

- **579 raw / 547 unique** field names (one large JSON array literal)
- Includes `documents`, `financials_availability`, `earnings_availability`,
  `isin-displayed`, `cusip`, `cfi_code`, `top_holdings`, `etf_asset_type_exposure`,
  the full `interest_income_*` / `pretax_income_*` / `income_tax_*` families
- **Persisted** to `docs/fixtures/screener-columns.json`, regenerated by
  `npm run harvest:rest` (§11)

> **Sibling bundles carry same-shape arrays that are NOT columns.** Picking by
> "looks like a JSON string array" yields 761 names, ~180 of which are chart
> feature flags (`auto_enable_symbol_labels`) and line-tool classes
> (`LineToolFibRetracement`). The harvest selects by **content** — the array
> containing known-good column seeds — which yields the correct 547.

This settles `get_screener_columns` (§10) — but note it is harvested, so it
drifts when TradingView adds fields. Prefer it as a *validation allowlist*, not
as a live catalogue (§11, field-map rules).

## 3. Economic calendar — `chartevents-reuters.tradingview.com`

The best find in this document. **No headers required at all** — not even
`Origin`:

```
GET https://chartevents-reuters.tradingview.com/events?from=2026-09-16&to=2026-09-19&countries=US,EU
→ 200, ~78–236 KB
```

```json
{"status":"ok","result":[{
  "id":"16654740 2026-09-16 11:00:00 +0000 UTC MBA 15-Yr Contract Rate ...",
  "title":"MBA 15-Yr Contract Rate",
  "country":"US","currency":"USD",
  "date":"2026-09-16T11:00:00.000Z",
  "actual":null,"forecast":null,"previous":6.17,
  "importance":0,"period":"w/o Sep. 7, 2026","unit":"%",
  "comment":"","link":"","scale":"","source":"","indicator":"MBA 15-Yr Contract Rate"
}]}
```

- `importance`: `-1` low, `0` medium, `1` high (matches the official tool's
  `min_importance` scale). **Implementation note:** a live no-country probe on
  2026-09-16 also emitted `2`, which is outside the documented scale —
  `tv_economic_calendar` therefore labels only the three documented values and
  returns `importance_label: null` for anything else rather than coercing it.
- `countries` accepts a comma-separated ISO-2 list; omitted returns all.
- The `id` field is a composite string (timestamp + title), **not** a stable
  numeric id — do not use it as a primary key.
- `actual`/`forecast` are `null` for future events; this is a forward-looking
  calendar, not a historical release feed.

**Alternative host (worse):** `economic-calendar.tradingview.com/events`
returns the same shape but **403s without `Origin`+`Referer`**. Use
`chartevents-reuters`.

## 4. News — `news-headlines.tradingview.com`

### 4.1 Per-symbol headlines

```
GET https://news-headlines.tradingview.com/v2/headlines?symbol=NASDAQ%3AAAPL&lang=en&client=web
→ 200, ~128 KB
```

```json
{"items":[{
  "id":"DJN_DN20260915008240:0",
  "title":"Apple Finally Built a Smarter Siri. ...",
  "provider":"dow-jones","source":"Dow Jones Newswires",
  "published":1789524000,"urgency":2,"permission":"provider",
  "relatedSymbols":[{"symbol":"NASDAQ:AAPL","logoid":"apple"}],
  "storyPath":"/news/DJN_DN20260915008240:0/"
}]}
```

- `urgency`: `1` = top story, `2` = normal.
- `client=web` appears required.
- `lang` supports `en,ru,de,fr,es,pt,it,pl,tr,ar,he,ko,ja,vi,th,ms,id,zh-Hans,zh-Hant,ro,en_IN`.
- **Headlines only, ~100 per symbol.** Full story text is §4.3 / §5.

### 4.2 `news-mediator` — news flow & by-symbol

```
GET https://news-mediator.tradingview.com/public/news-flow/v2/news?<params>
GET https://news-mediator.tradingview.com/public/view/v1/symbol?<params>
Headers: User-Agent + Origin: https://www.tradingview.com
```

**Parameter construction is strict and non-obvious.** Filters are
`filter=<id>:<csv-values>`, URL-encoded, and **must be sorted by filter id
alphabetically** or the server 400s:

```
filter=lang%3Aen&filter=symbol%3ANASDAQ%3AAAPL&client=web&user_prostatus=non_pro
```

| Param | Notes |
|---|---|
| `filter=lang:<code>` | required |
| `filter=symbol:<EXCHANGE:TICKER>` | the `EXCHANGE:` prefix is **required** — bare `AAPL` → 422 |
| `filter=id:<story_id>` | sort `id` before `lang` |
| `client=web` | required |
| `streaming=true` | optional; adds streaming metadata |
| `user_prostatus=non_pro` \| `pro` | affects `paywall`/`permission` |

Verified: `public/view/v1/symbol` with `symbol:` returned **200 / 137 KB / 200
items**; `public/news-flow/v2/news` returned **200 / 127 KB**.

- Errors are informative — `"filters must be sorted"` and
  `"symbol is missing or multiple symbols set"` are both server-side validation,
  not blocked requests. Read the message.
- The **full item key set is only**: `paywall, id, title, published, urgency,
  permission, relatedSymbols, storyPath, provider`. **No body text here** —
  `items_with_body === 0` was measured across 200 items.
- By-id queries return `items: []` — use it to resolve a symbol's flow, not a
  single story.

> Discovery method: these paths came from the story bundle
> `static.tradingview.com/static/bundles/story.*.js`, whose
> `mediatorUrl()` helper revealed `public/news-flow/v2/news` and
> `public/view/v1/symbol`. The bundle's own code is the spec — read it rather
> than guessing param names.

### 4.3 `get_story` — full story text (solved)

Story text is **not** on any JSON API. It is an SSR payload in the story page:

```
GET https://www.tradingview.com/news/<story_id>/
   e.g. https://www.tradingview.com/news/DJN_DN20260915008240:0/
```

The page carries **6** `<script type="application/prs.init-data+json">` blocks.
The story is in the block whose JSON contains `title` + `ast_description` —
**the first block is the site menu, not the story**, so a naive "take block 0"
fails. Walk every block for an object with `title` and
(`ast_description` | `short_description`).

Verified extraction — **4,672 chars** of body text:

```
story keys: published, id, title, provider, language, story_path,
            short_description, ast_description, permission, paywall,
            related_symbols, urgency, tags, robots, copyright, read_time
```

`ast_description` is an AST: `{type:"root", children:[{type:"p", children:["..."]}]}`.
Flatten with a recursive child-walk. `short_description` is a truncated
plain-text fallback. `permission`/`paywall` are set per provider (`provider` +
`paywall: true` for Dow Jones) — honour them and do not strip paywall markers.

## 5. Documents & filings — SSR init-data (solved)

```
GET https://www.tradingview.com/symbols/<EXCHANGE>-<TICKER>/documents/
   e.g. https://www.tradingview.com/symbols/NASDAQ-AAPL/documents/
```

Same `prs.init-data+json` mechanism as §4.3. The filings block is the one
matching `symbol-page-tab-filings`. Structure:

```
symbolPage.documents = { items: [...], meta: {...}, total }
```

**Implementation note (2026-09-16):** the filings object hangs off the symbol
page alongside its siblings — `page.earnings` (the date-keyed map), `currency`,
`active_tab` — so the implementation matches on `documents.items + total` on the
PARENT and reads `page.documents.*`. Matching the bare `{items,total}` child
would find the same object but lose the sibling earnings map. There are 7
init-data blocks on the page and the filings one is block **3**, not block 0.

Verified: **AAPL 157 documents**, NVDA 146, MSFT 86 (`documents.total` equals
`items.length` — the whole set ships in the page, no paging).

**Document item shape:**

```json
{
  "id": "urn:report:quartr.com:3669984",
  "correlation_id": "urn:event:quartr.com:658553",
  "category": { "id": "quarterly_report", "title": "Quarterly report" },
  "fiscal_period": "Q3", "fiscal_year": 2026,
  "provider": { "id": "quartr", "name": "Quartr" },
  "reported": 1785445200, "status": "usable",
  "title": "Q3 2026",
  "views": [
    { "id": "urn:transcripts:quartr.com:4150668", "type": "transcript" },
    { "id": "urn:summary_document_transcript:quartr.com:2559595", "type": "summary" }
  ],
  "event": "earning", "form": {...}, "symbols": [{ "symbol": "NASDAQ:AAPL" }]
}
```

| Field | Verified values |
|---|---|
| `category.id` | `event_transcript`, `quarterly_report`, `call_transcript`, `earnings_release`, `annual_report`, `slides` |
| `views[].type` | `transcript`, `summary`, `pdf` |
| `provider.id` | `quartr` (only provider observed) |
| `event` | `earning`, `corporate_event` |
| `status` | `usable` |

`documents.meta.items` is the **filter tree** the UI renders — ids include
`all`, `earnings`, `quarterly_reports`, `annual_reports`, each with
`available`, `attrs.title`, and `events`/`categories`. Use it to validate
category filters rather than hardcoding.

**Implementation finding (2026-09-16):** the tree is **nested**, and a filter id
owns its whole subtree. Live AAPL shape: `earnings` → {`quarterly_reports`,
`annual_reports` (+`interim_reports`, `available: false`), `earnings_releases`,
`call_transcript`}; `corporate_events` → {`event_transcript`}. So
`category: "earnings"` matches **144** items across 4 category ids, while
`category: "corporate_events"` matches 12 `event_transcript` items — the two
subtrees are disjoint. `tv_documents` collects the subtree's category set (not
just the id), and surfaces `available` so a caller can tell a dead filter from
an empty result.

`page.earnings` is a **separate** date-keyed map (unix seconds → `{date,
standardized, estimate, period, timeType, reported, revenueEstimate,
revenueValue}`) — usable as an earnings-history source.

**Caveats:**

- `form` is an **object**, not a string (`"10-K"` is not a flat field). Do not
  assume `form` is a form-type code.
- Slug is `<EXCHANGE>-<TICKER>` — `NYSE-TSLA` **404s**, `NASDAQ-TSLA` works.
  Derive the exchange from `symbol_search`, don't guess it.
- **`get_document_view` is NOT solved.** The `views[].id` values are Quartr
  URNs; no endpoint accepting them was found (`public/view/v1/document`,
  `scanner-backend/.../documents/view`, and both page-URL forms all 404). The
  official MCP resolves these server-side. Treat body text of a filing as
  **unavailable** until an endpoint is found — the list, categories, dates and
  view ids are what we can deliver.

## 6. Symbol search — `symbol-search.tradingview.com`

```
GET https://symbol-search.tradingview.com/symbol_search/v3/?text=AAPL&hl=1&lang=en
Headers: User-Agent + Origin: https://www.tradingview.com
→ 200, ~24 KB
```

**Already implemented** at `src/core/chart.js:273` (`symbolSearch`) and exposed
as `symbol_search`. This doc records it for completeness — do not re-implement.

Two findings worth noting:

- `Origin` alone is sufficient; `Referer` is not needed (verified).
- Matches are **HTML-highlight wrapped**: `"symbol":"<em>AAPL</em>"`. Stripping
  is required and already done at `chart.js:290`.
- Returns `isin`, `cusip`, `cik_code`, `currency_code` per match — useful for
  deriving the documents slug (§5).

## 7. Widgets are a discovery channel, not a transport
Widget loaders do **not** contain data URLs. The runtime config does. The
repeatable procedure that found §3:

1. Find the widget id (e.g. `events`, `technical-analysis`, `screener`) from
   <https://www.tradingview.com/widget-docs/widgets/>
2. `GET https://www.tradingview-widget.com/embed-widget/<id>/`
   → the rendered embed page whose inline bootstrap holds the config
3. Grep that HTML for `*_URL` / `*_HOST` / `*_ENDPOINT` assignments:

   ```
   window.CHARTEVENTS_URL        = 'https://chartevents-reuters.tradingview.com/'
   window.S3_LOGO_SERVICE_BASE_URL = 'https://s3-symbol-logo.tradingview.com/'
   window.PUSHSTREAM_URL         = 'wss://pushstream.tradingview.com'
   window.WIDGET_SHERIFF_HOST    = 'https://widget-sheriff.tradingview-widget.com'
   ```

4. Fetch that host directly.

Notes:

- `https://s3.tradingview.com/external-embedding/embed-widget-<id>.js` — the
  loader — contained **no** absolute URLs. Only the embed page (step 2) does.
- The embed pages themselves (`/embed-widget/events/`) return HTML apps, and
  their sub-paths (`/events`, `/api/events`) 403. Do not treat the widget host
  as an API.
- **Never render or scrape a widget to get data.** Every widget is a JS client
  for an endpoint reachable directly (§1.1). Scraping a canvas/iframe is
  strictly worse than calling the URL it calls.

This procedure is unexhausted and is the recommended way to find §10's gaps.

**The second, more reliable channel is the site's own bundles.** §4.2's exact
URL and param syntax came from reading `story.*.js`, and §2.5's 547-field
catalogue came from a numbered widget chunk. Both are more precise than
hostname-hunting:

1. Fetch the relevant page (`www.tradingview.com/news/<id>/`,
   `www.tradingview.com/symbols/<sym>/documents/`)
2. Extract `https://static.tradingview.com/static/bundles/*.js` script srcs
3. Grep for `mediatorUrl`, `createUrlParams`, `public/...`, or a bare large
   JSON array literal
4. Read the construction code — the bundles are unminified enough to read

`advanced-chart` (76 KB) carries the richest config and is worth re-harvesting
first:

```
window.CHARTEVENTS_URL        = 'https://chartevents-reuters.tradingview.com/'
window.ECONOMIC_CALENDAR_URL  = 'https://economic-calendar.tradingview.com/'
window.NEWS_MEDIATOR_URL      = 'https://news-mediator.tradingview.com'
window.EARNINGS_CALENDAR_URL  = 'https://scanner.tradingview.com'
window.PINE_URL               = 'https://pine-facade.tradingview.com/pine-facade'
window.SCREENER_HOST          = 'https://scanner.tradingview.com'
window.S3_LOGO_SERVICE_BASE_URL = 'https://s3-symbol-logo.tradingview.com/'
window.PUSHSTREAM_URL         = 'wss://pushstream.tradingview.com'
window.WIDGET_SHERIFF_HOST    = 'https://widget-sheriff.tradingview-widget.com'
```

Notes:

- `https://s3.tradingview.com/external-embedding/embed-widget-<id>.js` — the
  loader — contained **no** absolute URLs. Only the embed page (step 2) does.
- The embed pages themselves (`/embed-widget/events/`) return HTML apps, and
  their sub-paths (`/events`, `/api/events`) 403. Do not treat the widget host
  as an API.
- **Never render or scrape a widget to get data.** Every widget is a JS client
  for an endpoint reachable directly (§1.1). Scraping a canvas/iframe is
  strictly worse than calling the URL it calls.
- Widget ids that **404** on the embed host (not all documented ids resolve):
  `seasonal-chart`, `market-summary`, `market-data`, `world-market-summary`,
  `ticker-tag`, `single-ticker`, `forex-table`, `fundamental-data`,
  `company-profile`, `news`, `top-stories`, `economic-map`, `broker-*`. The
  working ones: `advanced-chart`, `symbol-overview`, `market-overview`,
  `ticker-tape`, `tickers`, `stock-heatmap`, `crypto-coins-heatmap`,
  `etf-heatmap`, `screener`, `crypto-mkt-screener`, `symbol-info`,
  `technical-analysis`, `financials`, `timeline`, `events`.

### 7.1 Extracting `prs.init-data+json` (used by §4.3 and §5)

Several pages embed data as SSR JSON rather than exposing an API:

```js
const blocks = [...html.matchAll(
  /<script type="application\/prs\.init-data\+json">([\s\S]*?)<\/script>/g
)].map(m => m[1]);
```

Rules learned the hard way:

- **There are multiple blocks** (6 on a story page, 7 on a symbol page) and the
  story/filings data is rarely in the first. Walk *all* of them looking for a
  shape marker (`title` + `ast_description`, or `symbol-page-tab-filings`).
- Each block is itself keyed by an opaque id (`{"gpyz2o": {...}}`) — take
  `Object.values(block)[0]`.
- Some keys hold **objects keyed by date**, not arrays
  (`documents.items`, `earnings`). Check the type before iterating.

## 8. Account-scoped surfaces (different mechanism)

These **require the desktop app's authenticated session** and cannot use §1.1
direct HTTP — the endpoints read a session cookie and do not accept one being
passed in.

| Surface | Endpoint | Existing code |
|---|---|---|
| Alerts list/create/delete | `pricealerts.tradingview.com/{list,create,delete}_alerts` | `src/core/alerts.js` |
| Watchlist add/remove | `www.tradingview.com/api/v1/symbols_list/custom/...` | `src/core/watchlist.js:223` |
| Pine saved scripts | `pine-facade.tradingview.com/pine-facade/{list,get}` | `src/core/pine.js:770` |

Mechanism: `evaluateAsync` + `fetch(..., { credentials: 'include' })` inside the
page. The alerts implementation deliberately uses **synchronous XHR with
`withCredentials`** (`src/core/alerts.js:56`) because the endpoint rejects CORS
preflight; prefer `evaluateAsync` for anything with a large response —
synchronous XHR blocks the renderer thread.

Gaps vs the official MCP, all in this class:

- `update_alert` — change message/name/expiry/notifications on an existing id
- `stop_alerts` / `restart_alerts` — pause/resume without deleting
- `get_alerts_log` — **fire history; we have no equivalent at all**
- `get_alerts` — raw payload including conditions
- Watchlist CRUD beyond the active list (`list`/`create`/`delete`/`update`)

## 9. Security and evidence rules

Inherit `docs/PAPER_TRADING_DISCOVERY.md` §"Security rules for evidence
collection" verbatim. Additionally:

- These endpoints are **unauthenticated**; no cookie or token must ever be
  attached to a §2–§7 request, and none was during discovery.
- Do not add credentials, session ids, or `Origin` bypass tokens to this
  document or to fixtures.
- Redact account identifiers if §8 evidence is ever captured.

## 10. Open gaps

| Gap | Official tool | Status |
|---|---|---|
| ~~Full news story text~~ | `get_news_story` | **SOLVED** — §4.3, SSR `prs.init-data+json` on `www.tradingview.com/news/<id>/` |
| Filings & transcripts **list** | `get_documents` | **SOLVED** — §5, `www.tradingview.com/symbols/<EX>-<T>/documents/` (AAPL 157 docs) |
| ~~Financial history~~ | `get_financial_history` | **SOLVED** — §2.2, `_fy_h`/`_fq_h` field suffix returns arrays |
| ~~Earnings calendar (bulk)~~ | `get_earnings_calendar` | **SOLVED** — §2.1, scan with `earnings_release_next_date in_range [0, 9999999999]` → 2,014 rows |
| ~~Screener column catalogue~~ | `get_screener_columns` | **SOLVED** — §2.5, 547 fields harvested from bundle (no live endpoint) |
| Document **body text** | `get_document_view` | **OPEN** — §5. `views[].id` are Quartr URNs; no accepting endpoint found (4 candidates 404). List/dates/categories work; body text does not. |
| Economic symbol catalogue | `get_economic_symbols` | **OPEN** — §2.3/§2.4. No catalogue endpoint; `enum/ordered` returns `{}` for every economic id tried. |

### 10.1 Dead ends (do not re-probe)

Recorded so the next attempt does not repeat them:

| Attempted | Result |
|---|---|
| `documents.tradingview.com` | DNS failure |
| `earnings.tradingview.com/api/v1/calendar` | DNS failure |
| `scanner-backend.tradingview.com/{documents,earnings/calendar}` | 404 |
| `scanner-backend.tradingview.com/enum/ordered?id=<19 guessed ids>` | `{}` for all but `metrics*` |
| `news-mediator.tradingview.com/public/view/v1/{document,story,article}` | 404 |
| `news-mediator.../news/v1/<id>` | 404 |
| `www.tradingview.com/documents/<urn>/` | 404 |
| `www.tradingview.com/symbols/<sym>/documents/<urn>/` | 404 |
| `chartevents-reuters.tradingview.com/{countries,indicators}` | 404 |
| `symbol-search.tradingview.com/...&search_type=economic` | 200 but `symbols: []` |
| `s3-symbol-logo.tradingview.com/<logo>.svg` | 403 (referer-gated) |
| `economic-calendar.tradingview.com/events` | 403 without `Origin` — use `chartevents-reuters` |
| TSLA documents at `NYSE-TSLA` | 404 — correct slug is `NASDAQ-TSLA` |

## 11. Implementation notes

### Registry shape (P2-19)

Every tool must be one registry op (`src/tools/_registry.js op()`), with
annotations from `A.*` and a **read-only** access class. Read ops may carry an
`http` transport (`{ method, path, adapter }`) which auto-binds a gateway route;
mutations cannot without an ADR (see `CLAUDE.md` Mutation routes).

**[BUILT 2026-09-16]** — one new core module, one new tool file, exactly as
suggested (plus the wire-in points):

```
src/core/rest.js       # host table, UA, get/post, init-data extractor, shaping   ← BUILT
src/tools/rest.js      # op() registrations                                       ← BUILT
src/core/index.js      # export * as rest                                        ← wired
src/tools/index.js     # registerRestTools + registerAll                         ← wired
src/tools/_profiles.js # 12 names added to the `base` allowlist                  ← wired
src/tools/_format.js   # REST_ERROR_REASONS table beside the frozen CDP one      ← wired
eslint.config.mjs      # AbortSignal global (first src/ use)                      ← wired
docs/fixtures/*.json   # loaded at startup as a typo allowlist, never fetched     ← wired
tests/rest.test.js     # 58 offline cases (stubbed _deps.fetch)                   ← BUILT
```

| Built tool | Wraps | GET route | Official equivalent |
|---|---|---|---|
| `tv_screener_run` | `POST /{market}/scan` | `/screener` | `run_screener` |
| `tv_symbol_data` | `GET /symbol` (quote, profile, fundamentals, forecasts, dividends) | `/symbol/data` | `get_symbol_data`, `get_symbol_data_batch`, `get_financials`, `get_forecasts` |
| `tv_symbol_history` | `GET /symbol` with the 17 `_h` fields (§2.2.1) | `/symbol/history` | `get_financial_history` |
| `tv_earnings_history` | `GET /symbol` → `earnings_per_share_diluted_fy_h`/`_fq_h` + `fiscal_period_fy_h` | `/symbol/earnings-history` | *(scanner use)* |
| `tv_dividend_history` | `GET /symbol` → `dps_common_stock_prim_issue_fy_h` | `/symbol/dividend-history` | *(scanner use)* |
| `tv_technicals_rating` | `GET /symbol` + fixed field set | `/symbol/technicals` | `get_technicals_rating` |
| `tv_earnings_calendar` | `POST /{market}/scan` filtered by `earnings_release_next_date` | `/calendar/earnings` | `get_earnings_calendar` |
| `tv_economic_calendar` | `chartevents-reuters/events` | `/calendar/economic` | `get_economic_calendar` |
| `tv_news` | `news-headlines/v2/headlines` + `news-mediator` | `/news` | `get_news` |
| `tv_news_story` | story page SSR init-data | `/news/story` | `get_news_story` |
| `tv_documents` | documents page SSR init-data | `/documents` | `get_documents` |
| `tv_screener_columns` | harvested bundle list (§2.5) | `/screener/columns` | `get_screener_columns` |

Route names differ from the tool names on purpose: `/news` and `/documents` are
the resource, and `/symbol/*` namespaces the four facets that are all one
endpoint. Every one is a read-only GET (op() refuses anything else on an `http`
binding), asserted in `tests/registry.test.js`.

`tv_symbol_data` covers four official tools via a field map — prefer that over
four near-duplicate tools, and expose the field allowlist so callers can reach
any of the 547 columns without a new tool.

### Field-map design (the chosen approach)

**Decision: one `tv_symbol_data` tool with a named-field map, not one tool per
capability.** Rationale: every §2.2 capability is the same `GET /symbol` call
with different `fields`. Separate tools would duplicate the fetch, the auth
headers, the error envelope and the tests four-plus times.

Three layers, in order of preference:

```js
// src/core/rest.js

// Layer 1 — NAMED GROUPS. What callers use 95% of the time; stable and short.
export const FIELD_GROUPS = Object.freeze({
  quote:      ['name','close','change','change_abs','volume','market_cap_basic','sector','industry'],
  technicals: ['RSI|60','Stoch.K|60','Stoch.D|60','CCI20|60','ADX|60','MACD.macd|60',
               'Mom|60','AO|60','EMA10|60','EMA200|60','SMA200|60','VWMA|60','HullMA9|60',
               'Recommend.All|60','Recommend.MA|60','Recommend.Other|60'],
  fundamentals: ['total_revenue','net_income','ebitda','gross_margin','return_on_equity','debt_to_equity'],
  forecasts:  ['recommendation_mark','price_target_average','price_target_high','price_target_low',
               'recommendation_buy','recommendation_hold','recommendation_sell',
               'earnings_per_share_forecast_next_fq'],
  dividends:  ['dividends_yield','dividend_payout_ratio_ttm','dividend_amount_recent',
               'dividend_ex_date_recent','dividend_payment_date_recent'],
  profile:    ['number_of_employees','total_shares_outstanding','beta_1_year'],
  history:    HISTORY_FIELDS,   // the 17 verified array fields, below
});

// Layer 2 — the history fields. A literal, NOT derived from the catalogue:
// the catalogue contains look-alike names that return null.
export const HISTORY_FIELDS = Object.freeze([
  'total_revenue_fy_h','total_revenue_fq_h','net_income_fy_h','net_income_fq_h',
  'total_assets_fy_h','total_assets_fq_h','total_debt_fy_h','total_debt_fq_h',
  'free_cash_flow_fy_h','free_cash_flow_fq_h','gross_profit_fy_h','ebitda_fy_h',
  'earnings_per_share_diluted_fy_h','earnings_per_share_diluted_fq_h',
  'earnings_per_share_basic_fy_h','dps_common_stock_prim_issue_fy_h',
  'fiscal_period_fy_h',
]);

// Layer 3 — ESCAPE HATCH. Any raw column name passes through unvalidated
// against the harvested catalogue, which is used only to WARN on a miss.
```

Tool surface:

```
tv_symbol_data({ symbol, fields: ["quote","history"] })          // groups
tv_symbol_data({ symbol, fields: ["RSI|60","close"] })           // raw columns
tv_symbol_data({ symbol })                                        // default: quote
tv_symbol_data({ symbols: ["NASDAQ:AAPL","NASDAQ:NVDA"], ... })   // batch
```

Design rules:

1. **`fields` accepts group names and raw column names, mixed.** Resolve groups
   to columns, then union with raw names, then dedupe, then send one request.
2. **Unknown group name → error** (typo protection). **Unknown raw column →
   warn, still send it** — the catalogue is harvested and will lag TradingView,
   so a miss must not block a valid new field. Surface the warning in the
   result (`unknown_fields: [...]`) rather than throwing.
3. **Batch means one request per symbol** — `/symbol` is single-symbol. Emit
   them under `Promise.all` with a concurrency cap (~5) so a 50-symbol batch
   cannot trip rate limits. `symbols` is the ONLY reason to prefer this over
   `run_screener`, which returns many symbols in one request, so document when
   to use which.
4. **`history: true` implies a large response** (20–32 values × 17 fields ≈ 4 KB
   per symbol). Keep it opt-in per group, never in the default set.
5. **Ship the catalogue as a fixture, not a fetch.** `docs/fixtures/screener-columns.json`
   is loaded at startup for validation only. Never fetched inline.
6. **One `_h` field with no group and no `history` flag is legal** — the escape
   hatch covers it.

**Bulk scanning is a different tool.** `tv_screener_run` is the right call when
you need many symbols at once (one request, `totalCount`, server-side
sort/filter). The two compose: screen for the symbol list, then `tv_symbol_data`
for the detail on the handful you care about.

### Persisted fixtures

Discovery artifacts that must survive `%TEMP%` cleanup live in
`docs/fixtures/`, regenerated by `scripts/harvest_rest_fields.js`
(`npm run harvest:rest`):

| File | Contents |
|---|---|
| `screener-columns.json` | 547 accepted column names (validation allowlist) |
| `history-fields.json` | the 17 array-valued fields, with the naming warning |
| `rest-probe.json` | live response shapes per host, for regression comparison |

`--offline` re-derives `history-fields.json` and leaves the network-dependent
files untouched — use it when only the literals changed.

> **Do not treat `screener-columns.json` as proof a field returns data.** It is
> the accepted-name list. `earnings_per_share_diluted_fy_h` is **absent from it
> yet returns a 20-element array**; `eps_estimates_fq_h` is **present and
> returns `null`**. The catalogue is for typo-warning only — `history-fields.json`
> is the list that actually works.

### Hard requirements

1. **No new dependency.** Node 24 has global `fetch`, `AbortSignal.timeout`.
   The existing REST calls (`chart.js:284`, `pine.js:276`) already use bare
   `fetch`. Adding axios/undici would be a regression.
2. **A browser `User-Agent` on every request.** Non-negotiable for
   `scanner`/`news`; `chartevents-reuters` tolerates a bare UA but send it
   anyway for consistency. Model it on `chart.js:285`'s header style.
   `Origin: https://www.tradingview.com` is additionally required by
   `symbol-search` and `news-mediator`.
3. **Timeouts.** `AbortSignal.timeout(...)` — these are third-party endpoints
   and the MCP is synchronous from the client's perspective.
4. **`no_404=true`** on every `/symbol` call, or unknown symbols throw.
5. **Cap row counts.** `/scan` at `range: [0, 1000]` is a multi-MB response.
   Default small (≤100), require an explicit opt-in above that, consistent with
   the OHLCV cap in `CLAUDE.md`.
6. **Reuse `symbolSearch`** — do not add a second symbol-search implementation.
   Note the documents slug (§5) needs `EXCHANGE-TICKER`, which `symbol_search`
   resolves.
7. **Return the stable envelope** (`{success: true, ...}` /
   `buildErrorEnvelope`) like every other tool, with a distinct error code for
   upstream HTTP failures so callers can tell "TV said no" from "we broke".
8. **Offline tests.** These are pure-HTTP functions — they must be testable
   without a browser or the desktop app. Follow the `_deps` injection seam used
   throughout `src/core/*` so tests can stub `fetch`. No test may hit the
   network.
9. **HTML parsing is required for §4.3 and §5.** This is the one departure from
   "pure JSON API". Keep it to a single regex + `JSON.parse` on the
   `prs.init-data+json` blocks (§7.1) — **do not add an HTML parser or a
   headless browser** for this. If the SSR payload shape ever changes, those two
   tools fail loudly rather than silently degrading.
10. **Sort news-mediator filters** (alphabetically by filter id) and always
    send the `EXCHANGE:` prefix on `symbol:` — both are hard server-side
    validations (§4.2).

### Profile placement

These are chart-independent, so they belong in `base` (`src/tools/_profiles.js`)
alongside `quote_get`. **[DONE 2026-09-16]** All 12 are in the `base` allowlist.
The predicted budget problem was real and was handled:

- `base` went 27 → 42 tools and 8,382 → 12,548 bytes (schema-less estimate).
- The first pass measured **13,679 bytes (13.36 KB)**, over the old 12 KB
  ceiling. Rather than only raising the ceiling, the 12 REST descriptions were
  TRIMMED (long-form caveats moved into each result's `note` field, where the
  agent reads them next to the data anyway).
- `tests/profiles.test.js` now records the measured baseline and sets the
  ceiling at baseline + ~10% (13.8 KB), in the same change that changed the
  surface — the ceiling still refuses silent growth.

### Rate limits and terms

The official MCP documents ~100 req/min per user. These endpoints are
**undocumented and unversioned**, publish no quota, and may throttle or block
without notice. They are fine for personal/research use; confirm TradingView's
terms before any public or commercial deployment. This is the same class of
dependency `RESEARCH.md` Limitations already declares ("undocumented internal
APIs subject to change without notice").

**Enforced in the implementation**, so a caller cannot trip them by accident:
one request per symbol with a concurrency cap of 5 for batch (≤ 50 symbols),
screener rows capped at 1000 with a 100 default and the cap checked BEFORE the
request, the economic-calendar window capped at 90 days (the payload is
~78–236 KB per week), and every request carrying `AbortSignal.timeout`.

## 12. Reproduce the evidence

All probes were throwaway scripts; the commands are reproducible with:

```bash
# Screener symbol data (no headers beyond UA)
curl -s 'https://scanner.tradingview.com/symbol?symbol=NASDAQ%3AAAPL&fields=close,RSI%7C60&no_404=true' \
  -H 'User-Agent: Mozilla/5.0'

# Financial history (array-valued fields)
curl -s 'https://scanner.tradingview.com/symbol?symbol=NASDAQ%3AAAPL&fields=free_cash_flow_fy_h&no_404=true' \
  -H 'User-Agent: Mozilla/5.0'

# Earnings history (EPS per period) + fiscal-year labels
curl -s 'https://scanner.tradingview.com/symbol?symbol=NASDAQ%3AAAPL&fields=earnings_per_share_diluted_fy_h,earnings_per_share_diluted_fq_h,fiscal_period_fy_h&no_404=true' \
  -H 'User-Agent: Mozilla/5.0'

# Dividend history (20 years, per share) - note the non-obvious field name
curl -s 'https://scanner.tradingview.com/symbol?symbol=NASDAQ%3AAAPL&fields=dps_common_stock_prim_issue_fy_h&no_404=true' \
  -H 'User-Agent: Mozilla/5.0'

# History columns in bulk (filter on a SCALAR, carry the array in columns)
curl -s 'https://scanner.tradingview.com/america/scan' \
  -H 'User-Agent: Mozilla/5.0' -H 'Content-Type: text/plain;charset=UTF-8' \
  -d '{"filter":[{"left":"dividends_yield","operation":"greater","right":3}],"columns":["name","dividends_yield","dps_common_stock_prim_issue_fy_h","earnings_per_share_diluted_fy_h"],"sort":{"sortBy":"dividends_yield","sortOrder":"desc"},"range":[0,4]}'

# Bulk earnings calendar (scan, in_range over all time)
curl -s 'https://scanner.tradingview.com/america/scan' \
  -H 'User-Agent: Mozilla/5.0' -H 'Content-Type: text/plain;charset=UTF-8' \
  -d '{"filter":[{"left":"earnings_release_next_date","operation":"in_range","right":[0,9999999999]}],"columns":["name","earnings_release_next_date"],"range":[0,3]}'

# Enum catalogue
curl -s 'https://scanner-backend.tradingview.com/enum/ordered?id=metrics_full_name' \
  -H 'User-Agent: Mozilla/5.0'

# Economic calendar (no Origin/Referer needed)
curl -s 'https://chartevents-reuters.tradingview.com/events?from=2026-09-16&to=2026-09-19&countries=US'

# News headlines
curl -s 'https://news-headlines.tradingview.com/v2/headlines?symbol=NASDAQ%3AAAPL&lang=en&client=web' \
  -H 'User-Agent: Mozilla/5.0'

# News flow (Origin required; filters sorted; EXCHANGE: prefix required)
curl -s 'https://news-mediator.tradingview.com/public/view/v1/symbol?filter=lang%3Aen&filter=symbol%3ANASDAQ%3AAAPL&client=web&user_prostatus=non_pro' \
  -H 'User-Agent: Mozilla/5.0' -H 'Origin: https://www.tradingview.com'

# Story text (SSR init-data - walk ALL blocks, story is not block 0)
curl -s 'https://www.tradingview.com/news/DJN_DN20260915008240:0/' \
  -H 'User-Agent: Mozilla/5.0' | grep -o 'ast_description' | head -1

# Documents / filings list (SSR init-data, symbol-page-tab-filings block)
curl -s 'https://www.tradingview.com/symbols/NASDAQ-AAPL/documents/' \
  -H 'User-Agent: Mozilla/5.0' | grep -o 'symbol-page-tab-filings' | head -1

# Symbol search (Origin required)
curl -s 'https://symbol-search.tradingview.com/symbol_search/v3/?text=AAPL&hl=1&lang=en' \
  -H 'User-Agent: Mozilla/5.0' -H 'Origin: https://www.tradingview.com'

# Widget config harvest (how chartevents-reuters was found)
curl -s 'https://www.tradingview-widget.com/embed-widget/advanced-chart/' \
  -H 'User-Agent: Mozilla/5.0' | grep -o "window\.[A-Z_]*_URL[^;]*"

# Screener column catalogue (from a bundle, not an endpoint)
curl -s 'https://www.tradingview-widget.com/static/bundles/embed/74255.bff3409fb827c7aefdf8.js' \
  -H 'User-Agent: Mozilla/5.0' | grep -o '\["[a-z0-9_\-]*",.*\]'
```

Verified 2026-09-15 from Node 24.11.1 and the repo `.venv` Python via
`urllib.request` — identical results from both.

Discovery scripts were throwaway and lived in
`C:\Users\vinay\AppData\Local\Temp\opencode\`. **That directory is temp and will
be cleaned.** The results that matter are persisted (§11):

```bash
npm run harvest:rest            # regenerate all fixtures (needs network)
npm run harvest:rest -- --offline   # re-derive history-fields.json only
```
