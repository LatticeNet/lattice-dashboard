/**
 * The graph mode of Monitoring's Network view (design 32 D2): the fleet's
 * paths as one deterministic drawing, from the reads the page already makes.
 *
 *   control plane   every node's heartbeat freshness, counted (the relation
 *                   is the same for every node, so it is drawn once, as a
 *                   count, and as a mark on each node, never as 34 lines)
 *   paths           every path the matrix holds (usePathsData) at the page's
 *                   window, the path set's and the operator's checks alike,
 *                   from the drawn sources: one edge per pair of endpoints,
 *                   in the path's display state (up, degraded, down, unknown
 *                   with its reason, paused) and that state's tone only
 *                   (design 29 D13). A check to a node is an edge between two
 *                   real nodes; a check to an address ends at one terminal
 *                   per address. Several checks on one pair draw one edge,
 *                   which lists each of them
 *   chains          relay line to exit node (GET /api/network/lines/chains)
 *
 * Layout, left to right as traffic leaves the fleet: the control plane and
 * the drawn sources in a narrow left column (they are few; the picker
 * chooses which, the first four in the path set's order by default), each
 * drawing its own fan; every other node in one tall column grouped by region
 * in rough order of distance from mainland China, then by country, then by
 * name, each target row carrying one state mark per drawn source so
 * overlapping fans stay readable; chains as arcs on that column's right edge,
 * so a relay that is also a target keeps one row; address terminals in a
 * right column. Past COLLAPSE_AT rows each country folds into one row and
 * the edges into it fold into one, coloured by the worst.
 *
 * The page's query (the same grammar and the same ?paths.q= as list mode)
 * never removes anything from the drawing: matching edges and their ends keep
 * full strength and the rest fade, and every source with a matching path is
 * drawn while the query holds, so no match hides behind the picker.
 *
 * Kept free of Vue so `node --test` covers it directly.
 */
import type { Incident, LatencyProbeNode, LatencyProbePlan, LineChainView, Node } from "@/lib/api/types";
import { nodeStatus, type NodeStatus } from "@/lib/nodeStatus";
import { REGION_ORDER, regionOf, regionRank, type RegionKey } from "@/lib/regions";
import type { QueryValue } from "@/components/common/tableUrlState";
import { worstFirst } from "@/views/fleet/nodePathsModel";
import { countPaths, displayState, reachBySource, type PathCounts, type PathDisplay, type PathItem, type PathsMatrix, type SourceReach } from "@/views/fleet/pathsModel";

export { REGION_ORDER, regionOf, regionRank, type RegionKey };

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
  /** A drawn source or a source the picker offers. */
  source: boolean;
  /** The path set's word on the node as a target: probed, paused, not_probeable or none. */
  probeTarget?: string;
  targetReason?: string;
  endpointNote?: string;
  endpoint?: string;
  relay: boolean;
  exit: boolean;
  /** Open or acknowledged incidents on the node. */
  incidents: number;
  /** In the node list; false for a node only the plan, the matrix or a chain named. */
  listed: boolean;
}

/** Endpoint id of the control plane; node ids never start with "@". */
export const CONTROL_PLANE = "@cp";
/** Endpoint id of an address a check dials (a URL, a host and port), one per address. */
export const addressEndpoint = (address: string) => `@addr:${address}`;

/* ------------------------------------------------------------------ */
/* Edges                                                                */
/* ------------------------------------------------------------------ */

/**
 * A path edge's state is its paths' display state (pathsModel.displayState):
 * up, degraded, down, unknown (with the server's reason) or paused. The server
 * decides freshness, so a path whose source went quiet already reads unknown;
 * nothing here re-judges it with a clock.
 */
export type EdgePathState = PathDisplay;
export type ChainState = "converged" | "pending" | "drifted" | "failed";
export type TopoEdgeKind = "path" | "chain";
export type TopoEdgeState = EdgePathState | ChainState;

export interface TopoLastSample {
  at: number;
  /** The outcome when it is known: a path only says when it last heard, and that a down one failed. */
  ok?: boolean;
}

