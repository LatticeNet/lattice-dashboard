/**
 * Pure model for the Evidence area: its three layers and where old links land,
 * the one query field and its tokens, the per-node coverage an Overview leads
 * with, and the last-hour summary drawn from records the connections endpoint
 * already returns. Kept free of Vue so `node --test` covers it directly (house
 * *Model.ts pattern).
 *
 * The layering (design 22, section 7): Overview says what is being collected
 * and offers the one action that changes it, Explore asks one question of
 * what was collected, Collection holds the per-node policy and the capture
 * history. Every filter stays in the address bar under the names the HTTP
 * contract uses (connTraceModel owns those); the field is a rendering of them.
 */
import type { QueryRecord, QueryValue } from "@/components/common/tableUrlState";
import type {
  ConnRecord,
  LogSource,
  LogSourceStatsView,
  TraceCollectorState,
  TraceCollectorView,
  TracePolicy,
  TraceSession,
  TraceSessionCreateRequest,
  TraceStatsResponse,
} from "@/lib/api/types";
import {
  CLOSE_REASONS,
  CONN_TRACE_PARAMS,
  USER_KINDS,
  readConnTraceFilters,
  writeConnTraceFilters,
  type ConnTraceFilters,
} from "./connTraceModel.ts";
import {
  formatTokens,
  parseTokens,
  scanQueryWords,
  splitTokenList,
  type QueryWord,
  type TokenGrammar,
  type TokenProblem,
  type TokenProblemKind,
  type TokenResolvers,
  type TokenValues,
} from "../../lib/queryTokens.ts";

/* ------------------------------------------------------------------ */
/* Layers and lenses                                                   */
/* ------------------------------------------------------------------ */

export const EVIDENCE_LAYERS = ["overview", "explore", "collection"] as const;
export type EvidenceLayer = (typeof EVIDENCE_LAYERS)[number];

export const EVIDENCE_LENSES = ["connections", "log"] as const;
export type EvidenceLens = (typeof EVIDENCE_LENSES)[number];

/** Query keys the area owns besides the connection filters. */
export const EVIDENCE_PARAM = {
  layer: "view",
  lens: "lens",
  /** Free text: a substring for the raw log, a row search for connections. */
  text: "q",
  /** The raw log source the log lens reads. */
  source: "source",
  /** The connection open in the side panel, as connRecordKey spells it. */
  conn: "conn",
  /** The inner tab of the old Connections lens; read once, never written. */
  legacyTab: "tab",
} as const;

/**
 * Keys that only mean something inside Explore. A link carrying any of them
 * without saying which layer it wants was made for the old page, where these
 * filtered the table the page opened on, so it lands in Explore.
 */
export const EVIDENCE_EXPLORE_PARAMS: readonly string[] = [
  ...CONN_TRACE_PARAMS,
  EVIDENCE_PARAM.lens,
  EVIDENCE_PARAM.text,
  EVIDENCE_PARAM.source,
  EVIDENCE_PARAM.conn,
];

function readParam(query: QueryRecord, key: string): string {
  const raw = query[key];
  const value = Array.isArray(raw) ? raw.find((entry) => typeof entry === "string") : raw;
  return typeof value === "string" ? value.trim() : "";
}

function hasExploreParams(query: QueryRecord): boolean {
  return EVIDENCE_EXPLORE_PARAMS.some((key) => readParam(query, key) !== "");
}

/**
 * The old Connections lens had its own tab row: connections, sessions,
 * policy. Sessions and policy became the Collection layer, connections became
 * Explore. vpn-core may still send `tab`, since its allowlist entry names it.
 */
const LEGACY_TAB_LAYER: Record<string, EvidenceLayer> = {
  connections: "explore",
  sessions: "collection",
  policy: "collection",
};

/**
 * Which layer a query asks for.
 *
 * An explicit `view` wins. Without one, the old inner tab decides, then any
 * Explore parameter, and only a query that names nothing lands on Overview.
 * That order keeps every link the console and vpn-core ever minted working:
 * `?node_id=n` (vpn-core's Connections link) opens Explore on that node,
 * `?lens=log` (the /platform/logs redirect) opens the raw log, and
 * `?tab=policy` opens Collection.
 */
export function resolveEvidenceLayer(query: QueryRecord): EvidenceLayer {
  const view = readParam(query, EVIDENCE_PARAM.layer).toLowerCase();
  if ((EVIDENCE_LAYERS as readonly string[]).includes(view)) return view as EvidenceLayer;
  const legacy = LEGACY_TAB_LAYER[readParam(query, EVIDENCE_PARAM.legacyTab).toLowerCase()];
  if (legacy) return legacy;
  return hasExploreParams(query) ? "explore" : "overview";
}

export function resolveEvidenceLens(query: QueryRecord): EvidenceLens {
  return readParam(query, EVIDENCE_PARAM.lens).toLowerCase() === "log" ? "log" : "connections";
}

/**
 * The canonical spelling of an Evidence query.
 *
 * The layer is written out whenever leaving it off would resolve to a
 * different one: Overview is the bare URL only when no Explore parameter is
 * present, so an operator who steps from Explore to Overview keeps the
 * question in the address bar and gets it back on return. The legacy `tab`
 * is dropped once read, and the default lens is never spelled. Idempotent,
 * so the view may apply it on every navigation without looping.
 */
