/**
 * Core Pine Script logic — shared between MCP tools and CLI.
 * All functions accept plain options objects and return plain JS objects.
 * They throw on error (callers catch and format).
 */
import { evaluate, evaluateAsync, getClient } from '../connection.js';

/**
 * Compile-button finder (injected into TV page).
 *
 * TradingView localises the Pine editor buttons, and the desktop build renders
 * the label twice inside the button ("Add to chartAdd to chart"), so matching
 * on visible textContent alone fails outside en-US. Check title and aria-label
 * too — those carry the un-doubled label — and de-duplicate the text before
 * comparing. Returns the canonical English action so callers stay locale-free.
 *
 * Deliberately never falls back to the plain Save button: saving is not compiling.
 * "Save and add to chart" is used only when no plain add/update button exists, and
 * is reported under its own name so callers can tell that a cloud save happened.
 */
const FIND_COMPILE_BUTTON = `
  (function findCompileButton() {
    var ADD = /(add to chart|dem chart hinzuf|zum chart hinzuf|ajouter au graphique|agregar al gr|aggiungi al grafico|adicionar ao gr|добавить на график|添加到图表|グラフに追加)/i;
    var UPDATE = /(update on chart|auf dem chart aktualisier|chart aktualisier|mettre . jour sur le graphique|actualizar en el gr|aggiorna sul grafico|atualizar no gr|обновить на графике|更新图表)/i;
    var SAVE_AND_ADD = /(save and add to chart|speichern und dem chart hinzuf)/i;

    function labelsOf(el) {
      var txt = (el.textContent || '').trim().replace(/\\s+/g, ' ');
      // Collapse the doubled label ("FooFoo" -> "Foo").
      var half = txt.length / 2;
      if (txt.length > 1 && txt.length % 2 === 0 && txt.slice(0, half) === txt.slice(half)) {
        txt = txt.slice(0, half);
      }
      return [txt, el.getAttribute('title') || '', el.getAttribute('aria-label') || ''];
    }

    var btns = document.querySelectorAll('button,[role="button"]');
    var addBtn = null, updateBtn = null, saveAddBtn = null;

    for (var i = 0; i < btns.length; i++) {
      var el = btns[i];
      if (el.offsetParent === null) continue;      // only the visible editor
      if (el.disabled) continue;
      var ls = labelsOf(el);
      for (var j = 0; j < ls.length; j++) {
        var l = ls[j];
        if (!l) continue;
        // Check save-and-add first: its label also contains "add to chart".
        if (!saveAddBtn && SAVE_AND_ADD.test(l)) { saveAddBtn = el; break; }
        if (!addBtn && ADD.test(l)) { addBtn = el; break; }
        if (!updateBtn && UPDATE.test(l)) { updateBtn = el; break; }
      }
    }
    // Prefer the buttons that compile without touching the user's saved scripts.
    if (addBtn) return { el: addBtn, action: 'Add to chart' };
    if (updateBtn) return { el: updateBtn, action: 'Update on chart' };
    if (saveAddBtn) return { el: saveAddBtn, action: 'Save and add to chart' };
    return null;
  })
`;

// Root of the Pine Editor panel. Used to scope DOM lookups so we never touch the
// chart's own controls (notably the chart-layout Save button, which shares the
// "saveButton" class prefix with Pine's). Other classes in this subtree are
// build-hashed (e.g. editorWrapper-mImut1T6) and unsafe to match on.
const PINE_ROOT = '.tv-script-widget';

// ── Monaco finder (injected into TV page) ──
const FIND_MONACO = `
  (function findMonacoEditor() {
    var container = document.querySelector('.monaco-editor.pine-editor-monaco');
    if (!container) return null;
    var el = container;
    var fiberKey;
    for (var i = 0; i < 20; i++) {
      if (!el) break;
      fiberKey = Object.keys(el).find(function(k) { return k.startsWith('__reactFiber$'); });
      if (fiberKey) break;
      el = el.parentElement;
    }
    if (!fiberKey) return null;
    var current = el[fiberKey];
    for (var d = 0; d < 15; d++) {
      if (!current) break;
      if (current.memoizedProps && current.memoizedProps.value && current.memoizedProps.value.monacoEnv) {
        var env = current.memoizedProps.value.monacoEnv;
        if (env.editor && typeof env.editor.getEditors === 'function') {
          var editors = env.editor.getEditors();
          if (editors.length > 0) return { editor: editors[0], env: env };
        }
      }
      current = current.return;
    }
    return null;
  })()
`;

