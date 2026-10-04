/**
 * The Topology layer of Monitoring: the fleet's paths as one deterministic
 * drawing, from the reads the page already makes.
 *
 *   control plane   every node's heartbeat freshness, counted (the relation
 *                   is the same for every node, so it is drawn once, as a
 *                   count, and as a mark on each node, never as 34 lines)
 *   probes          latency probe pairs, source to target, classed by the
 *                   same rule as the Latency matrix (latencyCell) plus two
 *                   facts the matrix cannot show in a window: a source that
 *                   stopped reporting and a last probe that is old
 *   chains          relay line to exit node (GET /api/network/lines/chains)
 *   checks          operator monitors, from the nodes that run them (or the
 *                   control plane, for a certificate watch) to their target
 *
 * Layout, left to right as traffic leaves the fleet: the control plane and
 * the probe sources in a narrow left column (they are few), every other node
 * in one tall column grouped by region in rough order of distance from
 * mainland China, then by country, then by name, so latency colours read as
 * a gradient down the column and an odd one stands out; chains as arcs on
 * that column's right edge, so a relay that is also a probe target keeps one
 * row; checks in a right column. Past COLLAPSE_AT rows each country folds
 * into one row and the edges into it fold into one, coloured by the worst.
 *
 * Kept free of Vue so `node --test` covers it directly.
 */
import type {
  Incident,
  LatencyProbeNode,
  LatencyProbePlan,
  LatencyRollups,
  LatencyWindow,
  LineChainView,
  MonitorView,
  Node,
} from "@/lib/api/types";
import { nodeStatus, type NodeStatus } from "@/lib/nodeStatus";
import { REGION_ORDER, regionOf, regionRank, type RegionKey } from "@/lib/regions";
import { LOSS_ATTENTION, isTarget, latencyCell, latencySources, pairKey, quietAfterMs, type LatencyBand, type PausedReason } from "@/views/fleet/latencyModel";

export { REGION_ORDER, regionOf, regionRank, quietAfterMs, type RegionKey };

/* ------------------------------------------------------------------ */
/* Nodes                                                                */
/* ------------------------------------------------------------------ */

/** How recently a node's agent beat to the control plane, from its status. */
export type Freshness = "fresh" | "degraded" | "quiet" | "never" | "disabled";

const FRESHNESS: Record<NodeStatus, Freshness> = {
  online: "fresh",
  degraded: "degraded",
  offline: "quiet",
  never_reported: "never",
  disabled: "disabled",
};

export interface TopoNode {
  id: string;
  name: string;
  country?: string;
  region: RegionKey;
  /** Absent when the node list was not read (no node:read): only the plan named it. */
  status?: NodeStatus;
  freshness?: Freshness;
  /** The last beat, epoch ms; absent for a node that never reported. */
  lastSeenAt?: number;
  probeSource: boolean;
  /** The plan's target state: probed, paused, not_probeable or none. */
  probeTarget?: string;
  targetReason?: string;
  endpointNote?: string;
  endpoint?: string;
  relay: boolean;
  exit: boolean;
  checkSource: boolean;
  /** Open or acknowledged incidents on the node. */
  incidents: number;
  /** In the node list; false for a node only the plan, a chain or a monitor named. */
  listed: boolean;
}

/** Endpoint id of the control plane; node ids never start with "@". */
export const CONTROL_PLANE = "@cp";
export const checkEndpoint = (monitorId: string) => `@check:${monitorId}`;

/* ------------------------------------------------------------------ */
/* Edges                                                                */
/* ------------------------------------------------------------------ */

/**
 *   measured  probes succeeded in the window
 *   lossy     measured, and LOSS_ATTENTION or more of them failed
 *   failing   probes were heard and none succeeded
 *   unknown   the pair runs and nothing was heard in the window
 *   paused    the pair, its target or the whole configuration is off
 *   quiet     the window has numbers, but the source stopped reporting or
 *             its last probe is older than quietAfterMs: what is drawn is
 *             history, not now
 */
export type ProbeState = "measured" | "lossy" | "failing" | "unknown" | "paused" | "quiet";
export type ChainState = "converged" | "pending" | "drifted" | "failed";
export type CheckState = "up" | "failing" | "stale" | "none";
export type TopoEdgeKind = "probe" | "chain" | "check";
export type TopoEdgeState = ProbeState | ChainState | CheckState;

