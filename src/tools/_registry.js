/**
 * Canonical operation registry (P2-19) — the structural spine.
 *
 * ONE definition per operation, shared by every transport:
 *   { name, description, handler, inputSchema, outputSchema, annotations,
 *     access, transports: { http?: { path, method, adapter } } }
 *
 * The MCP layer registers ops verbatim (server.tool positional shape is
 * mirrored so migration is mechanical); the HTTP gateway derives its route
 * table from the SAME set. A route exists ONLY on ops that declare an http
 * transport, and only read-access ops may do so (op() refuses otherwise —
 * the §4.3 read-only rule is structural, not conventional; mutations need an
 * authorizing ADR to become bindable).
 *
 * The http ADAPTER is the op's HTTP-specific binding: a small lambda that
 * turns (url, _deps) into the SAME core call the MCP handler makes — declared
 * beside the op, so the gateway needs no per-op knowledge, no result
 * unwrapping (the adapter returns the raw payload), and the _deps offline
 * seam flows straight into core (as it did in the first-slice hardcoded
 * table). Handlers keep the MCP dual-form; adapters return plain JSON.
 *
 * Design notes:
 * - `access` is DERIVED from the annotation object via ACCESS_BY_CLASS —
 *   annotations stay the single authority; access can never drift from them
 *   (P2-13 ↔ P2-19 coherence is enforced by construction and re-tested).
 * - op() returns the op object (additive, testable, no import cycles).
 */

import { A } from './_annotations.js';

/** ops live in a module-level map — one definition per name, everywhere */
const OPS = new Map();

/** annotation object → access class (the coherence constraint P2-20 tests) */
export const ACCESS_BY_CLASS = Object.freeze([
  [A.READ, 'read'],
  [A.MUTATE_IDEMPOTENT, 'mutate'],
  [A.MUTATE_ORDER, 'order'],
  [A.DESTRUCTIVE, 'destructive'],
  [A.OPEN_WORLD, 'open-world'],
  [A.SYSTEM, 'system'],
]);

export function accessFromAnnotations(annotations) {
  for (const [cls, access] of ACCESS_BY_CLASS) {
    const keys = Object.keys(cls);
    if (!keys.length) continue;
    if (keys.every((k) => cls[k] === annotations?.[k])) return access;
  }
  return null; // unknown annotation shape — registry refuses it
}

/** annotation class → access, for callers that register from an A.X reference */
export function accessFromClassRef(cls) {
  for (const [c, access] of ACCESS_BY_CLASS) {
    if (c === cls) return access;
  }
  return null;
}

/**
 * Register an operation. Positional signature mirrors server.tool(name,
 * description, schema, annotations, handler) so tool files convert
 * mechanically (server.tool → op). Extra registry fields arrive as a 6th
 * argument: { http, outputSchema, meta } where http: { path, adapter }.
 *
 * A known access class is REQUIRED (derivable from the annotation object).
 */
export function op(name, description, schema, annotations, handler, extra = {}) {
  if (typeof name !== 'string' || !name) throw new TypeError('op: name required');
  if (OPS.has(name)) throw new Error(`registry: duplicate op '${name}'`);
  if (typeof handler !== 'function') throw new TypeError(`op '${name}': handler required`);

  const access = accessFromAnnotations(annotations);
  if (!access) {
    throw new TypeError(
      `op '${name}': annotations do not match any known access class ` +
      '(P2-13/P2-19 coherence) — update _annotations.js ACCESS_BY_CLASS first',
    );
  }
  let httpBinding = null;
  if (extra.http) {
    const { path, adapter, method = 'GET' } = extra.http;
    if (!path || typeof path !== 'string' || !path.startsWith('/')) {
      throw new TypeError(`op '${name}': http.path must be an absolute path`);
    }
    if (method !== 'GET') {
      throw new TypeError(
        `op '${name}': http method '${method}' requires an authorizing ADR — the ` +
        'gateway is read-only by design; non-GET transports are unbindable for now',
      );
    }
    if (access !== 'read') {
      throw new TypeError(
        `op '${name}': http binding requires access 'read' (gateway is read-only ` +
        'by design; mutations need an authorizing ADR first)',
      );
    }
    if (typeof adapter !== 'function') {
      throw new TypeError(`op '${name}': http.adapter must be a function (url, _deps) => payload`);
    }
    httpBinding = Object.freeze({ method, path, adapter });
  }

  const entry = Object.freeze({
    name,
    description,
    handler,
    inputSchema: schema ?? {},
    // Optional P2-3 output contract (SDK validates structuredContent against
    // it when present). Error responses never carry outputSchema validation
    // (SDK skips isError results) so the error envelope is unaffected.
    ...(extra.outputSchema ? { outputSchema: extra.outputSchema } : {}),
    annotations: Object.freeze({ ...annotations }),
    access,
    // Transport bindings. http: { method, path, adapter(url, _deps)→payload }.
    transports: Object.freeze({
      ...(httpBinding ? { http: httpBinding } : {}),
    }),
    ...(extra.meta ? { meta: Object.freeze({ ...extra.meta }) } : {}),
  });
  OPS.set(name, entry);
  return entry;
}

// ── views over the registry ─────────────────────────────────────────────────

export function listOps() {
  return [...OPS.values()];
}

export function getOp(name) {
  return OPS.get(name) || null;
}

export function opCount() {
  return OPS.size;
}

/** Derived HTTP route table — read ops with an http transport binding. */
export function httpRoutes() {
  return listOps()
    .filter((o) => o.transports.http && o.access === 'read')
    .map((o) => ({
      method: o.transports.http.method,
      path: o.transports.http.path,
      op: o.name,
      handler: o.handler,
      adapter: o.transports.http.adapter,
    }));
}

/** Reset for tests. Production code never calls this. */
export function _resetForTest() {
  OPS.clear();
}