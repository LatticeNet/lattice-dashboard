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
 *   - a path is up, degraded, down or unknown; degraded is shown only from a
 *     server that sends `degraded_at` (design 29 D13), so nothing here invents
 *     it and an older server's matrix never shows it;
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
  PathDegradation,
  PathSourceView,
  PathState,
  PathTargetView,
  PathView,
  PathsResponse,
} from "@/lib/api/types";
import type { QueryRecord, QueryValue } from "@/components/common/tableUrlState";
import type { QueryField, QuerySchema } from "@/lib/query/engine";
import { regionOf, type RegionKey } from "@/lib/regions";

import { isReachabilityCheck, readBeaconReplans, type BeaconReplanItem } from "@/views/fleet/beaconModel";
import { triangulate, verdictFor, type Triangulation, type Verdict } from "@/views/fleet/triangulationModel";
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

export type MonitoringLayer = "overview" | "network" | "checks" | "incidents";
export const MONITORING_LAYERS: readonly MonitoringLayer[] = ["overview", "network", "checks", "incidents"];

/**
 * Layer names links used before, and where they land now (design 32 D2):
 * Paths and the old Latency layer open the Network view in list mode, the
 * old Topology the Network view as it opens by default.
 */
export const LEGACY_LAYERS: Readonly<Record<string, { view: MonitoringLayer; as?: "list" }>> = {
  latency: { view: "network", as: "list" },
  paths: { view: "network", as: "list" },
  topology: { view: "network" },
  monitors: { view: "checks" },
  keepalive: { view: "incidents" },
};

function first(raw: QueryValue | undefined): string | undefined {
  const value = Array.isArray(raw) ? raw.find((entry) => typeof entry === "string") : raw;
  return typeof value === "string" && value.trim() ? value : undefined;
}

/**
 * The current spelling of an old Monitoring link, or null when the query is
 * already current. `?view=paths` and `?view=latency` become
 * `?view=network&as=list`, `?view=topology` becomes `?view=network`,
 * `?view=monitors` becomes `?view=checks`, and the keepalive spelling of
 * Incidents becomes `?view=incidents`; the old `?tab=` key is read the same
 * way, and an old `?pair=` becomes `?path=`. Every other parameter is kept
 * as it was, `?path=` and an `?as=` the link already names included.
 * Applied once with `replace`.
 */
export function legacyMonitoringRedirect(query: QueryRecord): Record<string, QueryValue> | null {
  const view = first(query.view);
  const tab = first(query.tab);
  const pair = first(query.pair);
  const mapped = view ? LEGACY_LAYERS[view] : !view && tab ? LEGACY_LAYERS[tab] : undefined;
  if (!mapped && !pair) return null;
  const next = { ...query } as Record<string, QueryValue>;
  if (mapped) {
    next.view = mapped.view;
    if (mapped.as && !first(query.as)) next.as = mapped.as;
    if (!view) delete next.tab;
  }
  if (pair) {
    if (!first(query.path)) next.path = pair;
    delete next.pair;
    if (!first(next.view)) {
      next.view = "network";
      if (!first(query.as)) next.as = "list";
    }
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

/**
 * The state as the console reads it. `degraded` counts only from a server
 * that judges it (`judgesDegraded`, from `degraded_at` on the matrix); from
 * any other server, and for any word the console does not know, the state is
 * unknown, never up.
 */
export function normalizeState(raw: string | undefined, judgesDegraded = true): PathState {
  if (raw === "up" || raw === "down") return raw;
  if (raw === "degraded" && judgesDegraded) return "degraded";
  return "unknown";
}

/** Whether the server judges degraded (design 29 D13): an M3 server always sends the key, null before its first run. */
export function judgesDegraded(response: Pick<PathsResponse, "degraded_at"> | undefined): boolean {
  return !!response && Object.prototype.hasOwnProperty.call(response, "degraded_at");
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
  "icmp_not_permitted",
  "destination_refused",
  "method_refused",
  "icmp_filtered",
  "beacon_not_enabled",
  "firewall_pending",
  // Design 29 M2b (D12): the beacon's own reasons.
  "beacon_source_pending",
  "refused_by_node",
  "beacon_not_listening",
  "beacon_filtered",
  "beacon_stale",
  "beacon_unknown_epoch",
  "beacon_rate_limited",
  "beacon_no_key",
  // Design 32 D1: a check definition's pair the control plane paused to keep its source under the packet budget.
  "packet_budget",
] as const;
export type UnknownReason = (typeof UNKNOWN_REASONS)[number];

/** Why a path reads degraded (design 29 D13): the arms that held at the last evaluation that found the condition. */
export const DEGRADED_REASONS = ["degraded_loss", "degraded_latency", "degraded_loss_latency"] as const;
export type DegradedReason = (typeof DEGRADED_REASONS)[number];

/** Every reason the console has a sentence for: unknown's and degraded's, one table (D13 prefixes degraded's so they never collide). */
export const PATH_REASONS = [...UNKNOWN_REASONS, ...DEGRADED_REASONS] as const;
export type PathReason = UnknownReason | DegradedReason;

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
  beacon_off: "beacon_not_enabled",
};

/** The reason as a code the console has a sentence for, or undefined. */
export function reasonCode(reason: string | undefined): PathReason | undefined {
  const raw = reason?.trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!raw) return undefined;
  if ((PATH_REASONS as readonly string[]).includes(raw)) return raw as PathReason;
  return REASON_ALIASES[raw];
}