/**
 * Opens the Pine Editor panel and waits for Monaco to become available.
 * Returns true if editor is accessible, false on timeout.
 */
export async function ensurePineEditorOpen() {
  const already = await evaluate(`
    (function() {
      var m = ${FIND_MONACO};
      return m !== null;
    })()
  `);
  if (already) return true;

  // 'scripteditor' is the widget's registered name; activateScriptEditorTab()
  // silently no-ops while the widget is missing from the bar's enabled list
  // (the state after the user closes the panel), so enable + show come first.
  const OPEN_EDITOR = `
    (function() {
      var bwb = window.TradingView && window.TradingView.bottomWidgetBar;
      if (!bwb) return false;
      if (typeof bwb.setWidgetAvailability === 'function') bwb.setWidgetAvailability('scripteditor', true);
      if (typeof bwb.showWidget === 'function') bwb.showWidget('scripteditor');
      if (typeof bwb.activateScriptEditorTab === 'function') bwb.activateScriptEditorTab();
      return true;
    })()
  `;
  await evaluate(OPEN_EDITOR);

  await evaluate(`
    (function() {
      var btn = document.querySelector('[aria-label="Pine"]')
        || document.querySelector('[data-name="pine-dialog-button"]');
      if (btn) btn.click();
    })()
  `);

  let remounted = false;
  for (let i = 0; i < 50; i++) {
    await new Promise(r => setTimeout(r, 200));
    const ready = await evaluate(`(function() { return ${FIND_MONACO} !== null; })()`);
    if (ready) return true;
    // Stale mount: Monaco DOM is present but its subtree carries no React
    // fiber keys, so FIND_MONACO can never succeed against it. Hide the bar
    // and reopen once to force a fresh React-attached mount.
    if (!remounted && i >= 15) {
      const zombie = await evaluate(`!!document.querySelector('.monaco-editor.pine-editor-monaco')`);
      if (zombie) {
        await evaluate(`
          (function() {
            var bwb = window.TradingView && window.TradingView.bottomWidgetBar;
            if (bwb && typeof bwb.hide === 'function') bwb.hide();
          })()
        `);
        await new Promise(r => setTimeout(r, 400));
        await evaluate(OPEN_EDITOR);
        // Consume the one-shot only on an actual remount attempt, so a
        // slow first mount that turns out fiber-less can still be recovered.
        remounted = true;
      }
    }
  }
  return false;
}

// ── Pure / offline functions ──

