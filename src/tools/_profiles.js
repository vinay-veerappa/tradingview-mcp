/**
 * Canonical operation registry (P2-19) — the single source connecting
 * operations to profiles. The step-5 scope is deliberately narrow:
 *
 * 1. PROFILE MEMBERSHIP: one table declaring which tools each runtime profile
 *    advertises. Profiles are the agent-facing context control (the 40KB
 *    problem); they remain SDK enable/disable-based until full registry
 *    generation lands, so everything here is additive and reversible.
 * 2. system_status + cdp_diagnostics + profile_get/profile_set — always-
 *    visible introspection, the contract from P2-14.
 * 3. Payload-budget test data (P2-20): budgets measured from the real SDK
 *    tools/list payload, ceilings = baseline + 10%.
 *
 * NOT in step 5: moving handlers/schemas into registry entries (each tool
 * file keeps its own registration); HTTP/gateway; resource registration.
 * Those are steps 6+ and stay gated on this module's contracts.
 */

import { z } from 'zod';
import { jsonResult, errorResult } from './_format.js';
import { A } from './_annotations.js';
import { listCapabilities } from '../capabilities.js';

/**
 * Profile definitions. Order = inheritance-free (explicit lists, verified at
 * startup by ensureProfilesSane below). 'base' is the DEFAULT profile.
 */
export const PROFILES = Object.freeze({
  // Trader's daily surface: read everything, minimal mutations.
  base: Object.freeze([
    'tv_health_check', 'tv_launch', 'tv_compatibility_report', 'cdp_diagnostics',
    'session_snapshot', 'chart_changes', 'chart_get_state',
    'quote_get', 'data_get_ohlcv', 'data_get_study_values',
    'data_get_pine_lines', 'data_get_pine_labels', 'data_get_pine_tables', 'data_get_pine_boxes',
    'capture_screenshot', 'depth_get', 'tv_discover',
    // light mutations used in an ordinary session
    'chart_set_symbol', 'chart_set_timeframe', 'chart_set_type',
    'chart_manage_indicator', 'chart_scroll_to_date', 'alert_create', 'alert_list',
    'draw_shape', 'draw_list', 'draw_remove_one',
  ]),
  // Pine development: editor + compiler + analysis. Adds to base.
  pine: [
    'pine_set_source', 'pine_smart_compile', 'pine_compile', 'pine_check',
    'pine_get_errors', 'pine_get_console', 'pine_get_source', 'pine_save',
    'pine_new', 'pine_open', 'pine_list_scripts', 'pine_analyze',
  ],
  // Chart control surface: full UI automation. Replaces base's light set when
  // active? NO — additive: profiles COMPOSE (base ∪ requested).
  control: [
    'chart_set_type', 'chart_set_visible_range', 'chart_scroll_to_date',
    'chart_manage_indicator', 'indicator_set_inputs', 'indicator_toggle_visibility',
    'indicator_add', 'indicator_search',
    'ui_open_panel', 'ui_click', 'ui_keyboard', 'ui_find_element', 'ui_fullscreen',
    'layout_switch', 'layout_list', 'layout_new',
    'pane_list', 'pane_focus', 'pane_set_symbol', 'pane_set_layout',
    'tab_list', 'tab_new', 'tab_switch', 'tab_close',
    'watchlist_get', 'watchlist_add', 'watchlist_remove',
    'batch_run', 'alert_delete', 'draw_clear',
  ],
  // Paper trading surface (fail-closed broker identity still enforced in core).
  paper: [
    'paper_get_status', 'paper_open_panel', 'paper_connect',
    'paper_get_account', 'paper_list_accounts', 'paper_switch_account',
    'paper_list_positions', 'paper_list_orders',
    'paper_place_order', 'paper_cancel_order', 'paper_modify_order',
    'paper_close_position', 'paper_set_brackets',
  ],
  // Everything, including dangerous surfaces. Explicit opt-in only.
});

// Tools in NO profile that remain visible only under devel (or always-on
// status tooling). These are the power/dangerous surfaces.
const DEV_ONLY = [
  'ui_evaluate', 'ui_keyboard', 'ui_hover', 'ui_mouse_click', 'ui_scroll',
  'ui_type_text', 'ui_find_element', 'ui_watchlist', 'ui_open_panel',
  'replay_start', 'replay_step', 'replay_autoplay', 'replay_stop', 'replay_status',
  'replay_trade', 'batch_run', 'watchlist_populate', 'tv_update',
  'indicator_set_inputs', 'indicator_toggle_visibility', 'indicator_search',
];

