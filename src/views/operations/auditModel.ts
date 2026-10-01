/**
 * Pure model for the Audit page (design 23, section 4.3).
 *
 * Three layers on `?view=`: Changes (the default), All events and Integrity.
 * Changes drops node online and offline flips (about 44 a day on the 34-node
 * fleet) and observe events inside the server's scan, so paging and counts
 * stay true to what the operator is looking for. The query field speaks the
 * shared token grammar; each key writes the URL key and HTTP parameter the
 * server reads.
 *
 * Kept free of Vue so `node --test` covers it directly.
 */
import type { TokenGrammar, TokenValues } from "@/lib/queryTokens";

export const AUDIT_LAYERS = ["changes", "all", "integrity"] as const;
export type AuditLayer = (typeof AUDIT_LAYERS)[number];

export const AUDIT_PAGE_SIZE = 50;

/** Node reachability flips: the noise Changes hides. */
export const NODE_FLIP_ACTIONS = ["node.online", "node.offline"] as const;

export const AUDIT_DECISIONS = ["allow", "deny", "observe", "warn", "dismiss"] as const;

/**
 * node, actor, action, decision, scope and trace, plus free text. `action`
 * matches exactly unless it ends in "*" (the server's rule), so `action:task.*`
 * reads the whole namespace. `decision` is one value: the server compares it
 * exactly and takes no list.
 */
export const AUDIT_GRAMMAR: TokenGrammar = {
  fields: [
    { key: "node", kind: "value", resolve: "node", param: "node_id" },
    { key: "actor", kind: "value", param: "actor_id" },
    { key: "action", kind: "value" },
    { key: "decision", kind: "value" },
    { key: "scope", kind: "value" },
    { key: "trace", kind: "value", param: "correlation_id" },
  ],
  flags: [],
  textParam: "q",
};

export interface AuditQueryParams {
  action?: string;
  decision?: string;
  node_id?: string;
  actor_id?: string;
  scope?: string;
  correlation_id?: string;
  q?: string;
  at_from?: string;
  at_to?: string;
  exclude_action?: string;
  exclude_decision?: string;
  limit: number;
  offset: number;
}

export interface AuditRequestInput {
  layer: AuditLayer;
  tokens: TokenValues;
  window: { from?: string; to?: string };
  offset: number;
  limit?: number;
}

/**
 * What Changes hides, given what the operator asked for. A question about
 * node flips (`action:node.*`, `action:node.offline`) or about observe events
 * (`decision:observe`) is answered, not contradicted: the exclusion that would
 * empty it is dropped.
 */
export function changesExclusions(tokens: TokenValues): { exclude_action?: string; exclude_decision?: string } {
  const action = tokens.values.action ?? "";
  const decision = tokens.values.decision ?? "";
  const out: { exclude_action?: string; exclude_decision?: string } = {};
  if (!action.startsWith("node.") && action !== "node*") out.exclude_action = NODE_FLIP_ACTIONS.join(",");
  if (decision !== "observe") out.exclude_decision = "observe";
  return out;
}

/** The one GET /api/audit a layer, a question and a window mean. */
export function auditRequest(input: AuditRequestInput): AuditQueryParams {
  const values = input.tokens.values;
  const params: AuditQueryParams = { limit: input.limit ?? AUDIT_PAGE_SIZE, offset: input.offset };
  if (values.node) params.node_id = values.node;
  if (values.actor) params.actor_id = values.actor;
  if (values.action) params.action = values.action;
  if (values.decision) params.decision = values.decision;
  if (values.scope) params.scope = values.scope;
  if (values.trace) params.correlation_id = values.trace;
  if (input.tokens.text) params.q = input.tokens.text;
  if (input.window.from) params.at_from = input.window.from;
  if (input.window.to) params.at_to = input.window.to;
  if (input.layer === "changes") Object.assign(params, changesExclusions(input.tokens));
  return params;
}

/**
 * Whether the server answered rows the request excluded. A server from before
 * exclude_action ignores the parameter, and Changes then shows node flips and
 * observe events; the proof line must not say they are hidden. Prefixes match
 * the server's rule: a trailing "*" is optional.
 */
export function exclusionsIgnored(
  params: Pick<AuditQueryParams, "exclude_action" | "exclude_decision">,
  events: ReadonlyArray<{ action: string; decision: string }>,
): boolean {
  const prefixes = (params.exclude_action ?? "").split(",").filter(Boolean).map((p) => (p.endsWith("*") ? p.slice(0, -1) : p));
  const decisions = (params.exclude_decision ?? "").split(",").filter(Boolean);
  if (!prefixes.length && !decisions.length) return false;
  return events.some((event) => decisions.includes(event.decision) || prefixes.some((prefix) => event.action.startsWith(prefix)));
}

/** What the proof line says about the scan behind the count. */
export type AuditScan =
  | { kind: "complete"; total: number; scanned: number }
  | { kind: "capped"; total: number; scanned: number }
  | { kind: "unknown"; total: number };

export function auditScan(response: { total: number; scanned?: number; complete?: boolean } | undefined): AuditScan | null {
  if (!response) return null;
  if (response.complete === false) return { kind: "capped", total: response.total, scanned: response.scanned ?? response.total };
  if (typeof response.scanned === "number") return { kind: "complete", total: response.total, scanned: response.scanned };
  return { kind: "unknown", total: response.total };
}

/**
 * Decisions a Filters popover offers as one choice each. Not every decision
 * is common; the popover names the ones an operator narrows to.
 */
export const AUDIT_DECISION_CHOICES = ["allow", "deny", "observe"] as const;

/** Where the last Verify chain result is kept between visits (per viewer). */
export const VERIFY_STORAGE_KEY = "lattice.audit.lastVerify";

export interface StoredVerify {
  at: string;
  enabled: boolean;
  ok: boolean;
  count?: number;
}

/** Read a stored verify result; anything malformed is no result. */
export function readStoredVerify(raw: string | null): StoredVerify | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<StoredVerify>;
    if (typeof value.at !== "string" || Number.isNaN(Date.parse(value.at)) || typeof value.enabled !== "boolean") return null;
    return { at: value.at, enabled: value.enabled, ok: value.ok === true, count: typeof value.count === "number" ? value.count : undefined };
  } catch {
    return null;
  }
}
