/**
 * Broker session control (login / logout) through the trading panel UI.
 *
 * Design constraints (L-133):
 * - UI-gated only: the same clicks a person makes. No broker API calls, no
 *   token handling, no order path.
 * - Credentials are typed from the same Windows Credential Manager entries the
 *   NT8 launcher uses, held in memory only; only lengths are ever reported.
 * - Fail-closed: if the form does not hold the typed values, nothing is
 *   submitted; a typed error from the broker is reported as auth_failed and is
 *   never auto-retried.
 * - The response tap (core/broker.js) is attached BEFORE connecting so the
 *   connect-time /accounts call — the id→name mapping — is captured.
 */
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { attachTaps, getAccount } from './broker.js';

const sleepDefault = (ms) => new Promise((r) => setTimeout(r, ms));

export const SESSION = Object.freeze({
  LOGIN_TIMEOUT_MS: 30000,
  LOGOUT_TIMEOUT_MS: 15000,
});

// ── UI helper expressions (build-tolerant: aria/title/text, no class hashes) ──

const EXP = {
  tradePill: `(() => {
    const leaf = [...document.querySelectorAll('span, div, button')].filter(e =>
      (e.children.length === 0 ? (e.textContent || '').trim() : '') === 'Trade' && e.getBoundingClientRect().y < 60)[0];
    return leaf ? (leaf.closest('button') || leaf.parentElement || leaf) : null;
  })()`,
  catalogOpen: `(document.body.innerText || '').includes('Trade with your broker')`,
  card: `[...document.querySelectorAll('[aria-label="Broker card - NinjaTrader"]')].filter(e => e.getBoundingClientRect().width > 0)[0]`,
  passwordInput: `[...document.querySelectorAll('input')].filter(i => i.type === 'password' && i.getBoundingClientRect().width > 0)[0] || null`,
  warning: `document.querySelector('[data-name="warning-dialog"]')`,
  warningOk: `[...document.querySelectorAll('[data-name="warning-dialog"] button')].filter(b => (b.textContent || '').trim() === 'I understand')[0] || null`,
  connectBtn: `[...document.querySelectorAll('button')].filter(b => (b.textContent || '').trim() === 'Connect' && b.getBoundingClientRect().width > 50)[0] || null`,
  panelOpenBtn: `document.querySelector('button[aria-label="Open account manager"]')`,
  panelCloseBtn: `document.querySelector('button[aria-label="Close account manager"]')`,
  collapsedBar: `(() => {
    const spans = [...document.querySelectorAll('span')].filter(s => (s.textContent || '').trim() === 'NinjaTrader' && s.getBoundingClientRect().y > 1900);
    if (!spans.length) return null;
    return spans[0].closest('button') || spans[0].parentElement;
  })()`,
  menuBtn: `document.querySelector('button[title="Manage settings and connection"]')
    || [...document.querySelectorAll('button')].filter(e => (e.className || '').includes('menuButton') && e.getBoundingClientRect().width > 0)[0] || null`,
  logoutItem: `(() => {
    const all = [...document.querySelectorAll('*')].filter(e => (e.textContent || '').trim() === 'Log out');
    return all.filter(el => !all.some(o => o !== el && el.contains(o)))[0] || all[0] || null;
  })()`,
  formError: `(() => {
    const root = document.getElementById('overlap-manager-root') || document.body;
    const m = (root.innerText || '').match(/[^\\n]*(incorrect|wrong|invalid|failed|unable|not correct)[^\\n]*/i);
    return m ? m[0].slice(0, 200) : null;
  })()`,
  tabState: `(() => {
    const pick = (label) => [...document.querySelectorAll('button, [role=button]')].filter(b => (b.textContent || '').trim() === label)[0];
    const state = (b) => {
      if (!b) return null;
      const aria = b.getAttribute('aria-pressed') || b.getAttribute('aria-checked') || b.getAttribute('aria-selected');
      const cls = (b.className || '');
      return { aria: aria === 'true' ? true : (aria === 'false' ? false : null), clsActive: /active|selected|checked/i.test(cls) };
    };
    return JSON.stringify({ live: state(pick('Live')), demo: state(pick('Demo')) });
  })()`,
};