export interface TopoLastSample {
  at: number;
  ok: boolean;
  ms?: number;
  error?: string;
}

export interface TopoEdge {
  id: string;
  kind: TopoEdgeKind;
  /** Node id, CONTROL_PLANE, or checkEndpoint(monitor id). */
  from: string;
  to: string;
  state: TopoEdgeState;
  /** Lower is worse; lists and bundles sort and pick by it. */
  severity: number;
  band?: LatencyBand;
  p50Ms?: number;
  p95Ms?: number;
  loss?: number;
  samples?: number;
  expected?: number;
  coverage?: number;
  partial?: boolean;
  pausedReason?: PausedReason;
  /** Why a quiet probe is quiet. */
  quietReason?: "source" | "old";
  last?: TopoLastSample;
  chain?: { status: string; sourceLine: string; targetLine?: string; error?: string };
  monitorId?: string;
}

export interface TopoCheck {
  /** checkEndpoint(monitor id). */
  id: string;
  monitorId: string;
  name: string;
  type: string;
  target: string;
  enabled: boolean;
  /** Dialled by the control plane (tls). */
  serverEvaluated: boolean;
  assignAll: boolean;
  /** Every node that runs it, drawn or not. */
  sourceIds: string[];
  summary: Record<CheckState, number>;
  /** An every-node check draws only its sources that are not up; this says so. */
  fannedOut: boolean;
}

export interface ControlPlaneSummary {
  total: number;
  fresh: number;
  degraded: number;
  quiet: number;
  never: number;
  disabled: number;
  /** The node list was read. */
  known: boolean;
}

export type TopologyLayer = "all" | "probes" | "chains" | "checks";
export const TOPOLOGY_LAYERS: readonly TopologyLayer[] = ["all", "probes", "chains", "checks"];

export interface TopologyInput {
  /** Undefined when not read (no node:read, or still loading). */
  nodes?: readonly Node[];
  plan?: LatencyProbePlan;
  rollups?: LatencyRollups;
  /** Undefined when not read or not readable. */
  chains?: readonly LineChainView[];
  /** Every monitor the server listed; generated ones are left out here. */
  monitors?: readonly MonitorView[];
  incidents?: readonly Incident[];
  window: LatencyWindow;
  layer: TopologyLayer;
  now: number;
}

export interface TopologyCounts {
  paths: number;
  failing: number;
  lossy: number;
  quiet: number;
  unknown: number;
  paused: number;
  chains: number;
  chainsBroken: number;
  /** Chains whose exit is not decided yet (only planned): not drawn. */
  chainsUnplaced: number;
  checks: number;
  checksFailing: number;
}

export interface TopologyModel {
  layer: TopologyLayer;
  window: LatencyWindow;
  /** Every node the reads named, by id. */
  nodes: Map<string, TopoNode>;
  /** The left column: probe sources in the configured order. */
  sources: TopoNode[];
  /** The tall column, sorted region, country, name, id. */
  members: TopoNode[];
  checks: TopoCheck[];
  edges: TopoEdge[];
  cp: ControlPlaneSummary;
  counts: TopologyCounts;
}

function parseTime(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  // The server sends the Go zero time for a node that never reported.
  return Number.isNaN(ms) || ms < Date.UTC(2000, 0, 1) ? undefined : ms;
}

const SEVERITY: Record<TopoEdgeKind, Record<string, number>> = {
  probe: { failing: 0, lossy: 1, quiet: 2, unknown: 4, paused: 8 },
  chain: { failed: 0, drifted: 1, pending: 4, converged: 7 },
  check: { failing: 0, stale: 2, none: 4, up: 7 },
};

const BAND_SEVERITY: Record<LatencyBand, number> = { destructive: 3, warning: 5, "chart-2": 6, success: 7 };

export function edgeSeverity(kind: TopoEdgeKind, state: TopoEdgeState, band?: LatencyBand): number {
  if (kind === "probe" && state === "measured") return band ? BAND_SEVERITY[band] : 3;
  return SEVERITY[kind][state] ?? 5;
}

/** A chain row's status in the four words the drawing uses. */
export function chainState(row: Pick<LineChainView, "status" | "attempt">): ChainState {
  switch (row.status) {
    case "converged":
      return "converged";
    case "drifted":
      return "drifted";
    case "failed":
      return "failed";
    default:
      return row.attempt?.status === "failed" ? "failed" : "pending";
  }
}

