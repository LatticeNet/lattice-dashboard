/**
 * Pure model for the Approvals page layers (design 23, section 4.3).
 *
 * Three layers on `?view=`: Needs you, History and Stuck. With no layer in
 * the address the page opens on Needs you when it has items and on History
 * otherwise: production holds 1,351 approvals and none waiting, so the old
 * default was an empty inbox. A layer the operator picks is always written
 * to the address (the "auto" fallback is never a layer of its own), so a
 * pending plan arriving later never moves the page under them.
 *
 * History is one server query: status, plugin and node are the listing's
 * own parameters and the range is `since` (on updated_at). The listing has
 * no actor filter, so the field offers none.
 *
 * Kept free of Vue so `node --test` covers it directly.
 */
import type { ApprovalListParams, ApprovalListResponse } from "@/lib/api/index";
import type { ApprovalStatus, ApprovalView } from "@/lib/api/types";
import type { QueryRecord, QueryValue } from "@/components/common/tableUrlState";
import type { TokenGrammar, TokenValues } from "@/lib/queryTokens";

export const APPROVAL_LAYERS = ["needs", "history", "stuck"] as const;
export type ApprovalLayer = (typeof APPROVAL_LAYERS)[number];
/** The bare address: resolved to Needs you or History once the inbox is read. */
export const AUTO_LAYER = "auto";
export type ApprovalLayerChoice = ApprovalLayer | typeof AUTO_LAYER;

export const APPROVAL_PAGE_SIZE = 50;

export const HISTORY_STATUSES = ["pending", "approved", "applied", "rejected", "dismissed"] as const satisfies readonly ApprovalStatus[];

export const APPROVAL_HISTORY_GRAMMAR: TokenGrammar = {
  fields: [
    { key: "status", kind: "enum", values: HISTORY_STATUSES },
    { key: "plugin", kind: "value" },
    { key: "node", kind: "value", resolve: "node", param: "node_id" },
  ],
  flags: [],
  textParam: "q",
};

export const HISTORY_RANGES = ["24h", "7d", "30d", "all"] as const;

/**
 * The layer a bare address opens on. Until the inbox has been read the page
 * does not guess; a failed read opens Needs you, where the error is said.
 */
export function defaultApprovalLayer(input: { needs: number; read: boolean; failed: boolean }): ApprovalLayer | null {
  if (input.needs > 0 || input.failed) return "needs";
  return input.read ? "history" : null;
}

export interface HistoryRequestInput {
  tokens: TokenValues;
  window: { from?: string };
  offset: number;
  limit?: number;
}

/**
 * The one listing call a history question means. Dismissed rows are
 * tombstones the server hides unless asked, so asking for them by status
 * sets include_dismissed too.
 */
export function historyRequest(input: HistoryRequestInput): ApprovalListParams {
  const params: ApprovalListParams = { limit: input.limit ?? APPROVAL_PAGE_SIZE, offset: input.offset };
  const status = input.tokens.enums.status;
  if (status?.length) {
    params.status = status.join(",");
    if (status.includes("dismissed")) params.include_dismissed = true;
  }
  if (input.tokens.values.plugin) params.plugin = input.tokens.values.plugin;
  if (input.tokens.values.node) params.node_id = input.tokens.values.node;
  if (input.window.from) params.since = input.window.from;
  return params;
}

function rowMatches(row: ApprovalView, params: ApprovalListParams): boolean {
  const statuses = typeof params.status === "string" ? params.status.split(",").filter(Boolean) : [];
  if (statuses.length && !statuses.includes(row.status)) return false;
  if (!statuses.includes("dismissed") && row.status === "dismissed" && !params.include_dismissed) return false;
  if (params.plugin && row.plugin !== params.plugin) return false;
  if (params.node_id && row.node_id !== params.node_id) return false;
  if (params.since && Date.parse(row.updated_at ?? row.created_at ?? "") < Date.parse(params.since)) return false;
  return true;
}

export interface ApprovalPage {
  approvals: ApprovalView[];
  total: number;
  serverFiltered: boolean;
}

/** One page whatever the server answered; a bare array is filtered and paged here. */
export function normalizeApprovalPage(response: ApprovalListResponse | ApprovalView[], params: ApprovalListParams): ApprovalPage {
  const offset = params.offset ?? 0;
  const limit = params.limit ?? APPROVAL_PAGE_SIZE;
  if (Array.isArray(response) || response.total === undefined) {
    const rows = (Array.isArray(response) ? response : response.approvals ?? []).filter((row) => rowMatches(row, params));
    return { approvals: rows.slice(offset, offset + limit), total: rows.length, serverFiltered: false };
  }
  return { approvals: response.approvals ?? [], total: response.total, serverFiltered: true };
}

/**
 * Old links, read once: `?selected=<id>` (SSH Guard, older consoles) opens
 * the plan in the sheet; `?bucket=` (plugins navigate with it) picks the
 * layer, and a history bucket becomes the status token. Returns null when
 * there is nothing to rewrite.
 */
export function legacyApprovalQuery(query: QueryRecord): Record<string, QueryValue> | null {
  const first = (raw: QueryValue | undefined) => (Array.isArray(raw) ? raw.find((v) => typeof v === "string") : raw)?.trim() ?? "";
  const selected = first(query.selected);
  const bucket = first(query.bucket);
  if (!selected && !bucket && query.q === undefined) return null;
  const next: Record<string, QueryValue> = {};
  for (const [key, value] of Object.entries(query)) {
    if (key === "selected" || key === "bucket" || key === "q" || value === undefined) continue;
    next[key] = value;
  }
  if (selected && !next.open) next.open = selected;
  if (bucket === "pending" || bucket === "active" || bucket === "stale") next.view = "needs";
  else if (bucket === "stuck") next.view = "stuck";
  else if (bucket === "approved" || bucket === "applied" || bucket === "rejected" || bucket === "dismissed") {
    next.view = "history";
    next.status = bucket;
  } else if (bucket === "all") next.view = "history";
  return next;
}
