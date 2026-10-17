/**
 * The Topology layer of Monitoring: the fleet's paths as one deterministic
 * drawing, from the reads the page already makes.
 *
 *   control plane   every node's heartbeat freshness, counted (the relation
 *                   is the same for every node, so it is drawn once, as a
 *                   count, and as a mark on each node, never as 34 lines)
 *   probes          the path set's paths, source to target, from the same
 *                   matrix Paths draws (usePathsData) at the page's window;
 *                   an edge's state is the path's display state (up,
 *                   degraded, down, unknown, paused) and its colour that
 *                   state's tone, nothing else (design 29 D13)
 *   chains          relay line to exit node (GET /api/network/lines/chains)
 *   checks          operator monitors, from the nodes that run them (or the
 *                   control plane, for a certificate watch) to their target;
 *                   a source whose newest run passes on a path the matrix
 *                   judges degraded reads degraded, as the Checks list does
 *
 * Layout, left to right as traffic leaves the fleet: the control plane and
 * the drawn probe sources in a narrow left column (they are few; the picker
 * chooses which, the first four in the path set's order by default), each
 * drawing its own fan; every other node in one tall column grouped by region
 * in rough order of distance from mainland China, then by country, then by
 * name, each target row carrying one state mark per drawn source so
 * overlapping fans stay readable; chains as arcs on that column's right edge,
 * so a relay that is also a probe target keeps one row; checks in a right
 * column. Past COLLAPSE_AT rows each country folds into one row and the
 * edges into it fold into one, coloured by the worst.
 *
 * Kept free of Vue so `node --test` covers it directly.
 */
