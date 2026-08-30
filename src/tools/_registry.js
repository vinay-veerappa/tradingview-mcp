/**
 * Canonical operation registry (P2-19) — the structural spine.
 *
 * ONE definition per operation, shared by every transport:
 *   { name, description, handler, inputSchema, outputSchema, annotations,
 *     access, transports: { http?: { path, method, adapter } } }
 *
 * The MCP layer registers ops verbatim (server.tool positional shape is
 * mirrored so migration is mechanical); the HTTP gateway derives its route
 * table from the SAME set. GET routes exist on read-access ops; mutation
 * routes (POST/PATCH/DELETE) exist ONLY on ops that cite ADR 0001 in
 * `extra.meta.mutation_adr` and declare the env gate at gateway start
 * (docs/adr/0001-mutation-routes.md) — the §4.3 read-only default still
 * holds unless BOTH the op-level and server-level gates authorize.
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
    // ADR 0001: mutations are declarable over HTTP only when the op carries
    // the ADR reference in its meta — the escape hatch is explicit and
    // per-op, never bulk. Without it, non-GET/non-read stays refused.
    const { path, adapter, method = 'GET' } = extra.http;
    const adr = extra.meta?.mutation_adr;
    const mutates = access !== 'read';
    const nonGet = method !== 'GET';
    if (mutates || nonGet) {
      if (adr !== '0001-mutation-routes') {
        throw new TypeError(
          `op '${name}': mutation HTTP binding requires meta.mutation_adr = ` +
          "'0001-mutation-routes' (ADR 0001) — gateway is read-only by default",
        );
      }
    }
    if (nonGet) {
      if (!['POST', 'PATCH', 'DELETE'].includes(method)) {
        throw new TypeError(
          `op '${name}': http method '${method}' is not allowed; ` +
          'mutation routes are POST (place), PATCH (modify), DELETE (cancel)',
        );
      }
      if (access === 'destructive' || access === 'open-world') {
        throw new TypeError(
          `op '${name}': access '${access}' stays MCP-only per ADR 0001 — ` +
          'destructive/open-world ops are never HTTP-bindable',
        );
      }
      if (access !== 'order' && access !== 'mutate') {
        throw new TypeError(
          `op '${name}': access '${access}' is not HTTP-bindable (allowed: read GET, mutate/order POST/PATCH/DELETE under ADR 0001)`,
        );
      }
      if (!path || typeof path !== 'string' || !path.startsWith('/')) {
        throw new TypeError(`op '${name}': http.path must be an absolute path`);
      }
    } else {
      if (!path || typeof path !== 'string' || !path.startsWith('/')) {
        throw new TypeError(`op '${name}': http.path must be an absolute path`);
      }
      if (access !== 'read') {
        throw new TypeError(
          `op '${name}': http binding requires access 'read' (gateway is read-only ` +
          'by design; mutations need an authorizing ADR first)',
        );
      }
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
    // Transport bindings. http: { method, path, adapter(url, _deps [, body, req])→payload }.
    // Mutation adapters (POST/PATCH/DELETE) additionally receive the parsed
    // JSON body and the raw request (ADR 0001).
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
    .filter((o) => o.transports.http)
    .map((o) => ({
      method: o.transports.http.method,
      path: o.transports.http.path,
      op: o.name,
      access: o.access,
      handler: o.handler,
      adapter: o.transports.http.adapter,
    }));
}

/** Reset for tests. Production code never calls this. */
export function _resetForTest() {
  OPS.clear();
}