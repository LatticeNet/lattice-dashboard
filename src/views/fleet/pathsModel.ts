/**
 * Monitoring paths (design 29, D5 to D7): one source probing one target with
 * one method, its state for now and its numbers for the page's window.
 *
 * The server sends the matrix (GET /api/monitors/paths). A server from before
 * design 29 has no such route; the console then builds the same shape from
 * the latency plan and rollups it already serves (pathsFromLatency), so every
 * layer reads one model whichever server answered.
 *
 * Rules this file keeps above every other:
 *   - a path is up, down or unknown; degraded does not exist until the server
 *     computes it (M3), so nothing here invents it;
 *   - unknown always has a reason, and an unknown reason code is shown as it
 *     came rather than dropped;
 *   - unknown is never drawn as a colour that could pass for up.
 *
 * Kept free of Vue so `node --test` covers it directly.
 */
import type {
  LatencyProbePlan,
  LatencyRollups,
  LatencyWindow,
  MonitorWindow,
  PathSourceView,
  PathState,
  PathTargetView,
  PathView,
  PathsResponse,
} from "@/lib/api/types";
import type { QueryRecord, QueryValue } from "@/components/common/tableUrlState";
import type { QueryField, QuerySchema } from "@/lib/query/engine";
import { regionOf, regionRank, type RegionKey } from "@/lib/regions";

import { isTarget, latencySources, quietAfterMs } from "@/views/fleet/latencyModel";

/* ------------------------------------------------------------------ */
/* Windows                                                              */
/* ------------------------------------------------------------------ */

export const MONITOR_WINDOWS: readonly MonitorWindow[] = ["1h", "6h", "24h", "3d", "7d", "14d"];
/** What a server from before design 29 can answer: the latency rollup windows. */
export const LEGACY_WINDOWS: readonly MonitorWindow[] = ["1h", "24h", "7d"];
/** The bare URL's window, as the Latency layer had it. */
export const DEFAULT_WINDOW: MonitorWindow = "1h";

export const WINDOW_SECONDS: Record<MonitorWindow, number> = {
  "1h": 3600,
  "6h": 6 * 3600,
  "24h": 24 * 3600,
  "3d": 3 * 86400,
  "7d": 7 * 86400,
  "14d": 14 * 86400,
};

/** Which server answered: the paths route, the latency routes it falls back to, or not known yet. */
export type PathsSource = "paths" | "legacy" | "unknown";

/**
 * The windows the page offers. 14 days only when fine history is kept that
 * long (design 29 D4); before the first read the page offers the windows every
 * new server has, and a legacy server narrows them to its three.
 */
export function availableWindows(source: PathsSource, fineRetentionDays?: number): MonitorWindow[] {
  if (source === "legacy") return [...LEGACY_WINDOWS];
  const base: MonitorWindow[] = ["1h", "6h", "24h", "3d", "7d"];
  if ((fineRetentionDays ?? 0) >= 14) base.push("14d");
  return base;
}

export function parseWindow(raw: QueryValue | undefined): MonitorWindow {
  const value = Array.isArray(raw) ? raw.find((entry) => typeof entry === "string") : raw;
  return MONITOR_WINDOWS.includes(value as MonitorWindow) ? (value as MonitorWindow) : DEFAULT_WINDOW;
}

/**
 * The window a read uses: the one asked for when it is offered, otherwise the
 * longest offered window that is not longer, otherwise the shortest offered.
 * A 6h link on a legacy server reads 1h; a 14d link without 14 days of
 * history reads 7d.
 */
export function effectiveWindow(requested: MonitorWindow, offered: readonly MonitorWindow[]): MonitorWindow {
  if (offered.includes(requested)) return requested;
  const shorter = offered.filter((w) => WINDOW_SECONDS[w] <= WINDOW_SECONDS[requested]).sort((a, b) => WINDOW_SECONDS[b] - WINDOW_SECONDS[a]);
  return shorter[0] ?? offered[0] ?? DEFAULT_WINDOW;
}

/** The latency rollup window a legacy read answers for a page window. */
export function legacyWindow(window: MonitorWindow): LatencyWindow {
  return effectiveWindow(window, LEGACY_WINDOWS) as LatencyWindow;
}

/* ------------------------------------------------------------------ */
/* Layers and old links                                                 */
/* ------------------------------------------------------------------ */

