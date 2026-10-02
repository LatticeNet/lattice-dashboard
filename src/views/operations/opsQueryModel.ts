/**
 * The address of an Operations collection: a time range, a server page
 * offset, and the query tokens (design 23, sections 3.9 and 4.3). Tasks,
 * Audit and Approvals history each ask the server for one page of what the
 * operator asked; this model is the part they share.
 *
 *   ?range=24h                  a preset; the page's default is the bare URL
 *   ?range=custom&since=&until= custom bounds, RFC 3339 with Z
 *   ?offset=50                  the server page, 0 is the bare URL
 *
 * Kept free of Vue so `node --test` covers it directly.
 */
import type { QueryRecord, QueryValue } from "@/components/common/tableUrlState";

export const OPS_RANGES = ["1h", "24h", "7d", "30d", "all", "custom"] as const;
export type OpsRange = (typeof OPS_RANGES)[number];

const RANGE_MS: Record<Exclude<OpsRange, "all" | "custom">, number> = {
  "1h": 3_600_000,
  "24h": 86_400_000,
  "7d": 7 * 86_400_000,
  "30d": 30 * 86_400_000,
};

export const RANGE_PARAM = "range";
export const SINCE_PARAM = "since";
export const UNTIL_PARAM = "until";
export const OFFSET_PARAM = "offset";

export interface RangeState {
  range: OpsRange;
  /** Custom bounds, ISO; empty unless the range is custom. */
  since: string;
  until: string;
}

function first(raw: QueryValue | undefined): string {
  const value = Array.isArray(raw) ? raw.find((entry) => typeof entry === "string") : raw;
  return typeof value === "string" ? value.trim() : "";
}

function instant(raw: QueryValue | undefined): string {
  const text = first(raw);
  const ms = text ? Date.parse(text) : Number.NaN;
  return Number.isNaN(ms) ? "" : new Date(ms).toISOString();
}

export function isOpsRange(value: string): value is OpsRange {
  return (OPS_RANGES as readonly string[]).includes(value);
}

/** The range an address asks for; an unknown value is the page's default. */
export function readRange(query: QueryRecord, fallback: OpsRange): RangeState {
  const raw = first(query[RANGE_PARAM]);
  const range = isOpsRange(raw) ? raw : fallback;
  if (range !== "custom") return { range, since: "", until: "" };
  return { range, since: instant(query[SINCE_PARAM]), until: instant(query[UNTIL_PARAM]) };
}

/**
 * Put a range into a query. The page's default is the bare URL, bounds are
 * written only for a custom range, and the page offset is dropped: a new
 * window is a new first page.
 */
export function writeRange(query: QueryRecord, state: RangeState, fallback: OpsRange): Record<string, QueryValue> {
  const next: Record<string, QueryValue> = {};
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || key === RANGE_PARAM || key === SINCE_PARAM || key === UNTIL_PARAM || key === OFFSET_PARAM) continue;
    next[key] = value;
  }
  if (state.range !== fallback) next[RANGE_PARAM] = state.range;
  if (state.range === "custom") {
    if (state.since) next[SINCE_PARAM] = state.since;
    if (state.until) next[UNTIL_PARAM] = state.until;
  }
  return next;
}

/**
 * The window a range means at `now`, as the RFC 3339 bounds the server
 * reads (UTC, with Z: a bare "+" offset decodes to a space in a query string
 * and the task list answers 400). "all" has no bounds.
 */
export function rangeWindow(state: RangeState, now: number): { from?: string; to?: string } {
  if (state.range === "all") return {};
  if (state.range === "custom") {
    return { from: state.since || undefined, to: state.until || undefined };
  }
  return { from: new Date(now - RANGE_MS[state.range]).toISOString() };
}

/** The server page an address holds; anything unreadable is the first page. */
export function readOffset(query: QueryRecord): number {
  const n = Number(first(query[OFFSET_PARAM]));
  return Number.isInteger(n) && n > 0 ? n : 0;
}

/** Move to a server page; the first page is the bare URL. */
export function writeOffset(query: QueryRecord, offset: number): Record<string, QueryValue> {
  const next: Record<string, QueryValue> = {};
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || key === OFFSET_PARAM) continue;
    next[key] = value;
  }
  if (offset > 0) next[OFFSET_PARAM] = String(offset);
  return next;
}

/** "51-100 of 1,771": the page bounds, 1-based, for the pager. */
export function pageBounds(offset: number, shown: number): { from: number; to: number } {
  return shown === 0 ? { from: 0, to: 0 } : { from: offset + 1, to: offset + shown };
}
