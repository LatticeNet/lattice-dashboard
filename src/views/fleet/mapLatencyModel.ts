/**
 * The Map page's latency layer (design 32 R1): read from the paths matrix,
 * whichever check measures a pair, now that the path set is a check like any
 * other. It draws from one source, the one that measures the most nodes (a
 * tie goes to the matrix's first), with one reading per target: the measured
 * path that speaks for the pair (topologyModel.pairOrder). A pair a check
 * skips or the operator paused is not a path (design 32 R2) and draws no arc.
 *
 * Pure: no Vue, no i18n.
 */
import type { LatencyFact } from "@/components/fleet/fleetMapTypes";

import { latencyBand } from "@/views/fleet/latencyModel";
import type { PathItem, PathsMatrix } from "@/views/fleet/pathsModel";
import { pairOrder } from "@/views/fleet/topologyModel";

export interface MapLatency {
  sourceId: string;
  sourceName: string;
  /** By target node id. */
  readings: Map<string, LatencyFact>;
  /** Other sources that measure nodes, which the Monitoring page shows. */
  otherSources: number;
}

function factOf(path: PathItem): LatencyFact {
  const base = { p50Ms: undefined as number | undefined, loss: path.loss, samples: path.samples, expected: path.expected };
  if ((path.state === "up" || path.state === "degraded") && path.p50Ms !== undefined) {
    return { kind: "measured", band: latencyBand(path.p50Ms), ...base, p50Ms: path.p50Ms };
  }
  if (path.state === "down") return { kind: "failing", band: undefined, ...base };
  return { kind: "unknown", band: undefined, ...base };
}

export function mapLatency(matrix: Pick<PathsMatrix, "sources" | "paths">): MapLatency | undefined {
  const bySource = new Map<string, Map<string, PathItem[]>>();
  for (const path of matrix.paths) {
    if (!path.source || !path.targetNode || path.targetNode === path.source) continue;
    const targets = bySource.get(path.source) ?? new Map<string, PathItem[]>();
    targets.set(path.targetNode, [...(targets.get(path.targetNode) ?? []), path]);
    bySource.set(path.source, targets);
  }
  if (bySource.size === 0) return undefined;
  const order = new Map(matrix.sources.map((s, i) => [s.nodeId, i]));
  const rank = (id: string) => order.get(id) ?? Number.MAX_SAFE_INTEGER;
  const [sourceId] = [...bySource.keys()].sort((a, b) => bySource.get(b)!.size - bySource.get(a)!.size || rank(a) - rank(b));
  const readings = new Map<string, LatencyFact>();
  for (const [target, paths] of bySource.get(sourceId!)!) readings.set(target, factOf(pairOrder(paths)[0]!));
  const sourceName = matrix.sources.find((s) => s.nodeId === sourceId)?.name || matrix.paths.find((p) => p.source === sourceId)?.sourceName || sourceId!;
  return { sourceId: sourceId!, sourceName, readings, otherSources: bySource.size - 1 };
}