export function normalizeEvidenceQuery(query: QueryRecord): Record<string, QueryValue> {
  const layer = resolveEvidenceLayer(query);
  const lens = resolveEvidenceLens(query);
  const next: Record<string, QueryValue> = {};
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    if (key === EVIDENCE_PARAM.layer || key === EVIDENCE_PARAM.legacyTab || key === EVIDENCE_PARAM.lens) continue;
    next[key] = value;
  }
  if (lens !== "connections") next[EVIDENCE_PARAM.lens] = lens;
  if (layer !== "overview" || hasExploreParams(next)) next[EVIDENCE_PARAM.layer] = layer;
  return next;
}

/** Move to a layer, keeping everything else in the query. */
export function writeEvidenceLayer(query: QueryRecord, layer: EvidenceLayer): Record<string, QueryValue> {
  return normalizeEvidenceQuery({ ...query, [EVIDENCE_PARAM.layer]: layer, [EVIDENCE_PARAM.legacyTab]: undefined });
}

/** True when two queries carry the same keys and values. Guards redundant replaces. */
export function evidenceQueryEqual(a: QueryRecord, b: QueryRecord): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (JSON.stringify(a[key] ?? null) !== JSON.stringify(b[key] ?? null)) return false;
  }
  return true;
}

/**
 * Where the two retired routes land. /platform/logs was the raw log page and
 * /platform/trace the connections page with its three tabs; both keep their
 * query, so a bookmark still shows the node and filter it named.
 */
export function legacyEvidenceQuery(route: "logs" | "trace", query: QueryRecord): Record<string, QueryValue> {
  if (route === "logs") return normalizeEvidenceQuery({ ...query, [EVIDENCE_PARAM.lens]: "log" });
  return normalizeEvidenceQuery(query);
}

/* ------------------------------------------------------------------ */
/* The query field                                                     */
/* ------------------------------------------------------------------ */

/**
 * Token keys the field understands. A word is a token only when the text
 * before its first colon is one of these, so `example.com:443` and an IPv6
 * address stay free text.
 */
export const EVIDENCE_TOKEN_KEYS = ["node", "user", "line", "dest", "reason", "kind", "session", "source"] as const;
export type EvidenceTokenKey = (typeof EVIDENCE_TOKEN_KEYS)[number];

/** Bare words that switch a flag on. `is:stalled` and `is:open` read the same. */
export const EVIDENCE_TOKEN_FLAGS = ["stalled", "open"] as const;

/** Keys the raw log lens cannot apply; the view says so instead of ignoring them silently. */
export const CONNECTION_ONLY_TOKENS: readonly EvidenceTokenKey[] = ["user", "line", "dest", "reason", "kind", "session"];

/**
 * The field's grammar in the shared token language (src/lib/queryTokens),
 * listed in the order the field writes tokens back. The address bar keeps
 * the HTTP contract's own names (connTraceModel), so this grammar only drives
 * the field; readEvidenceQuery and writeEvidenceQuery own the URL.
 */
export const EVIDENCE_GRAMMAR: TokenGrammar = {
  fields: [
    { key: "node", kind: "list", resolve: "node" },
    { key: "source", kind: "value", resolve: "source" },
    { key: "user", kind: "list", resolve: "user" },
    { key: "line", kind: "list" },
    { key: "session", kind: "list" },
    { key: "dest", kind: "value" },
    { key: "reason", kind: "enum", values: CLOSE_REASONS },
    { key: "kind", kind: "enum", values: USER_KINDS },
  ],
  // `open` is typed as a word, but its parameter is the HTTP contract's
  // `include_open`: `?open=` is the key every page's side sheet owns.
  flags: EVIDENCE_TOKEN_FLAGS.map((name) => (name === "open" ? { name, param: "include_open" } : { name })),
};

/** Everything the one field can say, resolved to the identifiers requests carry. */
export interface EvidenceQuery {
  nodeId: string;
  userId: string;
  lineUuid: string;
  sessionId: string;
  dst: string;
  closeReasons: string[];
  userKinds: string[];
  stalledOnly: boolean;
  includeOpen: boolean;
  sourceId: string;
  text: string;
}

export const EMPTY_EVIDENCE_QUERY: EvidenceQuery = {
  nodeId: "",
  userId: "",
  lineUuid: "",
  sessionId: "",
  dst: "",
  closeReasons: [],
  userKinds: [],
  stalledOnly: false,
  includeOpen: false,
  sourceId: "",
  text: "",
};

/**
 * Names in, identifiers out, and back. An operator types `node:legend-sg`;
 * the request carries the node id. Each resolver returns undefined for a value
 * it does not know, and the parser then keeps the value as typed (it may be an
 * id) and reports it, rather than dropping a filter the operator asked for.
 */
export interface EvidenceTokenResolvers {
  nodeId?: (value: string) => string | undefined;
  nodeLabel?: (id: string) => string;
  userId?: (value: string) => string | undefined;
  userLabel?: (id: string) => string;
  sourceId?: (value: string) => string | undefined;
  sourceLabel?: (id: string) => string;
}

export type EvidenceTokenProblemKind = TokenProblemKind;
export type EvidenceTokenProblem = TokenProblem;

export interface ParsedEvidenceQuery {
  query: EvidenceQuery;
  problems: EvidenceTokenProblem[];
}

