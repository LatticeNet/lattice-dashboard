/**
 * Pure model for the fleet map (design 23, sections 4.1 and 4.2): where the
 * nodes are, drawn as status clusters with counts.
 *
 * Thirteen nodes in Los Angeles used to be thirteen 2-unit dots on one spot,
 * read as a single blob of whatever colour was drawn last. A cluster is one
 * mark with a count, coloured by the worst state among its members, with the
 * number not reporting beside it, so an offline node is never hidden under
 * twelve green ones. Home draws the clusters as its one picture; the Map page
 * recomputes them per zoom, and a click on one opens its node (or, for many,
 * lists them).
 *
 * Kept free of Vue so `node --test` covers it directly.
 */
import { ATTENTION_ORDER, type NodeStatus } from "@/lib/nodeStatus";

export const MAP_WIDTH = 1000;
export const MAP_HEIGHT = 500;

/** Equirectangular: longitude to x, latitude to y, clamped to the map. */
export function project(lon: number, lat: number, width = MAP_WIDTH, height = MAP_HEIGHT): { x: number; y: number } {
  const lonClamped = Math.max(-180, Math.min(180, lon));
  const latClamped = Math.max(-90, Math.min(90, lat));
  return { x: ((lonClamped + 180) / 360) * width, y: ((90 - latClamped) / 180) * height };
}

/** An SVG path for one ring of flat [lon, lat, lon, lat, ...] pairs. */
export function ringPath(ring: readonly number[], width = MAP_WIDTH, height = MAP_HEIGHT): string {
  let d = "";
  for (let i = 0; i + 1 < ring.length; i += 2) {
    const lon = ring[i];
    const lat = ring[i + 1];
    if (lon === undefined || lat === undefined) break;
    const point = project(lon, lat, width, height);
    d += `${i === 0 ? "M" : "L"}${point.x.toFixed(1)} ${point.y.toFixed(1)} `;
  }
  return d ? `${d}Z` : "";
}

export interface MapPoint {
  id: string;
  x: number;
  y: number;
  status: NodeStatus;
}

/** What a cluster's colour says, worst member first. */
export type ClusterTone = "destructive" | "warning" | "muted" | "success";

export interface MapCluster {
  /** Stable while the membership holds: the smallest member id. */
  key: string;
  x: number;
  y: number;
  ids: string[];
  /** Members that are not reporting (offline or never reported). */
  down: number;
  tone: ClusterTone;
}

const DOWN = new Set<NodeStatus>(["offline", "never_reported"]);

/**
 * The colour a set of statuses earns: offline beats degraded beats the quiet
 * states. A never-reported node alone is quiet (muted), but beside online
 * nodes it is one of the cluster's down count, so the cluster cannot read
 * green while its badge counts it.
 */
export function clusterTone(statuses: readonly NodeStatus[]): ClusterTone {
  if (statuses.includes("offline")) return "destructive";
  if (statuses.includes("degraded")) return "warning";
  if (statuses.length > 0 && statuses.every((status) => status !== "online")) return "muted";
  if (statuses.includes("never_reported")) return "warning";
  return "success";
}

/**
 * Greedy clustering in map units. Points are taken worst first (so a cluster
 * forms around a node that needs a hand rather than absorbing it at its
 * edge), and each joins the nearest cluster whose centre is within `radius`;
 * the centre then moves to the members' mean. Pass the radius in map units at
 * the current zoom (screen radius divided by the scale), so clusters split as
 * the operator zooms in.
 */
export function clusterPoints(points: readonly MapPoint[], radius: number): MapCluster[] {
  const ordered = [...points].sort(
    (a, b) => ATTENTION_ORDER[a.status] - ATTENTION_ORDER[b.status] || a.id.localeCompare(b.id),
  );
  const clusters: { x: number; y: number; members: MapPoint[] }[] = [];
  for (const point of ordered) {
    let best: (typeof clusters)[number] | undefined;
    let bestDistance = Infinity;
    for (const cluster of clusters) {
      const distance = Math.hypot(cluster.x - point.x, cluster.y - point.y);
      if (distance <= radius && distance < bestDistance) {
        best = cluster;
        bestDistance = distance;
      }
    }
    if (best) {
      best.members.push(point);
      best.x = best.members.reduce((sum, member) => sum + member.x, 0) / best.members.length;
      best.y = best.members.reduce((sum, member) => sum + member.y, 0) / best.members.length;
    } else {
      clusters.push({ x: point.x, y: point.y, members: [point] });
    }
  }
  return clusters.map((cluster) => {
    const ids = cluster.members.map((member) => member.id).sort();
    const statuses = cluster.members.map((member) => member.status);
    return {
      key: ids[0]!,
      x: cluster.x,
      y: cluster.y,
      ids,
      down: statuses.filter((status) => DOWN.has(status)).length,
      tone: clusterTone(statuses),
    };
  });
}

/** A mark's radius in screen pixels: grows with the square root of its count, capped. */
export function clusterRadius(count: number, base = 7): number {
  return Math.min(base * 2.6, base + Math.sqrt(Math.max(0, count - 1)) * 3);
}

/**
 * The zoom that splits a cluster: enough to spread its members past the
 * clustering radius, capped at `max`. Returns undefined when the members sit
 * on one spot (13 nodes resolved to one city), where no zoom will split them
 * and the page should list them instead.
 */
export function zoomToSplit(members: readonly Pick<MapPoint, "x" | "y">[], radius: number, current: number, max = 5): number | undefined {
  if (members.length < 2) return undefined;
  let spread = 0;
  for (const a of members) {
    for (const b of members) spread = Math.max(spread, Math.hypot(a.x - b.x, a.y - b.y));
  }
  if (spread < 0.5) return undefined;
  const want = Math.min(max, Math.max(current * 2, ((radius * current) / spread) * 1.2));
  return want > current + 0.01 ? want : undefined;
}