export function analyze({ source }) {
  const lines = source.split('\n');
  const diagnostics = [];

  let isV6 = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('//@version=6')) { isV6 = true; break; }
    if (trimmed.startsWith('//@version=')) break;
    if (trimmed === '' || trimmed.startsWith('//')) continue;
    break;
  }

  const arrays = new Map();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fromMatch = line.match(/(\w+)\s*=\s*array\.from\(([^)]*)\)/);
    if (fromMatch) {
      const name = fromMatch[1].trim();
      const args = fromMatch[2].trim();
      const size = args === '' ? 0 : args.split(',').length;
      arrays.set(name, { name, size, line: i + 1 });
      continue;
    }
    const newMatch = line.match(/(\w+)\s*=\s*array\.new(?:<\w+>|_\w+)\((\d+)?/);
    if (newMatch) {
      const name = newMatch[1].trim();
      const size = newMatch[2] !== undefined ? parseInt(newMatch[2], 10) : null;
      arrays.set(name, { name, size, line: i + 1 });
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const pattern = /array\.(get|set)\(\s*(\w+)\s*,\s*(-?\d+)/g;
    let match;
    while ((match = pattern.exec(line)) !== null) {
      const method = match[1];
      const arrName = match[2];
      const idx = parseInt(match[3], 10);
      const info = arrays.get(arrName);
      if (!info || info.size === null) continue;
      if (idx < 0 || idx >= info.size) {
        diagnostics.push({
          line: i + 1, column: match.index + 1,
          message: `array.${method}(${arrName}, ${idx}) — index ${idx} out of bounds (array size is ${info.size})`,
          severity: 'error',
        });
      }
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const firstLastPattern = /(\w+)\.(first|last)\(\)/g;
    let match;
    while ((match = firstLastPattern.exec(line)) !== null) {
      const arrName = match[1];
      if (arrName === 'array') continue;
      const info = arrays.get(arrName);
      if (info && info.size === 0) {
        diagnostics.push({
          line: i + 1, column: match.index + 1,
          message: `${arrName}.${match[2]}() called on possibly empty array (declared with size 0)`,
          severity: 'warning',
        });
      }
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.includes('strategy.entry') || trimmed.includes('strategy.close')) {
      let hasStrategyDecl = false;
      for (const l of lines) {
        if (l.trim().startsWith('strategy(')) { hasStrategyDecl = true; break; }
      }
      if (!hasStrategyDecl) {
        diagnostics.push({
          line: i + 1, column: 1,
          message: 'strategy.entry/close used but no strategy() declaration found — did you mean to use indicator()?',
          severity: 'error',
        });
        break;
      }
    }
  }

  if (!isV6 && source.includes('//@version=')) {
    const vMatch = source.match(/\/\/@version=(\d+)/);
    if (vMatch && parseInt(vMatch[1]) < 5) {
      diagnostics.push({
        line: 1, column: 1,
        message: `Script uses Pine v${vMatch[1]} — consider upgrading to v6 for latest features`,
        severity: 'info',
      });
    }
  }

  return {
    success: true,
    issue_count: diagnostics.length,
    diagnostics,
    note: diagnostics.length === 0 ? 'No static analysis issues found. Use pine_compile or pine_smart_compile for full server-side compilation check.' : undefined,
  };
}

export async function check({ source }) {
  const formData = new URLSearchParams();
  formData.append('source', source);

  const response = await fetch(
    'https://pine-facade.tradingview.com/pine-facade/translate_light?user_name=Guest&pine_id=00000000-0000-0000-0000-000000000000',
    {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'Referer': 'https://www.tradingview.com/',
      },
      body: formData,
    }
  );

  if (!response.ok) {
    throw new Error(`TradingView API returned ${response.status}: ${response.statusText}`);
  }

  const result = await response.json();
  const errors = [];
  const warnings = [];
  const inner = result?.result;

  if (inner) {
    if (inner.errors2 && inner.errors2.length > 0) {
      for (const e of inner.errors2) {
        errors.push({
          line: e.start?.line, column: e.start?.column,
          end_line: e.end?.line, end_column: e.end?.column,
          message: e.message,
        });
      }
    }
    if (inner.warnings2 && inner.warnings2.length > 0) {
      for (const w of inner.warnings2) {
        warnings.push({ line: w.start?.line, column: w.start?.column, message: w.message });
      }
    }
  }

  if (result.error && typeof result.error === 'string') {
    errors.push({ message: result.error });
  }

  const compiled = errors.length === 0;
  return {
    success: true,
    compiled,
    error_count: errors.length,
    warning_count: warnings.length,
    errors: errors.length > 0 ? errors : undefined,
    warnings: warnings.length > 0 ? warnings : undefined,
    note: compiled ? 'Pine Script compiled successfully.' : undefined,
  };
}

// ── Functions requiring TradingView connection ──

export async function getSource() {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor or Monaco not found in React fiber tree.');

  const source = await evaluate(`
    (function() {
      var m = ${FIND_MONACO};
      if (!m) return null;
      return m.editor.getValue();
    })()
  `);

  if (source === null || source === undefined) {
    throw new Error('Monaco editor found but getValue() returned null.');
  }

  return { success: true, source, line_count: source.split('\n').length, char_count: source.length };
}

export async function setSource({ source }) {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const escaped = JSON.stringify(source);
  const set = await evaluate(`
    (function() {
      var m = ${FIND_MONACO};
      if (!m) return false;
      m.editor.setValue(${escaped});
      return true;
    })()
  `);

  if (!set) throw new Error('Monaco found but setValue() failed.');
  return { success: true, lines_set: source.split('\n').length };
}

export async function compile() {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const clicked = await evaluate(`
    (function() {
      var hit = ${FIND_COMPILE_BUTTON}();
      if (!hit) return null;
      hit.el.click();
      return hit.action;
    })()
  `);

  if (!clicked) {
    const c = await getClient();
    await c.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 2, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter' });
  }

  await new Promise(r => setTimeout(r, 2000));
  return { success: true, button_clicked: clicked || 'keyboard_shortcut', source: 'dom_fallback' };
}

export async function getErrors() {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const errors = await evaluate(`
    (function() {
      var m = ${FIND_MONACO};
      if (!m) return [];
      var model = m.editor.getModel();
      if (!model) return [];
      var markers = m.env.editor.getModelMarkers({ resource: model.uri });
      return markers.map(function(mk) {
        return { line: mk.startLineNumber, column: mk.startColumn, message: mk.message, severity: mk.severity };
      });
    })()
  `);

  return {
    success: true,
    has_errors: errors?.length > 0,
    error_count: errors?.length || 0,
    errors: errors || [],
  };
}

export async function save() {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const c = await getClient();
  await c.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 2, key: 's', code: 'KeyS', windowsVirtualKeyCode: 83 });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 's', code: 'KeyS' });
  await new Promise(r => setTimeout(r, 800));

  // Handle "Save Script" name dialog that appears for new/unsaved scripts
  const dialogHandled = await evaluate(`
    (function() {
      var saveBtn = null;
      var btns = document.querySelectorAll('button');
      for (var i = 0; i < btns.length; i++) {
        var text = btns[i].textContent.trim();
        if (text === 'Save' && btns[i].offsetParent !== null) {
          // Check if it's in a dialog (not the Pine Editor save button)
          var parent = btns[i].closest('[class*="dialog"], [class*="modal"], [class*="popup"], [role="dialog"]');
          if (parent) { saveBtn = btns[i]; break; }
        }
      }
      if (saveBtn) { saveBtn.click(); return true; }
      return false;
    })()
  `);

  if (dialogHandled) await new Promise(r => setTimeout(r, 500));

  return { success: true, action: dialogHandled ? 'saved_with_dialog' : 'Ctrl+S_dispatched' };
}

