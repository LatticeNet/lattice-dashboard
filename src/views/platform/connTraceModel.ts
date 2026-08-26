/**
 * Pure model for the Connection Trace screen: filter serialisation, the
 * display mappings a row depends on, session TTL clamping, and keyset page
 * accumulation. Kept free of Vue so `node --test` covers it directly (house
 * *Model.ts pattern).
 *
 * The rule the whole screen exists to protect: a byte count that was never
 * sampled is UNKNOWN, not zero. A connection shorter than the agent's
 * /connections sampling interval is born and dies between two samples, so its
 * counters were never read. Printing 0 there is a lie an operator would act
 * on, so `bytes_known` is carried all the way to the cell and the unknown case
 * renders words instead of a number.
 *
 * Not to be confused with `src/views/operations/traceModel.ts`, which is the
 * audit correlation trace and has nothing to do with sing-box connections.
 */
import { formatBytes, formatDuration } from "../../lib/format.ts";
import type { QueryRecord, QueryValue } from "@/components/common/tableUrlState";
import type { ConnRecord } from "@/lib/api/types";

/* ------------------------------------------------------------------ */
/* Filters                                                             */
/* ------------------------------------------------------------------ */

/** Relative windows an operator picks from, plus the explicit escape hatch. */
export const TRACE_RANGES = ["15m", "1h", "6h", "24h", "7d", "custom"] as const;
export type TraceRange = (typeof TRACE_RANGES)[number];

const RANGE_SECONDS: Record<Exclude<TraceRange, "custom">, number> = {
  "15m": 900,
  "1h": 3600,
  "6h": 21600,
  "24h": 86400,
  "7d": 604800,
};

/** How a connection ended, in the order the chips are rendered. */
export const CLOSE_REASONS = [
  "eof",
  "canceled",
  "reset",
  "timeout",
  "dial_failed",
  "auth_failed",
  "handshake_failed",
  "udp_idle",
  "core_restart",
  "unknown",
] as const;
export type CloseReason = (typeof CLOSE_REASONS)[number];

/** How confidently a user was attributed to a connection. */
export const USER_KINDS = ["managed", "legacy", "discovered", "unnamed", "unobserved", "unresolved"] as const;
export type UserKind = (typeof USER_KINDS)[number];

/** The whole of the linkable filter state for the connections list. */
export interface ConnTraceFilters {
  range: TraceRange;
  /** Explicit window bounds, honoured only while range is "custom". */
  since: string;
  until: string;
  nodeId: string;
  userId: string;
  lineUuid: string;
  sessionId: string;
  /** Case-insensitive substring matched against the destination host. */
  dst: string;
  closeReasons: string[];
  userKinds: string[];
  stalledOnly: boolean;
  includeOpen: boolean;
}

export const DEFAULT_TRACE_RANGE: TraceRange = "1h";

export const DEFAULT_CONN_TRACE_FILTERS: ConnTraceFilters = {
  range: DEFAULT_TRACE_RANGE,
  since: "",
  until: "",
  nodeId: "",
  userId: "",
  lineUuid: "",
  sessionId: "",
  dst: "",
  closeReasons: [],
  userKinds: [],
  stalledOnly: false,
  includeOpen: false,
};

/**
 * Query parameter names.
 *
 * Deliberately the same names the HTTP contract uses, so the address bar and
 * the request an operator would reproduce with curl read alike. The results
 * table owns a separate, namespaced set of keys (`conn.sort` and friends) via
 * tableUrlState, so the two cannot collide.
 */
const PARAM = {
  range: "range",
  since: "since",
  until: "until",
  nodeId: "node_id",
  userId: "user_id",
  lineUuid: "line_uuid",
  sessionId: "session_id",
  dst: "dst",
  closeReasons: "close_reason",
  userKinds: "user_kind",
  stalledOnly: "stalled",
  includeOpen: "include_open",
} as const;

/** Every query key this filter set owns. */
export const CONN_TRACE_PARAMS: readonly string[] = Object.values(PARAM);