/** One word of the field, and how much of it was typed outside quotes. */
export type EvidenceWord = QueryWord;

/** Split the field into words (the shared scanner; see queryTokens). */
export function scanEvidenceQuery(input: string): EvidenceWord[] {
  return scanQueryWords(input);
}

/** The words alone. */
export function tokenizeEvidenceQuery(input: string): string[] {
  return scanQueryWords(input).map((entry) => entry.word);
}

function tokenResolvers(resolvers: EvidenceTokenResolvers): TokenResolvers {
  return {
    node: { toId: resolvers.nodeId, label: resolvers.nodeLabel },
    user: { toId: resolvers.userId, label: resolvers.userLabel },
    source: { toId: resolvers.sourceId, label: resolvers.sourceLabel },
  };
}

function toTokenValues(query: EvidenceQuery): TokenValues {
  const values: Record<string, string> = {};
  if (query.nodeId) values.node = query.nodeId;
  if (query.sourceId) values.source = query.sourceId;
  if (query.userId) values.user = query.userId;
  if (query.lineUuid) values.line = query.lineUuid;
  if (query.sessionId) values.session = query.sessionId;
  if (query.dst) values.dest = query.dst;
  const enums: Record<string, string[]> = {};
  if (query.closeReasons.length) enums.reason = [...query.closeReasons];
  if (query.userKinds.length) enums.kind = [...query.userKinds];
  const flags: string[] = [];
  if (query.stalledOnly) flags.push("stalled");
  if (query.includeOpen) flags.push("open");
  return { values, enums, flags, text: query.text };
}

/**
 * Read the field. Unknown enum values (a close reason this build does not
 * know) are reported and left out, because the server would reject them and
 * a filter nobody can satisfy reads as a quiet network.
 */
export function parseEvidenceQuery(input: string, resolvers: EvidenceTokenResolvers = {}): ParsedEvidenceQuery {
  const parsed = parseTokens(input, EVIDENCE_GRAMMAR, tokenResolvers(resolvers));
  return {
    query: {
      nodeId: parsed.values.node ?? "",
      userId: parsed.values.user ?? "",
      lineUuid: parsed.values.line ?? "",
      sessionId: parsed.values.session ?? "",
      dst: parsed.values.dest ?? "",
      closeReasons: parsed.enums.reason ?? [],
      userKinds: parsed.enums.kind ?? [],
      stalledOnly: parsed.flags.includes("stalled"),
      includeOpen: parsed.flags.includes("open"),
      sourceId: parsed.values.source ?? "",
      text: parsed.text,
    },
    problems: parsed.problems,
  };
}

/**
 * Write the field. Identifiers the console can name are shown by name, so
 * the field reads the way the operator would have typed it, and parsing it
 * back with the same resolvers yields the same query.
 */
export function formatEvidenceQuery(query: EvidenceQuery, resolvers: EvidenceTokenResolvers = {}): string {
  return formatTokens(toTokenValues(query), EVIDENCE_GRAMMAR, tokenResolvers(resolvers));
}

/**
 * The tokens of an applied query whose names no resolver turned into an id,
 * spelled as the field shows them. The search sent those values as typed:
 * with the lists loaded that means the name matches nothing known, and with
 * a list missing it means the name was never looked up.
 */
export function unresolvedEvidenceTokens(query: EvidenceQuery, resolvers: EvidenceTokenResolvers = {}): string[] {
  return parseEvidenceQuery(formatEvidenceQuery(query, resolvers), resolvers)
    .problems.filter((problem) => problem.kind === "unresolved")
    .map((problem) => problem.token);
}

/** The field's state as the address bar holds it. */
export function readEvidenceQuery(query: QueryRecord): EvidenceQuery {
  const filters = readConnTraceFilters(query);
  return {
    nodeId: filters.nodeId,
    userId: filters.userId,
    lineUuid: filters.lineUuid,
    sessionId: filters.sessionId,
    dst: filters.dst,
    closeReasons: filters.closeReasons,
    userKinds: filters.userKinds,
    stalledOnly: filters.stalledOnly,
    includeOpen: filters.includeOpen,
    sourceId: readParam(query, EVIDENCE_PARAM.source),
    text: readParam(query, EVIDENCE_PARAM.text),
  };
}

/**
 * Put the field's state into the address bar. The time range is not the
 * field's; it is carried from `range` (the toolbar's own control), so a
 * query change never resets the window.
 */
export function writeEvidenceQuery(
  query: QueryRecord,
  next: EvidenceQuery,
  range: Pick<ConnTraceFilters, "range" | "since" | "until"> = readConnTraceFilters(query),
): Record<string, QueryValue> {
  const filters: ConnTraceFilters = {
    range: range.range,
    since: range.since,
    until: range.until,
    nodeId: next.nodeId,
    userId: next.userId,
    lineUuid: next.lineUuid,
    sessionId: next.sessionId,
    dst: next.dst,
    closeReasons: [...next.closeReasons],
    userKinds: [...next.userKinds],
    stalledOnly: next.stalledOnly,
    includeOpen: next.includeOpen,
  };
  const written = writeConnTraceFilters(query, filters);
  delete written[EVIDENCE_PARAM.source];
  delete written[EVIDENCE_PARAM.text];
  if (next.sourceId) written[EVIDENCE_PARAM.source] = next.sourceId;
  if (next.text) written[EVIDENCE_PARAM.text] = next.text;
  return written;
}