export async function getConsole() {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const entries = await evaluate(`
    (function() {
      var results = [];
      var rows = document.querySelectorAll('[class*="consoleRow"], [class*="log-"], [class*="consoleLine"]');
      if (rows.length === 0) {
        var bottomArea = document.querySelector('[class*="layout__area--bottom"]')
          || document.querySelector('[class*="bottom-widgetbar-content"]');
        if (bottomArea) {
          rows = bottomArea.querySelectorAll('[class*="message"], [class*="log"], [class*="console"]');
        }
      }
      if (rows.length === 0) {
        var pinePanel = document.querySelector('.pine-editor-container')
          || document.querySelector('[class*="pine-editor"]')
          || document.querySelector('[class*="layout__area--bottom"]');
        if (pinePanel) {
          var allSpans = pinePanel.querySelectorAll('span, div');
          for (var s = 0; s < allSpans.length; s++) {
            var txt = allSpans[s].textContent.trim();
            if (/^\\d{2}:\\d{2}:\\d{2}/.test(txt) || /error|warning|info/i.test(allSpans[s].className)) {
              rows = Array.from(rows || []);
              rows.push(allSpans[s]);
            }
          }
        }
      }
      for (var i = 0; i < rows.length; i++) {
        var text = rows[i].textContent.trim();
        if (!text) continue;
        var ts = null;
        var tsMatch = text.match(/^(\\d{4}-\\d{2}-\\d{2}\\s+)?\\d{2}:\\d{2}:\\d{2}/);
        if (tsMatch) ts = tsMatch[0];
        var type = 'info';
        var cls = rows[i].className || '';
        if (/error/i.test(cls) || /error/i.test(text.substring(0, 30))) type = 'error';
        else if (/compil/i.test(text.substring(0, 40))) type = 'compile';
        else if (/warn/i.test(cls)) type = 'warning';
        results.push({ timestamp: ts, type: type, message: text });
      }
      return results;
    })()
  `);

  return { success: true, entries: entries || [], entry_count: entries?.length || 0 };
}