/**
 * Reasons that are the operator's own choice (a pause). They are listed, but
 * never as a warning and never in a count of problems.
 */
const CHOSEN: ReadonlySet<PathReason> = new Set(["source_paused", "path_paused", "path_set_paused", "check_paused"]);

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

/** The ink a path's loss is drawn in: see lossTone. */
export type LossTone = "destructive" | "warning" | "ink" | "muted";

/**
 * The ink for a path's loss bars and figures. State tones are the only
 * saturated colour (design 29 D13), so a loss takes its path's tone where
 * the state is down (red) or degraded (amber); on an up path a loss is a
 * figure, not a state, and takes the foreground ink; on a path that reads
 * unknown or paused it is muted, since what it holds is not an outage.
 * Undefined (no path read) is ink.
 */
export function lossTone(state: PathDisplay | undefined): LossTone {
  switch (state) {
    case "down":
      return "destructive";
    case "degraded":
      return "warning";
    case "unknown":
    case "paused":
      return "muted";
    default:
      return "ink";
  }
}

/** The text class a loss figure takes in each tone; ink adds none, so the figure keeps its row's ink. */
export const LOSS_TEXT: Readonly<Record<LossTone, string>> = { destructive: "text-destructive", warning: "text-warning-text", ink: "", muted: "text-muted-foreground" };

/** The CSS colour token a loss bar is filled with in each tone. */
export const LOSS_FILL: Readonly<Record<LossTone, string>> = { destructive: "--destructive", warning: "--warning", ink: "--foreground", muted: "--muted-foreground" };

/**
 * A multi-packet run's echoes for the runs list (design 29 M2a): how many
 * were sent and lost and each RTT that came back, rounded to a tenth of a
 * millisecond. Undefined for a single-probe run (tcp, http), which sends one.
 */
export function runEchoes(run: { sent?: number; lost?: number; rtts_ms?: number[] }): { sent: number; lost: number; rtts: string[] } | undefined {
  const sent = Math.max(0, Math.floor(run.sent ?? 0));
  if (sent === 0) return undefined;
  const lost = Math.min(sent, Math.max(0, Math.floor(run.lost ?? 0)));
  const rtts = (run.rtts_ms ?? []).filter((v) => typeof v === "number" && Number.isFinite(v)).slice(0, 10).map((v) => (Math.round(v * 10) / 10).toFixed(1));
  return { sent, lost, rtts };
}