export type MonitoringLayer = "overview" | "paths" | "checks" | "topology" | "incidents";
export const MONITORING_LAYERS: readonly MonitoringLayer[] = ["overview", "paths", "checks", "topology", "incidents"];

/** Layer names links used before design 29, and where they land now. */
export const LEGACY_LAYERS: Readonly<Record<string, MonitoringLayer>> = {
  latency: "paths",
  monitors: "checks",
  keepalive: "incidents",
};

function first(raw: QueryValue | undefined): string | undefined {
  const value = Array.isArray(raw) ? raw.find((entry) => typeof entry === "string") : raw;
  return typeof value === "string" && value.trim() ? value : undefined;
}

/**
 * The current spelling of an old Monitoring link, or null when the query is
 * already current. `?view=latency` becomes `?view=paths` (and its `?pair=`
 * becomes `?path=`), `?view=monitors` becomes `?view=checks`, and the
 * keepalive spelling of Incidents becomes `?view=incidents`; the old `?tab=`
 * key is read the same way. Applied once with `replace`.
 */
export function legacyMonitoringRedirect(query: QueryRecord): Record<string, QueryValue> | null {
  const view = first(query.view);
  const tab = first(query.tab);
  const pair = first(query.pair);
  const mappedView = view ? LEGACY_LAYERS[view] : undefined;
  const mappedTab = !view && tab ? LEGACY_LAYERS[tab] : undefined;
  if (!mappedView && !mappedTab && !pair) return null;
  const next = { ...query } as Record<string, QueryValue>;
  if (mappedView) next.view = mappedView;
  if (mappedTab) {
    next.view = mappedTab;
    delete next.tab;
  }
  if (pair) {
    if (!first(query.path)) next.path = pair;
    delete next.pair;
    if (!first(next.view)) next.view = "paths";
  }
  return next;
}

/* ------------------------------------------------------------------ */
/* Path keys                                                            */
/* ------------------------------------------------------------------ */

/** The control plane, which runs tls checks, has no node id; its column is keyed by this. */
export const CONTROL_PLANE = "_";

export interface PathAddress {
  source: string;
  /** The target node of a path the path set generated. */
  targetNode?: string;
  /** The check of an operator path; such a path has a row of its own. */
  monitorId?: string;
}

/**
 * `?path=` names a path: `<source>~<target node>` for a path the path set
 * generated (the old `?pair=` spelling, so those links still open), and
 * `<source>~@<monitor id>` for a path of an operator check.
 */
export function encodePathKey(address: PathAddress): string {
  const source = address.source || CONTROL_PLANE;
  if (address.targetNode && !address.monitorId) return `${source}~${address.targetNode}`;
  return `${source}~@${address.monitorId ?? ""}`;
}

export function decodePathKey(raw: string | null | undefined): PathAddress | undefined {
  if (!raw) return undefined;
  const at = raw.indexOf("~");
  if (at <= 0 || at === raw.length - 1) return undefined;
  const sourceRaw = raw.slice(0, at);
  const rest = raw.slice(at + 1);
  const source = sourceRaw === CONTROL_PLANE ? "" : sourceRaw;
  if (rest.startsWith("@")) {
    const monitorId = rest.slice(1);
    return monitorId ? { source, monitorId } : undefined;
  }
  return { source, targetNode: rest };
}

/* ------------------------------------------------------------------ */
/* States and reasons                                                   */
/* ------------------------------------------------------------------ */

export function normalizeState(raw: string | undefined): PathState {
  return raw === "up" || raw === "down" ? raw : "unknown";
}

/**
 * Unknown reasons the console can say in a sentence (design 29 D6, plus the
 * reasons the latency plan already gives). Anything else is shown as sent.
 */
export const UNKNOWN_REASONS = [
  "agent_offline",
  "source_paused",
  "path_paused",
  "path_set_paused",
  "check_paused",
  "source_unavailable",
  "not_probeable",
  "no_data",
  "no_tcp_line",
  "udp_only",
  "no_public_address",
  "no_inventory",
  "no_results",
  "results_stopped",
  "agent_too_old",
  "method_refused",
  "icmp_filtered",
  "beacon_not_enabled",
  "firewall_pending",
] as const;
export type UnknownReason = (typeof UNKNOWN_REASONS)[number];