/** First usable string for a query key; vue-router may hand over an array. */
function readParam(query: QueryRecord, key: string): string {
  const raw = query[key];
  const value = Array.isArray(raw) ? raw.find((entry) => typeof entry === "string") : raw;
  return typeof value === "string" ? value.trim() : "";
}

/** True for the strings an operator or a link may use to mean yes. */
function readFlag(query: QueryRecord, key: string): boolean {
  const value = readParam(query, key).toLowerCase();
  return value === "true" || value === "1" || value === "yes";
}

/**
 * Read a comma-separated multi-value filter, keeping only values this build
 * knows. Unknown values are dropped rather than sent on: the server would
 * reject them, and a filter nobody can satisfy renders an empty table that
 * looks like a quiet network.
 *
 * The result is ordered by the canonical list, not by the URL, so reading and
 * writing a filter back is idempotent.
 */
function readEnumList(query: QueryRecord, key: string, allowed: readonly string[]): string[] {
  const raw = readParam(query, key);
  if (!raw) return [];
  const wanted = new Set(
    raw
      .split(",")
      .map((part) => part.trim().toLowerCase())
      .filter(Boolean),
  );
  return allowed.filter((value) => wanted.has(value));
}

/** An instant the browser can parse, normalised to ISO; "" when unusable. */
function readInstant(query: QueryRecord, key: string): string {
  const raw = readParam(query, key);
  if (!raw) return "";
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? "" : new Date(ms).toISOString();
}

/**
 * Read the filter state out of a route query.
 *
 * Every field is validated rather than trusted, so a hand-edited or stale link
 * renders a correct screen instead of an empty one or a rejected request.
 */
export function readConnTraceFilters(query: QueryRecord): ConnTraceFilters {
  const rangeRaw = readParam(query, PARAM.range).toLowerCase();
  const range = (TRACE_RANGES as readonly string[]).includes(rangeRaw)
    ? (rangeRaw as TraceRange)
    : DEFAULT_TRACE_RANGE;

  return {
    range,
    since: range === "custom" ? readInstant(query, PARAM.since) : "",
    until: range === "custom" ? readInstant(query, PARAM.until) : "",
    nodeId: readParam(query, PARAM.nodeId),
    userId: readParam(query, PARAM.userId),
    lineUuid: readParam(query, PARAM.lineUuid),
    sessionId: readParam(query, PARAM.sessionId),
    dst: readParam(query, PARAM.dst),
    closeReasons: readEnumList(query, PARAM.closeReasons, CLOSE_REASONS),
    userKinds: readEnumList(query, PARAM.userKinds, USER_KINDS),
    stalledOnly: readFlag(query, PARAM.stalledOnly),
    includeOpen: readFlag(query, PARAM.includeOpen),
  };
}

/**
 * Merge the filter state into an existing route query.
 *
 * Keys owned by these filters are set when they differ from the default and
 * deleted when they do not; every other key is carried through untouched, so
 * the filter bar never clobbers the table's own sort or the tab selection.
 * Same contract as writeTableUrlState, which owns the table half of the URL.
 */
export function writeConnTraceFilters(
  query: QueryRecord,
  filters: ConnTraceFilters,
): Record<string, QueryValue> {
  const owned = new Set<string>(CONN_TRACE_PARAMS);
  const next: Record<string, QueryValue> = {};

  for (const [key, value] of Object.entries(query)) {
    if (owned.has(key) || value === undefined) continue;
    next[key] = value;
  }

  if (filters.range !== DEFAULT_TRACE_RANGE) next[PARAM.range] = filters.range;
  if (filters.range === "custom") {
    if (filters.since) next[PARAM.since] = filters.since;
    if (filters.until) next[PARAM.until] = filters.until;
  }
  if (filters.nodeId) next[PARAM.nodeId] = filters.nodeId;
  if (filters.userId) next[PARAM.userId] = filters.userId;
  if (filters.lineUuid) next[PARAM.lineUuid] = filters.lineUuid;
  if (filters.sessionId) next[PARAM.sessionId] = filters.sessionId;
  if (filters.dst) next[PARAM.dst] = filters.dst;
  if (filters.closeReasons.length) next[PARAM.closeReasons] = filters.closeReasons.join(",");
  if (filters.userKinds.length) next[PARAM.userKinds] = filters.userKinds.join(",");
  if (filters.stalledOnly) next[PARAM.stalledOnly] = "true";
  if (filters.includeOpen) next[PARAM.includeOpen] = "true";

  return next;
}