export type RunRow<R> = { kind: "run"; run: R } | { kind: "unmeasured"; reason: string; count: number; newest: R; oldest: R };

/**
 * The latest runs as the sheet lists them, newest first: a stretch of runs
 * that measured nothing for the same reason (an agent whose kernel refuses
 * ICMP reports one every interval) is one row with its count and time span,
 * not twenty identical lines.
 */
export function runRows<R extends { reason?: string; success?: boolean }>(runs: readonly R[], failedAs?: string): RunRow<R>[] {
  const out: RunRow<R>[] = [];
  for (const run of runs) {
    const last = out[out.length - 1];
    // On a path the server reads unknown (an ICMP target that never answered), a failed run measured nothing either.
    const reason = run.reason || (failedAs && run.success === false ? failedAs : undefined);
    if (reason && last?.kind === "unmeasured" && last.reason === reason) {
      last.count += 1;
      last.oldest = run;
    } else if (reason) {
      out.push({ kind: "unmeasured", reason, count: 1, newest: run, oldest: run });
    } else {
      out.push({ kind: "run", run });
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* The matrix                                                           */
/* ------------------------------------------------------------------ */

/**
 * The methods each source's paths use, sorted: one method names a column
 * in its header; more than one (Auto falling back to TCP for some targets)
 * puts the method on each cell instead.
 */
export function methodsBySource(paths: readonly { source: string; method: string }[]): Map<string, string[]> {
  const sets = new Map<string, Set<string>>();
  for (const p of paths) {
    if (!p.method) continue;
    const set = sets.get(p.source) ?? new Set<string>();
    set.add(p.method);
    sets.set(p.source, set);
  }
  return new Map([...sets].map(([source, set]) => [source, [...set].sort()]));
}

/** One path, normalized, with the names it is shown by. */
export interface PathItem {
  key: string;
  /** The row the path sits in: a target node id, or `@<monitor id>` for an operator check. */
  rowKey: string;
  source: string;
  sourceName: string;
  targetNode?: string;
  targetName: string;
  /** The target node's own name, also on an operator check's path, whose row is named by the check. */
  targetNodeName?: string;
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
  /** Why and since when the path reads degraded (design 29 D13); present only while it does. */
  degraded?: PathDegradationItem;
}

/** A degraded path's evidence as the console reads it: times in epoch ms, shares 0 to 1. */
export interface PathDegradationItem {
  since?: number;
  evaluatedAt?: number;
  /** Set while the condition is absent; the path leaves ten minutes after it. */
  clearingSince?: number;
  loss?: { value: number; baseline: number; trigger: number; sent: number; lost: number };
  latency?: { p50Ms: number; runs: number; baselineMs: number; triggerMs: number };
}

/** How long a clearing path stays degraded once the condition is gone (lattice-sdk PathDegradedLeaveAfter). */
export const DEGRADED_LEAVE_AFTER_MS = 10 * 60_000;

/** The server's degradation record, read: unreadable figures drop their arm rather than show as zero. */
export function readDegradation(raw: PathDegradation | null | undefined): PathDegradationItem | undefined {
  if (!raw) return undefined;
  const out: PathDegradationItem = { since: epoch(raw.since), evaluatedAt: epoch(raw.evaluated_at), clearingSince: epoch(raw.clearing_since) };
  const l = raw.loss;
  if (l && [l.value, l.baseline, l.trigger].every((v) => finite(v) !== undefined)) {
    out.loss = { value: l.value, baseline: l.baseline, trigger: l.trigger, sent: Math.max(0, Math.floor(l.sent ?? 0)), lost: Math.max(0, Math.floor(l.lost ?? 0)) };
  }
  const t = raw.latency;
  if (t && [t.p50_ms, t.baseline_ms, t.trigger_ms].every((v) => finite(v) !== undefined)) {
    out.latency = { p50Ms: t.p50_ms, runs: Math.max(0, Math.floor(t.runs ?? 0)), baselineMs: t.baseline_ms, triggerMs: t.trigger_ms };
  }
  return out;
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
  /** Degraded paths; zero from a server that does not judge degraded. */
  degraded: number;
  down: number;
  /** Unknown and not a pause. */
  unknown: number;
  /** Unknown because the operator paused it. */
  paused: number;
}

/**
 * The one count rule (design 32 D1): every count the page shows is this,
 * over the matrix's paths or over the paths a query keeps, so the proof line,
 * Overview and both Network modes say the same number for the same set.
 */
export function countPaths(paths: readonly Pick<PathItem, "state" | "reason">[]): PathCounts {
  const counts: PathCounts = { paths: paths.length, up: 0, degraded: 0, down: 0, unknown: 0, paused: 0 };
  for (const path of paths) counts[displayState(path)] += 1;
  return counts;
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
  /** The server judges degraded (it sent `degraded_at`, design 29 D13): only then is degraded shown or counted. */
  judgesDegraded: boolean;
  /** When the degraded evaluator last ran; undefined before its first run, or on a server that does not judge it. */
  degradedAt?: number;
  /** The nodes whose beacon needs a change plan, by node id (empty from a server that does not say). */
  replans: Map<string, BeaconReplanItem>;
  /**
   * The read carried `beacon_replans` (a server with the monitoring
   * follow-ups, which always sends it): that server also omits a beacon
   * view's `replan` when no plan is needed, so its absence is an answer.
   */
  replansKnown: boolean;
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
  // The server lists the control plane as a source too (node id empty, named "Control plane" in English); the
  // console's own label wins, so it reads in the page's language like every other place that names it.
  const controlPlane = (sent: string | undefined) => names.controlPlane ?? (sent || "control plane");
  const sources: PathColumn[] = (response.sources ?? []).map((s) => ({ nodeId: s.node_id, name: s.node_id ? s.name || s.node_id : controlPlane(s.name) }));
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
  const judges = judgesDegraded(response);
  for (const raw of response.paths ?? []) {
    // A beacon's reachability check is not a path (design 29 D12); the server leaves it out, and so does the console.
    if (isReachabilityCheck({ monitor_id: raw.monitor_id })) continue;
    const source = raw.source ?? "";
    if (!seenSources.has(source)) {
      seenSources.add(source);
      sources.push({ nodeId: source, name: source ? sourceById.get(source)?.name || names.nodeName?.(source) || source : controlPlane(undefined) });
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
      targetNodeName: raw.target_node ? targetNodeView?.name || names.nodeName?.(raw.target_node) || (row.kind === "node" ? row.name : undefined) : undefined,
      country: targetNodeView?.country ?? row.country,
      region: regionOf(targetNodeView?.country ?? row.country),
      target: raw.target ?? "",
      monitorId: raw.monitor_id,
      checkName,
      managed: !!raw.managed,
      method: raw.method || "tcp",
      state: normalizeState(raw.state, judges),
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
    if (item.state === "degraded") item.degraded = readDegradation(raw.degraded);
    // Two checks in one cell (a method switch the server has not joined yet):
    // the worse state is the one the cell shows.
    const key = cellKey(rowKey, source);
    const held = cells.get(key);
    if (!held || stateRank(item.state) < stateRank(held.state)) cells.set(key, item);
    paths.push(item);
  }
  const counts = countPaths(paths);
  return {
    window: String(response.window ?? ""),
    observedAt: epoch(response.observed_at),
    sources,
    rows: [...rows.values()],
    paths,
    cells,
    counts,
    judgesDegraded: judges,
    degradedAt: judges ? epoch(response.degraded_at) : undefined,
    replans: readBeaconReplans(response.beacon_replans),
    replansKnown: response.beacon_replans !== undefined,
  };
}

/**
 * What a path is said to reach: its target node when it has one (a check to
 * a node is a path between two nodes, design 32 D1), else its row's name (a
 * check to an address is named by the check). The query's `target:` reads
 * both, and the attention list's links name their paths by key.
 */
export function targetLabel(path: Pick<PathItem, "targetNodeName" | "targetName">): string {
  return path.targetNodeName || path.targetName;
}

/** Down first, then degraded, then unknown, then up (design 29 D13). */
export function stateRank(state: PathState): number {
  return state === "down" ? 0 : state === "degraded" ? 1 : state === "unknown" ? 2 : 3;
}

/* ------------------------------------------------------------------ */
/* Overview                                                             */
/* ------------------------------------------------------------------ */

export type PathAttention =
  /** A target down from some of the sources that measure it (`measuredBy`), with its verdict. */
  | { kind: "down"; rowKey: string; targetName: string; paths: PathItem[]; worstLoss: number; measuredBy: number; verdict?: Verdict }
  /** The down paths triangulation places on one source's network (design 29 D13 rule 2). */
  | { kind: "downSource"; source: string; sourceName: string; paths: PathItem[]; verdict: Verdict }
  /** A target degraded from some of the sources that measure it. */
  | { kind: "degraded"; rowKey: string; targetName: string; paths: PathItem[]; measuredBy: number; verdict?: Verdict }
  /** The degraded paths triangulation places on one source's network. */
  | { kind: "degradedSource"; source: string; sourceName: string; paths: PathItem[]; verdict: Verdict }
  /** A source whose agent is offline: one line for every path it cannot run. */
  | { kind: "offline"; source: string; sourceName: string; paths: PathItem[] }
  /**
   * A target whose beacon needs a change plan (the server's beacon_replans):
   * the paths that wait on it (firewall_pending, beacon_source_pending), and
   * none when only NetGuard's allow set is wider than the sources that use it.
   */
  | { kind: "replan"; nodeId: string; targetName: string; replan: BeaconReplanItem; paths: PathItem[] }
  | { kind: "unknown"; reason: string; paths: PathItem[] }
  /** Paths the operator paused: listed as information, never as a problem. */
  | { kind: "paused"; paths: PathItem[] };

/**
 * What needs a look, worst first (design 29 D13): each target that is down
 * (one entry per target, its sources inside), the down paths triangulation
 * places on a source's network (one entry per source), then the same two for
 * degraded paths, then each source whose agent is offline (one entry for all
 * the paths it cannot run), then each target whose beacon needs a change plan
 * (its waiting paths inside, so the entry's action is the plan), then the
 * other unknown paths grouped by reason, and the paused paths last as one
 * entry. A fleet whose five NAT targets all read "not probeable" gets one
 * line for them, not five. Each down and degraded entry carries its verdict,
 * the lead path's.
 */
export function pathAttention(matrix: PathsMatrix, triangulation: Triangulation = triangulate(matrix)): PathAttention[] {
  const down = new Map<string, PathItem[]>();
  const downBySource = new Map<string, PathItem[]>();
  const degraded = new Map<string, PathItem[]>();
  const degradedBySource = new Map<string, PathItem[]>();
  const offline = new Map<string, PathItem[]>();
  const waiting = new Map<string, PathItem[]>();
  const unknown = new Map<string, PathItem[]>();
  const paused: PathItem[] = [];
  const measuredBy = new Map<string, number>();
  const push = (map: Map<string, PathItem[]>, key: string, path: PathItem) => map.set(key, [...(map.get(key) ?? []), path]);
  for (const path of matrix.paths) {
    measuredBy.set(path.rowKey, (measuredBy.get(path.rowKey) ?? 0) + 1);
    const shown = displayState(path);
    const verdict = verdictFor(triangulation, path);
    if (shown === "down") push(verdict?.kind === "source" ? downBySource : down, verdict?.kind === "source" ? path.source : path.rowKey, path);
    else if (shown === "degraded") push(verdict?.kind === "source" ? degradedBySource : degraded, verdict?.kind === "source" ? path.source : path.rowKey, path);
    else if (shown === "paused") paused.push(path);
    else if (shown === "unknown") {
      const reason = reasonCode(path.reason) ?? path.reason ?? "no_results";
      if (reason === "agent_offline") push(offline, path.source, path);
      // A path waiting on its target's change plan sits with that plan, whose entry offers it.
      else if ((reason === "firewall_pending" || reason === "beacon_source_pending") && path.targetNode && matrix.replans.has(path.targetNode)) push(waiting, path.targetNode, path);
      else push(unknown, reason, path);
    }
  }
  const byTarget = (a: PathItem, b: PathItem) => a.targetName.localeCompare(b.targetName) || a.sourceName.localeCompare(b.sourceName);
  const lead = (paths: PathItem[]) => verdictFor(triangulation, paths[0]!);
  const downItems = [...down.entries()].map(([rowKey, paths]) => {
    const sorted = [...paths].sort((a, b) => (b.loss ?? 1) - (a.loss ?? 1) || a.sourceName.localeCompare(b.sourceName));
    return { kind: "down" as const, rowKey, targetName: sorted[0]!.targetName, paths: sorted, worstLoss: Math.max(...sorted.map((p) => p.loss ?? 1)), measuredBy: measuredBy.get(rowKey) ?? sorted.length, verdict: lead(sorted) };
  });
  downItems.sort((a, b) => b.paths.length - a.paths.length || b.worstLoss - a.worstLoss || a.targetName.localeCompare(b.targetName));
  const sourceItems = <K extends "downSource" | "degradedSource">(kind: K, map: Map<string, PathItem[]>) =>
    [...map.entries()]
      .map(([source, paths]) => {
        const sorted = [...paths].sort(byTarget);
        return { kind, source, sourceName: sorted[0]!.sourceName, paths: sorted, verdict: lead(sorted)! };
      })
      .sort((a, b) => b.paths.length - a.paths.length || a.sourceName.localeCompare(b.sourceName));
  // A degraded target's worst is the one furthest over its trigger: loss first, then latency.
  const overTrigger = (p: PathItem) => {
    const d = p.degraded;
    if (!d) return 0;
    const loss = d.loss && d.loss.trigger > 0 ? d.loss.value / d.loss.trigger : 0;
    const latency = d.latency && d.latency.triggerMs > 0 ? d.latency.p50Ms / d.latency.triggerMs : 0;
    return Math.max(loss, latency);
  };
  const degradedItems = [...degraded.entries()].map(([rowKey, paths]) => {
    const sorted = [...paths].sort((a, b) => overTrigger(b) - overTrigger(a) || a.sourceName.localeCompare(b.sourceName));
    return { kind: "degraded" as const, rowKey, targetName: sorted[0]!.targetName, paths: sorted, measuredBy: measuredBy.get(rowKey) ?? sorted.length, verdict: lead(sorted) };
  });
  degradedItems.sort((a, b) => b.paths.length - a.paths.length || overTrigger(b.paths[0]!) - overTrigger(a.paths[0]!) || a.targetName.localeCompare(b.targetName));
  const offlineItems = [...offline.entries()]
    .map(([source, paths]) => ({ kind: "offline" as const, source, sourceName: paths[0]!.sourceName, paths: [...paths].sort(byTarget) }))
    .sort((a, b) => b.paths.length - a.paths.length || a.sourceName.localeCompare(b.sourceName));
  // Targets with waiting paths first, by how many wait; a plan that only narrows NetGuard's allow set after them.
  const targetNameOf = (nodeId: string, replan: BeaconReplanItem) => matrix.rows.find((r) => r.nodeId === nodeId)?.name || replan.name;
  const replanItems = [...matrix.replans.values()]
    .map((replan) => {
      const paths = [...(waiting.get(replan.nodeId) ?? [])].sort(byTarget);
      return { kind: "replan" as const, nodeId: replan.nodeId, targetName: targetNameOf(replan.nodeId, replan), replan, paths };
    })
    .sort((a, b) => b.paths.length - a.paths.length || a.targetName.localeCompare(b.targetName));
  const unknownItems = [...unknown.entries()]
    .map(([reason, paths]) => ({ kind: "unknown" as const, reason, paths: [...paths].sort(byTarget) }))
    .sort((a, b) => b.paths.length - a.paths.length || a.reason.localeCompare(b.reason));
  const pausedItems = paused.length ? [{ kind: "paused" as const, paths: [...paused].sort(byTarget) }] : [];
  return [
    ...downItems,
    ...sourceItems("downSource", downBySource),
    ...degradedItems,
    ...sourceItems("degradedSource", degradedBySource),
    ...offlineItems,
    ...replanItems,
    ...unknownItems,
    ...pausedItems,
  ];
}

export interface SourceReach {
  source: string;
  name: string;
  up: number;
  degraded: number;
  down: number;
  unknown: number;
  paused: number;
  total: number;
}

/**
 * For each source, how many of its paths are up, degraded, down, unknown and
 * paused: every path it runs, a check to an address included, so the lines
 * add up to the page's one count (design 32 D1) and the Network view's
 * source picker says what Overview says.
 */
export function reachBySource(matrix: Pick<PathsMatrix, "sources" | "paths">): SourceReach[] {
  return matrix.sources.map((column) => {
    const reach: SourceReach = { source: column.nodeId, name: column.name, up: 0, degraded: 0, down: 0, unknown: 0, paused: 0, total: 0 };
    for (const path of matrix.paths) {
      if (path.source !== column.nodeId) continue;
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
  return /[\s:"(),]/.test(value) ? `"${value.replace(/(["\\])/g, "\\$1")}"` : value;
}

/** The item's paths by their exact keys, in the item's order. */
function pathKeyList(paths: readonly PathItem[]): string {
  return [...new Set(paths.map((p) => p.key))].map(quoteQueryValue).join(",");
}

/**
 * Show's query lists exactly the paths the item counts, by their path keys
 * (`path:=`), never by a name: a target's name also matches a check named
 * after it, and since a check to a node is drawn between two nodes (design
 * 32 D1) `target:` matches the node's name on every check that reaches it.
 * A re-plan can wait on no path yet (it only narrows NetGuard's allow set);
 * its query then names the target and the reason, matched whole (`:=`).
 */
export function attentionQuery(item: PathAttention): string {
  switch (item.kind) {
    case "down":
    case "downSource":
      return `state:down path:=${pathKeyList(item.paths)}`;
    case "degraded":
    case "degradedSource":
      return `state:degraded path:=${pathKeyList(item.paths)}`;
    case "offline":
      return `state:unknown source:=${quoteQueryValue(item.sourceName)}`;
    case "replan":
      return item.paths.length
        ? `state:unknown path:=${pathKeyList(item.paths)}`
        : `state:unknown target:=${quoteQueryValue(item.targetName)} reason:=${item.replan.reason}`;
    case "unknown":
      return `state:unknown reason:=${quoteQueryValue(item.reason)}`;
    case "paused":
      return "state:paused";
  }
}

/** A reach line's query: the source's paths, matched by its whole name, in one state or all. */
export function reachQuery(reach: SourceReach, state?: PathDisplay): string {
  const parts = [`source:=${quoteQueryValue(reach.name)}`];
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

/** A share as the degraded evidence states it: one decimal under ten percent ("4.2%", "0.4%"), whole above. */
export function formatShare(share: number | undefined): string {
  if (share === undefined || !Number.isFinite(share)) return "";
  const pct = Math.max(0, share * 100);
  if (pct === 0) return "0%";
  if (pct < 10) return `${pct.toFixed(1).replace(/\.0$/, "")}%`;
  return `${Math.round(pct)}%`;
}

/**
 * Whether a path's window figures are its own now: it reads up, degraded or
 * down. An unknown or paused path still holds the figures of the runs before
 * it stopped (or of none), and the list, its sort, the query and the sheet's
 * availability never read them as its own (design 32 D1).
 */
export function measuresNow(path: Pick<PathItem, "state">): boolean {
  return path.state === "up" || path.state === "degraded" || path.state === "down";
}

/**
 * Successful runs of the runs expected, 0 to 1. Undefined when nothing was
 * expected, no run was counted, or the path does not measure now: a path that
 * never ran has no availability, never 0%.
 */
export function availability(path: Pick<PathItem, "state" | "samples" | "expected" | "loss">): number | undefined {
  if (!measuresNow(path) || path.samples <= 0 || !path.expected || path.expected <= 0) return undefined;
  const ok = path.samples * (1 - (path.loss ?? 0));
  return Math.max(0, Math.min(1, ok / path.expected));
}

/* ------------------------------------------------------------------ */
/* The list query over paths                                            */
/* ------------------------------------------------------------------ */

/** The states the query knows, as the console words them: a pause is its own state. */
export const PATH_STATES: readonly PathDisplay[] = ["down", "degraded", "unknown", "paused", "up"];
export const PATH_METHODS = ["tcp", "http", "tls", "icmp", "beacon"] as const;

/** Queries the help offers on Paths; each key names the sentence that says what it finds. */
export const PATHS_QUERY_EXAMPLES = [
  { key: "down", query: "state:down" },
  { key: "degraded", query: "state:degraded" },
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
  const percent = (share: number | undefined) => (share === undefined ? undefined : share * 100);
  const fields: QueryField<PathItem>[] = [
    // The row's name and, on a check to a node, the node's own name: a definition's paths are found by the node they reach.
    {
      key: "target",
      aliases: ["to"],
      type: "string",
      hint: hint("target"),
      get: (p) => (p.targetNodeName && p.targetNodeName !== p.targetName ? [p.targetName, p.targetNodeName] : p.targetName),
      sort: (p) => p.targetName,
      suggest: (rows) => rows.flatMap((p) => (p.targetNodeName ? [p.targetName, p.targetNodeName] : [p.targetName])),
    },
    // One path by its key, as ?path= names it; the attention list's links list exactly their paths this way.
    { key: "path", type: "string", hint: hint("path"), get: (p) => p.key, sort: false },
    { key: "source", aliases: ["from"], type: "string", hint: hint("source"), get: (p) => p.sourceName, suggest: (rows) => rows.map((p) => p.sourceName) },
    {
      key: "state",
      aliases: ["status"],
      type: "enum",
      hint: hint("state"),
      values: PATH_STATES,
      valueAliases: { failing: "down", failed: "down", ok: "up", healthy: "up", stopped: "paused", slow: "degraded" },
      get: (p) => displayState(p),
    },
    { key: "reason", aliases: ["why"], type: "list", hint: hint("reason"), get: reasonWords, suggest: (rows) => rows.map((p) => reasonCode(p.reason) ?? p.reason ?? "").filter(Boolean), sort: false },
    { key: "region", type: "string", hint: hint("region"), get: (p) => p.region, suggest: (rows) => rows.map((p) => p.region) },
    { key: "country", type: "string", hint: hint("country"), get: (p) => p.country },
    { key: "method", type: "enum", hint: hint("method"), values: PATH_METHODS, get: (p) => p.method },
    { key: "check", type: "string", hint: hint("check"), get: (p) => p.checkName ?? p.monitorId },
    // The figures as the list shows them: none while the path does not measure now, so a sort never ranks a blank cell.
    { key: "p50", type: "number", hint: hint("p50"), get: (p) => (measuresNow(p) ? p.p50Ms : undefined) },
    { key: "p95", type: "number", hint: hint("p95"), get: (p) => (measuresNow(p) ? p.p95Ms : undefined) },
    { key: "jitter", type: "number", hint: hint("jitter"), get: (p) => (measuresNow(p) ? p.jitterMs : undefined) },
    { key: "loss", type: "number", unit: "percent", hint: hint("loss"), get: (p) => (measuresNow(p) && p.samples > 0 ? percent(p.loss) : undefined) },
    { key: "availability", aliases: ["avail"], type: "number", unit: "percent", hint: hint("availability"), get: (p) => percent(availability(p)) },
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