/** True when the field says nothing: no token and no text. */
export function isEmptyEvidenceQuery(query: EvidenceQuery): boolean {
  return formatEvidenceQuery(query) === "";
}

/** Tokens present that the raw log lens cannot apply, for the one sentence that says so. */
export function connectionOnlyTokens(query: EvidenceQuery): EvidenceTokenKey[] {
  const out: EvidenceTokenKey[] = [];
  if (query.userId) out.push("user");
  if (query.lineUuid) out.push("line");
  if (query.dst) out.push("dest");
  if (query.closeReasons.length) out.push("reason");
  if (query.userKinds.length) out.push("kind");
  if (query.sessionId) out.push("session");
  return out;
}

/**
 * Free text over the fields a connection row shows. Every word must appear
 * somewhere, case-insensitive: "legend 443" finds a legend-sg row to port 443.
 */
export function connMatchesText(fields: readonly string[], text: string): boolean {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = fields.join(" ").toLowerCase();
  return words.every((word) => haystack.includes(word));
}

/* ------------------------------------------------------------------ */
/* The side panel address                                              */
/* ------------------------------------------------------------------ */

export interface ConnKeyParts {
  node_id: string;
  core_generation: number;
  log_id: number;
  started_at: string;
}

/**
 * Read `?conn=` back into the key the hops endpoint takes. connRecordKey
 * spells it node:generation:log:started_at, and the start time carries colons
 * of its own, so only the first three separators split.
 */
export function parseConnKey(raw: string): ConnKeyParts | null {
  const parts = raw.trim().split(":");
  if (parts.length < 4) return null;
  const [node, generation, log, ...rest] = parts;
  const core = Number(generation);
  const logId = Number(log);
  if (!node || !Number.isInteger(core) || core < 0 || !Number.isInteger(logId) || logId < 0) return null;
  const startedAt = rest.join(":");
  return { node_id: node, core_generation: core, log_id: logId, started_at: startedAt };
}

/* ------------------------------------------------------------------ */
/* Coverage                                                            */
/* ------------------------------------------------------------------ */

/** A raw log source is stale when its node has not shipped a line for this long. */
export const RAW_LOG_STALE_MS = 24 * 3_600_000;

function instantMs(value?: string): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  // Go's zero time arrives as year 1 on a source that never shipped a line.
  if (Number.isNaN(ms) || ms <= 0) return undefined;
  return ms;
}

export interface CoverageSource {
  id: string;
  name: string;
  enabled: boolean;
  /** Lines held; undefined when stats were not read. */
  lines?: number;
  /** Last ingest, "" when the source never shipped a line. */
  lastIngestAt: string;
  /** No line for longer than RAW_LOG_STALE_MS, or never one at all. */
  stale: boolean;
}

export interface CoverageRow {
  nodeId: string;
  name: string;
  /** The stored policy; undefined when the policy list did not include this node. */
  trace?: { enabled: boolean; level: string };
  /** Running captures that include this node. */
  capturing: number;
  /** When the soonest of those captures ends, "" when none runs. */
  captureEndsAt: string;
  sources: CoverageSource[];
  /** False when the source list was not read; an empty `sources` then means unknown, not none. */
  sourcesKnown: boolean;
  /** Lines held across the node's sources; undefined when any count is unread. */
  heldLines?: number;
  /** Connections this node recorded in the last-hour sample; undefined when no sample was read. */
  lastHour?: number;
  /**
   * The collector's readiness. Undefined when the policy was not read or the
   * server predates readiness (alpha-0.2.2a117 and older): the row then reads
   * as it did before readiness existed.
   */
  readiness?: Readiness;
  /** Raw sing-box lines flow under this policy; undefined from an older server. */
  rawLines?: boolean;
  /**
   * Trace read as off, no capture, the source list read and empty, nothing
   * held: the row says nothing new. A row whose policy or sources were not
   * read is never quiet, because "off" and "none" would then be guesses.
   */
  quiet: boolean;
}

export interface CoverageInput {
  nodes: readonly { id: string; name?: string }[];
  /** undefined when the policy list was not read. */
  policies?: readonly TracePolicy[];
  sessions: readonly TraceSession[];
  sources: readonly LogSource[];
  /** False when the source list failed or has not loaded. Defaults to true. */
  sourcesKnown?: boolean;
  /** The server runs without a trace store (503), so no node can trace whatever its policy says. */
  traceUnavailable?: boolean;
  stats: readonly LogSourceStatsView[];
  lastHourByNode?: ReadonlyMap<string, number>;
  nowMs: number;
}

/**
 * A capture that is still collecting: running and not past its deadline. The
 * server counts the same way (ActiveTraceSessions(now)); a session the last
 * poll reported as running may have expired since.
 */
export function isActiveSession(session: TraceSession, nowMs: number): boolean {
  if (session.state !== "running") return false;
  const ends = Date.parse(session.expires_at);
  return Number.isNaN(ends) || ends > nowMs;
}

/** Running sessions that include a node. An empty node list is the whole fleet. */
export function sessionCoversNode(session: TraceSession, nodeId: string): boolean {
  if (session.state !== "running") return false;
  const targets = session.filter?.node_ids ?? [];
  return targets.length === 0 || targets.includes(nodeId);
}