/**
 * Compile / apply the current script to the chart.
 *
 * `allowSave` defaults to false and MUST stay that way: TradingView's Save
 * button persists into the script slot the buffer is bound to, so an implicit
 * Save here silently overwrites whichever saved script happens to be open.
 * See upstream issue #395.
 */
export async function smartCompile({ allowSave = false } = {}) {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const studiesBefore = await evaluate(`
    (function() {
      try {
        var chart = window.TradingViewApi._activeChartWidgetWV.value();
        if (chart && typeof chart.getAllStudies === 'function') return chart.getAllStudies().length;
      } catch(e) {}
      return null;
    })()
  `);

  const buttonClicked = await evaluate(`
    (function() {
      var allowSave = ${allowSave ? 'true' : 'false'};
      // Primary: locale-aware label matcher (title/aria-label + doubled-label
      // de-duplication). Never falls back to Save on its own.
      var hit = ${FIND_COMPILE_BUTTON}();
      if (hit) { hit.el.click(); return hit.action; }
      // Locale-independent structural fallback (upstream #487 + #463): when the
      // UI language matches no label regex above, find the icon-only compile
      // button ("noContent" class, no text) positioned immediately before
      // the Save button inside the script toolbar row. Save is scoped to the
      // Pine Editor panel root so the chart-layout Save is never clicked, and
      // Save is only honoured when allowSave is true.
      var saveBtn = null;
      var btns = document.querySelectorAll('button');
      for (var i = 0; i < btns.length; i++) {
        var cls = (typeof btns[i].className === 'string') ? btns[i].className : '';
        if (cls.indexOf('saveButton') !== -1 && btns[i].offsetParent !== null && btns[i].closest('${PINE_ROOT}')) { saveBtn = btns[i]; break; }
      }
      if (saveBtn) {
        var row = saveBtn.closest('.tv-script-widget') || saveBtn.parentElement;
        var rowBtns = row ? Array.prototype.slice.call(row.querySelectorAll('button')) : [];
        var saveIdx = rowBtns.indexOf(saveBtn);
        for (var j = saveIdx - 1; j >= 0; j--) {
          if (rowBtns[j].className.indexOf('noContent') !== -1 && rowBtns[j].offsetParent !== null) {
            rowBtns[j].click();
            return 'Add to chart (structural)';
          }
        }
        if (allowSave) {
          saveBtn.click();
          return 'Pine Save';
        }
      }
      return null;
    })()
  `);

  if (!buttonClicked) {
    const c = await getClient();
    await c.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 2, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter' });
  }

  await new Promise(r => setTimeout(r, 2500));

  const errors = await evaluate(`
    (function() {
      var m = ${FIND_MONACO};
      if (!m) return [];
      var model = m.editor.getModel();
      if (!model) return [];
      var markers = m.env.editor.getModelMarkers({ resource: model.uri });
      return markers.map(function(mk) {
        return { line: mk.startLineNumber, column: mk.startColumn, message: mk.message, severity: mk.severity };
      });
    })()
  `);

  const studiesAfter = await evaluate(`
    (function() {
      try {
        var chart = window.TradingViewApi._activeChartWidgetWV.value();
        if (chart && typeof chart.getAllStudies === 'function') return chart.getAllStudies().length;
      } catch(e) {}
      return null;
    })()
  `);

  const studyAdded = (studiesBefore !== null && studiesAfter !== null) ? studiesAfter > studiesBefore : null;

  return {
    success: true,
    button_clicked: buttonClicked || 'keyboard_shortcut',
    has_errors: errors?.length > 0,
    errors: errors || [],
    study_added: studyAdded,
  };
}

/**
 * Reads the Pine Editor's binding state: which saved script the buffer is
 * currently attached to. Used to prove a new script was really created rather
 * than the open script being silently overwritten.
 */