// Tools in NO profile remain visible only under devel. system_status and
// profile_set are registered separately and always visible — add them to every
// non-devel profile's allowlist here so applyProfile never hides them.
export function toolsForProfile(profile) {
  if (profile === 'devel') return null; // all visible
  const set = PROFILES[profile];
  if (!set) return null;
  return new Set([...set, ...ALWAYS_VISIBLE]);
}

const ALWAYS_VISIBLE = Object.freeze(['system_status', 'profile_set']);

export function knownProfiles() {
  return Object.keys(PROFILES); // devel handled dynamically, not a list entry
}

// ── runtime profile state (module singleton) ───────────────────────────────

const STATIC_PROFILES = Object.freeze(['base', 'pine', 'control', 'paper']);

let _activeProfile = process.env.TRADINGVIEW_MCP_PROFILE || 'base';

export function getActiveProfile() { return _activeProfile; }

export function setActiveProfile(name) {
  // 'devel' is valid but not a static list entry (it means "no filtering").
  if (name !== 'devel' && !knownProfiles().includes(name)) {
    throw new Error(`unknown profile '${name}'; known: ${knownProfiles().join(', ')}, devel`);
  }
  const prev = _activeProfile;
  _activeProfile = name;
  return prev;
}

// ── applied to the SDK's registration table ────────────────────────────────

/**
 * Apply the active profile to an McpServer: disable tools outside the
 * profile. The SDK filters disabled tools from tools/list and rejects calls
 * pre-handler (verified against 1.27.1). 'devel' / unknown = no filtering
 * (fail-open for visibility, but capability gates stay fail-closed).
 */
export function applyProfile(server, profile = _activeProfile) {
  const allowed = toolsForProfile(profile);
  if (!allowed) return { profile, disabled: 0, enabled: Object.keys(server._registeredTools).length };
  let disabled = 0;
  for (const [name, t] of Object.entries(server._registeredTools)) {
    if (allowed.has(name)) { t.enable?.(); continue; }
    t.disable?.();
    disabled++;
  }
  return { profile, disabled, enabled: allowed.size };
}

/**
 * Runtime profile switch: enables/disables registrations and notifies
 * list-changed so live clients re-fetch. Returns summary.
 */
export function switchProfile(server, profile) {
  setActiveProfile(profile);
  const result = applyProfile(server, profile);
  try { server.sendToolListChanged?.(); } catch { /* not connected */ }
  return result;
}

// ── introspection tool (P2-14) — always visible ────────────────────────────

export function registerSystemTools(server, { env = process.env } = {}) {
  server.tool('system_status', 'One-stop introspection: active profile, per-profile tool visibility, capability gates (which are disabled and what they would unlock), and CDP connection state. Always visible regardless of profile.',
    A.READ,
    async () => {
      try {
        const registered = Object.keys(server._registeredTools);
        const allowed = toolsForProfile(_activeProfile);
        const visible = allowed ? registered.filter(n => allowed.has(n)) : registered;
        const hidden = allowed ? registered.filter(n => !allowed.has(n)) : [];
        const capabilities = listCapabilities(env);
        return jsonResult({
          success: true,
          profile: _activeProfile,
          profiles_available: knownProfiles(),
          tools_visible: visible.length,
          tools_hidden: hidden.length,
          ...(allowed && { hidden_tool_names: hidden }),
          capabilities,
          notes: [
            'profile_set requires confirm: true and switches the advertised toolset at runtime',
            'capability gates stay fail-closed regardless of profile',
          ],
        });
      } catch (err) { return errorResult(err); }
    });

  server.tool('profile_set', 'Switch the advertised toolset profile at runtime (base | pine | control | paper | devel). Sends tools/list_changed so clients re-fetch. confirm must be true.',
    {
      profile: z.enum(['base', 'pine', 'control', 'paper', 'devel']).describe('Target profile'),
      confirm: z.boolean().describe('Must be true — changes the agent-visible tool surface'),
    },
    A.READ,
    async ({ profile, confirm }) => {
      try {
        if (confirm !== true) {
          const e = new Error('profile_set requires confirm: true (changes the advertised toolset)');
          return errorResult(e);
        }
        const result = switchProfile(server, profile);
        return jsonResult({
          success: true,
          action: 'profile_set',
          ...result,
          note: 'toolset switched; a tools/list re-fetch returns the new surface',
        });
      } catch (err) { return errorResult(err); }
    });
}