/** True when two filter states would produce the same query. Guards redundant navigations. */
export function connTraceFiltersEqual(a: ConnTraceFilters, b: ConnTraceFilters): boolean {
  return (
    a.range === b.range &&
    a.since === b.since &&
    a.until === b.until &&
    a.nodeId === b.nodeId &&
    a.userId === b.userId &&
    a.lineUuid === b.lineUuid &&
    a.sessionId === b.sessionId &&
    a.dst === b.dst &&
    a.stalledOnly === b.stalledOnly &&
    a.includeOpen === b.includeOpen &&
    a.closeReasons.join(",") === b.closeReasons.join(",") &&
    a.userKinds.join(",") === b.userKinds.join(",")
  );
}

/** True when the operator has not narrowed the list away from its default view. */
export function isDefaultConnTraceFilters(filters: ConnTraceFilters): boolean {
  return connTraceFiltersEqual(filters, DEFAULT_CONN_TRACE_FILTERS);
}

/** How many filter dimensions are currently constraining the list. */
export function activeFilterCount(filters: ConnTraceFilters): number {
  let count = 0;
  if (filters.range !== DEFAULT_TRACE_RANGE) count++;
  if (filters.nodeId) count++;
  if (filters.userId) count++;
  if (filters.lineUuid) count++;
  if (filters.sessionId) count++;
  if (filters.dst) count++;
  if (filters.closeReasons.length) count++;
  if (filters.userKinds.length) count++;
  if (filters.stalledOnly) count++;
  if (filters.includeOpen) count++;
  return count;
}

/**
 * Resolve the window into the instants the request carries.
 *
 * A preset is resolved against `nowMs` at request time, never stored, so a
 * link that says "last hour" keeps meaning the last hour when someone opens it
 * tomorrow. A custom window is absolute and means the same thing forever.
 */
export function resolveTraceWindow(
  filters: ConnTraceFilters,
  nowMs: number,
): { since: string; until: string } {
  if (filters.range === "custom") {
    return { since: filters.since, until: filters.until };
  }
  const seconds = RANGE_SECONDS[filters.range];
  return { since: new Date(nowMs - seconds * 1000).toISOString(), until: "" };
}

export interface ConnTraceRequestOptions {
  limit: number;
  /** Keyset cursor from the previous page; omitted for the newest page. */
  cursor?: string;
  nowMs: number;
}

/**
 * Build the query the connections endpoint takes. Multi-value dimensions are
 * comma-joined per the contract; empty values are omitted entirely so the
 * server sees "no constraint" rather than "match the empty string".
 */
export function connectionsRequestParams(
  filters: ConnTraceFilters,
  opts: ConnTraceRequestOptions,
): Record<string, string | number> {
  const window = resolveTraceWindow(filters, opts.nowMs);
  const params: Record<string, string | number> = { limit: opts.limit };

  if (window.since) params.since = window.since;
  if (window.until) params.until = window.until;
  if (filters.nodeId) params.node_id = filters.nodeId;
  if (filters.userId) params.user_id = filters.userId;
  if (filters.lineUuid) params.line_uuid = filters.lineUuid;
  if (filters.sessionId) params.session_id = filters.sessionId;
  if (filters.dst) params.dst = filters.dst;
  if (filters.closeReasons.length) params.close_reason = filters.closeReasons.join(",");
  if (filters.userKinds.length) params.user_kind = filters.userKinds.join(",");
  if (filters.stalledOnly) params.stalled = "true";
  if (filters.includeOpen) params.include_open = "true";
  if (opts.cursor) params.cursor = opts.cursor;

  return params;
}

/* ------------------------------------------------------------------ */
/* Close reason                                                        */
/* ------------------------------------------------------------------ */

export type TraceTone = "success" | "warning" | "destructive" | "secondary" | "info" | "outline";