// ── deps ───────────────────────────────────────────────────────────────────

function resolveDeps(deps) {
  return {
    attachTaps: deps?.attachTaps || attachTaps,
    account: deps?.account || getAccount,
    sleep: deps?.sleep || sleepDefault,
    credential: deps?.credential || null,
    client: deps?.client || null,
    listPages: deps?.listPages,
    attach: deps?.attach,
    evaluate: deps?.evaluate,
  };
}

async function evalIn(client, expression) {
  const r = await client.Runtime.evaluate({ expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    throw new Error((r.exceptionDetails.exception?.description || 'evaluate failed').slice(0, 200));
  }
  return r.result ? r.result.value : undefined;
}

async function rectCenter(client, expression) {
  const raw = await evalIn(client, `(() => { const e = (${expression}); if (!e) return 'null';
    const r = e.getBoundingClientRect(); if (r.width === 0) return 'null';
    return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 }); })()`);
  if (!raw || raw === 'null') return null;
  return JSON.parse(raw);
}

async function clickAt(client, x, y) {
  await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x, y, button: 'none' });
  await client.Input.dispatchMouseEvent({ type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await client.Input.dispatchMouseEvent({ type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
}

async function pressEscape(client) {
  await client.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
  await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
}

/** Pick the chart page whose DOM shows the given marker (else the first client). */
async function pickClient(clients, expr) {
  for (const client of clients) {
    const has = await evalIn(client, `!!(${expr})`).catch(() => false);
    if (has) return client;
  }
  return clients[0];
}

async function waitFor(fn, { timeoutMs = 8000, intervalMs = 300, label = 'condition' } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function sleep(ms) { return sleepDefault(ms); }

// ── credentials (Windows Credential Manager, in-memory only) ───────────────

const PS_READ_TARGET = (target) => `
$sig = @'
using System;
using System.Runtime.InteropServices;
public class TvCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL { public int Flags; public int Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten; public int CredentialBlobSize;
    public IntPtr CredentialBlob; public int Persist; public int AttributeCount; public IntPtr Attributes;
    public string TargetAlias; public string UserName; }
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, EntryPoint = "CredReadW", SetLastError = true)]
  public static extern bool CredRead(string target, int type, int flags, out IntPtr credPtr);
  public static string[] Read(string target) {
    IntPtr p;
    if (!CredRead(target, 1, 0, out p)) return null;
    CREDENTIAL c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
    byte[] blob = new byte[c.CredentialBlobSize];
    Marshal.Copy(c.CredentialBlob, blob, 0, c.CredentialBlobSize);
    return new string[] { c.UserName, System.Text.Encoding.Unicode.GetString(blob) };
  }
}
'@;
Add-Type -TypeDefinition $sig;
$r = [TvCred]::Read(${JSON.stringify(target)});
if ($r -eq $null) { Write-Output 'NULL'; exit }
Write-Output $r[0];
Write-Output $r[1];
`;

export const DEFAULT_NT8_TARGET = 'whis.gg/NinjaTrader.Launcher/AutoLogin';

/**
 * Read a credential pair. `source`:
 *  - 'nt8' (default): the launcher entry the NT8 auto-login uses — account from
 *    the credential username, password from its blob.
 *  - 'tv': TradingView's own saved broker entry for the given account
 *    (`TradingView Desktop/<account>`); returns password only.
 */
export function readCredential({ source = 'nt8', account, target } = {}) {
  const t = target || (source === 'tv' ? `TradingView Desktop/${account}` : DEFAULT_NT8_TARGET);
  if (source === 'tv' && !account && !target) {
    return Promise.reject(new Error('source "tv" requires an account name (TradingView stores broker credentials per account)'));
  }
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS_READ_TARGET(t)],
      { maxBuffer: 1 << 20, timeout: 20000 },
      (err, stdout, stderr) => {
        if (err) return reject(new Error('credential read failed: ' + String(stderr || err.message).slice(0, 160)));
        const lines = String(stdout).split(/\r?\n/).filter((l) => l !== '');
        if (!lines.length || lines[0] === 'NULL') return reject(new Error(`credential entry '${t}' not found`));
        resolve({ account: source === 'tv' ? account : (lines[0] || ''), password: lines[1] || '', target: t });
      });
  });
}