/** Spellings the server or the latency plan may use for the same reason. */
const REASON_ALIASES: Readonly<Record<string, UnknownReason>> = {
  offline: "agent_offline",
  node_offline: "agent_offline",
  source_offline: "agent_offline",
  paused: "path_paused",
  pair_off: "path_paused",
  pair_paused: "path_paused",
  pairs_off: "path_paused",
  disabled_pair: "path_paused",
  config_off: "path_set_paused",
  monitor_paused: "check_paused",
  check_disabled: "check_paused",
  disabled: "check_paused",
  unknown_node: "source_unavailable",
  node_disabled: "source_unavailable",
  no_source: "source_unavailable",
  never_reported: "no_results",
  stale: "results_stopped",
  quiet: "results_stopped",
  method_unsupported: "agent_too_old",
  unsupported_method: "agent_too_old",
  refused_by_node: "method_refused",
  beacon_off: "beacon_not_enabled",
  icmp_not_permitted: "method_refused",
};

/** The reason as a code the console has a sentence for, or undefined. */
export function reasonCode(reason: string | undefined): UnknownReason | undefined {
  const raw = reason?.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!raw) return undefined;
  if ((UNKNOWN_REASONS as readonly string[]).includes(raw)) return raw as UnknownReason;
  return REASON_ALIASES[raw];
}

/**
 * Reasons that are the operator's own choice (a pause). They are listed, but
 * never as a warning and never in a count of problems.
 */
const CHOSEN: ReadonlySet<UnknownReason> = new Set(["source_paused", "path_paused", "path_set_paused", "check_paused"]);

export function isChosenUnknown(reason: string | undefined): boolean {
  const code = reasonCode(reason);
  return code !== undefined && CHOSEN.has(code);
}

/**
 * The state as the console words it: a path that is unknown because the
 * operator paused it reads "paused", everywhere (cells, lists, counts,
 * the query), so a pause is never counted as a problem.
 */
export type PathDisplay = PathState | "paused";

export function displayState(path: { state: PathState; reason?: string }): PathDisplay {
  return path.state === "unknown" && isChosenUnknown(path.reason) ? "paused" : path.state;
}

/* ------------------------------------------------------------------ */
/* The matrix                                                           */
/* ------------------------------------------------------------------ */

/** One path, normalized, with the names it is shown by. */
export interface PathItem {
  key: string;
  /** The row the path sits in: a target node id, or `@<monitor id>` for an operator check. */
  rowKey: string;
  source: string;
  sourceName: string;
  targetNode?: string;
  targetName: string;
  country?: string;
  region: RegionKey;
  target: string;
  monitorId: string;
  checkName?: string;
  managed: boolean;
  method: string;
  state: PathState;
  reason?: string;
  p50Ms?: number;
  p95Ms?: number;
  jitterMs?: number;
  loss?: number;
  samples: number;
  expected: number;
  prev?: { p50Ms?: number; loss?: number };
  lastAt?: number;
}

export interface PathRow {
  key: string;
  kind: "node" | "check";
  nodeId?: string;
  monitorId?: string;
  name: string;
  country?: string;
  /** The region group, or `checks` for operator checks (they sit last). */
  group: RegionKey | "checks";
  /** The target the row's paths dial, when they agree (an operator check's URL). */
  target?: string;
}

export interface PathColumn {
  /** The source node id; empty for the control plane. */
  nodeId: string;
  name: string;
}

export interface PathCounts {
  paths: number;
  up: number;
  down: number;
  /** Unknown and not a pause. */
  unknown: number;
  /** Unknown because the operator paused it. */
  paused: number;
}

export interface PathsMatrix {
  window: string;
  observedAt?: number;
  sources: PathColumn[];
  rows: PathRow[];
  paths: PathItem[];
  /** `rowKey|source` to the path in that cell. */
  cells: Map<string, PathItem>;
  counts: PathCounts;
}

export interface MatrixNames {
  /** A check's name, for operator check rows. */
  checkName?: (monitorId: string) => string | undefined;
  /** The control plane's column label. */
  controlPlane?: string;
  /** A node's name, for a source the server did not name. */
  nodeName?: (nodeId: string) => string | undefined;
}

export function cellKey(rowKey: string, source: string): string {
  return `${rowKey}|${source}`;
}

