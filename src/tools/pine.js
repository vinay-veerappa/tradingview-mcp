import { z } from 'zod';
import { A } from './_annotations.js';
import { jsonResult, errorResult } from './_format.js';
import * as core from '../core/pine.js';

export function registerPineTools(server) {
  server.tool('pine_get_source', 'Get current Pine Script source code from the editor. Can return 200KB+ on complex scripts — pass max_chars to cap the returned source (line_count/char_count still report the full size, and truncated:true flags a capped result).', {
    max_chars: z.coerce.number().int().positive().optional().describe('Cap the returned source to this many characters (default: full source)'),
  },
    A.READ, async ({ max_chars }) => {
    try { return jsonResult(await core.getSource({ max_chars })); }
    catch (err) { return errorResult(err); }
  });

  server.tool('pine_set_source', 'Set Pine Script source code in the editor', {
    source: z.string().describe('Pine Script source code to inject'),
  },
    A.MUTATE_IDEMPOTENT, async ({ source }) => {
    try { return jsonResult(await core.setSource({ source })); }
    catch (err) { return errorResult(err); }
  });

  server.tool('pine_compile', 'Compile / add the current Pine Script to the chart', {},
    A.SYSTEM, async () => {
    try { return jsonResult(await core.compile()); }
    catch (err) { return errorResult(err); }
  });

  server.tool('pine_get_errors', 'Get Pine Script compilation errors from Monaco markers', {},
    A.READ, async () => {
    try { return jsonResult(await core.getErrors()); }
    catch (err) { return errorResult(err); }
  });

  server.tool('pine_save', 'Save the current Pine Script (Ctrl+S)', {},
    A.MUTATE_IDEMPOTENT, async () => {
    try { return jsonResult(await core.save()); }
    catch (err) { return errorResult(err); }
  });

  server.tool('pine_get_console', 'Read Pine Script console/log output (compile messages, log.info(), errors)', {},
    A.READ, async () => {
    try { return jsonResult(await core.getConsole()); }
    catch (err) { return errorResult(err); }
  });

  server.tool('pine_smart_compile', 'Intelligent compile: detects button, compiles, checks errors, reports study changes. Does NOT save by default.', {
    allow_save: z.boolean().optional().describe('Allow clicking Save if no non-destructive compile button is found. DANGEROUS: Save persists into the script slot the editor is bound to and will overwrite that saved script. Default false.'),
  },
    A.SYSTEM, async ({ allow_save }) => {
    try { return jsonResult(await core.smartCompile({ allowSave: allow_save === true })); }
    catch (err) { return errorResult(err); }
  });

  server.tool('pine_new', 'Create a genuinely new, unsaved Pine Script via the editor menu. Throws rather than overwriting the currently open script.', {
    type: z.enum(['indicator', 'strategy', 'library']).describe('Type of script to create'),
  },
    A.MUTATE_IDEMPOTENT, async ({ type }) => {
    try { return jsonResult(await core.newScript({ type })); }
    catch (err) { return errorResult(err); }
  });

  server.tool('pine_open', 'Open a saved Pine Script by name', {
    name: z.string().describe('Name of the saved script to open (case-insensitive match)'),
  },
    A.MUTATE_IDEMPOTENT, async ({ name }) => {
    try { return jsonResult(await core.openScript({ name })); }
    catch (err) { return errorResult(err, { source: 'pine_facade_rest' }); }
  });

  server.tool('pine_list_scripts', 'List saved Pine Scripts', {},
    A.READ, async () => {
    try { return jsonResult(await core.listScripts()); }
    catch (err) { return errorResult(err); }
  });

  server.tool('pine_analyze', 'Run static analysis on Pine Script code WITHOUT compiling — catches array out-of-bounds, unguarded array.first()/last(), bad loop bounds, and implicit bool casts. Works offline, no TradingView connection needed.', {
    source: z.string().describe('Pine Script source code to analyze'),
  },
    A.READ, async ({ source }) => {
    try { return jsonResult(core.analyze({ source })); }
    catch (err) { return errorResult(err); }
  });

  server.tool('pine_check', 'Compile Pine Script via TradingView\'s server API without needing the chart open. Returns compilation errors/warnings. Useful for validating code before injecting into the chart.', {
    source: z.string().describe('Pine Script source code to compile/validate'),
  },
    A.READ, async ({ source }) => {
    try { return jsonResult(await core.check({ source })); }
    catch (err) { return errorResult(err); }
  });
}