// ── login ──────────────────────────────────────────────────────────────────

/**
 * Log in through the trading panel. Returns:
 * { ok, steps[], account, connected, pairing, error_kind? }
 * error_kind: 'auth_failed' (broker rejected), 'form_not_held' (nothing submitted),
 *             'ui_unreachable' (panel/catalog/card/form not found).
 */
export async function login({ account, password, source = 'nt8', waitMs = SESSION.LOGIN_TIMEOUT_MS, _deps } = {}) {
  const deps = resolveDeps(_deps);
  const steps = [];

  let cred = { account, password };
  if (!cred.password) {
    cred = await (deps.credential ? deps.credential({ source, account }) : readCredential({ source, account }));
    steps.push('credentials loaded (source=' + source + ', account=' + cred.account + ', passwordLen=' + String(cred.password || '').length + ')');
  }
  if (!cred.account || !cred.password) {
    return { ok: false, steps, error_kind: 'ui_unreachable', message: 'no usable credentials resolved' };
  }

  const clients = deps.client ? [deps.client] : await deps.attachTaps({ _deps: deps });
  if (!clients.length) return { ok: false, steps, error_kind: 'ui_unreachable', message: 'no TradingView chart page found over CDP' };
  const client = await pickClient(clients, `(${EXP.catalogOpen}) || !!(${EXP.tradePill}) || !!(${EXP.panelCloseBtn})`);
  steps.push('tap attached before connect (captures the /accounts mapping)');

  // Dismiss any overlay that would swallow clicks.
  if (await evalIn(client, `!!(${EXP.warning})`)) {
    await pressEscape(client);
    await sleep(400);
    steps.push('warning dialog dismissed');
  }

  // Open the catalog if not already open.
  if (!(await evalIn(client, EXP.catalogOpen))) {
    const pill = await waitFor(async () => rectCenter(client, EXP.tradePill), { timeoutMs: 5000, label: 'Trade pill' });
    await clickAt(client, pill.x, pill.y);
    await waitFor(async () => evalIn(client, EXP.catalogOpen), { timeoutMs: 8000, label: 'broker catalog' });
    steps.push('broker catalog opened');
  }

  // Open the NinjaTrader form.
  if (!(await evalIn(client, `!!(${EXP.passwordInput})`))) {
    const card = await waitFor(async () => rectCenter(client, EXP.card), { timeoutMs: 10000, label: 'NinjaTrader card' });
    await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: card.x, y: card.y, button: 'none' });
    await sleep(250);
    await clickAt(client, card.x, card.y);
    await waitFor(async () => evalIn(client, `!!(${EXP.passwordInput})`), { timeoutMs: 8000, label: 'connect form' });
    steps.push('connect form opened');
  }

  // Demo/Live guard: never connect a live account implicitly.
  const tabState = JSON.parse(await evalIn(client, EXP.tabState));
  if (tabState.live && (tabState.live.aria === true || tabState.live.clsActive)) {
    return { ok: false, steps, error_kind: 'ui_unreachable', message: 'Live tab appears selected; refusing to connect (demo only)' };
  }
  steps.push('tab guard passed (live not selected)');

  // Type the pair (React-native setter, no field clicks that trigger autofill).
  const typed = await evalIn(client, `(() => {
    const list = [...document.querySelectorAll('input')].filter(i => i.getBoundingClientRect().width > 0);
    const idx = list.findIndex(i => i.type === 'password');
    const user = idx > 0 ? list.slice(0, idx).reverse().find(i => i.type !== 'password') : null;
    const pass = idx >= 0 ? list[idx] : null;
    if (!user || !pass) return 'no_fields';
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    set.call(user, ${JSON.stringify(cred.account)});
    user.dispatchEvent(new Event('input', { bubbles: true })); user.dispatchEvent(new Event('change', { bubbles: true }));
    set.call(pass, ${JSON.stringify(cred.password)});
    pass.dispatchEvent(new Event('input', { bubbles: true })); pass.dispatchEvent(new Event('change', { bubbles: true }));
    return JSON.stringify({ user: user.value, passLen: pass.value.length });
  })()`);
  if (typed === 'no_fields') {
    return { ok: false, steps, error_kind: 'ui_unreachable', message: 'username/password fields not found' };
  }
  let check = JSON.parse(typed);
  steps.push('fields set (user=' + check.user + ', passLen=' + check.passLen + ')');
  if (check.user !== cred.account || check.passLen !== cred.password.length) {
    // One bounded re-apply: the app restores its remembered pair asynchronously.
    await sleep(400);
    check = JSON.parse(await evalIn(client, `(() => {
      const list = [...document.querySelectorAll('input')].filter(i => i.getBoundingClientRect().width > 0);
      const idx = list.findIndex(i => i.type === 'password');
      const user = idx > 0 ? list.slice(0, idx).reverse().find(i => i.type !== 'password') : null;
      return JSON.stringify({ user: user ? user.value : '', passLen: idx >= 0 ? list[idx].value.length : -1 });
    })()`));
  }
  if (check.user !== cred.account || check.passLen !== cred.password.length) {
    return { ok: false, steps, error_kind: 'form_not_held', message: 'form did not hold the typed pair; nothing was submitted' };
  }
  cred = { account: cred.account, password: null };

  // Submit.
  const conn = await waitFor(async () => rectCenter(client, EXP.connectBtn), { timeoutMs: 5000, label: 'Connect button' });
  await clickAt(client, conn.x, conn.y);
  steps.push('Connect clicked');

  // Observe outcome: broker error text, or the session coming up.
  const started = Date.now();
  while (Date.now() - started < waitMs) {
    const errText = await evalIn(client, EXP.formError).catch(() => null);
    if (errText) {
      return { ok: false, steps, error_kind: 'auth_failed', message: String(errText).slice(0, 200) };
    }
    const accountState = await deps.account({ waitMs: 600 }).catch(() => null);
    if (accountState && accountState.connected) {
      steps.push('gateway polling resumed');
      return {
        ok: true,
        steps,
        account: accountState.label || null,
        broker_account_id: accountState.broker_account_id || null,
        pairing_source: accountState.pairing_source || null,
        connected: true,
      };
    }
    await sleep(700);
  }
  return { ok: false, steps, error_kind: 'ui_unreachable', message: 'no error shown and no traffic resumed within the timeout' };
}