function epoch(value: string | number | undefined | null): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "number") return value > 1e12 ? value : value * 1000;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function finite(value: number | undefined | null): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** The server's matrix, arranged: targets as rows (they are many), sources as columns (they are few). */
export function buildPathsMatrix(response: PathsResponse, names: MatrixNames = {}): PathsMatrix {
  const sourceById = new Map<string, PathSourceView>((response.sources ?? []).map((s) => [s.node_id, s]));
  const targetById = new Map<string, PathTargetView>((response.targets ?? []).map((t) => [t.node_id, t]));
  const sources: PathColumn[] = (response.sources ?? []).map((s) => ({ nodeId: s.node_id, name: s.name || s.node_id }));
  const seenSources = new Set(sources.map((s) => s.nodeId));
  const rows = new Map<string, PathRow>();
  for (const target of response.targets ?? []) {
    rows.set(target.node_id, {
      key: target.node_id,
      kind: "node",
      nodeId: target.node_id,
      name: target.name || target.node_id,
      country: target.country,
      group: regionOf(target.country),
    });
  }
  const paths: PathItem[] = [];
  const cells = new Map<string, PathItem>();
  for (const raw of response.paths ?? []) {
    const source = raw.source ?? "";
    if (!seenSources.has(source)) {
      seenSources.add(source);
      sources.push({ nodeId: source, name: source ? sourceById.get(source)?.name || names.nodeName?.(source) || source : (names.controlPlane ?? "control plane") });
    }
    const operatorRow = !raw.managed || !raw.target_node;
    const rowKey = operatorRow ? `@${raw.monitor_id}` : raw.target_node!;
    const checkName = names.checkName?.(raw.monitor_id);
    if (!rows.has(rowKey)) {
      if (operatorRow) {
        rows.set(rowKey, { key: rowKey, kind: "check", monitorId: raw.monitor_id, name: checkName || raw.target || raw.monitor_id, group: "checks", target: raw.target });
      } else {
        const target = targetById.get(rowKey);
        rows.set(rowKey, { key: rowKey, kind: "node", nodeId: rowKey, name: target?.name || rowKey, country: target?.country, group: regionOf(target?.country) });
      }
    }
    const row = rows.get(rowKey)!;
    const targetNodeView = raw.target_node ? targetById.get(raw.target_node) : undefined;
    const item: PathItem = {
      key: encodePathKey(operatorRow ? { source, monitorId: raw.monitor_id } : { source, targetNode: raw.target_node }),
      rowKey,
      source,
      sourceName: sources.find((s) => s.nodeId === source)?.name ?? source,
      targetNode: raw.target_node || undefined,
      targetName: row.kind === "check" ? row.name : row.name,
      country: targetNodeView?.country ?? row.country,
      region: regionOf(targetNodeView?.country ?? row.country),
      target: raw.target ?? "",
      monitorId: raw.monitor_id,
      checkName,
      managed: !!raw.managed,
      method: raw.method || "tcp",
      state: normalizeState(raw.state),
      reason: raw.reason || undefined,
      p50Ms: finite(raw.p50_ms),
      p95Ms: finite(raw.p95_ms),
      jitterMs: finite(raw.jitter_ms),
      loss: finite(raw.loss),
      samples: raw.samples ?? 0,
      expected: raw.expected ?? 0,
      prev: raw.prev ? { p50Ms: finite(raw.prev.p50_ms), loss: finite(raw.prev.loss) } : undefined,
      lastAt: epoch(raw.last_at),
    };
    // Two checks in one cell (a method switch the server has not joined yet):
    // the worse state is the one the cell shows.
    const key = cellKey(rowKey, source);
    const held = cells.get(key);
    if (!held || stateRank(item.state) < stateRank(held.state)) cells.set(key, item);
    paths.push(item);
  }
  const counts: PathCounts = { paths: paths.length, up: 0, down: 0, unknown: 0, paused: 0 };
  for (const path of paths) counts[displayState(path)] += 1;
  return {
    window: String(response.window ?? ""),
    observedAt: epoch(response.observed_at),
    sources,
    rows: [...rows.values()],
    paths,
    cells,
    counts,
  };
}

/** Down first, then unknown, then up. */
export function stateRank(state: PathState): number {
  return state === "down" ? 0 : state === "unknown" ? 1 : 2;
}

export interface PathRowGroup {
  group: RegionKey | "checks";
  rows: PathRow[];
}

/**
 * Rows by region (src/lib/regions.ts), near first, then by country and name,
 * as the Latency layer grouped them; operator checks last, by name.
 */
