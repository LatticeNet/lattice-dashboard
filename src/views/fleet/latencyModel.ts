/**
 * The Latency layer of Monitoring: a source by target matrix of handshake
 * times and loss, one pair's series, and the probe configuration editor.
 *
 * The server owns the plan (which nodes are sources and targets, which
 * endpoint each target is dialled at, and why) and the rollups (p50, p95
 * and loss per pair over 1 h, 24 h and 7 d, with the probes heard beside the
 * probes expected). This model only arranges them, and keeps one rule above
 * every other: a pair the console has not heard from reads as unknown, never
 * as a colour that could be mistaken for a clean path. Green means a
 * measured p50 under 50 ms and nothing else.
 *
 * Kept free of Vue so `node --test` covers it directly.
 */
import type {
  LatencyBucket,
  LatencyPair,
  LatencyPairRollup,
  LatencyProbeConfig,
  LatencyProbeNode,
  LatencyProbePairState,
  LatencyProbePlan,
  LatencyRollups,
  LatencySeries,
  LatencyStats,
  LatencyWindow,
  Node,
} from "@/lib/api/types";
import { latencyClass } from "@/lib/latency";
import { beaconTargetBlock } from "@/views/fleet/beaconModel";
import { publicIPv4, sourceSupport } from "@/views/fleet/checkRulesModel";
import { ALERT_DEFAULT_AFTER, ALERT_MAX_AFTER, degradedDraftFrom, degradedForSave, degradedProblems, effectiveAlert, type DegradedDraft } from "@/views/fleet/degradedRuleModel";
import { regionOf, regionRank, type RegionKey } from "@/lib/regions";

export const LATENCY_WINDOWS: readonly LatencyWindow[] = ["1h", "24h", "7d"];
export type LatencyReading = "p50" | "p95";
export const LATENCY_READINGS: readonly LatencyReading[] = ["p50", "p95"];

/** Bounds the server enforces (lattice-sdk LatencyProbe* constants). */
export const LATENCY_MIN_INTERVAL_SEC = 10;
export const LATENCY_MAX_INTERVAL_SEC = 3600;
export const LATENCY_MAX_TIMEOUT_SEC = 30;
export const LATENCY_DEFAULT_INTERVAL_SEC = 60;
export const LATENCY_DEFAULT_TIMEOUT_SEC = 5;

/** A window heard for less than this share of its expected probes is marked partial. */
export const PARTIAL_COVERAGE = 0.5;
/** Loss at or above this share in the shown window puts a pair on the attention list. */
export const LOSS_ATTENTION = 0.2;

/** A pair whose newest result is older than this reads as quiet, whatever its window says. */
export function quietAfterMs(intervalSec: number): number {
  return Math.max(3 * Math.max(intervalSec, 1) * 1000, 180_000);
}

/** A band from src/lib/latency.ts, or none when nothing was measured. */
export type LatencyBand = "success" | "chart-2" | "warning" | "destructive";

/**
 * Full class names per band, written out so Tailwind sees every one of them
 * at build time: a class built from a template string is never generated.
 *
 * Over 250 ms is still a measurement: a red bar and a red number on a plain
 * cell. The red tint belongs to a pair whose every probe failed
 * (LatencyLayer's failing cell), so the two never look alike.
 */
export const BAND_STYLE: Record<LatencyBand, { bar: string; tint: string; text: string; swatch: string }> = {
  success: { bar: "bg-success", tint: "bg-success/10", text: "text-foreground", swatch: "bg-success" },
  "chart-2": { bar: "bg-chart-2", tint: "bg-chart-2/10", text: "text-foreground", swatch: "bg-chart-2" },
  warning: { bar: "bg-warning", tint: "bg-warning/12", text: "text-warning-text", swatch: "bg-warning" },
  destructive: { bar: "bg-destructive", tint: "", text: "text-destructive", swatch: "bg-destructive" },
};

export function latencyBand(ms: number | undefined): LatencyBand | undefined {
  if (ms === undefined || !Number.isFinite(ms)) return undefined;
  const cls = latencyClass(ms);
  return cls in BAND_STYLE ? (cls as LatencyBand) : undefined;
}