function emptyNode(id: string, name: string, country?: string): TopoNode {
  return {
    id,
    name: name || id,
    country: country || undefined,
    region: regionOf(country),
    probeSource: false,
    relay: false,
    exit: false,
    checkSource: false,
    incidents: 0,
    listed: false,
  };
}

function compareMembers(a: TopoNode, b: TopoNode): number {
  return (
    regionRank(a.region) - regionRank(b.region) ||
    (a.country ?? "~").localeCompare(b.country ?? "~") ||
    a.name.localeCompare(b.name) ||
    a.id.localeCompare(b.id)
  );
}

const SERVER_EVALUATED = new Set(["tls"]);

/** An every-node check with more sources than this draws only the ones that are not up. */
export const CHECK_FAN = 6;

/** The whole model for one layer and window. */
export function buildTopology(input: TopologyInput): TopologyModel {
  const { plan, rollups, window, layer, now } = input;
  const nodes = new Map<string, TopoNode>();

  for (const node of input.nodes ?? []) {
    const status = nodeStatus(node);
    nodes.set(node.id, {
      ...emptyNode(node.id, node.name, node.geo?.country),
      status,
      freshness: FRESHNESS[status],
      lastSeenAt: parseTime(node.last_seen),
      listed: true,
    });
  }
  const planNodes = new Map<string, LatencyProbeNode>((plan?.nodes ?? []).map((n) => [n.node_id, n]));
  for (const pn of planNodes.values()) {
    let node = nodes.get(pn.node_id);
    if (!node) {
      node = emptyNode(pn.node_id, pn.name, pn.country);
      nodes.set(pn.node_id, node);
    }
    if (!node.country && pn.country) {
      node.country = pn.country;
      node.region = regionOf(pn.country);
    }
    node.probeTarget = pn.target;
    node.targetReason = pn.target_reason;
    node.endpointNote = pn.endpoint_note;
    node.endpoint = pn.endpoint;
  }
  const ensure = (id: string): TopoNode => {
    let node = nodes.get(id);
    if (!node) {
      node = emptyNode(id, id);
      nodes.set(id, node);
    }
    return node;
  };

  for (const incident of input.incidents ?? []) {
    if (!incident.node_id || incident.id.startsWith("pending:")) continue;
    if (incident.state !== "open" && incident.state !== "acknowledged") continue;
    const node = nodes.get(incident.node_id);
    if (node) node.incidents += 1;
  }

  const edges: TopoEdge[] = [];
  const counts: TopologyCounts = {
    paths: 0,
    failing: 0,
    lossy: 0,
    quiet: 0,
    unknown: 0,
    paused: 0,
    chains: 0,
    chainsBroken: 0,
    chainsUnplaced: 0,
    checks: 0,
    checksFailing: 0,
  };
  const showProbes = layer === "all" || layer === "probes";
  const showChains = layer === "all" || layer === "chains";
  const showChecks = layer === "all" || layer === "checks";

  /* ---- Probes ---- */
  const sources: TopoNode[] = [];
  if (plan) {
    const quietAfter = quietAfterMs(plan.config.interval_sec);
    const pairs = new Map(plan.pairs.map((p) => [pairKey(p.source, p.target), p]));
    const rollupByPair = new Map((rollups?.pairs ?? []).map((r) => [pairKey(r.source, r.target), r]));
    const columns = latencySources(plan).filter((s) => !s.note);
    for (const column of columns) {
      const node = ensure(column.nodeId);
      node.probeSource = true;
      if (node.name === node.id && column.name) node.name = column.name;
      if (showProbes) sources.push(node);
    }
    if (showProbes) {
      for (const target of plan.nodes.filter(isTarget)) {
        for (const column of columns) {
          const key = pairKey(column.nodeId, target.node_id);
          const pair = pairs.get(key);
          const rollup = rollupByPair.get(key);
          const cell = latencyCell(plan, column, target, pair, rollup, window, "p50");
          if (cell.kind === "self" || cell.kind === "notProbeable") continue;
          if (cell.kind === "paused" && cell.pausedReason === "source") continue;
          let state: ProbeState;
          if (cell.kind === "paused") state = "paused";
          else if (cell.kind === "unknown") state = "unknown";
          else if (cell.kind === "failing") state = "failing";
          else state = (cell.loss ?? 0) >= LOSS_ATTENTION ? "lossy" : "measured";
          const latestAt = parseTime(rollup?.latest?.at);
          let quietReason: TopoEdge["quietReason"];
          if (state === "measured" || state === "lossy" || state === "failing") {
            const source = nodes.get(column.nodeId);
            if (source?.freshness === "quiet" || source?.freshness === "never") quietReason = "source";
            else if (latestAt !== undefined && now - latestAt > quietAfter) quietReason = "old";
            if (quietReason) state = "quiet";
          }
          const edge: TopoEdge = {
            id: `probe:${key}`,
            kind: "probe",
            from: column.nodeId,
            to: target.node_id,
            state,
            severity: 0,
            band: cell.band,
            p50Ms: cell.p50Ms,
            p95Ms: cell.p95Ms,
            loss: cell.loss,
            samples: cell.samples,
            expected: cell.expected,
            coverage: cell.coverage,
            partial: cell.partial,
            pausedReason: cell.pausedReason,
            quietReason,
            monitorId: pair?.monitor_id,
          };
          if (rollup?.latest && latestAt !== undefined) {
            edge.last = { at: latestAt, ok: rollup.latest.success, ms: rollup.latest.latency_ms, error: rollup.latest.error };
          }
          edge.severity = edgeSeverity("probe", state, cell.band);
          edges.push(edge);
          counts.paths += 1;
          if (state === "failing") counts.failing += 1;
          else if (state === "lossy") counts.lossy += 1;
          else if (state === "quiet") counts.quiet += 1;
          else if (state === "unknown") counts.unknown += 1;
          else if (state === "paused") counts.paused += 1;
        }
      }
    }
  }

  /* ---- Chains ---- */
  for (const row of input.chains ?? []) {
    const target = row.current?.target_node_id;
    if (!showChains) continue;
    if (!target || !row.source_node_id) {
      counts.chainsUnplaced += 1;
      continue;
    }
    const relay = ensure(row.source_node_id);
    const exit = ensure(target);
    relay.relay = true;
    exit.exit = true;
    const state = chainState(row);
    edges.push({
      id: `chain:${row.source_line_uuid}`,
      kind: "chain",
      from: relay.id,
      to: exit.id,
      state,
      severity: edgeSeverity("chain", state),
      chain: {
        status: row.status,
        sourceLine: row.source_line_uuid,
        targetLine: row.current?.target_line_uuid,
        error: row.last_error || row.attempt?.error || undefined,
      },
    });
    counts.chains += 1;
    if (state === "failed" || state === "drifted") counts.chainsBroken += 1;
  }

  /* ---- Checks ---- */
  const checks: TopoCheck[] = [];
  if (showChecks) {
    const runners = [...nodes.values()].filter((n) => n.listed && n.status !== "disabled").map((n) => n.id);
    for (const monitor of input.monitors ?? []) {
      if (monitor.managed_by) continue;
      const serverEvaluated = SERVER_EVALUATED.has(monitor.type);
      const latest = new Map((monitor.latest ?? []).map((l) => [l.node_id ?? "", l]));
      const staleAfter = quietAfterMs(monitor.interval_sec);
      let sourceIds: string[];
      if (serverEvaluated) sourceIds = [CONTROL_PLANE];
      else if (monitor.assign_all) sourceIds = [...new Set([...runners, ...[...latest.keys()].filter(Boolean)])].sort();
      else sourceIds = [...new Set(monitor.node_ids ?? [])].sort();
      const check: TopoCheck = {
        id: checkEndpoint(monitor.id),
        monitorId: monitor.id,
        name: monitor.name || monitor.id,
        type: monitor.type,
        target: monitor.target,
        enabled: monitor.enabled,
        serverEvaluated,
        assignAll: !!monitor.assign_all && !serverEvaluated,
        sourceIds,
        summary: { up: 0, failing: 0, stale: 0, none: 0 },
        fannedOut: false,
      };
      const perSource = sourceIds.map((sourceId) => {
        const result = latest.get(serverEvaluated ? "" : sourceId);
        const at = parseTime(result?.at);
        let state: CheckState = "none";
        if (result && at !== undefined) state = now - at > staleAfter ? "stale" : result.success ? "up" : "failing";
        check.summary[state] += 1;
        return { sourceId, result, at, state };
      });
      check.fannedOut = check.assignAll && perSource.length > CHECK_FAN;
      for (const { sourceId, result, at, state } of perSource) {
        if (sourceId !== CONTROL_PLANE) ensure(sourceId).checkSource = true;
        // An every-node check draws the sources with news; the rest are counted on the check.
        if (check.fannedOut && state === "up") continue;
        if (!monitor.enabled) continue;
        edges.push({
          id: `check:${monitor.id}:${sourceId}`,
          kind: "check",
          from: sourceId,
          to: check.id,
          state,
          severity: edgeSeverity("check", state),
          monitorId: monitor.id,
          last: result && at !== undefined ? { at, ok: result.success, ms: result.latency_ms, error: result.error } : undefined,
        });
      }
      checks.push(check);
      counts.checks += 1;
      if (monitor.enabled && check.summary.failing > 0) counts.checksFailing += 1;
    }
    checks.sort((a, b) => Number(b.summary.failing > 0) - Number(a.summary.failing > 0) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  }

  /* ---- Columns ---- */
  const left = new Set(sources.map((s) => s.id));
  const inLayer = (node: TopoNode): boolean => {
    if (left.has(node.id)) return false;
    switch (layer) {
      case "all":
        return true;
      case "probes":
        return node.probeTarget === "probed" || node.probeTarget === "paused" || node.probeTarget === "not_probeable";
      case "chains":
        return node.relay || node.exit;
      case "checks":
        return node.checkSource;
    }
  };
  const members = [...nodes.values()].filter(inLayer).sort(compareMembers);

  const cp: ControlPlaneSummary = { total: 0, fresh: 0, degraded: 0, quiet: 0, never: 0, disabled: 0, known: input.nodes !== undefined };
  for (const node of nodes.values()) {
    if (!node.listed || !node.freshness) continue;
    cp.total += 1;
    cp[node.freshness] += 1;
  }

  return { layer, window, nodes, sources, members, checks, edges, cp, counts };
}

/** The edges that touch one endpoint. */
export function edgesOf(model: Pick<TopologyModel, "edges">, id: string): TopoEdge[] {
  return model.edges.filter((e) => e.from === id || e.to === id);
}

/** What a node's row says about the probes into it: the worst one, and how many there are. */
export function rowProbe(model: Pick<TopologyModel, "edges">, nodeId: string): { edge: TopoEdge; count: number } | undefined {
  const into = model.edges.filter((e) => e.kind === "probe" && e.to === nodeId);
  if (into.length === 0) return undefined;
  const worst = into.reduce((a, b) => (b.severity < a.severity ? b : a));
  return { edge: worst, count: into.length };
}

/** Every path worst first, for the list and for the phone. */
export function pathsWorstFirst(model: Pick<TopologyModel, "edges" | "nodes" | "checks">): TopoEdge[] {
  const name = (id: string) => model.nodes.get(id)?.name ?? model.checks.find((c) => c.id === id)?.name ?? id;
  return [...model.edges].sort(
    (a, b) => a.severity - b.severity || (b.p50Ms ?? 0) - (a.p50Ms ?? 0) || name(a.to).localeCompare(name(b.to)) || a.id.localeCompare(b.id),
  );
}

/* ------------------------------------------------------------------ */
/* Edge style                                                           */
/* ------------------------------------------------------------------ */

export type EdgeStroke = "solid" | "dashed" | "dotted";

export interface EdgeStyle {
  /** A CSS custom property from src/style/app.css. */
  color: string;
  stroke: EdgeStroke;
  width: number;
}

const BAND_VAR: Record<LatencyBand, string> = {
  success: "--success",
  "chart-2": "--chart-2",
  warning: "--warning",
  destructive: "--destructive",
};

/**
 * One rule for every edge. A colour means a measurement or a state worth
 * reading; nothing heard is dotted grey and never a colour, and history from
 * a quiet source is dashed grey so it cannot pass for a live green.
 */
export function edgeStyle(edge: Pick<TopoEdge, "kind" | "state" | "band">): EdgeStyle {
  switch (edge.kind) {
    case "probe":
      switch (edge.state) {
        case "measured":
          return { color: BAND_VAR[edge.band ?? "destructive"], stroke: "solid", width: 1.5 };
        case "lossy":
          return { color: BAND_VAR[edge.band ?? "destructive"], stroke: "solid", width: 2.5 };
        case "failing":
          return { color: "--destructive", stroke: "dashed", width: 2 };
        case "quiet":
          return { color: "--muted-foreground", stroke: "dashed", width: 1.25 };
        case "paused":
          return { color: "--muted-foreground", stroke: "dashed", width: 1 };
        default:
          return { color: "--muted-foreground", stroke: "dotted", width: 1.25 };
      }
    case "chain":
      switch (edge.state) {
        case "converged":
          return { color: "--primary", stroke: "solid", width: 2 };
        case "drifted":
          return { color: "--warning", stroke: "solid", width: 2 };
        case "failed":
          return { color: "--destructive", stroke: "dashed", width: 2 };
        default:
          return { color: "--info", stroke: "dashed", width: 1.5 };
      }
    case "check":
      switch (edge.state) {
        case "up":
          return { color: "--success", stroke: "solid", width: 1.25 };
        case "failing":
          return { color: "--destructive", stroke: "solid", width: 2 };
        case "stale":
          return { color: "--muted-foreground", stroke: "dashed", width: 1.25 };
        default:
          return { color: "--muted-foreground", stroke: "dotted", width: 1.25 };
      }
  }
}

/* ------------------------------------------------------------------ */
/* Layout                                                               */
/* ------------------------------------------------------------------ */

export const ROW_H = 32;
export const HEADER_H = 24;
export const GROUP_GAP = 8;
export const CP_H = 64;
export const SOURCE_H = 56;
export const SOURCE_GAP = 12;
export const CHECK_H = 52;
export const CHECK_GAP = 8;
export const LEFT_W = 208;
export const CHECK_W = 232;
/** Rows past this fold by country. */
export const COLLAPSE_AT = 60;

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type LayoutRow =
  | { type: "header"; key: string; region: RegionKey; count: number; y: number; h: number }
  | { type: "node"; key: string; node: TopoNode; y: number; h: number; indent: boolean }
  | { type: "country"; key: string; country: string; region: RegionKey; members: TopoNode[]; expanded: boolean; y: number; h: number };

export interface LayoutEdge {
  /** The worst edge of the bundle; the one the drawing styles and the card shows. */
  edge: TopoEdge;
  /** Edges folded into this line (1 when nothing folded). */
  bundle: TopoEdge[];
  key: string;
  d: string;
  /** Where the line ends, and which way it points there (1 right, -1 left), for an arrowhead. */
  end: { x: number; y: number; dir: 1 | -1 };
}

export interface TopologyLayout {
  width: number;
  height: number;
  cp: Box;
  sources: { node: TopoNode; box: Box }[];
  rowsX: number;
  rowsW: number;
  rows: LayoutRow[];
  checks: { check: TopoCheck; box: Box }[];
  edges: LayoutEdge[];
  /** Countries folded into one row each. */
  collapsed: boolean;
  /** Endpoint id to the row or box key it is drawn at. */
  anchorOf: Map<string, string>;
}

export interface LayoutOptions {
  width: number;
  /** Countries the operator opened while folded. */
  expanded?: ReadonlySet<string>;
  collapseAt?: number;
}

const r1 = (n: number) => Math.round(n * 10) / 10;

function bezier(x1: number, y1: number, x2: number, y2: number): string {
  const dx = Math.max(24, (x2 - x1) * 0.5);
  return `M${r1(x1)} ${r1(y1)} C${r1(x1 + dx)} ${r1(y1)} ${r1(x2 - dx)} ${r1(y2)} ${r1(x2)} ${r1(y2)}`;
}

function arc(x: number, y1: number, y2: number): string {
  const bulge = 14 + Math.min(64, Math.abs(y2 - y1) * 0.18);
  return `M${r1(x)} ${r1(y1)} C${r1(x + bulge)} ${r1(y1)} ${r1(x + bulge)} ${r1(y2)} ${r1(x)} ${r1(y2)}`;
}

/**
 * A line from the left column to a check would cross the tall column, which
 * hides it behind its rows and shows it in every gap between them. It rides a
 * lane above the column instead: up, across, and down into the check.
 */
export const TOP_LANE = -10;

function overTheTop(x1: number, y1: number, x2: number, y2: number): string {
  const lane = TOP_LANE;
  return (
    `M${r1(x1)} ${r1(y1)} C${r1(x1 + 40)} ${r1(y1)} ${r1(x1 + 40)} ${lane} ${r1(x1 + 80)} ${lane} ` +
    `L${r1(x2 - 80)} ${lane} C${r1(x2 - 40)} ${lane} ${r1(x2 - 40)} ${r1(y2)} ${r1(x2)} ${r1(y2)}`
  );
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Where everything is drawn, for one width. Same model and width, same picture. */
export function layoutTopology(model: TopologyModel, options: LayoutOptions): TopologyLayout {
  const width = Math.max(560, Math.floor(options.width));
  const expanded = options.expanded ?? new Set<string>();
  const collapsed = model.members.length > (options.collapseAt ?? COLLAPSE_AT);
  const hasChains = model.edges.some((e) => e.kind === "chain");
  const hasChecks = model.checks.length > 0;

  const arcW = hasChains ? 80 : 16;
  const checkW = hasChecks ? CHECK_W : 0;
  const checkGap = hasChecks ? 56 : 0;
  const rowsW = clamp(Math.round(width * 0.3), 260, 380);
  const spare = width - LEFT_W - rowsW - arcW - checkW - checkGap;
  const gapLR = clamp(spare, 72, 300);
  const rowsX = LEFT_W + gapLR;
  const checksX = hasChecks ? Math.max(rowsX + rowsW + arcW + checkGap, width - checkW) : 0;
  // Narrower than the columns need: the drawing keeps its columns and its frame scrolls sideways.
  const drawnWidth = Math.max(width, hasChecks ? checksX + checkW : rowsX + rowsW + arcW);

  /* ---- The tall column ---- */
  const rows: LayoutRow[] = [];
  let y = 0;
  const groups = new Map<RegionKey, TopoNode[]>();
  for (const node of model.members) {
    const list = groups.get(node.region) ?? [];
    list.push(node);
    groups.set(node.region, list);
  }
  const anchorOf = new Map<string, string>();
  for (const region of REGION_ORDER) {
    const list = groups.get(region);
    if (!list?.length) continue;
    if (rows.length) y += GROUP_GAP;
    rows.push({ type: "header", key: `region:${region}`, region, count: list.length, y, h: HEADER_H });
    y += HEADER_H;
    if (!collapsed) {
      for (const node of list) {
        rows.push({ type: "node", key: node.id, node, y, h: ROW_H, indent: false });
        anchorOf.set(node.id, node.id);
        y += ROW_H;
      }
      continue;
    }
    const byCountry = new Map<string, TopoNode[]>();
    for (const node of list) {
      const code = node.country?.toUpperCase() || "??";
      const members = byCountry.get(code) ?? [];
      members.push(node);
      byCountry.set(code, members);
    }
    for (const [country, members] of byCountry) {
      const key = `country:${country}`;
      const open = expanded.has(country);
      rows.push({ type: "country", key, country, region, members, expanded: open, y, h: ROW_H });
      y += ROW_H;
      for (const node of members) {
        if (open) {
          rows.push({ type: "node", key: node.id, node, y, h: ROW_H, indent: true });
          anchorOf.set(node.id, node.id);
          y += ROW_H;
        } else {
          anchorOf.set(node.id, key);
        }
      }
    }
  }
  const rowsHeight = y;
  const rowByKey = new Map(rows.map((row) => [row.key, row]));

  /* ---- Left column ---- */
  const cp: Box = { x: 0, y: 0, w: LEFT_W, h: CP_H };
  anchorOf.set(CONTROL_PLANE, CONTROL_PLANE);
  const block = model.sources.length * SOURCE_H + Math.max(0, model.sources.length - 1) * SOURCE_GAP;
  let sy = Math.max(CP_H + 24, Math.round((rowsHeight - block) / 2));
  const sources = model.sources.map((node) => {
    const box: Box = { x: 0, y: sy, w: LEFT_W, h: SOURCE_H };
    anchorOf.set(node.id, `source:${node.id}`);
    sy += SOURCE_H + SOURCE_GAP;
    return { node, box };
  });
  const sourceBox = new Map(sources.map((s) => [`source:${s.node.id}`, s.box]));

  /* ---- Checks ---- */
  const checkBlock = model.checks.length * CHECK_H + Math.max(0, model.checks.length - 1) * CHECK_GAP;
  let cy = Math.max(0, Math.round((rowsHeight - checkBlock) / 2));
  const checks = model.checks.map((check) => {
    const box: Box = { x: checksX, y: cy, w: checkW, h: CHECK_H };
    anchorOf.set(check.id, check.id);
    cy += CHECK_H + CHECK_GAP;
    return { check, box };
  });
  const checkBox = new Map(checks.map((c) => [c.check.id, c.box]));

  /* ---- Edges ---- */
  type Anchor = { kind: "left" | "row" | "check"; xl: number; xr: number; y: number };
  const anchor = (id: string): Anchor | undefined => {
    const key = anchorOf.get(id);
    if (!key) return undefined;
    if (key === CONTROL_PLANE) return { kind: "left", xl: cp.x, xr: cp.x + cp.w, y: cp.y + cp.h / 2 };
    const sb = sourceBox.get(key);
    if (sb) return { kind: "left", xl: sb.x, xr: sb.x + sb.w, y: sb.y + sb.h / 2 };
    const cb = checkBox.get(key);
    if (cb) return { kind: "check", xl: cb.x, xr: cb.x + cb.w, y: cb.y + cb.h / 2 };
    const row = rowByKey.get(key);
    if (row) return { kind: "row", xl: rowsX, xr: rowsX + rowsW, y: row.y + row.h / 2 };
    return undefined;
  };

  const bundles = new Map<string, { edges: TopoEdge[]; from: Anchor; to: Anchor; fromKey: string; toKey: string }>();
  for (const edge of model.edges) {
    const from = anchor(edge.from);
    const to = anchor(edge.to);
    if (!from || !to) continue;
    const fromKey = anchorOf.get(edge.from)!;
    const toKey = anchorOf.get(edge.to)!;
    if (fromKey === toKey) continue; // a chain inside one folded country
    const key = `${edge.kind}:${fromKey}>${toKey}`;
    const entry = bundles.get(key);
    if (entry) entry.edges.push(edge);
    else bundles.set(key, { edges: [edge], from, to, fromKey, toKey });
  }

  const edges: LayoutEdge[] = [];
  for (const [key, { edges: list, from, to }] of bundles) {
    const worst = list.reduce((a, b) => (b.severity < a.severity ? b : a));
    let d: string;
    let end: LayoutEdge["end"];
    // A chain out of a probe source rides 6 px below the probe to the same row, so the two never merge.
    const lift = worst.kind === "chain" && from.kind === "left" ? 6 : 0;
    if (from.kind === "row" && to.kind === "row") {
      d = arc(from.xr, from.y, to.y);
      end = { x: from.xr, y: to.y, dir: -1 };
    } else if (to.kind === "check" && from.kind === "left" && model.members.length > 0) {
      d = overTheTop(from.xr, from.y, to.xl, to.y);
      end = { x: to.xl, y: to.y, dir: 1 };
    } else if (to.kind === "check") {
      d = bezier(from.xr, from.y, to.xl, to.y);
      end = { x: to.xl, y: to.y, dir: 1 };
    } else if (from.kind === "row" && to.kind === "left") {
      d = bezier(to.xr, to.y, from.xl, from.y);
      end = { x: to.xr, y: to.y, dir: -1 };
    } else if (from.kind === "left" && to.kind === "left") {
      d = arc(from.xr, from.y, to.y);
      end = { x: from.xr, y: to.y, dir: -1 };
    } else {
      d = bezier(from.xr, from.y + lift, to.xl, to.y + lift);
      end = { x: to.xl, y: to.y + lift, dir: 1 };
    }
    edges.push({ edge: worst, bundle: list, key, d, end });
  }
  // Worst drawn last, so a red line is never under a green one.
  edges.sort((a, b) => b.edge.severity - a.edge.severity || a.key.localeCompare(b.key));

  const lastSource = sources[sources.length - 1];
  const lastCheck = checks[checks.length - 1];
  const height = Math.max(
    rowsHeight,
    cp.y + cp.h,
    lastSource ? lastSource.box.y + lastSource.box.h : 0,
    lastCheck ? lastCheck.box.y + lastCheck.box.h : 0,
  );

  return { width: drawnWidth, height, cp, sources, rowsX, rowsW, rows, checks, edges, collapsed, anchorOf };
}

/** The endpoints a hovered endpoint lights: itself and everything one edge away. */
export function neighbourhood(model: Pick<TopologyModel, "edges">, id: string): Set<string> {
  const out = new Set<string>([id]);
  for (const edge of model.edges) {
    if (edge.from === id) out.add(edge.to);
    if (edge.to === id) out.add(edge.from);
  }
  return out;
}