export function groupPathRows(rows: readonly PathRow[]): PathRowGroup[] {
  const rank = (row: PathRow) => (row.group === "checks" ? 1000 : regionRank(row.group));
  const sorted = [...rows].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (a.country ?? "~").toUpperCase().localeCompare((b.country ?? "~").toUpperCase()) ||
      a.name.localeCompare(b.name) ||
      a.key.localeCompare(b.key),
  );
  const groups: PathRowGroup[] = [];
  for (const row of sorted) {
    const last = groups[groups.length - 1];
    if (last && last.group === row.group) last.rows.push(row);
    else groups.push({ group: row.group, rows: [row] });
  }
  return groups;
}

/**
 * What the matrix shows under a query: the rows and columns that hold a
 * matching path, and which cells match. With no query every row and column
 * shows, a target without paths included.
 */
export function visibleMatrix(
  matrix: PathsMatrix,
  matching: ReadonlySet<string> | undefined,
): { rows: PathRow[]; sources: PathColumn[]; matches: (path: PathItem) => boolean } {
  if (!matching) return { rows: matrix.rows, sources: matrix.sources, matches: () => true };
  const rowKeys = new Set<string>();
  const sourceKeys = new Set<string>();
  for (const path of matrix.paths) {
    if (!matching.has(path.key)) continue;
    rowKeys.add(path.rowKey);
    sourceKeys.add(path.source);
  }
  return {
    rows: matrix.rows.filter((row) => rowKeys.has(row.key)),
    sources: matrix.sources.filter((source) => sourceKeys.has(source.nodeId)),
    matches: (path) => matching.has(path.key),
  };
}

export interface MatrixSection {
  /** Node targets by region, or the operator checks. */
  kind: "nodes" | "checks";
  /** The sources with a path in this section: a check's sources do not widen the node matrix. */
  sources: PathColumn[];
  groups: PathRowGroup[];
}

/**
 * The matrix as the page draws it: the node targets in one table whose
 * columns are the sources probing them, and the operator checks in a second
 * table whose columns are the checks' own sources. One table for both left
 * a column per check source that was empty on every node row.
 */