/**
 * What one cell of the matrix says.
 *
 *   measured      the pair runs and some probes in the window succeeded
 *   failing       the pair runs, probes were heard, and none succeeded
 *   unknown       the pair runs and nothing was heard in the window
 *   paused        the pair, its source or the whole configuration is off
 *   notProbeable  the target serves no port the rule may dial
 *   self          a source is never its own target
 */
export type LatencyCellKind = "measured" | "failing" | "unknown" | "paused" | "notProbeable" | "self";

/** Why a paused cell is paused. */
export type PausedReason = "pair_off" | "config_off" | "source" | "target";

export interface LatencyCell {
  kind: LatencyCellKind;
  source: string;
  target: string;
  /** The chosen reading (p50 or p95), when one was measured. */
  valueMs?: number;
  p50Ms?: number;
  p95Ms?: number;
  band?: LatencyBand;
  /** Failure share of the probes heard, 0 to 1. */
  loss?: number;
  samples: number;
  expected: number;
  /** Share of the expected probes that were heard, 0 to 1. */
  coverage?: number;
  /** Heard, but for less than PARTIAL_COVERAGE of the window. */
  partial: boolean;
  pausedReason?: PausedReason;
  /** A paused pair still carries what it measured before, drawn without a band. */
  hasHistory: boolean;
  /** The operator's switch for this pair; false only when the pair was switched off. */
  pairEnabled: boolean;
  /** A pair exists for this source and target (the source can probe). */
  exists: boolean;
  /** When the pair's newest result was taken, epoch ms, however old. */
  lastAt?: number;
}

export interface LatencyRow {
  node: LatencyProbeNode;
  cells: LatencyCell[];
}

export interface LatencySourceColumn {
  nodeId: string;
  name: string;
  /** Why this configured source cannot probe: unknown_node or node_disabled. */
  note?: string;
}

export interface LatencyMatrix {
  sources: LatencySourceColumn[];
  rows: LatencyRow[];
  counts: {
    targets: number;
    measured: number;
    unknown: number;
    failing: number;
    paused: number;
    notProbeable: number;
  };
}

export function pairKey(source: string, target: string): string {
  return `${source}~${target}`;
}

export function parsePairKey(raw: string | undefined | null): LatencyPair | undefined {
  if (!raw) return undefined;
  const at = raw.indexOf("~");
  if (at <= 0 || at === raw.length - 1) return undefined;
  return { source: raw.slice(0, at), target: raw.slice(at + 1) };
}

const TARGET_STATES = new Set(["probed", "paused", "not_probeable"]);

export function isTarget(node: LatencyProbeNode): boolean {
  return TARGET_STATES.has(node.target);
}

function coverageOf(stats: LatencyStats): number | undefined {
  if (!stats.expected || stats.expected <= 0) return undefined;
  return Math.max(0, Math.min(1, stats.samples / stats.expected));
}

/** The cell for one pair. */
export function latencyCell(
  plan: LatencyProbePlan,
  source: LatencySourceColumn,
  target: LatencyProbeNode,
  pair: LatencyProbePairState | undefined,
  rollup: LatencyPairRollup | undefined,
  window: LatencyWindow,
  reading: LatencyReading,
): LatencyCell {
  const stats = rollup?.windows[window];
  const base: LatencyCell = {
    kind: "unknown",
    source: source.nodeId,
    target: target.node_id,
    samples: stats?.samples ?? 0,
    expected: stats?.expected ?? 0,
    partial: false,
    hasHistory: (stats?.samples ?? 0) > 0,
    pairEnabled: pair?.enabled ?? true,
    exists: !!pair,
  };
  const lastAt = rollup?.latest?.at ? Date.parse(rollup.latest.at) : NaN;
  if (!Number.isNaN(lastAt)) base.lastAt = lastAt;
  if (stats && stats.samples > 0) {
    base.loss = stats.loss;
    base.p50Ms = stats.p50_ms;
    base.p95Ms = stats.p95_ms;
    base.coverage = coverageOf(stats);
    base.partial = base.coverage !== undefined && base.coverage < PARTIAL_COVERAGE;
  }
  if (source.nodeId === target.node_id) return { ...base, kind: "self", hasHistory: false };
  if (target.target === "not_probeable") return { ...base, kind: "notProbeable" };
  if (!pair) return { ...base, kind: "paused", pausedReason: "source" };
  if (!pair.active) {
    let reason: PausedReason = "target";
    if (!plan.config.enabled) reason = "config_off";
    else if (!pair.enabled) reason = "pair_off";
    return { ...base, kind: "paused", pausedReason: reason };
  }
  if (!stats || stats.samples <= 0) return { ...base, kind: "unknown" };
  if (stats.p50_ms === undefined) return { ...base, kind: "failing" };
  const valueMs = reading === "p95" ? (stats.p95_ms ?? stats.p50_ms) : stats.p50_ms;
  return { ...base, kind: "measured", valueMs, band: latencyBand(valueMs) };
}