const READ_BINDING = `
  (function() {
    var out = { title: null, saveState: null };
    var root = document.querySelector('${PINE_ROOT}');
    if (!root) return out;
    var titleEl = root.querySelector('button[class*="nameButton"]');
    if (titleEl) out.title = titleEl.textContent.trim();
    // A bound script shows a version stamp like "8 ∙ Today, 03:02"; an unsaved
    // one shows "Unsaved version". Separator glyph varies (· / ∙ / •),
    // so match "digits + any non-alphanumeric separator" rather than a literal.
    var els = root.querySelectorAll('button,div,span');
    for (var i = 0; i < els.length; i++) {
      var t = els[i].textContent;
      if (!t) continue;
      t = t.trim();
      if (/^unsaved/i.test(t) || /^[0-9]+\\s*[^0-9A-Za-z\\s]/.test(t)) { out.saveState = t; break; }
    }
    return out;
  })()
`;

export async function newScript({ type }) {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const typeMap = { indicator: 'indicator', strategy: 'strategy', library: 'library' };
  // Submenu labels carry their shortcut inline ("Indicator⌘ K, ⌘ I"), so anchor
  // at the start only. "Built-in…" sits in the same submenu and must not match.
  const patterns = {
    indicator: '^indicator',
    strategy: '^strategy',
    library: '^library',
  };
  const wanted = patterns[type] || patterns.indicator;

  const before = await evaluate(READ_BINDING);

  // Per TradingView docs, "Create new -> indicator/strategy/library" lives in the
  // script-NAME dropdown (the script title in the Pine Editor header). Older/other
  // builds surface it under the "..." (More) button, so try the title first and
  // fall back to More. Both are scoped to the Pine Editor subtree so we never hit
  // the chart toolbar's own "More" button.
  const menuOpened = await evaluate(`
    (function() {
      var root = document.querySelector('${PINE_ROOT}');
      if (!root) return false;
      // The script-name control is the dropdown holding Create new / Make a copy /
      // Version history. It is a DIV[role=button], NOT a <button>, so do not
      // restrict by tag. Class suffixes are build-hashed; match on the prefix.
      var title = Array.prototype.slice.call(
        root.querySelectorAll('[class*="nameButton"]')
      ).filter(function(e) { return e.offsetParent !== null; })[0];
      if (title) { title.click(); return 'title-dropdown'; }
      var more = Array.prototype.slice.call(
        root.querySelectorAll('button[aria-label="More"], button[data-name*="menu"], button[aria-label*="menu" i]')
      ).filter(function(b) { return b.offsetParent !== null; });
      if (more[0]) { more[0].click(); return 'more-button'; }
      return false;
    })()
  `);

  if (!menuOpened) {
    throw new Error(
      'Could not open the Pine Editor script menu (looked for the script-name dropdown, then "More") ' +
      `inside ${PINE_ROOT}. Refusing to fall back to overwriting the open script.`
    );
  }

  await new Promise(r => setTimeout(r, 400));

  // "Create new" opens a submenu; the type lives one level down. Only ever click
  // items matching these exact patterns — the same menu holds destructive entries.
  const MENU_SEL = '[role="menuitem"], [class*="item-"], [class*="label-"]';
  const clickMenuItem = (pattern) => evaluate(`
    (function() {
      var re = new RegExp(${JSON.stringify('PLACEHOLDER')}, 'i');
      var nodes = document.querySelectorAll('${MENU_SEL}');
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        if (n.offsetParent === null) continue;
        var t = (n.textContent || '').trim();
        if (t.length > 40) continue;
        if (re.test(t)) { n.click(); return t; }
      }
      return null;
    })()
  `.replace(JSON.stringify('PLACEHOLDER'), JSON.stringify(pattern)));

  const submenuOpened = await clickMenuItem('^create new$');
  if (!submenuOpened) {
    await evaluate(`(function(){ document.body.click(); return true; })()`);
    throw new Error('Could not find "Create new" in the Pine Editor script menu. Refusing to fall back to overwriting the open script.');
  }

  await new Promise(r => setTimeout(r, 400));

  const itemClicked = await clickMenuItem(wanted);

  if (!itemClicked) {
    // Close the menu so we do not leave the UI in a half-open state.
    await evaluate(`(function(){ document.body.click(); return true; })()`);
    throw new Error(
      'Could not find a "' + type + '" item in the Pine Editor "Create new" submenu. ' +
      'Refusing to fall back to overwriting the open script.'
    );
  }

  await new Promise(r => setTimeout(r, 900));

  const after = await evaluate(READ_BINDING);

  // A genuinely new script is unsaved and carries no version stamp. If the buffer
  // is still bound to the previously open script, fail loudly — a later save
  // would otherwise overwrite the user's script.
  const stillBound = after?.saveState && /^\d+\s*·/.test(after.saveState);
  if (stillBound) {
    throw new Error(
      'Pine Editor still reports a saved script ("' + after.saveState + '") after requesting a new script. ' +
      'Aborting: saving now would overwrite the open script.'
    );
  }

  return {
    success: true,
    type,
    action: 'new_script_created',
    template: typeMap[type],
    menu_item: itemClicked,
    binding_before: before,
    binding_after: after,
  };
}