export function matrixSections(matrix: PathsMatrix, shown: { rows: PathRow[]; sources: PathColumn[] }): MatrixSection[] {
  const groups = groupPathRows(shown.rows);
  const out: MatrixSection[] = [];
  for (const kind of ["nodes", "checks"] as const) {
    const mine = groups.filter((g) => (g.group === "checks") === (kind === "checks"));
    if (!mine.length) continue;
    const rows = mine.flatMap((g) => g.rows);
    const sources = shown.sources.filter((s) => rows.some((r) => matrix.cells.has(cellKey(r.key, s.nodeId))));
    out.push({ kind, sources, groups: mine });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Overview                                                             */
/* ------------------------------------------------------------------ */

export type PathAttention =
  /** A target down from some of the sources that measure it (`measuredBy`). */
  | { kind: "down"; rowKey: string; targetName: string; paths: PathItem[]; worstLoss: number; measuredBy: number }
  /** A source whose agent is offline: one line for every path it cannot run. */
  | { kind: "offline"; source: string; sourceName: string; paths: PathItem[] }
  | { kind: "unknown"; reason: string; paths: PathItem[] }
  /** Paths the operator paused: listed as information, never as a problem. */
  | { kind: "paused"; paths: PathItem[] };

/**
 * What needs a look, worst first: each target that is down from a source
 * (one entry per target, its sources inside), then each source whose agent
 * is offline (one entry for all the paths it cannot run), then the other
 * unknown paths grouped by reason, and the paused paths last as one entry.
 * A fleet whose five NAT targets all read "not probeable" gets one line for
 * them, not five.
 */
export function pathAttention(matrix: PathsMatrix): PathAttention[] {
  const down = new Map<string, PathItem[]>();
  const offline = new Map<string, PathItem[]>();
  const unknown = new Map<string, PathItem[]>();
  const paused: PathItem[] = [];
  const measuredBy = new Map<string, number>();
  const push = (map: Map<string, PathItem[]>, key: string, path: PathItem) => map.set(key, [...(map.get(key) ?? []), path]);
  for (const path of matrix.paths) {
    measuredBy.set(path.rowKey, (measuredBy.get(path.rowKey) ?? 0) + 1);
    const shown = displayState(path);
    if (shown === "down") push(down, path.rowKey, path);
    else if (shown === "paused") paused.push(path);
    else if (shown === "unknown") {
      const reason = reasonCode(path.reason) ?? path.reason ?? "no_results";
      if (reason === "agent_offline") push(offline, path.source, path);
      else push(unknown, reason, path);
    }
  }
  const byTarget = (a: PathItem, b: PathItem) => a.targetName.localeCompare(b.targetName) || a.sourceName.localeCompare(b.sourceName);
  const downItems = [...down.entries()].map(([rowKey, paths]) => {
    const sorted = [...paths].sort((a, b) => (b.loss ?? 1) - (a.loss ?? 1) || a.sourceName.localeCompare(b.sourceName));
    return { kind: "down" as const, rowKey, targetName: sorted[0]!.targetName, paths: sorted, worstLoss: Math.max(...sorted.map((p) => p.loss ?? 1)), measuredBy: measuredBy.get(rowKey) ?? sorted.length };
  });
  downItems.sort((a, b) => b.paths.length - a.paths.length || b.worstLoss - a.worstLoss || a.targetName.localeCompare(b.targetName));
  const offlineItems = [...offline.entries()]
    .map(([source, paths]) => ({ kind: "offline" as const, source, sourceName: paths[0]!.sourceName, paths: [...paths].sort(byTarget) }))
    .sort((a, b) => b.paths.length - a.paths.length || a.sourceName.localeCompare(b.sourceName));
  const unknownItems = [...unknown.entries()]
    .map(([reason, paths]) => ({ kind: "unknown" as const, reason, paths: [...paths].sort(byTarget) }))
    .sort((a, b) => b.paths.length - a.paths.length || a.reason.localeCompare(b.reason));
  const pausedItems = paused.length ? [{ kind: "paused" as const, paths: [...paused].sort(byTarget) }] : [];
  return [...downItems, ...offlineItems, ...unknownItems, ...pausedItems];
}

export interface SourceReach {
  source: string;
  name: string;
  up: number;
  down: number;
  unknown: number;
  paused: number;
  total: number;
}

/**
 * For each source, how many of its paths to nodes are up, down and unknown.
 * Operator checks to a URL or an address are not reach into the fleet, so
 * they are left out, and a source that runs only such checks has no line.
 */
export function reachBySource(matrix: PathsMatrix): SourceReach[] {
  return matrix.sources.map((column) => {
    const reach: SourceReach = { source: column.nodeId, name: column.name, up: 0, down: 0, unknown: 0, paused: 0, total: 0 };
    for (const path of matrix.paths) {
      if (path.source !== column.nodeId || path.rowKey.startsWith("@")) continue;
      reach[displayState(path)] += 1;
      reach.total += 1;
    }
    return reach;
  });
}

/**
 * A query that finds an attention item on Paths. Names go in quotes when
 * they hold a space or a colon, so the query parser reads them whole.
 */
export function quoteQueryValue(value: string): string {
  return /[\s:"()]/.test(value) ? `"${value.replace(/(["\\])/g, "\\$1")}"` : value;
}

export function attentionQuery(item: PathAttention): string {
  switch (item.kind) {
    case "down":
      return `state:down target:${quoteQueryValue(item.targetName)}`;
    case "offline":
      return `state:unknown source:${quoteQueryValue(item.sourceName)}`;
    case "unknown":
      return `state:unknown reason:${quoteQueryValue(item.reason)}`;
    case "paused":
      return "state:paused";
  }
}

export function reachQuery(reach: SourceReach, state?: PathDisplay): string {
  const parts = [`source:${quoteQueryValue(reach.name)}`];
  if (state) parts.push(`state:${state}`);
  return parts.join(" ");
}

/* ------------------------------------------------------------------ */
/* Numbers                                                              */
/* ------------------------------------------------------------------ */

export interface PathDelta {
  /** p50 now minus p50 one period earlier, ms. */
  p50Ms?: number;
  /** Loss now minus loss one period earlier, as a share (0.05 is five points). */
  loss?: number;
}

/** The change against the same window one period earlier; absent when either side is missing. */
export function pathDelta(path: Pick<PathItem, "p50Ms" | "loss" | "prev">): PathDelta {
  const out: PathDelta = {};
  if (path.prev?.p50Ms !== undefined && path.p50Ms !== undefined) out.p50Ms = path.p50Ms - path.prev.p50Ms;
  if (path.prev?.loss !== undefined && path.loss !== undefined) out.loss = path.loss - path.prev.loss;
  return out;
}

/** "+12 ms", "-3.4 ms", "0 ms". */
export function formatDeltaMs(ms: number): string {
  const abs = Math.abs(ms);
  const body = abs >= 1000 ? `${(abs / 1000).toFixed(2)} s` : abs < 10 ? `${abs.toFixed(1)} ms` : `${Math.round(abs)} ms`;
  if (abs < 0.05) return "0 ms";
  return `${ms > 0 ? "+" : "-"}${body}`;
}

/** Loss change in percentage points: "+12 pt", "-0.5 pt". */
export function formatDeltaLoss(share: number): string {
  const points = share * 100;
  if (Math.abs(points) < 0.05) return "0 pt";
  const body = Math.abs(points) < 10 ? Math.abs(points).toFixed(1).replace(/\.0$/, "") : String(Math.round(Math.abs(points)));
  return `${points > 0 ? "+" : "-"}${body} pt`;
}

/** Successful runs of the runs expected, 0 to 1; undefined when nothing was expected. */
export function availability(path: Pick<PathItem, "samples" | "expected" | "loss">): number | undefined {
  if (!path.expected || path.expected <= 0) return undefined;
  const ok = path.samples * (1 - (path.loss ?? 0));
  return Math.max(0, Math.min(1, ok / path.expected));
}

/* ------------------------------------------------------------------ */
/* The list query over paths                                            */
/* ------------------------------------------------------------------ */

/** The states the query knows, as the console words them: a pause is its own state. */
export const PATH_STATES: readonly PathDisplay[] = ["down", "unknown", "paused", "up"];
export const PATH_METHODS = ["tcp", "http", "tls", "icmp", "beacon"] as const;

/** Queries the help offers on Paths; each key names the sentence that says what it finds. */
export const PATHS_QUERY_EXAMPLES = [
  { key: "down", query: "state:down" },
  { key: "unknown", query: "state:unknown" },
  { key: "region", query: "region:europe p50>200" },
  { key: "loss", query: "loss>1% sort:-loss" },
] as const;

const hint = (key: string) => `fleet.monitoring.paths.query.fields.${key}`;

export interface PathsQueryOptions {
  /** The reason in words, so `reason:` matches what the operator reads. */
  reasonText: (reason: string | undefined) => string;
}

export function pathsQuerySchema(options: PathsQueryOptions): QuerySchema<PathItem> {
  const reasonWords = (p: PathItem): string[] => {
    if (!p.reason) return [];
    const code = reasonCode(p.reason);
    return [p.reason, code ?? "", options.reasonText(p.reason)].filter(Boolean);
  };
  const fields: QueryField<PathItem>[] = [
    { key: "target", aliases: ["to"], type: "string", hint: hint("target"), get: (p) => p.targetName, suggest: (rows) => rows.map((p) => p.targetName) },
    { key: "source", aliases: ["from"], type: "string", hint: hint("source"), get: (p) => p.sourceName, suggest: (rows) => rows.map((p) => p.sourceName) },
    {
      key: "state",
      aliases: ["status"],
      type: "enum",
      hint: hint("state"),
      values: PATH_STATES,
      valueAliases: { failing: "down", failed: "down", ok: "up", healthy: "up", stopped: "paused" },
      get: (p) => displayState(p),
    },
    { key: "reason", aliases: ["why"], type: "list", hint: hint("reason"), get: reasonWords, suggest: (rows) => rows.map((p) => reasonCode(p.reason) ?? p.reason ?? "").filter(Boolean), sort: false },
    { key: "region", type: "string", hint: hint("region"), get: (p) => p.region, suggest: (rows) => rows.map((p) => p.region) },
    { key: "country", type: "string", hint: hint("country"), get: (p) => p.country },
    { key: "method", type: "enum", hint: hint("method"), values: PATH_METHODS, get: (p) => p.method },
    { key: "check", type: "string", hint: hint("check"), get: (p) => p.checkName ?? p.monitorId },
    { key: "p50", type: "number", hint: hint("p50"), get: (p) => p.p50Ms },
    { key: "p95", type: "number", hint: hint("p95"), get: (p) => p.p95Ms },
    { key: "jitter", type: "number", hint: hint("jitter"), get: (p) => p.jitterMs },
    { key: "loss", type: "number", unit: "percent", hint: hint("loss"), get: (p) => (p.loss === undefined ? undefined : p.loss * 100) },
    { key: "managed", aliases: ["generated"], type: "bool", flag: true, hint: hint("managed"), get: (p) => p.managed, sort: false },
  ];
  return {
    fields,
    text: (p) => [p.targetName, p.sourceName, p.country, p.method, p.checkName, p.target, ...reasonWords(p)],
  };
}

/* ------------------------------------------------------------------ */
/* A server from before design 29                                       */
/* ------------------------------------------------------------------ */

/**
 * The matrix built from the latency plan and rollups. Every pair of the plan
 * becomes a path of the tcp check it runs; its state comes from the newest
 * result (down when it failed, unknown with "results stopped" when it is
 * older than three intervals), and a pair that cannot run is unknown with the
 * plan's own reason. No jitter and no previous period: that server keeps
 * neither.
 */
export function pathsFromLatency(plan: LatencyProbePlan, rollups: LatencyRollups | undefined, window: MonitorWindow, now: number): PathsResponse {
  const rw = legacyWindow(window);
  const byNode = new Map(plan.nodes.map((node) => [node.node_id, node]));
  const sources = latencySources(plan);
  const pairByKey = new Map(plan.pairs.map((pair) => [`${pair.source}~${pair.target}`, pair]));
  const rollupByKey = new Map((rollups?.pairs ?? []).map((r) => [`${r.source}~${r.target}`, r]));
  const intervalSec = rollups?.interval_sec || plan.config.interval_sec || 60;
  const targets = plan.nodes.filter(isTarget);
  const paths: PathView[] = [];
  for (const target of targets) {
    for (const column of sources) {
      if (column.nodeId === target.node_id) continue;
      const key = `${column.nodeId}~${target.node_id}`;
      const pair = pairByKey.get(key);
      const rollup = rollupByKey.get(key);
      const stats = rollup?.windows[rw];
      const base: PathView = {
        source: column.nodeId,
        target_node: target.node_id,
        target: target.endpoint ?? "",
        monitor_id: pair?.monitor_id ?? rollup?.monitor_id ?? target.monitor_id ?? "",
        managed: true,
        method: "tcp",
        state: "unknown",
        samples: stats?.samples ?? 0,
        expected: stats?.expected ?? 0,
        prev: null,
      };
      if (stats && stats.samples > 0) {
        base.p50_ms = stats.p50_ms;
        base.p95_ms = stats.p95_ms;
        base.loss = stats.loss;
      }
      if (rollup?.latest?.at) base.last_at = rollup.latest.at;
      if (target.target === "not_probeable") {
        paths.push({ ...base, reason: target.endpoint_note || "no_tcp_line" });
        continue;
      }
      if (!pair) {
        paths.push({ ...base, reason: column.note || "source_unavailable" });
        continue;
      }
      if (!plan.config.enabled || !pair.active) {
        const reason = !plan.config.enabled ? "path_set_paused" : !pair.enabled ? "path_paused" : "source_unavailable";
        paths.push({ ...base, reason });
        continue;
      }
      const latest = rollup?.latest;
      if (!latest) {
        paths.push({ ...base, reason: "no_results" });
        continue;
      }
      const at = Date.parse(latest.at);
      if (!Number.isNaN(at) && now - at > quietAfterMs(intervalSec)) {
        paths.push({ ...base, reason: "results_stopped" });
        continue;
      }
      if (!latest.success) {
        paths.push({ ...base, state: "down", reason: latest.error || undefined });
        continue;
      }
      paths.push({ ...base, state: "up" });
    }
  }
  return {
    window: rw,
    observed_at: rollups?.generated_at,
    sources: sources.map((s) => ({ node_id: s.nodeId, name: s.name, region: byNode.get(s.nodeId)?.region })),
    targets: targets.map((t) => ({ node_id: t.node_id, name: t.name, country: t.country, region: t.region })),
    paths,
  };
}

/**
 * Whether a paths read failed because the route does not exist (a server
 * from before design 29), as opposed to failing: 404 or 405, or a body that
 * is not the matrix (an HTML fallback page).
 */
export function isMissingRoute(error: unknown): boolean {
  const status = (error as { status?: number } | null)?.status;
  return status === 404 || status === 405;
}

export function looksLikePaths(body: unknown): body is PathsResponse {
  return !!body && typeof body === "object" && Array.isArray((body as PathsResponse).paths);
}