/** Sources in the configured order, named from the plan; a deleted source keeps its id. */
export function latencySources(plan: LatencyProbePlan): LatencySourceColumn[] {
  const byId = new Map(plan.nodes.map((node) => [node.node_id, node]));
  const seen = new Set<string>();
  const out: LatencySourceColumn[] = [];
  for (const id of plan.config.sources ?? []) {
    if (seen.has(id)) continue;
    seen.add(id);
    const node = byId.get(id);
    out.push({ nodeId: id, name: node?.name || id, note: plan.source_notes?.[id] });
  }
  return out;
}

/** The whole matrix: targets as rows (they are many), sources as columns (they are few). */
export function buildLatencyMatrix(
  plan: LatencyProbePlan,
  rollups: LatencyRollups | undefined,
  window: LatencyWindow,
  reading: LatencyReading,
): LatencyMatrix {
  const sources = latencySources(plan);
  const pairs = new Map(plan.pairs.map((pair) => [pairKey(pair.source, pair.target), pair]));
  const rollupByPair = new Map((rollups?.pairs ?? []).map((r) => [pairKey(r.source, r.target), r]));
  const targets = plan.nodes
    .filter(isTarget)
    .sort((a, b) => (a.name || a.node_id).localeCompare(b.name || b.node_id) || a.node_id.localeCompare(b.node_id));
  const counts = { targets: targets.length, measured: 0, unknown: 0, failing: 0, paused: 0, notProbeable: 0 };
  const rows = targets.map((node) => {
    const cells = sources.map((source) => {
      const key = pairKey(source.nodeId, node.node_id);
      return latencyCell(plan, source, node, pairs.get(key), rollupByPair.get(key), window, reading);
    });
    for (const cell of cells) {
      if (cell.kind === "measured") counts.measured += 1;
      else if (cell.kind === "unknown") counts.unknown += 1;
      else if (cell.kind === "failing") counts.failing += 1;
      else if (cell.kind === "paused") counts.paused += 1;
    }
    if (node.target === "not_probeable") counts.notProbeable += 1;
    return { node, cells };
  });
  return { sources, rows, counts };
}

export interface LatencyRowGroup {
  region: RegionKey;
  rows: LatencyRow[];
}

/**
 * The matrix's rows by region (src/lib/regions.ts), near first, then by
 * country and name: from mainland China the handshake times climb down the
 * column, so the one that does not fit its neighbours is the one to read.
 */
export function groupLatencyRows(rows: readonly LatencyRow[]): LatencyRowGroup[] {
  const sorted = [...rows].sort((a, b) => {
    const ra = regionOf(a.node.country);
    const rb = regionOf(b.node.country);
    return (
      regionRank(ra) - regionRank(rb) ||
      (a.node.country ?? "~").toUpperCase().localeCompare((b.node.country ?? "~").toUpperCase()) ||
      (a.node.name || a.node.node_id).localeCompare(b.node.name || b.node.node_id) ||
      a.node.node_id.localeCompare(b.node.node_id)
    );
  });
  const groups: LatencyRowGroup[] = [];
  for (const row of sorted) {
    const region = regionOf(row.node.country);
    const last = groups[groups.length - 1];
    if (last && last.region === region) last.rows.push(row);
    else groups.push({ region, rows: [row] });
  }
  return groups;
}