export interface CloseReasonDisplay {
  /** Canonical id, or "unknown" for anything this build does not recognise. */
  id: string;
  labelKey: string;
  tone: TraceTone;
  /**
   * False when the record does not actually say how the connection ended.
   * The view owes the operator a sentence saying so rather than a chip that
   * reads like a result.
   */
  certain: boolean;
  /** What the server sent, kept when it was not a value this build knows. */
  raw: string;
}

/**
 * Colour is semantic, and "unknown" is the case that matters.
 *
 * An absent or unrecognised close reason means the stream ended or the
 * connection never produced a terminal line. Rendering that in the same green
 * as a completed transfer would turn a gap in the evidence into a clean
 * result, so it gets the neutral outline chip and `certain: false`.
 */
export function closeReasonDisplay(raw?: string): CloseReasonDisplay {
  const value = (raw ?? "").trim().toLowerCase();
  const known = (CLOSE_REASONS as readonly string[]).includes(value);
  const id = known ? value : "unknown";
  return {
    id,
    labelKey: `platform.trace.closeReason.${id}`,
    tone: CLOSE_REASON_TONE[id] ?? "outline",
    certain: id !== "unknown",
    raw: known ? value : (raw ?? "").trim(),
  };
}

const CLOSE_REASON_TONE: Record<string, TraceTone> = {
  eof: "success",
  canceled: "secondary",
  udp_idle: "secondary",
  reset: "warning",
  timeout: "warning",
  core_restart: "warning",
  dial_failed: "destructive",
  auth_failed: "destructive",
  handshake_failed: "destructive",
  unknown: "outline",
  open: "info",
};

/**
 * The chip one row renders.
 *
 * A still-open connection has not ended, so it gets its own state rather than
 * borrowing "unknown": nothing is missing, it simply has not happened yet.
 */
export function connCloseCell(record: ConnRecord): CloseReasonDisplay {
  if (record.open) {
    return {
      id: "open",
      labelKey: "platform.trace.closeReason.open",
      tone: "info",
      certain: true,
      raw: "",
    };
  }
  return closeReasonDisplay(record.close_reason);
}

/* ------------------------------------------------------------------ */
/* User attribution                                                    */
/* ------------------------------------------------------------------ */

export interface UserCellDisplay {
  /** One of USER_KINDS, or "unknown" when the record carries no kind. */
  kind: string;
  kindLabelKey: string;
  /** What to render as the user. Empty when nothing at all was logged. */
  primary: string;
  /** True when `primary` is an identifier rather than a human name. */
  monospace: boolean;
  /** True when the row shows a user this console actually resolved. */
  resolved: boolean;
  /** True when the row must carry a marker saying it could not be resolved. */
  marker: boolean;
  /**
   * The Lattice user id. For the detail panel only: a uuid is not a user, and
   * a row that printed one would read as an identity nobody can recognise.
   */
  userId: string;
}

/**
 * Resolve the user cell.
 *
 * `names` is an optional Lattice user-id to display-name map, which the screen
 * only has when the operator also holds `user:admin`. Without it a managed
 * connection still shows the `u_<hex>` name sing-box logged, which is real
 * evidence, rather than the uuid, which is not something an operator knows.
 */
export function userCellDisplay(
  record: ConnRecord,
  names?: ReadonlyMap<string, string>,
): UserCellDisplay {
  const rawKind = (record.user_kind ?? "").trim().toLowerCase();
  const kind = (USER_KINDS as readonly string[]).includes(rawKind) ? rawKind : "unknown";
  const userId = (record.user_id ?? "").trim();
  const userName = (record.user_name ?? "").trim();
  const directoryName = kind === "managed" && userId ? (names?.get(userId) ?? "") : "";

  const primary = directoryName || userName;
  const resolved = kind === "managed" && primary !== "";

  return {
    kind,
    kindLabelKey: `platform.trace.userKind.${kind}`,
    primary,
    monospace: primary !== "" && primary === userName,
    resolved,
    marker: !resolved,
    userId,
  };
}

/* ------------------------------------------------------------------ */
/* Bytes                                                               */
/* ------------------------------------------------------------------ */

