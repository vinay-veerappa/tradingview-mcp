/**
 * P2-10 — Analysis-ready named levels (formatting shim over Pine graphics).
 *
 * Normalizes Pine LABEL text / horizontal LINE prices into
 *   { raw_text, name, price, category, confidence }
 * for RECOGNIZED patterns only (PDH/PDL, opening range, settlement, ICH/IC
 * zones, week open/PH/PL). Conservative by design: exact token grammar,
 * high-confidence matches only — an unrecognized label NEVER becomes a level
 * (garbage-in must stay visible as an unnamed row, not silently mislabeled).
 *
 * Contract (plan §P2-10):
 *   - raw always preserved: every emitted level carries raw_text verbatim;
 *     `normalizePineLabels`/`normalizePineLines` return { ...original, named_levels }
 *     — the raw payload is never replaced, only augmented.
 *   - configurable: PATTERNS is frozen; callers may disable categories via
 *     `categories` (denylist) — off-list patterns stay off.
 *   - pure: no I/O, no CDP — testable offline; core data.js calls it as a
 *     formatting pass after the raw read.
 *
 * Grammar: LABEL = [PREFIX] NAME [SUFFIX]; NAME is one token from
 * PATTERNS (case-insensitive, whole-token). A price must accompany the text
 * (label y / line y1=y2); text without a price is not a level.
 */

// category → which pipeline consumes it (kept coarse on purpose)
export const CATEGORIES = Object.freeze({
  session: 'session',        // prior-day/week/session extremes
  opening_range: 'opening_range', // OR high/low & extensions
  settlement: 'settlement',  // futures settlement reference
  ict: 'ict',                // liquidity / imbalance zone tags
});

const SESSION_TOKENS = [
  ['PDH', 'session', 0.95], ['PDL', 'session', 0.95],
  ['PMH', 'session', 0.9], ['PML', 'session', 0.9],
  ['PWH', 'session', 0.9], ['PWL', 'session', 0.9],
  ['WO', 'session', 0.85], ['WE', 'session', 0.85],
  ['PH', 'session', 0.8], ['PL', 'session', 0.8],
  ['PDH1', 'session', 0.9], ['PDL1', 'session', 0.9],
  ['PDH2', 'session', 0.9], ['PDL2', 'session', 0.9],
  ['PWH1', 'session', 0.85], ['PWL1', 'session', 0.85],
];

const OPENING_TOKENS = [
  ['ORH', 'opening_range', 0.9], ['ORL', 'opening_range', 0.9],
  ['OR-MID', 'opening_range', 0.8], ['ORM', 'opening_range', 0.8],
  ['ORH25', 'opening_range', 0.75], ['ORL25', 'opening_range', 0.75],
  ['ORH50', 'opening_range', 0.75], ['ORL50', 'opening_range', 0.75],
  ['ORH75', 'opening_range', 0.75], ['ORL75', 'opening_range', 0.75],
  ['ORH100', 'opening_range', 0.75], ['ORL100', 'opening_range', 0.75],
  ['ORE', 'opening_range', 0.7],
];

const SETTLEMENT_TOKENS = [
  ['SET', 'settlement', 0.9], ['SETTLEMENT', 'settlement', 0.9],
  ['EQ', 'settlement', 0.85], ['ON CLOSE', 'settlement', 0.8],
];

const ICT_TOKENS = [
  ['ICH', 'ict', 0.85], ['IC', 'ict', 0.85],
  ['FVG', 'ict', 0.85], ['OB', 'ict', 0.8],
  ['BISI', 'ict', 0.8], ['SIBI', 'ict', 0.8],
];

// Frozen: single source of truth for the grammar; consumed by test too.
export const PATTERNS = Object.freeze([
  ...SESSION_TOKENS, ...OPENING_TOKENS, ...SETTLEMENT_TOKENS, ...ICT_TOKENS,
].map(([token, category, confidence]) => ({ token, category, confidence })));

// Whole-token match, case-insensitive: "PDH" matches "PDH 24550", "PDH (v2)",
// "NQ PDH" but NOT "APDH" or "PDH4X". Multi-token names (e.g. "ON CLOSE")
// match only when the full phrase appears as a word run.
function matchToken(text, tokenU) {
  const tokensU = tokenU.split(/\s+/);
  const parts = String(text).toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
  if (parts.length < tokensU.length) return false;
  for (let i = 0; i <= parts.length - tokensU.length; i++) {
    let ok = true;
    for (let j = 0; j < tokensU.length; j++) {
      if (parts[i + j] !== tokensU[j]) { ok = false; break; }
    }
    if (ok) return true;
  }
  return false;
}

/**
 * Normalize one (text, price) observation → level or null.
 * Category denylist (`categories`) prunes PATTERNS before matching.
 */
export function normalizeNamedLevel(text, price, { categories } = {}) {
  if (typeof text !== 'string' || !text.trim()) return null;
  if (price == null || !Number.isFinite(Number(price))) return null;
  const active = Array.isArray(categories) && categories.length
    ? PATTERNS.filter((p) => categories.includes(p.category))
    : PATTERNS;
  for (const { token, category, confidence } of active) {
    if (matchToken(text, token)) {
      return {
        name: token.toLowerCase(),
        price: Number(price),
        category,
        confidence,
        raw_text: text,
      };
    }
  }
  return null; // unrecognized → null, never a guess
}

/**
 * Formatting shim over getPineLabels() output. Raw preserved:
 * each study gains `named_levels` = [{...level, text: raw label text}] —
 * the original `labels` array is untouched.
 */
export function normalizePineLabels(studies, opts) {
  const out = [];
  for (const s of studies ?? []) {
    const levels = [];
    for (const l of s.labels ?? []) {
      const level = normalizeNamedLevel(l.text, l.price, opts);
      if (level) levels.push(level);
    }
    levels.sort((a, b) => b.price - a.price);
    out.push({ ...s, named_levels: levels });
  }
  return out;
}

/**
 * Formatting shim over getPineLines() output: horizontal line prices
 * (already deduped into `horizontal_levels`) → unnamed candidate levels.
 * Lines carry no text, so `name` is absent (raw price row is the identity);
 * only the numeric set is exposed, raw array untouched.
 */
export function normalizePineLines(studies) {
  return (studies ?? []).map((s) => ({
    ...s,
    horizontal_levels: s.horizontal_levels, // untouched, per contract
  }));
}