/** A pair whose last result is older than quietAfterMs: its window's numbers are history. */
export function cellQuietFor(cell: Pick<LatencyCell, "kind" | "lastAt">, intervalSec: number, now: number): number | undefined {
  if (cell.kind !== "measured" && cell.kind !== "failing") return undefined;
  if (cell.lastAt === undefined) return undefined;
  const age = now - cell.lastAt;
  return age > quietAfterMs(intervalSec) ? age : undefined;
}

/** Coverage as a whole percent, and "<1" for a share heard at all but under one percent. */
export function coveragePercent(coverage: number): string {
  if (coverage > 0 && coverage < 0.01) return "<1";
  return String(Math.round(coverage * 100));
}

export interface LatencyProblem {
  target: LatencyProbeNode;
  /** The pairs into this target worth a look, worst first. */
  pairs: { cell: LatencyCell; source: LatencySourceColumn }[];
  /** Every listed pair heard probes and none succeeded. */
  unreachable: boolean;
  /** The highest loss among the listed pairs, 0 to 1. */
  worstLoss: number;
}

/**
 * Targets worth a look in the shown window: a pair into them where nothing
 * succeeded, or one losing LOSS_ATTENTION or more. One entry per target, so a
 * target three sources cannot reach is one line, not three.
 */
export function latencyProblems(matrix: LatencyMatrix, limit = 6): LatencyProblem[] {
  const out: LatencyProblem[] = [];
  for (const row of matrix.rows) {
    const pairs: LatencyProblem["pairs"] = [];
    row.cells.forEach((cell, index) => {
      if (cell.kind === "failing" || (cell.kind === "measured" && (cell.loss ?? 0) >= LOSS_ATTENTION)) {
        pairs.push({ cell, source: matrix.sources[index]! });
      }
    });
    if (pairs.length === 0) continue;
    pairs.sort((a, b) => (b.cell.loss ?? 1) - (a.cell.loss ?? 1) || a.source.name.localeCompare(b.source.name));
    out.push({
      target: row.node,
      pairs,
      unreachable: pairs.every((p) => p.cell.kind === "failing"),
      worstLoss: Math.max(...pairs.map((p) => (p.cell.kind === "failing" ? 1 : (p.cell.loss ?? 0)))),
    });
  }
  out.sort((a, b) => Number(b.unreachable) - Number(a.unreachable) || b.worstLoss - a.worstLoss || b.pairs.length - a.pairs.length || a.target.name.localeCompare(b.target.name));
  return out.slice(0, limit);
}