/**
 * One row per node the operator may see: its trace policy, the captures that
 * include it, its raw log sources with their freshness, and what is held.
 *
 * The node set is the policy list (one row per node the caller holds log:read
 * for, the fleet whose evidence this page can show) with the node list and the
 * source list folded in, so a node with a source but no policy row still
 * appears. Nodes that are doing something sort first.
 */
export function evidenceCoverageRows(input: CoverageInput): CoverageRow[] {
  const names = new Map<string, string>();
  for (const node of input.nodes) names.set(node.id, node.name || node.id);

  const ids: string[] = [];
  const seen = new Set<string>();
  const add = (id: string) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    ids.push(id);
  };
  if (input.policies) for (const policy of input.policies) add(policy.node_id);
  else for (const node of input.nodes) add(node.id);
  for (const source of input.sources) add(source.node_id);

  const policyBy = new Map<string, TracePolicy>();
  for (const policy of input.policies ?? []) policyBy.set(policy.node_id, policy);
  const statsBy = new Map<string, LogSourceStatsView>();
  for (const entry of input.stats) statsBy.set(entry.source_id, entry);
  const running = input.sessions.filter((session) => isActiveSession(session, input.nowMs));

  const rows = ids.map<CoverageRow>((nodeId) => {
    const policy = policyBy.get(nodeId);
    const covering = running.filter((session) => sessionCoversNode(session, nodeId));
    const ends = covering
      .map((session) => session.expires_at)
      .filter(Boolean)
      .sort();
    const sources = input.sources
      .filter((source) => source.node_id === nodeId)
      .map<CoverageSource>((source) => {
        const stat = statsBy.get(source.id);
        const last = instantMs(stat?.last_ingest_at);
        return {
          id: source.id,
          name: source.name || source.id,
          enabled: source.enabled,
          lines: stat?.lines,
          lastIngestAt: last === undefined ? "" : (stat?.last_ingest_at ?? ""),
          stale: last === undefined || input.nowMs - last > RAW_LOG_STALE_MS,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    const heldLines = sources.some((source) => source.lines === undefined)
      ? undefined
      : sources.reduce((sum, source) => sum + (source.lines ?? 0), 0);
    const lastHour = input.lastHourByNode ? (input.lastHourByNode.get(nodeId) ?? 0) : undefined;
    const sourcesKnown = input.sourcesKnown ?? true;
    return {
      nodeId,
      name: names.get(nodeId) ?? nodeId,
      trace: policy ? { enabled: policy.enabled, level: policy.level } : undefined,
      capturing: covering.length,
      captureEndsAt: ends[0] ?? "",
      sources,
      sourcesKnown,
      heldLines: sourcesKnown ? heldLines : undefined,
      lastHour,
      readiness: collectorReadiness(policy, covering.length),
      rawLines: policy?.raw_effective,
      quiet: (policy?.enabled === false || input.traceUnavailable === true) && sourcesKnown && covering.length === 0 && sources.length === 0 && !lastHour,
    };
  });

  // Nodes switched on but not recording lead: they are the rows that need
  // someone (design 26, section 4.2), ahead of captures that are working.
  const rank = (row: CoverageRow) =>
    readinessNeedsAttention(row)
      ? 0
      : row.capturing > 0
        ? 1
        : row.trace?.enabled
          ? 2
          : (row.lastHour ?? 0) > 0
            ? 3
            : row.sources.length > 0
              ? 4
              : 5;
  return rows.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

/**
 * The node is recording connection records. With readiness reported, that is
 * a ready collector, not a switch that is on: a node switched on without a
 * Clash API records nothing. From an older server, which reports no
 * readiness, it stays what it was: policy on, or inside a running capture.
 */
export function isRecordingRow(row: Pick<CoverageRow, "trace" | "capturing" | "readiness">): boolean {
  if (!row.readiness) return !!row.trace?.enabled || row.capturing > 0;
  return row.readiness.kind === "ready";
}

/** Nodes recording connection records right now (see isRecordingRow). */
export function collectingNodeCount(rows: readonly CoverageRow[]): number {
  return rows.filter(isRecordingRow).length;
}

/** Nodes that are switched on (or captured) and whose collector is not ready, or not heard from. */
export function notReadyNodeCount(rows: readonly CoverageRow[]): number {
  return rows.filter(readinessNeedsAttention).length;
}

/* ------------------------------------------------------------------ */
/* Collector readiness (design 26, R1)                                 */
/* ------------------------------------------------------------------ */

/** The collector states this console knows (lattice-sdk model.CollectorState). */
export const COLLECTOR_STATES = [
  "off",
  "ready",
  "no_clash_api",
  "secret_unreadable",
  "stream_failing",
  "agent_too_old",
] as const satisfies readonly TraceCollectorState[];

/**
 * The first node-agent version that reports collector status
 * (lattice-server traceCollectorStatusMinAgent). Older agents get a state the
 * server infers, and the console names this version when it says so.
 */
export const COLLECTOR_STATUS_MIN_AGENT = "0.3.10-alpha.4";

/**
 * What the agent's line budget is when a policy says 0: each agent's own
 * default, 500 lines a second up to 0.3.10-alpha.3 and 5,000 from
 * 0.3.10-alpha.4 (design 26, section 4.3).
 */
export const AGENT_DEFAULT_BUDGET_BEFORE = 500;
export const AGENT_DEFAULT_BUDGET_FROM = 5000;

export type Readiness =
  /** Nothing asks this node to collect, and its collector says so. */
  | { kind: "off" }
  /** The /logs stream is open and /connections answers. */
  | { kind: "ready"; level: string }
  /**
   * The collector cannot record. `known` is false for a state string this
   * console does not know; `inferred` when the server worked it out from the
   * agent version rather than hearing it from the agent.
   */
  | { kind: "not_ready"; state: string; known: boolean; detail?: string; inferred: boolean }
  /** The policy or a capture changed after the agent's last report. */
  | { kind: "pending" }
  /** Collection is wanted and the agent has not reported yet. */
  | { kind: "waiting" }
  /** The agent has gone quiet; `last` is what it said before that. */
  | { kind: "stale"; last: Readiness; heardAt: string };

/** The server reports readiness at all: it sends raw_effective (and collector) on every policy. */
export function serverReportsReadiness(policy: TracePolicy | undefined): boolean {
  return !!policy && (typeof policy.raw_effective === "boolean" || isCollectorView(policy.collector));
}

function isCollectorView(value: unknown): value is TraceCollectorView {
  return !!value && typeof value === "object" && typeof (value as TraceCollectorView).state === "string";
}

function isKnownState(state: string): state is TraceCollectorState {
  return (COLLECTOR_STATES as readonly string[]).includes(state);
}

/**
 * One node's readiness, from its policy view and the running captures that
 * cover it. Undefined when the server predates readiness. Never `ready`
 * unless the agent said ready: no report is `waiting`, an unknown state is
 * `not_ready`, and a report from a node gone quiet is `stale`.
 */
export function collectorReadiness(policy: TracePolicy | undefined, capturing: number): Readiness | undefined {
  if (!policy || !serverReportsReadiness(policy)) return undefined;
  const wants = policy.enabled || capturing > 0;
  const report = policy.collector;
  if (!isCollectorView(report) || !report.state) return wants ? { kind: "waiting" } : { kind: "off" };

  let base: Readiness;
  if (report.state === "ready") {
    base = { kind: "ready", level: typeof report.level === "string" && report.level ? report.level : policy.level };
  }
  // An agent that still says off after the change was seen has not picked
  // the policy up from its config poll yet.
  else if (report.state === "off") base = wants ? { kind: "waiting" } : { kind: "off" };
  else {
    base = {
      kind: "not_ready",
      state: report.state,
      known: isKnownState(report.state),
      detail: report.detail || undefined,
      inferred: report.reported_by === "server",
    };
  }
  if (report.stale) {
    // A quiet node that nothing asks to collect is simply off.
    return wants ? { kind: "stale", last: base, heardAt: report.received_at ?? "" } : { kind: "off" };
  }
  if (report.pending) return { kind: "pending" };
  return base;
}

/** Collection is wanted on the row: policy on, or a running capture covers it. */
export function rowWantsCollection(row: Pick<CoverageRow, "trace" | "capturing">): boolean {
  return !!row.trace?.enabled || row.capturing > 0;
}

/**
 * Wanted, and the collector cannot record or has gone quiet: an attention
 * row. An agent too old to report is not one: with a Clash API address in
 * its policy it may well be recording, so it is neither counted as recording
 * nor as not recording, and its row says it cannot tell.
 */
export function readinessNeedsAttention(row: Pick<CoverageRow, "trace" | "capturing" | "readiness">): boolean {
  const r = row.readiness;
  if (!r || !rowWantsCollection(row)) return false;
  return r.kind === "stale" || (r.kind === "not_ready" && r.state !== "agent_too_old");
}

/**
 * After a save, the console re-reads the policy every few seconds while the
 * answer is still on its way from the agent, instead of waiting for the
 * 30 s poll (design 26 R1, questions 14 and 15).
 */
export const READINESS_REPOLL_MS = 3000;
export const READINESS_REPOLL_MAX_MS = 30_000;

export function readinessAwaitsAgent(readiness: Readiness | undefined): boolean {
  return readiness?.kind === "pending" || readiness?.kind === "waiting";
}

/**
 * Connections the budget refused to observe, for the readiness cell's second
 * line. Undefined when none were shed: loss is shown when it happened, not as
 * a standing zero.
 */
export function shedSummary(
  report: TraceCollectorView | undefined,
): { count: number; since: string; budget?: number } | undefined {
  if (!isCollectorView(report)) return undefined;
  const count = Number(report.shed_connections) || 0;
  if (count <= 0) return undefined;
  const budget = Number(report.budget_lines_per_sec) || undefined;
  return { count, since: report.counters_since ?? "", budget };
}

/**
 * The raw-lines checkbox's saved value: the stored switch, else (a policy
 * written before the switch existed) what flows today, which follows records.
 */
export function policyRawDraft(policy: TracePolicy): boolean {
  return policy.raw?.enabled ?? policy.raw_effective ?? false;
}

/**
 * A policy written before the raw switch existed, whose raw lines flow today
 * because records are on. Only such a row says "follows records": a
 * pre-switch row with records off gets records only when switched on (the
 * server materialises raw from the policy as it was), so the label would
 * promise raw lines it will not get.
 */
export function rawFollowsRecords(policy: TracePolicy): boolean {
  return !policy.raw && policy.raw_effective === true;
}

/* ------------------------------------------------------------------ */
/* The store proof line                                                */
/* ------------------------------------------------------------------ */

/** /api/trace/stats, either the full answer or the scoped one a narrow operator gets. */
export type TraceStoreStats = TraceStatsResponse;

export interface StoreProof {
  /** Records held; undefined when neither stats nor a page said. */
  records?: number;
  /** undefined when stats were not read. */
  encrypted?: boolean;
  /** Size cap in bytes; undefined when the answer was scoped or unread. */
  capBytes?: number;
  /** Nodes recording (see isRecordingRow). */
  collecting: number;
  /** Nodes switched on (or captured) whose collector is not ready or not heard from. */
  notReady: number;
  /** Nodes the coverage counts over; undefined while the list is unread. */
  total?: number;
}

/**
 * The numbers the proof line states. The full stats answer covers the whole
 * store and only reaches an operator who sees every node; anyone narrower gets
 * `scoped` and no counts, and then the count comes from the connections page,
 * whose `collected_total` is always over the nodes this caller may see.
 */
export function evidenceStoreProof(input: {
  stats?: TraceStoreStats;
  collectedTotal?: number;
  rows: readonly CoverageRow[];
  coverageKnown: boolean;
}): StoreProof {
  const { stats } = input;
  const full = stats && !stats.scoped;
  return {
    records: full && typeof stats.records === "number" ? stats.records : input.collectedTotal,
    encrypted: stats ? stats.cipher_enabled === true : undefined,
    capBytes: full && stats.max_bytes ? stats.max_bytes : undefined,
    collecting: collectingNodeCount(input.rows),
    notReady: notReadyNodeCount(input.rows),
    total: input.coverageKnown ? input.rows.length : undefined,
  };
}

/* ------------------------------------------------------------------ */
/* The last hour                                                       */
/* ------------------------------------------------------------------ */

/** Close reasons that mean the connection failed; ties in the bars keep this order. */
export const FAILURE_REASONS = [
  "dial_failed",
  "auth_failed",
  "handshake_failed",
  "reset",
  "timeout",
  "core_restart",
] as const;

export interface CountedValue {
  value: string;
  count: number;
}

export interface LastHourSummary {
  /** Records in the sample. */
  total: number;
  /** True when the sample stopped at its cap and the real count is higher. */
  capped: boolean;
  failures: CountedValue[];
  failureTotal: number;
  /** Most frequent destinations, by host without the port. */
  destinations: CountedValue[];
  byNode: Map<string, number>;
}

/** Where a connection went, for grouping: the sniffed name first, then the logged host. */
export function destinationKey(record: ConnRecord): string {
  return (record.sniffed_domain || record.dst_host || record.dst_ip || "").trim().toLowerCase();
}

/**
 * Summarise the last hour from the records the connections endpoint returned
 * for it. The endpoint pages at most 1000 records at a time; when the sample
 * stopped with a cursor still pending, `capped` says the total is a floor.
 */
export function summarizeLastHour(records: readonly ConnRecord[], capped: boolean, topN = 5): LastHourSummary {
  const failures = new Map<string, number>();
  const destinations = new Map<string, number>();
  const byNode = new Map<string, number>();
  for (const record of records) {
    byNode.set(record.node_id, (byNode.get(record.node_id) ?? 0) + 1);
    const reason = (record.close_reason ?? "").trim().toLowerCase();
    if (!record.open && (FAILURE_REASONS as readonly string[]).includes(reason)) {
      failures.set(reason, (failures.get(reason) ?? 0) + 1);
    }
    const dest = destinationKey(record);
    if (dest) destinations.set(dest, (destinations.get(dest) ?? 0) + 1);
  }
  // Most frequent first; ties keep the canonical order.
  const failureList = FAILURE_REASONS.filter((reason) => failures.has(reason))
    .map((reason) => ({ value: reason, count: failures.get(reason) ?? 0 }))
    .sort((a, b) => b.count - a.count);
  const destinationList = [...destinations.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value))
    .slice(0, topN);
  return {
    total: records.length,
    capped,
    failures: failureList,
    failureTotal: failureList.reduce((sum, entry) => sum + entry.count, 0),
    destinations: destinationList,
    byNode,
  };
}

/* ------------------------------------------------------------------ */
/* Capture                                                             */
/* ------------------------------------------------------------------ */

/** Durations the Overview offers, in seconds. The server caps a capture at two hours. */
export const CAPTURE_DURATIONS = [900, 1800, 3600, 7200] as const;
export const DEFAULT_CAPTURE_SECONDS = 3600;

/** Server limits on concurrent captures (server_trace.go), checked here to say why before asking. */
export const MAX_ACTIVE_CAPTURES = 16;
export const MAX_CAPTURES_PER_NODE = 8;

export type CaptureBlock =
  | ""
  | "needs-admin"
  | "store-off"
  | "sessions-unread"
  | "no-nodes"
  | "limit-total"
  | "limit-node";

/**
 * Why the capture action cannot run, or "" when it can. The action stays on
 * screen when blocked and says which of these it is.
 *
 * - needs-admin: a capture reads user traffic metadata and the server gates it
 *   on log:admin for every targeted node.
 * - store-off: the server answered 503, connection tracing is not enabled.
 * - sessions-unread: the capture list has not loaded or failed, so the
 *   server's limits cannot be checked; an unread list is not an empty one.
 * - no-nodes: nothing chosen yet.
 * - limit-total / limit-node: the server would refuse with 409.
 */
export function captureBlock(input: {
  canAdmin: boolean;
  storeReady: boolean;
  nodeIds: readonly string[];
  sessions: readonly TraceSession[];
  /** False while the capture list is loading or after it failed. */
  sessionsKnown: boolean;
  nowMs: number;
}): CaptureBlock {
  if (!input.canAdmin) return "needs-admin";
  if (!input.storeReady) return "store-off";
  if (!input.sessionsKnown) return "sessions-unread";
  if (input.nodeIds.length === 0) return "no-nodes";
  const running = input.sessions.filter((session) => isActiveSession(session, input.nowMs));
  if (running.length >= MAX_ACTIVE_CAPTURES) return "limit-total";
  for (const nodeId of input.nodeIds) {
    const count = running.filter((session) => (session.filter?.node_ids ?? []).includes(nodeId)).length;
    if (count >= MAX_CAPTURES_PER_NODE) return "limit-node";
  }
  return "";
}

/**
 * The nodes a capture starts with when the page was opened on a question
 * (`?node_id=`): only ids the operator can actually choose, once each, so a
 * stale or foreign id in the address bar never becomes a capture target.
 */
export function seedCaptureNodes(nodeParam: string, choices: readonly { id: string }[]): string[] {
  const known = new Set(choices.map((choice) => choice.id));
  return [...new Set(splitTokenList(nodeParam))].filter((id) => known.has(id));
}

/**
 * A name for a capture started from the Overview, which asks the operator for
 * nodes and a duration and nothing else. It says where and when, which is
 * what the history table needs to tell captures apart.
 */
export function captureSessionName(nodeNames: readonly string[], now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())} ${pad(now.getUTCHours())}:${pad(now.getUTCMinutes())}Z`;
  const shown = nodeNames.slice(0, 3).join(", ");
  const more = nodeNames.length > 3 ? ` +${nodeNames.length - 3}` : "";
  return `capture ${shown}${more} ${stamp}`;
}

/**
 * The request the capture action sends. Level debug because sing-box logs
 * every close line at debug and none at info (server_trace.go
 * traceDefaultLevel), and a capture exists to see connections finish.
 */
export function captureRequest(nodeIds: readonly string[], ttlSeconds: number, name: string): TraceSessionCreateRequest {
  return {
    name,
    level: "debug",
    ttl_seconds: ttlSeconds,
    filter: { node_ids: [...nodeIds] },
  };
}

/* ------------------------------------------------------------------ */
/* Raw log lens                                                        */
/* ------------------------------------------------------------------ */

/**
 * Which source the raw log lens reads: the one the query names, else the
 * freshest on the node the query names, else the freshest source there is.
 * Freshest is the enabled source whose node shipped a line most recently, so
 * the lens opens on lines that are arriving rather than on whichever name
 * sorts first; with no stats it falls back to the Collection list order
 * (enabled first, then by name). A node with no source gets none: showing
 * another node's lines under `node:X` would answer a question the operator
 * did not ask.
 */
export function pickLogSource(
  sources: readonly LogSource[],
  want: { sourceId: string; nodeId: string },
  stats: readonly LogSourceStatsView[] = [],
): LogSource | undefined {
  const ingest = new Map<string, number>();
  for (const entry of stats) ingest.set(entry.source_id, instantMs(entry.last_ingest_at) ?? 0);
  const sorted = [...sources].sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    const fresh = (ingest.get(b.id) ?? 0) - (ingest.get(a.id) ?? 0);
    if (fresh !== 0) return fresh;
    return (a.name || a.id).localeCompare(b.name || b.id);
  });
  if (want.sourceId) {
    const named = sorted.find((source) => source.id === want.sourceId);
    if (named) return named;
  }
  const nodes = splitTokenList(want.nodeId);
  if (nodes.length) return sorted.find((source) => nodes.includes(source.node_id));
  return sorted[0];
}

/* ------------------------------------------------------------------ */
/* Collection policy table                                             */
/* ------------------------------------------------------------------ */

/**
 * The policy columns whose value is the same on every node. Such a column
 * says its value once, in its header, instead of on each of 34 rows; the
 * row controls stay, revealed when the row is hovered or focused. A value is
 * reported only when there are at least two rows to be the same across.
 * `updated` is null when no node's policy has ever been changed.
 */
export interface UniformPolicyColumns {
  level?: TracePolicy["level"];
  budget?: number;
  updated?: string | null;
}

export function uniformPolicyColumns(policies: readonly TracePolicy[]): UniformPolicyColumns {
  if (policies.length < 2) return {};
  const [first, ...rest] = policies;
  const uniform: UniformPolicyColumns = {};
  if (rest.every((row) => row.level === first!.level)) uniform.level = first!.level;
  if (rest.every((row) => row.budget_lines_per_sec === first!.budget_lines_per_sec)) uniform.budget = first!.budget_lines_per_sec;
  const updatedOf = (row: TracePolicy) => row.updated_at || null;
  if (rest.every((row) => updatedOf(row) === updatedOf(first!))) uniform.updated = updatedOf(first!);
  return uniform;
}
