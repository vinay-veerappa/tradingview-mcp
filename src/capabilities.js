export const ARBITRARY_PAGE_JS_ENV = 'TRADINGVIEW_MCP_ALLOW_ARBITRARY_PAGE_JS';
export const ARBITRARY_PAGE_JS_ACK = 'I_UNDERSTAND_THIS_EXECUTES_ARBITRARY_JAVASCRIPT';
export const REPLAY_TRADING_ENV = 'TRADINGVIEW_MCP_ALLOW_REPLAY_TRADES';
export const REPLAY_TRADING_ACK = 'I_UNDERSTAND_THIS_CHANGES_SIMULATED_REPLAY_POSITIONS';
export const SELF_UPDATE_ENV = 'TRADINGVIEW_MCP_ALLOW_SELF_UPDATE';
export const SELF_UPDATE_ACK = 'I_UNDERSTAND_THIS_PULLS_AND_RUNS_REMOTE_CODE';

export function requireArbitraryPageJs(env = process.env) {
  if (env[ARBITRARY_PAGE_JS_ENV] !== ARBITRARY_PAGE_JS_ACK) {
    throw new Error(
      `Arbitrary page JavaScript is disabled. To deliberately enable ui_evaluate, set ${ARBITRARY_PAGE_JS_ENV}=${ARBITRARY_PAGE_JS_ACK} when starting the MCP server or CLI.`,
    );
  }
}

export function requireReplayTrading(env = process.env) {
  if (env[REPLAY_TRADING_ENV] !== REPLAY_TRADING_ACK) {
    throw new Error(
      `Simulated Replay trades are disabled. To deliberately enable replay_trade, set ${REPLAY_TRADING_ENV}=${REPLAY_TRADING_ACK} when starting the MCP server or CLI.`,
    );
  }
}

export function requireSelfUpdate(env = process.env) {
  if (env[SELF_UPDATE_ENV] !== SELF_UPDATE_ACK) {
    throw new Error(
      `Self-update is disabled. tv_update pulls origin/main and runs npm ci, executing remote code. To deliberately enable it, set ${SELF_UPDATE_ENV}=${SELF_UPDATE_ACK} when starting the MCP server or CLI.`,
    );
  }
}

/**
 * Capability inventory for system_status (P2-14). Never exposes ack values —
 * only ids, human labels, what each unlock requires, and current state.
 */
export function listCapabilities(env = process.env) {
  return [
    {
      id: 'arbitrary_page_js',
      label: 'Arbitrary page JavaScript (ui_evaluate)',
      env_var: ARBITRARY_PAGE_JS_ENV,
      enabled: env[ARBITRARY_PAGE_JS_ENV] === ARBITRARY_PAGE_JS_ACK,
      required_for: ['ui_evaluate'],
    },
    {
      id: 'replay_trades',
      label: 'Simulated Replay trades (replay_trade)',
      env_var: REPLAY_TRADING_ENV,
      enabled: env[REPLAY_TRADING_ENV] === REPLAY_TRADING_ACK,
      required_for: ['replay_trade'],
    },
    {
      id: 'self_update',
      label: 'Self-update (tv_update: git pull + npm ci)',
      env_var: SELF_UPDATE_ENV,
      enabled: env[SELF_UPDATE_ENV] === SELF_UPDATE_ACK,
      required_for: ['tv_update'],
    },
  ];
}