export interface TopoEdge {
  id: string;
  kind: TopoEdgeKind;
  /** A node id or CONTROL_PLANE. */
  from: string;
  /** A node id, or addressEndpoint(address) for a check to an address. */
  to: string;
  state: TopoEdgeState;
  /** Lower is worse; lists and bundles sort and pick by it. */
  severity: number;
  /** The figures of the path that speaks for the edge. */
  p50Ms?: number;
  p95Ms?: number;
  loss?: number;
  samples?: number;
  expected?: number;
  /** Why it is unknown, paused or degraded, as the server sent it. */
  reason?: string;
  method?: string;
  last?: TopoLastSample;
  /**
   * The paths this edge draws, the one that speaks for it first: one per
   * check that measures the pair (design 32 D1). Absent on a chain.
   */
  paths?: PathItem[];
  /** The path the edge opens: the one that speaks for it, or under a query the first that matches. */
  pathKey?: string;
  chain?: { status: string; sourceLine: string; targetLine?: string; error?: string };
  /** Kept by the page's query; true for every edge without one, and for chains, which the query does not read. */
  matched: boolean;
}

/** A terminal for an address the checks dial: drawn once however many checks and sources reach it. */
export interface TopoAddress {
  /** addressEndpoint(address). */
  id: string;
  address: string;
  /** The methods that dial it, sorted. */
  methods: string[];
  /** The names of the checks that dial it, sorted. */
  checks: string[];
  /** Its paths, drawn or not, by state. */
  counts: PathCounts;
  matched: boolean;
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

export type TopologyLayer = "all" | "paths" | "chains";
export const TOPOLOGY_LAYERS: readonly TopologyLayer[] = ["all", "paths", "chains"];

/** `?topo=` read: the old probes and checks filters both show paths now (design 32 D2). */
export function parseTopologyLayer(raw: QueryValue | undefined): TopologyLayer {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value === "probes" || value === "checks") return "paths";
  return TOPOLOGY_LAYERS.includes(value as TopologyLayer) ? (value as TopologyLayer) : "all";
}

export interface TopologyInput {
  /** Undefined when not read (no node:read, or still loading). */
  nodes?: readonly Node[];
  /** The path set plan: its source order and each target's note; edges come from the matrix. */
  plan?: LatencyProbePlan;
  /** The shared matrix (usePathsData) at the page's window; undefined until read. */
  matrix?: Pick<PathsMatrix, "sources" | "paths">;
  /** The sources the picker drew (`?topo.sources=`); undefined draws the default. */
  drawnSources?: readonly string[];
  /** The path keys the page's query keeps; undefined when there is no query. */
  matching?: ReadonlySet<string>;
  /** Undefined when not read or not readable. */
  chains?: readonly LineChainView[];
  incidents?: readonly Incident[];
  /** The page's window, for the words that name it. */
  window: string;
  layer: TopologyLayer;
}

export interface TopologyCounts {
  /** Paths drawn: the drawn sources' and the control plane's. */
  drawn: number;
  /** Paths whose source is not drawn; the view says so, since the page's count holds them. */
  undrawn: number;
  chains: number;
  chainsBroken: number;
  /** Chains whose exit is not decided yet (only planned): not drawn. */
  chainsUnplaced: number;
}

/** A source the picker lists: every source with a path, with its reach counts, drawn or not. */
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
  /** The left column: the drawn sources, in the path set's order. */
  sources: TopoNode[];
  /** Every source the picker offers, in the path set's order. */
  sourceChoices: TopoSourceChoice[];
  /** The drawn sources' ids, in the picker's (the path set's) order: a target row's marks follow it. */
  drawnSourceIds: string[];
  /** The tall column, sorted region, country, name, id. */
  members: TopoNode[];
  addresses: TopoAddress[];
  edges: TopoEdge[];
  cp: ControlPlaneSummary;
  counts: TopologyCounts;
  /** A query is filtering: what it does not keep is drawn faded. */
  filtering: boolean;
  /** Endpoints of a matching edge; empty without a query. */
  matchedEnds: Set<string>;
}

function parseTime(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  // The server sends the Go zero time for a node that never reported.
  return Number.isNaN(ms) || ms < Date.UTC(2000, 0, 1) ? undefined : ms;
}