/** i18n key rendered in place of a number the agent never measured. */
export const TRACE_BYTES_UNKNOWN_KEY = "platform.trace.bytesNotSampled";
/** i18n key for the tooltip explaining why there is no number. */
export const TRACE_BYTES_UNKNOWN_HINT_KEY = "platform.trace.bytesNotSampledHint";

export interface TraceBytesCell {
  /** False when the counters were never sampled for this connection. */
  known: boolean;
  /** Formatted size. Empty when `known` is false; there is no number to show. */
  text: string;
  /** i18n key the view renders instead of `text`. Empty when `known` is true. */
  i18nKey: string;
}

/**
 * Format a byte counter, keeping unknown and zero apart.
 *
 * A measured zero is a fact and prints as "0 B". An unsampled counter is a gap
 * and prints as words. These are different answers to different questions, and
 * collapsing them is the one regression this screen cannot ship with: an
 * operator reading 0 concludes the connection carried nothing, when the truth
 * is that nobody looked.
 */
export function traceBytesCell(bytes: number | undefined, known: boolean | undefined): TraceBytesCell {
  if (!known) return { known: false, text: "", i18nKey: TRACE_BYTES_UNKNOWN_KEY };
  return { known: true, text: formatBytes(bytes ?? 0), i18nKey: "" };
}

/**
 * Total bytes over a set of records, and how many of them were measured.
 *
 * The count is returned alongside the sum because a total drawn from three of
 * two hundred records is not a total anyone should read as one.
 */
export function traceBytesCoverage(records: readonly ConnRecord[]): {
  upload: number;
  download: number;
  measured: number;
  total: number;
} {
  let upload = 0;
  let download = 0;
  let measured = 0;
  for (const record of records) {
    if (!record.bytes_known) continue;
    measured++;
    upload += record.upload ?? 0;
    download += record.download ?? 0;
  }
  return { upload, download, measured, total: records.length };
}

/* ------------------------------------------------------------------ */
/* Hop path confidence                                                 */
/* ------------------------------------------------------------------ */

export const HOP_CONFIDENCES = ["exact", "inferred", "ambiguous", "none"] as const;

export interface HopConfidenceDisplay {
  id: string;
  /** Short label for the badge. */
  labelKey: string;
  /** Full sentence saying, in words, how much of this path is a guess. */
  wordingKey: string;
  tone: TraceTone;
  /** True only for a path an identity carried end to end. */
  exact: boolean;
  /** True when the stitcher could not choose and the candidates must be listed. */
  ambiguous: boolean;
}

const HOP_TONE: Record<string, TraceTone> = {
  exact: "success",
  inferred: "warning",
  ambiguous: "warning",
  none: "outline",
  unknown: "outline",
};

/**
 * Turn a stitch confidence into words.
 *
 * Anything short of "exact" is a join this console inferred, and the detail
 * panel says which one plainly. An unrecognised value maps to its own
 * "unknown" wording rather than to "none", because silently downgrading an
 * unfamiliar server value would present a guess as a measurement.
 */
export function hopConfidenceDisplay(raw?: string): HopConfidenceDisplay {
  const value = (raw ?? "").trim().toLowerCase();
  const id = (HOP_CONFIDENCES as readonly string[]).includes(value) ? value : "unknown";
  return {
    id,
    labelKey: `platform.trace.hopConfidence.${id}`,
    wordingKey: `platform.trace.hopConfidence.${id}Wording`,
    tone: HOP_TONE[id] ?? "outline",
    exact: id === "exact",
    ambiguous: id === "ambiguous",
  };
}

/* ------------------------------------------------------------------ */
/* Sessions                                                            */
/* ------------------------------------------------------------------ */

/** Server default when a session is started without a TTL. */
export const TRACE_TTL_DEFAULT_SECONDS = 900;
/**
 * Shortest capture worth starting. The contract pins only the default and the
 * ceiling; anything under a minute expires before the agent has polled its
 * config, so the session would look started and capture nothing.
 */
export const TRACE_TTL_MIN_SECONDS = 60;
/** Hard ceiling, enforced by the server and the agent independently. */
export const TRACE_TTL_MAX_SECONDS = 7200;