// ── logout ─────────────────────────────────────────────────────────────────

export async function logout({ waitMs = SESSION.LOGOUT_TIMEOUT_MS, _deps } = {}) {
  const deps = resolveDeps(_deps);
  const steps = [];

  const clients = deps.client ? [deps.client] : await deps.attachTaps({ _deps: deps });
  if (!clients.length) return { ok: false, steps, error_kind: 'ui_unreachable', message: 'no TradingView chart page found over CDP' };
  const client = await pickClient(clients, `!!(${EXP.panelCloseBtn}) || !!(${EXP.panelOpenBtn}) || !!(${EXP.collapsedBar})`);

  // Ensure the panel is open (collapsed bar or toggle).
  if (!(await evalIn(client, `!!(${EXP.panelCloseBtn})`))) {
    const opener = await rectCenter(client, `(${EXP.panelOpenBtn}) || (${EXP.collapsedBar})`).catch(() => null);
    if (opener) {
      await clickAt(client, opener.x, opener.y);
      await sleep(1200);
      steps.push('panel opened');
    }
  }

  const menu = await waitFor(async () => rectCenter(client, EXP.menuBtn), { timeoutMs: 6000, label: 'panel menu button' });
  await clickAt(client, menu.x, menu.y);
  const item = await waitFor(async () => rectCenter(client, EXP.logoutItem), { timeoutMs: 5000, label: 'Log out item' });
  await clickAt(client, item.x, item.y);
  steps.push('Log out clicked');

  const started = Date.now();
  while (Date.now() - started < waitMs) {
    const accountState = await deps.account({ waitMs: 300 }).catch(() => null);
    if (accountState && !accountState.connected) {
      steps.push('gateway polling stopped');
      return { ok: true, steps, connected: false };
    }
    await sleep(700);
  }
  return { ok: false, steps, error_kind: 'ui_unreachable', message: 'still connected after the timeout' };
}