export async function openScript({ name }) {
  const editorReady = await ensurePineEditorOpen();
  if (!editorReady) throw new Error('Could not open Pine Editor.');

  const escapedName = JSON.stringify(name.toLowerCase());

  const result = await evaluateAsync(`
    (function() {
      var target = ${escapedName};
      return fetch('https://pine-facade.tradingview.com/pine-facade/list/?filter=saved', { credentials: 'include' })
        .then(function(r) { return r.json(); })
        .then(function(scripts) {
          if (!Array.isArray(scripts)) return {error: 'pine-facade returned unexpected data'};
          var match = null;
          for (var i = 0; i < scripts.length; i++) {
            var sn = (scripts[i].scriptName || '').toLowerCase();
            var st = (scripts[i].scriptTitle || '').toLowerCase();
            if (sn === target || st === target) { match = scripts[i]; break; }
          }
          if (!match) {
            for (var j = 0; j < scripts.length; j++) {
              var sn2 = (scripts[j].scriptName || '').toLowerCase();
              var st2 = (scripts[j].scriptTitle || '').toLowerCase();
              if (sn2.indexOf(target) !== -1 || st2.indexOf(target) !== -1) { match = scripts[j]; break; }
            }
          }
          if (!match) return {error: 'Script "' + target + '" not found. Use pine_list_scripts to see available scripts.'};

          var id = match.scriptIdPart;
          var ver = match.version || 1;
          return fetch('https://pine-facade.tradingview.com/pine-facade/get/' + id + '/' + ver, { credentials: 'include' })
            .then(function(r2) { return r2.json(); })
            .then(function(data) {
              var source = data.source || '';
              if (!source) return {error: 'Script source is empty', name: match.scriptName || match.scriptTitle};
              var m = ${FIND_MONACO};
              if (m) {
                m.editor.setValue(source);
                return {success: true, name: match.scriptName || match.scriptTitle, id: id, lines: source.split('\\n').length};
              }
              return {error: 'Monaco editor not found to inject source', name: match.scriptName || match.scriptTitle};
            });
        })
        .catch(function(e) { return {error: e.message}; });
    })()
  `);

  if (result?.error) {
    throw new Error(result.error);
  }

  return { success: true, name: result.name, script_id: result.id, lines: result.lines, source: 'internal_api', opened: true };
}

export async function listScripts() {
  const scripts = await evaluateAsync(`
    fetch('https://pine-facade.tradingview.com/pine-facade/list/?filter=saved', { credentials: 'include' })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (!Array.isArray(data)) return {scripts: [], error: 'Unexpected response from pine-facade'};
        return {
          scripts: data.map(function(s) {
            return {
              id: s.scriptIdPart || null,
              name: s.scriptName || s.scriptTitle || 'Untitled',
              title: s.scriptTitle || null,
              version: s.version || null,
              modified: s.modified || null,
            };
          })
        };
      })
      .catch(function(e) { return {scripts: [], error: e.message}; })
  `);

  return {
    success: true,
    scripts: scripts?.scripts || [],
    count: scripts?.scripts?.length || 0,
    source: 'internal_api',
    error: scripts?.error,
  };
}