/**
 * Clamp a TTL to what the server will accept.
 *
 * Anything unusable (blank, not a number, zero or negative) becomes the
 * default rather than the floor: the operator expressed no opinion, so the
 * screen gives them the documented default instead of the shortest capture it
 * could get away with.
 */
export function clampTraceTtlSeconds(value: unknown): number {
  const seconds = typeof value === "number" ? value : Number(String(value ?? "").trim());
  if (!Number.isFinite(seconds) || seconds <= 0) return TRACE_TTL_DEFAULT_SECONDS;
  if (seconds < TRACE_TTL_MIN_SECONDS) return TRACE_TTL_MIN_SECONDS;
  if (seconds > TRACE_TTL_MAX_SECONDS) return TRACE_TTL_MAX_SECONDS;
  return Math.floor(seconds);
}

/* ------------------------------------------------------------------ */
/* Keyset paging                                                       */
/* ------------------------------------------------------------------ */

/**
 * The join key for one connection.
 *
 * sing-box's log id is a uint32 drawn from rand: unique enough inside one
 * process lifetime and nowhere else. It identifies a record only together with
 * the node and the core generation, which is why the key is a triple.
 */
/**
 * The full identity of a connection record.
 *
 * started_at is part of it. sing-box's log id is rand.Uint32, so one core
 * generation on one node can reuse it, and the server deliberately keeps both
 * connections. A key without the start time makes the second row replace the
 * first while paging, so a connection silently disappears from the table.
 */
export function connRecordKey(record: ConnRecord): string {
  return `${record.node_id}:${record.core_generation ?? 0}:${record.log_id}:${record.started_at ?? ""}`;
}

export interface ConnTracePage {
  records?: ConnRecord[];
  next_cursor?: string;
}

export interface ConnTracePaging {
  records: ConnRecord[];
  /** Cursor for the next older page; empty when there is none. */
  cursor: string;
  /** True once the server stopped handing back a cursor. */
  exhausted: boolean;
}

export function emptyConnTracePaging(): ConnTracePaging {
  return { records: [], cursor: "", exhausted: false };
}

/**
 * Append a keyset page to what is already on screen.
 *
 * A record that arrives again replaces the copy already held, in place, rather
 * than being appended or dropped. Both matter: an open connection is delivered
 * as a snapshot that a later page supersedes with the final record, so keeping
 * the first copy would freeze a row that has since closed, and appending the
 * second would show one connection twice. Order is the server's, which is the
 * order the keyset cursor walks.
 */
export function appendConnPage(state: ConnTracePaging, page: ConnTracePage): ConnTracePaging {
  const records = [...state.records];
  const index = new Map<string, number>();
  records.forEach((record, at) => index.set(connRecordKey(record), at));

  for (const record of page.records ?? []) {
    const key = connRecordKey(record);
    const at = index.get(key);
    if (at === undefined) {
      index.set(key, records.length);
      records.push(record);
    } else {
      records[at] = record;
    }
  }

  const cursor = (page.next_cursor ?? "").trim();
  return { records, cursor, exhausted: cursor === "" };
}

/* ------------------------------------------------------------------ */
/* Small row helpers                                                   */
/* ------------------------------------------------------------------ */

/** True when the agent saw a connection go quiet in both directions. */
export function isStalled(record: ConnRecord): boolean {
  return Boolean(record.stalled_at);
}

/** Destination as it should read in one cell: what was logged, then the port. */
export function destinationText(record: ConnRecord): string {
  const host = (record.dst_host || record.dst_ip || "").trim();
  if (!host) return "";
  return record.dst_port ? `${host}:${record.dst_port}` : host;
}

export interface TraceDurationCell {
  known: boolean;
  text: string;
}

/**
 * Duration from sing-box's own elapsed counter. Absent for a connection that
 * never produced a terminal line, which is a gap and reads as one.
 */
export function traceDurationCell(ms: number | undefined): TraceDurationCell {
  if (ms === undefined || ms === null || !Number.isFinite(ms) || ms < 0) {
    return { known: false, text: "" };
  }
  if (ms < 1000) return { known: true, text: `${Math.round(ms)} ms` };
  return { known: true, text: formatDuration(ms / 1000) };
}
