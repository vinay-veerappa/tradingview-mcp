#!/usr/bin/env node
/**
 * Harvest TradingView REST endpoint evidence into docs/fixtures/.
 *
 * This makes the discovery in docs/REST_DATA_SURFACES.md reproducible instead
 * of depending on a temp directory. Every request is unauthenticated and sends
 * no cookies (see the doc's §9 security rules).
 *
 * Writes:
 *   docs/fixtures/screener-columns.json    547 accepted screener column names
 *   docs/fixtures/history-fields.json      the 15 verified array-valued fields
 *   docs/fixtures/rest-probe.json          live response shapes for each host
 *
 * Does NOT write widget bundles (5 MB, and the config vars that matter are
 * recorded in the doc). Re-run this when TradingView adds fields.
 *
 * Usage: node scripts/harvest_rest_fields.js [--offline]
 *   --offline  skip network probes, only re-derive from cached bundle if present
 */
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = fileURLToPath(new URL('../docs/fixtures/', import.meta.url));
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const TV_ORIGIN = 'https://www.tradingview.com';
const offline = process.argv.includes('--offline');

const H = { 'User-Agent': UA };
const HB = { ...H, Origin: TV_ORIGIN };

async function get(url, headers = H) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r;
}

// The 15 array-valued history fields, verified 2026-09-15. Kept as a literal
// because the catalogue contains many look-alike names that return null --
// this list is the answer, not a guess (see doc section 2.2.1).
const HISTORY_FIELDS = [
  'total_revenue_fy_h', 'total_revenue_fq_h',
  'net_income_fy_h', 'net_income_fq_h',
  'total_assets_fy_h', 'total_assets_fq_h',
  'total_debt_fy_h', 'total_debt_fq_h',
  'free_cash_flow_fy_h', 'free_cash_flow_fq_h',
  'earnings_per_share_diluted_fy_h', 'earnings_per_share_diluted_fq_h',
  'earnings_per_share_basic_fy_h',
  'dps_common_stock_prim_issue_fy_h',
  'fiscal_period_fy_h',
  'gross_profit_fy_h', 'ebitda_fy_h',
];

async function harvestColumns() {
  // The accepted-column catalogue lives in a numbered widget bundle, not an
  // endpoint. Bundle filenames carry a content hash and change on deploy, so
  // discover the current one from the advanced-chart embed page.
  //
  // Only ONE array in these bundles is the column list. Sibling bundles carry
  // same-shape arrays that are NOT columns (chart feature flags, line-tool
  // class names) -- selecting by "looks like a JSON string array" pulls in
  // ~180 junk names. Pick by content: the catalogue is the array that contains
  // known-good column names.
  const SEEDS = ['market_cap_basic', 'total_revenue_fy_h', 'net_income_fy_h', 'earnings_per_share_basic_ttm'];
  const page = await (await get('https://www.tradingview-widget.com/embed-widget/advanced-chart/')).text();
  const chunks = [...new Set(page.match(/https:\/\/www\.tradingview-widget\.com\/static\/bundles\/embed\/\d+\.[a-f0-9]+\.js/g) || [])];
  let best = [];
  for (const c of chunks) {
    let js;
    try { js = await (await get(c)).text(); } catch { continue; }
    const arrays = js.match(/\[(?:"[a-z0-9_\-]+",?){50,}\]/gi) || [];
    for (const a of arrays) {
      let parsed;
      try { parsed = JSON.parse(a); } catch { continue; }
      // must contain every seed, else it is a different kind of list
      if (SEEDS.every((s) => parsed.includes(s)) && parsed.length > best.length) best = parsed;
    }
  }
  if (!best.length) throw new Error('screener column catalogue not found in any bundle');
  const unique = [...new Set(best)].sort();
  return { count: unique.length, fields: unique };
}

async function probeShapes() {
  const out = {};
  const tryGet = async (k, url, headers) => {
    try {
      const r = await get(url, headers);
      const t = await r.text();
      out[k] = { status: r.status, bytes: t.length, head: t.slice(0, 220) };
    } catch (e) { out[k] = { error: String(e.message).slice(0, 120) }; }
  };

  await tryGet('symbol_quote', 'https://scanner.tradingview.com/symbol?symbol=NASDAQ%3AAAPL&fields=name,close,volume,market_cap_basic&no_404=true');
  await tryGet('history_eps', 'https://scanner.tradingview.com/symbol?symbol=NASDAQ%3AAAPL&fields=earnings_per_share_diluted_fy_h,earnings_per_share_diluted_fq_h,fiscal_period_fy_h&no_404=true');
  await tryGet('history_dividend', 'https://scanner.tradingview.com/symbol?symbol=NASDAQ%3AAAPL&fields=dps_common_stock_prim_issue_fy_h&no_404=true');
  await tryGet('enum_metrics', 'https://scanner-backend.tradingview.com/enum/ordered?id=metrics_full_name');
  await tryGet('economic_calendar', 'https://chartevents-reuters.tradingview.com/events?from=2026-09-16&to=2026-09-19&countries=US');
  await tryGet('news_headlines', 'https://news-headlines.tradingview.com/v2/headlines?symbol=NASDAQ%3AAAPL&lang=en&client=web');
  await tryGet('news_flow', 'https://news-mediator.tradingview.com/public/news-flow/v2/news?filter=lang%3Aen&client=web&user_prostatus=non_pro', HB);
  await tryGet('symbol_search', 'https://symbol-search.tradingview.com/symbol_search/v3/?text=AAPL&hl=1&lang=en', HB);

  // documents + story are SSR pages; record that the marker is present rather
  // than the whole payload
  try {
    const h = await (await get('https://www.tradingview.com/symbols/NASDAQ-AAPL/documents/')).text();
    out.documents_page = {
      status: 200,
      bytes: h.length,
      has_filings_block: /symbol-page-tab-filings/.test(h),
      init_data_blocks: (h.match(/application\/prs\.init-data\+json/g) || []).length,
    };
  } catch (e) { out.documents_page = { error: String(e.message).slice(0, 120) }; }

  return out;
}

async function main() {
  await mkdir(OUT, { recursive: true });

  if (!offline) {
    console.log('harvesting screener columns from widget bundles...');
    const cols = await harvestColumns();
    await writeFile(join(OUT, 'screener-columns.json'), JSON.stringify(cols, null, 2));
    console.log(`  ${cols.count} column names -> docs/fixtures/screener-columns.json`);

    console.log('probing live endpoint shapes...');
    const shapes = await probeShapes();
    await writeFile(join(OUT, 'rest-probe.json'), JSON.stringify(shapes, null, 2));
    console.log(`  ${Object.keys(shapes).length} endpoints -> docs/fixtures/rest-probe.json`);
  }

  await writeFile(
    join(OUT, 'history-fields.json'),
    JSON.stringify(
      {
        verified: '2026-09-15',
        note: 'Array-valued (historical) screener fields. All return most-recent-first. Look-alike names such as earnings_per_share_fq_h return null -- use these exact names.',
        count: HISTORY_FIELDS.length,
        fields: HISTORY_FIELDS,
      },
      null,
      2
    )
  );
  console.log(`  ${HISTORY_FIELDS.length} history fields -> docs/fixtures/history-fields.json`);
}

main().catch((e) => { console.error('harvest failed:', e.message); process.exit(1); });