/** Handshake time as an operator reads it: 4.2 ms, 168 ms, 1.24 s. */
export function formatMs(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return "";
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`;
  if (ms < 10) return `${ms.toFixed(1)} ms`;
  return `${Math.round(ms)} ms`;
}

/** Loss as a share: 0%, under 1%, 12%, 100%. */
export function formatLoss(loss: number | undefined): string {
  if (loss === undefined || !Number.isFinite(loss)) return "";
  if (loss <= 0) return "0%";
  if (loss < 0.01) return "<1%";
  if (loss >= 1) return "100%";
  return `${Math.round(loss * 100)}%`;
}

/* ------------------------------------------------------------------ */
/* One pair's series                                                    */
/* ------------------------------------------------------------------ */

export interface SeriesBar {
  at: string;
  kind: "measured" | "failing" | "unknown";
  valueMs?: number;
  p95Ms?: number;
  loss?: number;
  samples: number;
  expected: number;
  band?: LatencyBand;
  /** Bar height as a share of the chart, 0 to 1. */
  height: number;
  /** p95 tick as a share of the chart, when measured. */
  p95?: number;
}

/** A round ceiling for the chart: 50, 100, 200, 250, 500, 1000, then whole seconds. */
export function chartCeiling(maxMs: number): number {
  for (const step of [50, 100, 200, 250, 500, 1000]) if (maxMs <= step) return step;
  return Math.ceil(maxMs / 1000) * 1000;
}

export function seriesBars(series: LatencySeries | undefined, reading: LatencyReading): { bars: SeriesBar[]; ceilingMs: number } {
  const buckets: LatencyBucket[] = series?.buckets ?? [];
  let max = 0;
  // The ceiling takes the p95 ticks too, so a tick never leaves the chart.
  for (const b of buckets) {
    const v = b.p95_ms ?? b.p50_ms;
    if (v !== undefined && Number.isFinite(v)) max = Math.max(max, v);
  }
  const ceilingMs = chartCeiling(Math.max(max, 1));
  const bars = buckets.map((b): SeriesBar => {
    if (b.samples <= 0) return { at: b.at, kind: "unknown", samples: 0, expected: b.expected, height: 1 };
    if (b.p50_ms === undefined) return { at: b.at, kind: "failing", loss: b.loss, samples: b.samples, expected: b.expected, height: 1 };
    const valueMs = reading === "p95" ? (b.p95_ms ?? b.p50_ms) : b.p50_ms;
    return {
      at: b.at,
      kind: "measured",
      valueMs,
      p95Ms: b.p95_ms,
      loss: b.loss,
      samples: b.samples,
      expected: b.expected,
      band: latencyBand(valueMs),
      height: Math.max(0.02, Math.min(1, valueMs / ceilingMs)),
      p95: b.p95_ms !== undefined ? Math.min(1, b.p95_ms / ceilingMs) : undefined,
    };
  });
  return { bars, ceilingMs };
}

/* ------------------------------------------------------------------ */
/* The configuration editor                                             */
/* ------------------------------------------------------------------ */

export interface LatencyDraft {
  enabled: boolean;
  intervalSec: number;
  timeoutSec: number;
  sources: string[];
  autoTargets: boolean;
  include: string[];
  exclude: string[];
  disabledPairs: LatencyPair[];
  /**
   * The kind every source probes with (design 29 M2a): "" (tcp), "icmp" or
   * "auto". A stored "tcp" reads as "", its meaning, so a save never turns
   * one into the other by accident.
   */
  method: string;
  /** Per-source pins over `method` ("tcp", "icmp", "auto"), by source id. */
  sourceMethods: Record<string, string>;
  /**
   * What the generated paths page (design 29 D13): "" as stored when the
   * server never had one (it reads as off), else off, down or
   * down_and_degraded. Kept as read, so a save that does not touch it (a
   * pause from the path sheet) sends it back unchanged.
   */
  alert: string;
  /** Failed runs in a row before a generated path pages down; 0 as stored when unset (it reads as 2). */
  alertAfter: number;
  /** The degraded rule for every generated path. */
  degraded: DegradedDraft;
  /** The version the draft was read at; a save names it. */
  version: number;
}

/** The path set's methods, in the order the editor offers them; "" is TCP. */
export const PATH_SET_METHODS = ["", "icmp", "auto"] as const;
/** The values a source pin may hold. */
export const SOURCE_PINS = ["tcp", "icmp", "auto"] as const;

/** The methods on an M2b server, Beacon among them (design 29 D12). */
export function pathSetMethods(m2b: boolean): string[] {
  return m2b ? ["", "icmp", "beacon", "auto"] : [...PATH_SET_METHODS];
}

/** The pins on an M2b server; a source already pinned to a method keeps it offered. */
export function sourcePins(m2b: boolean, held?: string): string[] {
  const pins: string[] = m2b ? ["tcp", "icmp", "beacon", "auto"] : [...SOURCE_PINS];
  return held && !pins.includes(held) ? [...pins, held] : pins;
}

function normalizeSetMethod(raw: string | undefined): string {
  const value = (raw ?? "").trim();
  return value === "tcp" ? "" : value;
}

export type TargetMode = "auto" | "always" | "never";

function sortedUnique(list: readonly string[] | undefined): string[] {
  return [...new Set(list ?? [])].sort();
}

function sortPairs(pairs: readonly LatencyPair[] | undefined): LatencyPair[] {
  const seen = new Set<string>();
  const out: LatencyPair[] = [];
  for (const pair of pairs ?? []) {
    const key = pairKey(pair.source, pair.target);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ source: pair.source, target: pair.target });
  }
  return out.sort((a, b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target));
}

export function draftFromConfig(config: LatencyProbeConfig): LatencyDraft {
  return {
    enabled: config.enabled,
    intervalSec: config.interval_sec || LATENCY_DEFAULT_INTERVAL_SEC,
    timeoutSec: config.timeout_sec || LATENCY_DEFAULT_TIMEOUT_SEC,
    sources: sortedUnique(config.sources),
    autoTargets: config.auto_targets,
    include: sortedUnique(config.include_targets),
    exclude: sortedUnique(config.exclude_targets),
    disabledPairs: sortPairs(config.disabled_pairs),
    method: normalizeSetMethod(config.method),
    sourceMethods: Object.fromEntries(Object.entries(config.source_methods ?? {}).filter(([, m]) => !!m)),
    alert: config.alert ?? "",
    alertAfter: config.alert_after && config.alert_after > 0 ? config.alert_after : 0,
    degraded: degradedDraftFrom(config.degraded),
    version: config.version ?? 0,
  };
}

export function draftToConfig(draft: LatencyDraft): LatencyProbeConfig {
  const config: LatencyProbeConfig = {
    enabled: draft.enabled,
    interval_sec: Number(draft.intervalSec),
    timeout_sec: Number(draft.timeoutSec),
    sources: sortedUnique(draft.sources),
    auto_targets: draft.autoTargets,
    include_targets: sortedUnique(draft.include),
    exclude_targets: sortedUnique(draft.exclude),
    disabled_pairs: sortPairs(draft.disabledPairs),
    version: draft.version,
  };
  // Sent only when set: a server before M2a decodes the body strictly and refuses a field it does not know.
  if (draft.method) config.method = draft.method;
  const sources = new Set(config.sources);
  const pins = Object.entries(draft.sourceMethods)
    .filter(([source, method]) => sources.has(source) && !!method)
    .sort(([a], [b]) => a.localeCompare(b));
  if (pins.length) config.source_methods = Object.fromEntries(pins);
  // Design 29 D13: sent only when set, for the same reason, and kept by every save that
  // rebuilds the configuration (a pause from the path sheet included), so none drops them.
  if (draft.alert) config.alert = draft.alert;
  if (draft.alertAfter > 0 && draft.alertAfter !== ALERT_DEFAULT_AFTER) config.alert_after = draft.alertAfter;
  const degraded = degradedForSave(draft.degraded);
  if (degraded) config.degraded = degraded;
  return config;
}

/** Pin one source's method, or follow the path set's again with undefined. */
export function setSourceMethod(draft: LatencyDraft, source: string, method: string | undefined): LatencyDraft {
  const next = { ...draft.sourceMethods };
  if (method) next[source] = method;
  else delete next[source];
  return { ...draft, sourceMethods: next };
}

/** The method a source uses: its pin, else the path set's ("" reads as tcp). */
export function sourceMethod(draft: Pick<LatencyDraft, "method" | "sourceMethods">, source: string): string {
  return draft.sourceMethods[source] || draft.method || "tcp";
}

export interface SourceMethodPreview {
  source: string;
  /** tcp, icmp, beacon or auto. */
  method: string;
  pinned: boolean;
  /** Set when the method needs icmp or the beacon client and the source's agent cannot run it: every path of the source reads unknown with it. */
  refusal?: string;
  /** The method the refusal is about (icmp or beacon). */
  refusalMethod?: string;
  /** Targets each method reaches; `none` reach nothing (no public IPv4, no TCP line, no beacon), `onSave` are resolved by the server on save. */
  icmp: number;
  tcp: number;
  beacon: number;
  /** Targets whose beacon would answer once a change plan on the target admits this source (design 29 D12: firewall pending, source pending). */
  beaconWaiting: number;
  none: number;
  onSave: number;
  /** The targets counted in `none`, by node id, in the plan's order. */
  noneTargets: string[];
  /** Why a target in `none` is not reached, where the method names it (a beacon that cannot answer, or none enabled). */
  noneReasons: Record<string, string>;
  /** The targets counted in `beaconWaiting`. */
  waitingTargets: string[];
}

/** Reasons a pinned beacon pair waits on the target's plan rather than failing outright. */
const BEACON_WAITING = new Set(["firewall_pending", "beacon_source_pending"]);

/**
 * Which method each source will use and how many of the draft's targets it
 * reaches with each, by the planner's rule (design 29 D11): a pinned or set
 * icmp never falls back, and its paths read unknown when the source cannot
 * run icmp; auto picks icmp where the source runs it and the target has a
 * public IPv4, else tcp where the target has a TCP line. A target's TCP line
 * is known only for nodes the plan already targets; for the others the
 * server resolves it on save.
 */
export function pathSetPreview(
  draft: LatencyDraft,
  plan: Pick<LatencyProbePlan, "nodes" | "source_notes"> & Partial<Pick<LatencyProbePlan, "pairs" | "config">>,
  nodes: readonly Node[],
): SourceMethodPreview[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const disabled = (pn: LatencyProbeNode) => pn.target_reason === "node_disabled" || plan.source_notes?.[pn.node_id] === "node_disabled";
  const targets = plan.nodes.filter((pn) => draftTargetReason(draft, pn, disabled(pn)).target);
  const pairs = new Map((plan.pairs ?? []).map((p) => [`${p.source}~${p.target}`, p]));
  const stored = plan.config ? draftFromConfig(plan.config) : undefined;
  return draft.sources.map((source) => {
    const method = sourceMethod(draft, source);
    const support = sourceSupport(byId.get(source), "icmp", true);
    const client = sourceSupport(byId.get(source), "beacon", true);
    const row: SourceMethodPreview = { source, method, pinned: !!draft.sourceMethods[source], icmp: 0, tcp: 0, beacon: 0, beaconWaiting: 0, none: 0, onSave: 0, noneTargets: [], noneReasons: {}, waitingTargets: [] };
    if (method === "icmp" && !support.ok) [row.refusal, row.refusalMethod] = [support.reason, "icmp"];
    if (method === "beacon" && !client.ok) [row.refusal, row.refusalMethod] = [client.reason, "beacon"];
    // The plan's pairs carry the server's verdict for the stored configuration: whether a target's beacon admits this
    // source and listens (the pair probes by beacon with no reason), and whether Auto kept a pair on TCP because ICMP
    // reads filtered there (design 29 D12). A pair the plan does not hold yet has no verdict.
    const storedAuto = stored ? sourceMethod(stored, source) === "auto" : false;
    for (const pn of targets) {
      if (pn.node_id === source) continue;
      const pair = pairs.get(`${source}~${pn.node_id}`);
      const beaconAdmits = !!pn.beacon_target && pair?.method === "beacon" && !pair.reason;
      const ipv4 = !!publicIPv4(pn.icmp_target || byId.get(pn.node_id)?.public_ip);
      // A line port the plan knows; none when the plan says why there is none; else the server resolves it on save.
      const tcp = pn.endpoint && pn.target !== "not_probeable" ? "yes" : pn.target === "not_probeable" || pn.endpoint_note ? "none" : "onSave";
      const unreached = (reason?: string) => {
        row.none += 1;
        row.noneTargets.push(pn.node_id);
        if (reason) row.noneReasons[pn.node_id] = reason;
      };
      const viaTcp = () => {
        if (tcp === "yes") row.tcp += 1;
        else if (tcp === "onSave") row.onSave += 1;
        else unreached();
      };
      if (method === "icmp") {
        if (support.ok && ipv4) row.icmp += 1;
        else unreached();
      } else if (method === "beacon") {
        // A beacon its agent cannot answer on (refused, too old, socket down) is not fixed by a plan: it is not reached, with why.
        const block = beaconTargetBlock(byId.get(pn.node_id));
        if (!client.ok) unreached();
        else if (!pn.beacon_target) unreached("beacon_not_enabled");
        else if (beaconAdmits) row.beacon += 1;
        else if (block) unreached(block);
        else if (!pair || !pair.reason || BEACON_WAITING.has(pair.reason)) {
          // A source the target's plan has not approved: its key and, under NetGuard, its rule wait for a change plan.
          row.beaconWaiting += 1;
          row.waitingTargets.push(pn.node_id);
        } else unreached(pair.reason);
      } else if (method === "auto" && client.ok && beaconAdmits) {
        row.beacon += 1;
      } else if (method === "auto" && support.ok && ipv4 && !(storedAuto && pair?.method === "tcp")) {
        row.icmp += 1;
      } else {
        viaTcp();
      }
    }
    return row;
  });
}

export function draftsDiffer(a: LatencyDraft, b: LatencyDraft): boolean {
  return JSON.stringify(draftToConfig(a)) !== JSON.stringify(draftToConfig(b));
}

export function targetMode(draft: LatencyDraft, nodeId: string): TargetMode {
  if (draft.exclude.includes(nodeId)) return "never";
  if (draft.include.includes(nodeId)) return "always";
  return "auto";
}

export function setTargetMode(draft: LatencyDraft, nodeId: string, mode: TargetMode): LatencyDraft {
  const include = draft.include.filter((id) => id !== nodeId);
  const exclude = draft.exclude.filter((id) => id !== nodeId);
  if (mode === "always") include.push(nodeId);
  if (mode === "never") exclude.push(nodeId);
  return { ...draft, include: include.sort(), exclude: exclude.sort() };
}

export function setSource(draft: LatencyDraft, nodeId: string, on: boolean): LatencyDraft {
  const sources = draft.sources.filter((id) => id !== nodeId);
  if (on) sources.push(nodeId);
  return { ...draft, sources: sources.sort() };
}

export function pairEnabledIn(draft: LatencyDraft, source: string, target: string): boolean {
  return !draft.disabledPairs.some((pair) => pair.source === source && pair.target === target);
}

export function setPairEnabled(draft: LatencyDraft, source: string, target: string, enabled: boolean): LatencyDraft {
  const rest = draft.disabledPairs.filter((pair) => !(pair.source === source && pair.target === target));
  return { ...draft, disabledPairs: sortPairs(enabled ? rest : [...rest, { source, target }]) };
}

export type DraftProblem = "interval" | "timeout" | "timeoutVsInterval" | "alertAfter" | "degraded";

export function draftProblems(draft: LatencyDraft): DraftProblem[] {
  const out: DraftProblem[] = [];
  const interval = Number(draft.intervalSec);
  const timeout = Number(draft.timeoutSec);
  if (!Number.isInteger(interval) || interval < LATENCY_MIN_INTERVAL_SEC || interval > LATENCY_MAX_INTERVAL_SEC) out.push("interval");
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > LATENCY_MAX_TIMEOUT_SEC) out.push("timeout");
  else if (!out.includes("interval") && timeout >= interval) out.push("timeoutVsInterval");
  if ((draft.alert === "down" || draft.alert === "down_and_degraded") && !alertAfterValid(draft.alertAfter)) out.push("alertAfter");
  if (degradedProblems(draft.degraded).length) out.push("degraded");
  return out;
}

/**
 * What the path set's alert line says: the policy in force (a path set
 * nobody set reads off) and the run count it pages after, a stored zero
 * reading as the default (2). While the field holds a count the save would
 * refuse, `after` is left out, so the line never names a number the field's
 * own error contradicts.
 */
export function alertPagesLine(draft: Pick<LatencyDraft, "alert" | "alertAfter">): { policy: "off" | "down" | "down_and_degraded"; after?: number } {
  const policy = effectiveAlert(draft.alert, true);
  if (policy === "off") return { policy };
  if (!alertAfterValid(draft.alertAfter)) return { policy };
  return { policy, after: draft.alertAfter > 0 ? draft.alertAfter : ALERT_DEFAULT_AFTER };
}

/** The path set's run count as the server takes it (validMonitorAlertAfter): 1 to ALERT_MAX_AFTER, or 0 for the default. */
export function alertAfterValid(alertAfter: number): boolean {
  if (alertAfter === 0) return true;
  const after = Number(alertAfter);
  return Number.isInteger(after) && after >= 1 && after <= ALERT_MAX_AFTER;
}

/**
 * Whether a node would be a target under the draft, and why, by the same rule
 * the server plans with (excluded, disabled, included, auto off, region). The
 * editor shows it before the save; the plan that comes back is the authority.
 */
export function draftTargetReason(draft: LatencyDraft, node: LatencyProbeNode, disabled: boolean): { target: boolean; reason: string } {
  if (draft.exclude.includes(node.node_id)) return { target: false, reason: "excluded" };
  if (disabled) return { target: false, reason: "node_disabled" };
  if (draft.include.includes(node.node_id)) return { target: true, reason: "included" };
  if (!draft.autoTargets) return { target: false, reason: "auto_off" };
  if (node.region === "outside_mainland") return { target: true, reason: "auto" };
  if (node.region === "mainland") return { target: false, reason: "mainland" };
  return { target: false, reason: "region_unknown" };
}