import type { Incident, LatencyProbeNode, LatencyProbePlan, LineChainView, MonitorView, Node } from "@/lib/api/types";
import { nodeStatus, type NodeStatus } from "@/lib/nodeStatus";
import { REGION_ORDER, regionOf, regionRank, type RegionKey } from "@/lib/regions";
import type { QueryValue } from "@/components/common/tableUrlState";
import { quietAfterMs } from "@/views/fleet/latencyModel";
import { cellKey, displayState, reasonCode, type PathDisplay, type PathItem, type PathsMatrix, type SourceReach } from "@/views/fleet/pathsModel";

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
 * A probe edge's state is its path's display state (pathsModel.displayState):
 * up, degraded, down, unknown (with the server's reason) or paused. The server
 * decides freshness, so a path whose source went quiet already reads unknown;
 * nothing here re-judges it with a clock.
 */
export type ProbeState = PathDisplay;
export type ChainState = "converged" | "pending" | "drifted" | "failed";
/** `degraded`: the newest run passed, but the control plane judges the path degraded (design 29 D13). */
export type CheckState = "up" | "degraded" | "failing" | "stale" | "none";
export type TopoEdgeKind = "probe" | "chain" | "check";
export type TopoEdgeState = ProbeState | ChainState | CheckState;

export interface TopoLastSample {
  at: number;
  /** The outcome, when it is known: a check's newest result has one; a probe path only says when it last heard. */
  ok?: boolean;
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
  p50Ms?: number;
  p95Ms?: number;
  loss?: number;
  samples?: number;
  expected?: number;
  /** A probe's reason as the server sent it: why it is unknown, paused or degraded. */
  reason?: string;
  /** A probe's method (tcp, icmp, beacon). */
  method?: string;
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
  /** The path set plan: its source order and each target's note; probe edges come from the matrix. */
  plan?: LatencyProbePlan;
  /** The shared matrix (usePathsData) at the page's window; undefined until read. */
  matrix?: Pick<PathsMatrix, "sources" | "paths" | "cells">;
  /** The sources the picker drew (`?topo.sources=`); undefined draws the default. */
  drawnSources?: readonly string[];
  /** Undefined when not read or not readable. */
  chains?: readonly LineChainView[];
  /** Every monitor the server listed; generated ones are left out here. */
  monitors?: readonly MonitorView[];
  incidents?: readonly Incident[];
  /** The page's window, for the words that name it. */
  window: string;
  layer: TopologyLayer;
  now: number;
}

export interface TopologyCounts {
  /** Probe paths drawn (the drawn sources' only). */
  paths: number;
  down: number;
  degraded: number;
  unknown: number;
  paused: number;
  chains: number;
  chainsBroken: number;
  /** Chains whose exit is not decided yet (only planned): not drawn. */
  chainsUnplaced: number;
  checks: number;
  checksFailing: number;
}

/** A source the picker lists: every path set source with its reach counts, drawn or not. */
export interface TopoSourceChoice {
  node: TopoNode;
  reach: SourceReach;
  drawn: boolean;
}

export interface TopologyModel {
  layer: TopologyLayer;
  window: string;
  /** Every node the reads named, by id. */
  nodes: Map<string, TopoNode>;
  /** The left column: the drawn probe sources, in the path set's order. */
  sources: TopoNode[];
  /** Every source the picker offers, in the path set's order. */
  sourceChoices: TopoSourceChoice[];
  /** The drawn sources' ids, in the picker's (the path set's) order: a target row's marks follow it. */
  drawnSourceIds: string[];
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
  probe: { down: 0, degraded: 1, unknown: 4, up: 7, paused: 8 },
  chain: { failed: 0, drifted: 1, pending: 4, converged: 7 },
  check: { failing: 0, degraded: 1, stale: 2, none: 4, up: 7 },
};

export function edgeSeverity(kind: TopoEdgeKind, state: TopoEdgeState): number {
  return SEVERITY[kind][state] ?? 5;
}

/** How many sources the drawing shows before the operator picks: a stable default that does not reorder as states change. */
export const DEFAULT_DRAWN_SOURCES = 4;

/** `?topo.sources=` read: node ids, comma separated, in the order given; empty is the default. */
export function parseDrawnSources(raw: QueryValue | undefined): string[] | undefined {
  const value = Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string").join(",") : raw;
  if (typeof value !== "string") return undefined;
  const ids = [...new Set(value.split(",").map((id) => id.trim()).filter(Boolean))];
  return ids.length ? ids : undefined;
}

/** `?topo.sources=` written: undefined when the choice is the default, so the bare address stays bare. */
export function formatDrawnSources(ids: readonly string[] | undefined, defaults: readonly string[]): string | undefined {
  if (!ids || ids.length === 0) return undefined;
  const same = ids.length === defaults.length && ids.every((id, i) => id === defaults[i]);
  return same ? undefined : ids.join(",");
}

/**
 * The path set's sources in its order, then any other source with a path to
 * a node; from the matrix alone when the plan is not read. A source the plan
 * notes (deleted or disabled) probes nothing and is left out, so it never
 * takes one of the default four places.
 */
export function probeSourceOrder(plan: Pick<LatencyProbePlan, "config" | "source_notes"> | undefined, matrix: Pick<PathsMatrix, "sources" | "paths"> | undefined): string[] {
  const noted = new Set(Object.keys(plan?.source_notes ?? {}));
  const probing = new Set((matrix?.paths ?? []).filter((p) => p.targetNode && !p.rowKey.startsWith("@") && p.source && !noted.has(p.source)).map((p) => p.source));
  const out: string[] = [];
  for (const id of plan?.config.sources ?? []) if (probing.has(id) && !out.includes(id)) out.push(id);
  for (const column of matrix?.sources ?? []) if (probing.has(column.nodeId) && !out.includes(column.nodeId)) out.push(column.nodeId);
  return out;
}

/** The sources drawn: the picker's choice that still probes, kept in the path set's order; else the first four. */
export function drawnSources(order: readonly string[], chosen: readonly string[] | undefined): string[] {
  const picked = chosen ? order.filter((id) => chosen.includes(id)) : [];
  return picked.length ? picked : order.slice(0, DEFAULT_DRAWN_SOURCES);
}

/** Reasons a path has nothing to dial on its target: no edge is drawn, and the row says "not probed". */
const NOTHING_TO_DIAL = new Set(["not_probeable", "no_tcp_line", "udp_only", "no_public_address", "no_inventory"]);

/** A path Topology draws as a probe: one the path set generated to a node, with something to dial. */
function isDrawnProbe(path: Pick<PathItem, "targetNode" | "rowKey" | "state" | "reason">): boolean {
  if (!path.targetNode || path.rowKey.startsWith("@")) return false;
  return !(path.state === "unknown" && NOTHING_TO_DIAL.has(reasonCode(path.reason) ?? path.reason ?? ""));
}

/**
 * Each source's reach as the drawing counts it (the picker's line): its
 * drawn probes by state, so "12 of 12 up" matches the fan, and a target with
 * nothing to dial is not counted as a problem.
 */
export function drawnReach(matrix: Pick<PathsMatrix, "sources" | "paths"> | undefined): Map<string, SourceReach> {
  const out = new Map<string, SourceReach>();
  for (const column of matrix?.sources ?? []) out.set(column.nodeId, { source: column.nodeId, name: column.name, up: 0, degraded: 0, down: 0, unknown: 0, paused: 0, total: 0 });
  for (const path of matrix?.paths ?? []) {
    if (!isDrawnProbe(path)) continue;
    const reach = out.get(path.source);
    if (!reach) continue;
    reach[displayState(path)] += 1;
    reach.total += 1;
  }
  return out;
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
  const { plan, matrix, window, layer, now } = input;
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
    down: 0,
    degraded: 0,
    unknown: 0,
    paused: 0,
    chains: 0,
    chainsBroken: 0,
    chainsUnplaced: 0,
    checks: 0,
    checksFailing: 0,
  };
  const showChains = layer === "all" || layer === "chains";
  const showChecks = layer === "all" || layer === "checks";

  /* ---- Probes ---- */
  const sources: TopoNode[] = [];
  const order = probeSourceOrder(plan, matrix);
  const drawn = drawnSources(order, input.drawnSources);
  const reachOf = drawnReach(matrix);
  const sourceName = new Map((matrix?.sources ?? []).map((s) => [s.nodeId, s.name]));
  const sourceChoices: TopoSourceChoice[] = order.map((id) => {
    const node = ensure(id);
    node.probeSource = true;
    if (node.name === node.id && sourceName.get(id)) node.name = sourceName.get(id)!;
    const reach = reachOf.get(id) ?? { source: id, name: node.name, up: 0, degraded: 0, down: 0, unknown: 0, paused: 0, total: 0 };
    return { node, reach, drawn: drawn.includes(id) };
  });
  const showProbes = layer === "all" || layer === "probes";
  if (showProbes) for (const id of drawn) sources.push(nodes.get(id)!);
  if (showProbes && matrix) {
    const drawnSet = new Set(drawn);
    for (const path of matrix.cells.values()) {
      // Your checks stay checks: a probe is a path the path set generated to a node.
      if (!isDrawnProbe(path) || !drawnSet.has(path.source)) continue;
      const target = ensure(path.targetNode!);
      if (target.name === target.id && path.targetNodeName) target.name = path.targetNodeName;
      if (!target.country && path.country) {
        target.country = path.country;
        target.region = regionOf(path.country);
      }
      if (!target.probeTarget || target.probeTarget === "none") target.probeTarget = "probed";
      const state = displayState(path);
      const edge: TopoEdge = {
        id: `probe:${path.source}~${path.targetNode}`,
        kind: "probe",
        from: path.source,
        to: path.targetNode!,
        state,
        severity: edgeSeverity("probe", state),
        p50Ms: path.p50Ms,
        p95Ms: path.p95Ms,
        loss: path.loss,
        samples: path.samples,
        expected: path.expected,
        reason: path.reason,
        method: path.method,
        monitorId: path.monitorId || undefined,
      };
      // The matrix says when the path last heard; only a down path's newest outcome is known (it failed).
      if (path.lastAt !== undefined) edge.last = { at: path.lastAt, ok: state === "down" ? false : undefined };
      edges.push(edge);
      counts.paths += 1;
      if (state === "down" || state === "degraded" || state === "unknown" || state === "paused") counts[state] += 1;
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
        summary: { up: 0, degraded: 0, failing: 0, stale: 0, none: 0 },
        fannedOut: false,
      };
      const perSource = sourceIds.map((sourceId) => {
        const result = latest.get(serverEvaluated ? "" : sourceId);
        const at = parseTime(result?.at);
        let state: CheckState = "none";
        if (result && at !== undefined) state = now - at > staleAfter ? "stale" : result.success ? "up" : "failing";
        // Degraded takes the warning tone wherever a path state is drawn (design 29 D13): a passing run on a
        // path the control plane judges degraded is not a green up. A check's path sits in its own matrix row.
        if (state === "up" && !serverEvaluated && matrix?.cells.get(cellKey(`@${monitor.id}`, sourceId))?.state === "degraded") state = "degraded";
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

  return { layer, window, nodes, sources, sourceChoices, drawnSourceIds: showProbes ? drawn : [], members, checks, edges, cp, counts };
}

/** The edges that touch one endpoint. */
export function edgesOf(model: Pick<TopologyModel, "edges">, id: string): TopoEdge[] {
  return model.edges.filter((e) => e.from === id || e.to === id);
}

/**
 * States that describe the path now. A stale check is history, unknown is
 * silence and paused is off: none of them says how the path behaves today.
 */
const LIVE: Record<TopoEdgeKind, ReadonlySet<string>> = {
  probe: new Set(["up", "degraded", "down"]),
  chain: new Set(["converged", "pending", "drifted", "failed"]),
  check: new Set(["up", "degraded", "failing"]),
};

export function isLive(edge: Pick<TopoEdge, "kind" | "state">): boolean {
  return LIVE[edge.kind].has(edge.state);
}

/**
 * The edge that speaks for several into one place (a row's probes, a folded
 * bundle): the worst of the live ones, and the worst of the rest only when
 * none is live. Severity alone ranks unknown above up, so one source whose
 * path went unknown would grey a row the other sources still measure. Lists
 * keep plain severity order.
 */
export function worstLive(edges: readonly TopoEdge[]): TopoEdge {
  const live = edges.filter(isLive);
  const pool = live.length ? live : edges;
  // Within one state the slowest speaks for the row, so a row of up paths shows its worst p50.
  return pool.reduce((a, b) => (b.severity < a.severity || (b.severity === a.severity && (b.p50Ms ?? -1) > (a.p50Ms ?? -1)) ? b : a));
}

/** What a node's row says about the probes into it: the worst live one, and how many there are. */
export function rowProbe(model: Pick<TopologyModel, "edges">, nodeId: string): { edge: TopoEdge; count: number } | undefined {
  const into = model.edges.filter((e) => e.kind === "probe" && e.to === nodeId);
  if (into.length === 0) return undefined;
  return { edge: worstLive(into), count: into.length };
}

/** A target row's word across its drawn sources: the state that speaks for it and how many of them read it. */
export interface RowSummary {
  /** The worst live state among the paths into the row, else the worst of the rest. */
  state: ProbeState;
  /** Drawn sources whose path reads that state. */
  n: number;
  /** Drawn sources with a path into the row. */
  of: number;
}

/**
 * With several sources drawn, a target row summarises across them ("down
 * from 1 of 4") rather than printing its worst edge: the worst edge alone
 * made one failing source read as the node being down while three others
 * reach it, and a p50 without its source said nothing true. Undefined with
 * one drawn source, whose edge says it all, and for a row no path enters.
 */
export function rowSummary(model: Pick<TopologyModel, "edges" | "drawnSourceIds">, nodeId: string): RowSummary | undefined {
  if (model.drawnSourceIds.length < 2) return undefined;
  const into = model.edges.filter((e) => e.kind === "probe" && e.to === nodeId);
  if (into.length === 0) return undefined;
  const state = worstLive(into).state as ProbeState;
  return { state, n: into.filter((e) => e.state === state).length, of: into.length };
}

/**
 * A target row's marks: one per drawn source, in the picker's order, so the
 * fans that overlap on the row stay readable; undefined where that source has
 * no path to it.
 */
export function rowMarks(model: Pick<TopologyModel, "edges" | "drawnSourceIds">, nodeId: string): { source: string; state?: ProbeState }[] {
  const into = new Map(model.edges.filter((e) => e.kind === "probe" && e.to === nodeId).map((e) => [e.from, e.state as ProbeState]));
  return model.drawnSourceIds.map((source) => ({ source, state: into.get(source) }));
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
  /**
   * Drawn as two rails (the colour, with the card's colour down its middle).
   * Chains carry it so that shape, not only hue, tells them from probes.
   */
  double?: boolean;
}

/** A probe state's tone token: state tones are the only saturated colour (design 29 D13). */
export const PROBE_TONE: Record<ProbeState, string> = {
  up: "--success",
  degraded: "--warning",
  down: "--destructive",
  unknown: "--muted-foreground",
  paused: "--muted-foreground",
};

/**
 * One rule for every edge. A probe's colour is its state's tone and nothing
 * else (the latency bands that coloured edges were a second saturated
 * scale): up, degraded and down solid; unknown dashed and paused dotted, both
 * muted, so neither can pass for a live green.
 */
export function edgeStyle(edge: Pick<TopoEdge, "kind" | "state">): EdgeStyle {
  switch (edge.kind) {
    case "probe":
      switch (edge.state) {
        case "up":
          return { color: PROBE_TONE.up, stroke: "solid", width: 1.5 };
        case "degraded":
          return { color: PROBE_TONE.degraded, stroke: "solid", width: 2 };
        case "down":
          return { color: PROBE_TONE.down, stroke: "solid", width: 2.5 };
        case "paused":
          return { color: PROBE_TONE.paused, stroke: "dotted", width: 1.25 };
        default:
          return { color: PROBE_TONE.unknown, stroke: "dashed", width: 1.25 };
      }
    case "chain":
      switch (edge.state) {
        case "converged":
          return { color: "--primary", stroke: "solid", width: 4.5, double: true };
        case "drifted":
          return { color: "--warning", stroke: "solid", width: 4.5, double: true };
        case "failed":
          return { color: "--destructive", stroke: "dashed", width: 4.5, double: true };
        default:
          return { color: "--info", stroke: "dashed", width: 4.5, double: true };
      }
    case "check":
      switch (edge.state) {
        case "up":
          return { color: "--success", stroke: "solid", width: 1.25 };
        case "degraded":
          return { color: "--warning", stroke: "solid", width: 1.75 };
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
/** Where the first probe source sits: right under the control plane box. */
export const SOURCES_TOP = CP_H + 24;
/** Rows past this fold by country. */
export const COLLAPSE_AT = 60;
/**
 * With several sources drawn, a target row also carries a summary across
 * them ("degraded from 1 of 6") and one mark per source, all of which keep
 * their width, so the name gets what is left. The row column grows by the
 * summary's extra width and a mark's width per drawn source, taken from the
 * width the fan gap does not need, so the name keeps its room as sources are
 * added. The fan never narrows below FAN_MIN_W for it.
 */
export const ROW_SUMMARY_EXTRA_W = 96;
export const ROW_MARK_W = 10;
export const FAN_MIN_W = 160;

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
  const drawnCount = model.drawnSourceIds.length;
  const baseRowsW = clamp(Math.round(width * 0.3), 260, 380);
  const rowsExtra = drawnCount > 1 ? ROW_SUMMARY_EXTRA_W + ROW_MARK_W * drawnCount : 0;
  const rowsW = baseRowsW + clamp(width - LEFT_W - baseRowsW - arcW - checkW - checkGap - FAN_MIN_W, 0, rowsExtra);
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
  // The sources sit right under the control plane and the checks start at
  // the top, so the fan's origin and the first check are on the first screen
  // however tall the column grows. Curves to the bottom of the column get
  // longer; an origin below the fold cost more.
  const cp: Box = { x: 0, y: 0, w: LEFT_W, h: CP_H };
  anchorOf.set(CONTROL_PLANE, CONTROL_PLANE);
  let sy = SOURCES_TOP;
  const sources = model.sources.map((node) => {
    const box: Box = { x: 0, y: sy, w: LEFT_W, h: SOURCE_H };
    anchorOf.set(node.id, `source:${node.id}`);
    sy += SOURCE_H + SOURCE_GAP;
    return { node, box };
  });
  const sourceBox = new Map(sources.map((s) => [`source:${s.node.id}`, s.box]));

  /* ---- Checks ---- */
  let cy = 0;
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
    const worst = worstLive(list);
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

/* ------------------------------------------------------------------ */
/* Reads                                                                */
/* ------------------------------------------------------------------ */

/**
 * The reads the drawing is made of. The layer makes the first two and the
 * chains read; the page makes the node list, incidents and monitors, which it
 * polls for its other layers anyway.
 */
export type TopoRead = "plan" | "paths" | "nodes" | "incidents" | "monitors" | "chains";

export interface TopoReadStatus {
  /** The session holds the scope the read needs; a read it cannot make is never sent. */
  allowed: boolean;
  /** A read has landed at least once. */
  hasData: boolean;
  /** The latest attempt failed. */
  failed: boolean;
}

export type TopoReadStatuses = Record<TopoRead, TopoReadStatus>;

/** Where one read stands, in the words the drawing uses. */
export type TopoReadState = "unreadable" | "loading" | "failed" | "read";

export function readState(status: TopoReadStatus): TopoReadState {
  if (!status.allowed) return "unreadable";
  if (status.hasData) return "read";
  return status.failed ? "failed" : "loading";
}

/**
 * The reads a layer's drawing is built from, in the order the proof line
 * names a failure. The proof line speaks for exactly these: its age is the
 * oldest of them and its error the first, so a failed monitor list cannot
 * hide behind a fresh probe plan.
 */
export function readsFor(layer: TopologyLayer, statuses: TopoReadStatuses): TopoRead[] {
  const out: TopoRead[] = ["plan"];
  if (layer === "all" || layer === "probes") out.push("paths");
  out.push("nodes", "incidents");
  if (layer === "all" || layer === "checks") out.push("monitors");
  if (layer === "all" || layer === "chains") out.push("chains");
  return out.filter((read) => statuses[read].allowed);
}

/**
 * Reads the layer needs that never landed and whose last attempt failed.
 * The drawing is missing their part outright (no heartbeats, no incident
 * marks, no checks), so each gets a line that says so, with a retry. A
 * failed refresh after a good read is only stale, and the proof line already
 * says that.
 */
export function missingReads(layer: TopologyLayer, statuses: TopoReadStatuses): TopoRead[] {
  return readsFor(layer, statuses).filter((read) => readState(statuses[read]) === "failed");
}

/** Why a filter has nothing to draw, or "loading" while the read it needs is still on its way. */
export type TopologyEmpty = "noSources" | "chainsDenied" | "chainsFailed" | "noChains" | "monitorsFailed" | "noChecks" | "noNodes";

export function layerEmpty(
  model: Pick<TopologyModel, "layer" | "sources" | "members" | "checks" | "counts">,
  statuses: TopoReadStatuses,
): TopologyEmpty | "loading" | null {
  switch (model.layer) {
    case "probes":
      return model.sources.length === 0 ? "noSources" : null;
    case "chains":
      switch (readState(statuses.chains)) {
        case "unreadable":
          return "chainsDenied";
        case "failed":
          return "chainsFailed";
        case "loading":
          return "loading";
        default:
          return model.counts.chains === 0 ? "noChains" : null;
      }
    case "checks":
      // An unread monitor list is not an empty one: "No checks yet" would be a guess.
      switch (readState(statuses.monitors)) {
        case "failed":
          return "monitorsFailed";
        case "loading":
          return "loading";
        default:
          return model.checks.length === 0 ? "noChecks" : null;
      }
    default:
      return model.members.length === 0 && model.sources.length === 0 ? "noNodes" : null;
  }
}