const SEVERITY: Record<TopoEdgeKind, Record<string, number>> = {
  path: { down: 0, degraded: 1, unknown: 4, up: 7, paused: 8 },
  chain: { failed: 0, drifted: 1, pending: 4, converged: 7 },
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
 * The path set's sources in its order, then every other node the matrix
 * shows running a path (an operator check's sources), in the matrix's
 * order; from the matrix alone when the plan is not read. A source the plan
 * notes (deleted or disabled) runs nothing and is left out, so it never
 * takes one of the default four places. The control plane is never a choice:
 * its box is always drawn.
 */
export function sourceOrder(plan: Pick<LatencyProbePlan, "config" | "source_notes"> | undefined, matrix: Pick<PathsMatrix, "sources" | "paths"> | undefined): string[] {
  const noted = new Set(Object.keys(plan?.source_notes ?? {}));
  const running = new Set((matrix?.paths ?? []).filter((p) => p.source && !noted.has(p.source)).map((p) => p.source));
  const out: string[] = [];
  for (const id of plan?.config.sources ?? []) if (running.has(id) && !out.includes(id)) out.push(id);
  for (const column of matrix?.sources ?? []) if (running.has(column.nodeId) && !out.includes(column.nodeId)) out.push(column.nodeId);
  return out;
}

/**
 * The sources drawn: the picker's choice that still runs a path, kept in the
 * path set's order, else the first four; and while a query holds, every
 * source with a matching path as well, so a match is never hidden behind the
 * picker.
 */
export function drawnSources(order: readonly string[], chosen: readonly string[] | undefined, withMatches: ReadonlySet<string> = new Set()): string[] {
  const picked = chosen ? order.filter((id) => chosen.includes(id)) : [];
  const base = new Set(picked.length ? picked : order.slice(0, DEFAULT_DRAWN_SOURCES));
  return order.filter((id) => base.has(id) || withMatches.has(id));
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
    source: false,
    relay: false,
    exit: false,
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

/** Where a path ends in the drawing: its target node, or the terminal of the address it dials. */
export function pathEnd(path: Pick<PathItem, "targetNode" | "target" | "monitorId">): string {
  return path.targetNode || addressEndpoint(path.target || `@${path.monitorId}`);
}

/**
 * A pair's paths in the order they speak: the live ones (up, degraded,
 * down) before the rest, and within each the worst first. A check that
 * cannot run (unknown) or that the operator paused does not grey a pair that
 * another check measures; the sheet still lists it.
 */
export function pairOrder(paths: readonly PathItem[]): PathItem[] {
  const live = (p: PathItem) => (["up", "degraded", "down"].includes(displayState(p)) ? 0 : 1);
  return [...paths].sort((a, b) => live(a) - live(b) || worstFirst(a, b));
}

/** The whole model for one layer, window and query. */
export function buildTopology(input: TopologyInput): TopologyModel {
  const { plan, matrix, window, layer, matching } = input;
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
  const counts: TopologyCounts = { drawn: 0, undrawn: 0, chains: 0, chainsBroken: 0, chainsUnplaced: 0 };
  const showPaths = layer === "all" || layer === "paths";
  const showChains = layer === "all" || layer === "chains";
  const matchedEnds = new Set<string>();

  /* ---- Paths ---- */
  const sources: TopoNode[] = [];
  const order = sourceOrder(plan, matrix);
  const withMatches = new Set(matching ? (matrix?.paths ?? []).filter((p) => p.source && matching.has(p.key)).map((p) => p.source) : []);
  const drawn = drawnSources(order, input.drawnSources, withMatches);
  const reachOf = new Map(matrix ? reachBySource(matrix).map((r) => [r.source, r]) : []);
  const sourceName = new Map((matrix?.sources ?? []).map((s) => [s.nodeId, s.name]));
  const sourceChoices: TopoSourceChoice[] = order.map((id) => {
    const node = ensure(id);
    node.source = true;
    if (node.name === node.id && sourceName.get(id)) node.name = sourceName.get(id)!;
    const reach = reachOf.get(id) ?? { source: id, name: node.name, up: 0, degraded: 0, down: 0, unknown: 0, paused: 0, total: 0 };
    return { node, reach, drawn: drawn.includes(id) };
  });
  if (showPaths) for (const id of drawn) sources.push(nodes.get(id)!);
  const addresses = new Map<string, { address: string; paths: PathItem[]; methods: Set<string>; checks: Set<string> }>();
  if (showPaths && matrix) {
    const drawnSet = new Set(drawn);
    const pairs = new Map<string, { from: string; to: string; paths: PathItem[] }>();
    for (const path of matrix.paths) {
      const to = pathEnd(path);
      if (!path.targetNode) {
        const entry = addresses.get(to) ?? { address: path.target || path.checkName || path.monitorId, paths: [], methods: new Set<string>(), checks: new Set<string>() };
        entry.paths.push(path);
        if (path.method) entry.methods.add(path.method);
        entry.checks.add(path.checkName || path.monitorId);
        addresses.set(to, entry);
      }
      // The control plane's box is always drawn; a node source only when the picker or the query draws it.
      if (path.source && !drawnSet.has(path.source)) {
        counts.undrawn += 1;
        continue;
      }
      const from = path.source || CONTROL_PLANE;
      const key = `${from}>${to}`;
      const pair = pairs.get(key) ?? { from, to, paths: [] };
      pair.paths.push(path);
      pairs.set(key, pair);
    }
    for (const { from, to, paths } of pairs.values()) {
      const ordered = pairOrder(paths);
      const lead = ordered[0]!;
      if (lead.targetNode) {
        const target = ensure(lead.targetNode);
        if (target.name === target.id && lead.targetNodeName) target.name = lead.targetNodeName;
        if (!target.country && lead.country) {
          target.country = lead.country;
          target.region = regionOf(lead.country);
        }
      }
      const kept = matching ? ordered.filter((p) => matching.has(p.key)) : ordered;
      const state = displayState(lead);
      const edge: TopoEdge = {
        id: `path:${from}>${to}`,
        kind: "path",
        from,
        to,
        state,
        severity: edgeSeverity("path", state),
        p50Ms: lead.p50Ms,
        p95Ms: lead.p95Ms,
        loss: lead.loss,
        samples: lead.samples,
        expected: lead.expected,
        reason: lead.reason,
        method: lead.method,
        paths: ordered,
        pathKey: (kept[0] ?? lead).key,
        matched: !matching || kept.length > 0,
      };
      // The matrix says when the path last heard; only a down path's newest outcome is known (it failed).
      if (lead.lastAt !== undefined) edge.last = { at: lead.lastAt, ok: state === "down" ? false : undefined };
      if (matching && edge.matched) {
        matchedEnds.add(from);
        matchedEnds.add(to);
      }
      edges.push(edge);
      counts.drawn += paths.length;
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
      matched: true,
    });
    counts.chains += 1;
    if (state === "failed" || state === "drifted") counts.chainsBroken += 1;
  }

  /* ---- Address terminals ---- */
  const drawnEnds = new Set(edges.map((e) => e.to));
  const terminals: TopoAddress[] = [...addresses]
    .filter(([id]) => drawnEnds.has(id))
    .map(([id, entry]) => ({
      id,
      address: entry.address,
      methods: [...entry.methods].sort(),
      checks: [...entry.checks].sort((a, b) => a.localeCompare(b)),
      counts: countPaths(entry.paths),
      matched: !matching || matchedEnds.has(id),
    }))
    .sort((a, b) => Number(b.counts.down > 0) - Number(a.counts.down > 0) || a.address.localeCompare(b.address) || a.id.localeCompare(b.id));

  /* ---- Columns ---- */
  const left = new Set(sources.map((s) => s.id));
  const ends = new Set(edges.flatMap((e) => [e.from, e.to]));
  const inLayer = (node: TopoNode): boolean => {
    if (left.has(node.id)) return false;
    switch (layer) {
      case "all":
        return true;
      case "paths":
        return ends.has(node.id) || node.probeTarget === "probed" || node.probeTarget === "paused" || node.probeTarget === "not_probeable";
      case "chains":
        return node.relay || node.exit;
    }
  };
  const members = [...nodes.values()].filter(inLayer).sort(compareMembers);

  const cp: ControlPlaneSummary = { total: 0, fresh: 0, degraded: 0, quiet: 0, never: 0, disabled: 0, known: input.nodes !== undefined };
  for (const node of nodes.values()) {
    if (!node.listed || !node.freshness) continue;
    cp.total += 1;
    cp[node.freshness] += 1;
  }

  return {
    layer,
    window,
    nodes,
    sources,
    sourceChoices,
    drawnSourceIds: showPaths ? drawn : [],
    members,
    addresses: terminals,
    edges,
    cp,
    counts,
    filtering: !!matching,
    matchedEnds,
  };
}

/** The edges that touch one endpoint. */
export function edgesOf(model: Pick<TopologyModel, "edges">, id: string): TopoEdge[] {
  return model.edges.filter((e) => e.from === id || e.to === id);
}

/** Whether an endpoint keeps full strength: everything does without a query; with one, the ends of a matching edge. */
export function endMatched(model: Pick<TopologyModel, "filtering" | "matchedEnds">, id: string): boolean {
  return !model.filtering || model.matchedEnds.has(id);
}

/**
 * States that describe the path now. Unknown is silence and paused is off:
 * neither says how the path behaves today.
 */
const LIVE: Record<TopoEdgeKind, ReadonlySet<string>> = {
  path: new Set(["up", "degraded", "down"]),
  chain: new Set(["converged", "pending", "drifted", "failed"]),
};

export function isLive(edge: Pick<TopoEdge, "kind" | "state">): boolean {
  return LIVE[edge.kind].has(edge.state);
}

/**
 * The edge that speaks for several into one place (a row's paths, a folded
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

/** What a node's row says about the paths into it: the worst live one, and how many there are. */
export function rowPath(model: Pick<TopologyModel, "edges">, nodeId: string): { edge: TopoEdge; count: number } | undefined {
  const into = model.edges.filter((e) => e.kind === "path" && e.to === nodeId);
  if (into.length === 0) return undefined;
  return { edge: worstLive(into), count: into.length };
}

/** A target row's word across its drawn sources: the state that speaks for it and how many of them read it. */
export interface RowSummary {
  /** The worst live state among the paths into the row, else the worst of the rest. */
  state: EdgePathState;
  /** Drawn sources whose path reads that state. */
  n: number;
  /** Drawn sources with a path into the row. */
  of: number;
  /** Why an unknown row is unknown: the speaking path's reason. */
  reason?: string;
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
  const into = model.edges.filter((e) => e.kind === "path" && e.to === nodeId);
  if (into.length === 0) return undefined;
  const lead = worstLive(into);
  const state = lead.state as EdgePathState;
  const summary: RowSummary = { state, n: into.filter((e) => e.state === state).length, of: into.length };
  if (state === "unknown" && lead.reason) summary.reason = lead.reason;
  return summary;
}

/**
 * A target row's marks: one per drawn source, in the picker's order, so the
 * fans that overlap on the row stay readable; undefined where that source has
 * no path to it.
 */
export function rowMarks(model: Pick<TopologyModel, "edges" | "drawnSourceIds">, nodeId: string): { source: string; state?: EdgePathState }[] {
  const into = new Map(model.edges.filter((e) => e.kind === "path" && e.to === nodeId).map((e) => [e.from, e.state as EdgePathState]));
  return model.drawnSourceIds.map((source) => ({ source, state: into.get(source) }));
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
   * Chains carry it so that shape, not only hue, tells them from paths.
   */
  double?: boolean;
}

/** A path state's tone token: state tones are the only saturated colour (design 29 D13). */
export const PATH_TONE: Record<EdgePathState, string> = {
  up: "--success",
  degraded: "--warning",
  down: "--destructive",
  unknown: "--muted-foreground",
  paused: "--muted-foreground",
};

/**
 * One rule for every edge. A path's colour is its state's tone and nothing
 * else (the latency bands that coloured edges were a second saturated
 * scale): up, degraded and down solid; unknown dashed and paused dotted, both
 * muted, so neither can pass for a live green.
 */
export function edgeStyle(edge: Pick<TopoEdge, "kind" | "state">): EdgeStyle {
  switch (edge.kind) {
    case "path":
      switch (edge.state) {
        case "up":
          return { color: PATH_TONE.up, stroke: "solid", width: 1.5 };
        case "degraded":
          return { color: PATH_TONE.degraded, stroke: "solid", width: 2 };
        case "down":
          return { color: PATH_TONE.down, stroke: "solid", width: 2.5 };
        case "paused":
          return { color: PATH_TONE.paused, stroke: "dotted", width: 1.25 };
        default:
          return { color: PATH_TONE.unknown, stroke: "dashed", width: 1.25 };
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
export const ADDRESS_H = 52;
export const ADDRESS_GAP = 8;
export const LEFT_W = 208;
export const ADDRESS_W = 232;
/** Where the first source sits: right under the control plane box. */
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
  /** The box or row it starts from (an anchorOf key), so the keyboard reaches it right after that box. */
  fromKey: string;
  /** The column it ends in: the left column, the tall column, or the addresses. */
  toColumn: "left" | "row" | "address";
}

export interface TopologyLayout {
  width: number;
  height: number;
  cp: Box;
  sources: { node: TopoNode; box: Box }[];
  rowsX: number;
  rowsW: number;
  rows: LayoutRow[];
  addresses: { address: TopoAddress; box: Box }[];
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
 * A line from the left column to an address would cross the tall column,
 * which hides it behind its rows and shows it in every gap between them. It
 * rides a lane above the column instead: up, across, and down into the
 * address.
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
  const hasAddresses = model.addresses.length > 0;

  const arcW = hasChains ? 80 : 16;
  const addressW = hasAddresses ? ADDRESS_W : 0;
  const addressGap = hasAddresses ? 56 : 0;
  const drawnCount = model.drawnSourceIds.length;
  const baseRowsW = clamp(Math.round(width * 0.3), 260, 380);
  const rowsExtra = drawnCount > 1 ? ROW_SUMMARY_EXTRA_W + ROW_MARK_W * drawnCount : 0;
  const rowsW = baseRowsW + clamp(width - LEFT_W - baseRowsW - arcW - addressW - addressGap - FAN_MIN_W, 0, rowsExtra);
  const spare = width - LEFT_W - rowsW - arcW - addressW - addressGap;
  const gapLR = clamp(spare, 72, 300);
  const rowsX = LEFT_W + gapLR;
  const addressesX = hasAddresses ? Math.max(rowsX + rowsW + arcW + addressGap, width - addressW) : 0;
  // Narrower than the columns need: the drawing keeps its columns and its frame scrolls sideways.
  const drawnWidth = Math.max(width, hasAddresses ? addressesX + addressW : rowsX + rowsW + arcW);

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
  // The sources sit right under the control plane and the addresses start at
  // the top, so the fan's origin and the first address are on the first screen
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

  /* ---- Addresses ---- */
  let cy = 0;
  const addresses = model.addresses.map((address) => {
    const box: Box = { x: addressesX, y: cy, w: addressW, h: ADDRESS_H };
    anchorOf.set(address.id, address.id);
    cy += ADDRESS_H + ADDRESS_GAP;
    return { address, box };
  });
  const addressBox = new Map(addresses.map((c) => [c.address.id, c.box]));

  /* ---- Edges ---- */
  type Anchor = { kind: "left" | "row" | "address"; xl: number; xr: number; y: number };
  const anchor = (id: string): Anchor | undefined => {
    const key = anchorOf.get(id);
    if (!key) return undefined;
    if (key === CONTROL_PLANE) return { kind: "left", xl: cp.x, xr: cp.x + cp.w, y: cp.y + cp.h / 2 };
    const sb = sourceBox.get(key);
    if (sb) return { kind: "left", xl: sb.x, xr: sb.x + sb.w, y: sb.y + sb.h / 2 };
    const cb = addressBox.get(key);
    if (cb) return { kind: "address", xl: cb.x, xr: cb.x + cb.w, y: cb.y + cb.h / 2 };
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
  for (const [key, { edges: list, from, to, fromKey }] of bundles) {
    const worst = worstLive(list);
    let d: string;
    let end: LayoutEdge["end"];
    // A chain out of a source rides 6 px below the path to the same row, so the two never merge.
    const lift = worst.kind === "chain" && from.kind === "left" ? 6 : 0;
    if (from.kind === "row" && to.kind === "row") {
      d = arc(from.xr, from.y, to.y);
      end = { x: from.xr, y: to.y, dir: -1 };
    } else if (to.kind === "address" && from.kind === "left" && model.members.length > 0) {
      d = overTheTop(from.xr, from.y, to.xl, to.y);
      end = { x: to.xl, y: to.y, dir: 1 };
    } else if (to.kind === "address") {
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
    edges.push({ edge: worst, bundle: list, key, d, end, fromKey, toColumn: to.kind });
  }
  // Worst drawn last, so a red line is never under a green one.
  edges.sort((a, b) => b.edge.severity - a.edge.severity || a.key.localeCompare(b.key));

  const lastSource = sources[sources.length - 1];
  const lastAddress = addresses[addresses.length - 1];
  const height = Math.max(
    rowsHeight,
    cp.y + cp.h,
    lastSource ? lastSource.box.y + lastSource.box.h : 0,
    lastAddress ? lastAddress.box.y + lastAddress.box.h : 0,
  );

  return { width: drawnWidth, height, cp, sources, rowsX, rowsW, rows, addresses, edges, collapsed, anchorOf };
}

/**
 * The drawn lines in the order the keyboard reaches them (design 32 D2):
 * grouped by the box they start from, in the order the boxes are drawn
 * (the control plane, then each source top to bottom, then the tall
 * column's rows), and inside a group by where they end, the tall column top
 * to bottom before the addresses. A page puts each group right after its box,
 * so Tab walks a source and then its paths.
 */
export function keyboardOrder(layout: Pick<TopologyLayout, "edges" | "sources" | "rows">): Map<string, LayoutEdge[]> {
  const boxes = [CONTROL_PLANE, ...layout.sources.map((s) => `source:${s.node.id}`), ...layout.rows.map((r) => r.key)];
  const rank = new Map(boxes.map((key, i) => [key, i]));
  const column = { left: 0, row: 0, address: 1 } as const;
  const out = new Map<string, LayoutEdge[]>();
  const sorted = [...layout.edges].sort(
    (a, b) => (rank.get(a.fromKey) ?? boxes.length) - (rank.get(b.fromKey) ?? boxes.length) || column[a.toColumn] - column[b.toColumn] || a.end.y - b.end.y || a.key.localeCompare(b.key),
  );
  for (const le of sorted) {
    const list = out.get(le.fromKey) ?? [];
    list.push(le);
    out.set(le.fromKey, list);
  }
  return out;
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
 * The reads the drawing is made of. The view makes the chains read; the
 * page makes the others, which it polls for its other layers anyway.
 */
export type TopoRead = "plan" | "paths" | "nodes" | "incidents" | "chains";

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

/** The reads a filter's drawing is built from, in the order a failure is named; never one the session cannot send. */
export function readsFor(layer: TopologyLayer, statuses: TopoReadStatuses): TopoRead[] {
  const out: TopoRead[] = ["plan"];
  if (layer === "all" || layer === "paths") out.push("paths");
  out.push("nodes", "incidents");
  if (layer === "all" || layer === "chains") out.push("chains");
  return out.filter((read) => statuses[read].allowed);
}

/**
 * Reads the filter needs that never landed and whose last attempt failed.
 * The drawing is missing their part outright (no heartbeats, no incident
 * marks, no chains), so each gets a line that says so, with a retry. A
 * failed refresh after a good read is only stale, and the proof line already
 * says that.
 */
export function missingReads(layer: TopologyLayer, statuses: TopoReadStatuses): TopoRead[] {
  return readsFor(layer, statuses).filter((read) => readState(statuses[read]) === "failed");
}

/** Why a filter has nothing to draw, or "loading" while the read it needs is still on its way. */
export type TopologyEmpty = "noSources" | "chainsDenied" | "chainsFailed" | "noChains" | "noNodes";

export function layerEmpty(
  model: Pick<TopologyModel, "layer" | "sources" | "members" | "addresses" | "edges" | "counts">,
  statuses: TopoReadStatuses,
): TopologyEmpty | "loading" | null {
  switch (model.layer) {
    case "paths":
      return model.edges.length === 0 ? "noSources" : null;
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
    default:
      return model.members.length === 0 && model.sources.length === 0 ? "noNodes" : null;
  }
}
