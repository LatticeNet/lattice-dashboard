/**
 * The node page's Paths card (design 29 D7): the paths that end at a node
 * ("reached by") and the paths that start from it ("reaches"), read from the
 * same matrix Monitoring draws, for one window.
 *
 * Kept free of Vue so `node --test` covers it directly.
 */
import { isReachabilityCheck } from "@/views/fleet/beaconModel";
import { displayState, quoteQueryValue, targetLabel, type PathDisplay, type PathItem, type PathsMatrix } from "@/views/fleet/pathsModel";

/** The windows the card offers: an hour, a day and a week, which every server answers. */
export const NODE_PATH_WINDOWS = ["1h", "24h", "7d"] as const;
export type NodePathWindow = (typeof NODE_PATH_WINDOWS)[number];
export const NODE_PATH_DEFAULT_WINDOW: NodePathWindow = "24h";
/** Rows a list shows before it hands over to Monitoring. */
export const NODE_PATHS_SHOWN = 8;

export interface NodePaths {
  /** Paths whose target is this node: one per source, and per operator check that names it. */
  reachedBy: PathItem[];
  /** Paths from this node to its targets. */
  reaches: PathItem[];
}

const DISPLAY_RANK: Record<PathDisplay, number> = { down: 0, degraded: 1, unknown: 2, paused: 3, skipped: 4, up: 5 };

/** Down first, then degraded, unknown, paused, skipped and up; within a state the lossiest, then the slowest. */
export function worstFirst(a: PathItem, b: PathItem): number {
  return (
    DISPLAY_RANK[displayState(a)] - DISPLAY_RANK[displayState(b)] ||
    (b.loss ?? 0) - (a.loss ?? 0) ||
    (b.p50Ms ?? -1) - (a.p50Ms ?? -1) ||
    a.key.localeCompare(b.key) ||
    // Two checks on one pair share its key (design 32 R1): their own ids keep the order stable.
    a.id.localeCompare(b.id)
  );
}

/**
 * The node's two lists. A path from the node to itself is neither, and a
 * beacon's reachability check is not a path at all (it is shown on the
 * Beacon card).
 */
export function nodePaths(matrix: Pick<PathsMatrix, "paths"> | undefined, nodeId: string): NodePaths {
  const out: NodePaths = { reachedBy: [], reaches: [] };
  if (!matrix || !nodeId) return out;
  for (const path of matrix.paths) {
    if (isReachabilityCheck({ monitor_id: path.monitorId })) continue;
    const toNode = path.targetNode === nodeId;
    const fromNode = path.source === nodeId;
    if (toNode && fromNode) continue;
    if (toNode) out.reachedBy.push(path);
    else if (fromNode) out.reaches.push(path);
  }
  out.reachedBy.sort(worstFirst);
  out.reaches.sort(worstFirst);
  return out;
}

/**
 * The other end of a path as the node's list names it: the source for
 * "reached by", the target (node or check) for "reaches", and the check
 * that measures it by name (design 32 R3), except on a check to an address,
 * whose target is named by the check already.
 */
export function otherEnd(path: PathItem, side: "reachedBy" | "reaches"): { name: string; check?: string } {
  const check = path.checkName || path.checkId;
  if (side === "reachedBy") return { name: path.sourceName || path.source, check };
  return { name: targetLabel(path), check: path.targetNode ? check : undefined };
}

/** The Paths layer query that lists all of a list's paths: by target name, or by source name. */
export function monitoringQuery(side: "reachedBy" | "reaches", nodeName: string): string {
  return side === "reachedBy" ? `target:${quoteQueryValue(nodeName)}` : `source:${quoteQueryValue(nodeName)}`;
}

/** Counts by display state, for the list's heading. */
export function stateCounts(paths: readonly PathItem[]): Record<PathDisplay, number> {
  const out: Record<PathDisplay, number> = { up: 0, degraded: 0, down: 0, unknown: 0, paused: 0, skipped: 0 };
  for (const p of paths) out[displayState(p)] += 1;
  return out;
}

/**
 * The figures a degraded row shows beside its reason: the evidence the
 * reason is about (design 29 D13), the median over the last 15 minutes for
 * latency and the loss over the last hour for loss, from the evaluation that
 * found it. Never the window's own p50: a 24-hour median beside "slower than
 * usual" reads as the usual figure, not the slow one. Empty when the server
 * sent no evidence, and for any other state.
 */
export function degradedFigures(path: Pick<PathItem, "state" | "degraded">): { latencyMs?: number; loss?: number } {
  if (path.state !== "degraded" || !path.degraded) return {};
  const out: { latencyMs?: number; loss?: number } = {};
  if (path.degraded.latency) out.latencyMs = path.degraded.latency.p50Ms;
  if (path.degraded.loss) out.loss = path.degraded.loss.value;
  return out;
}
