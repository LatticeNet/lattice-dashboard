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

/** A circle a cluster paints or listens on, offset from the cluster's centre, in map units. */
export interface ReachCircle {
  dx: number;
  dy: number;
  r: number;
}

/**
 * The circles a cluster occupies, given its member count and how many of
 * them are down: its tap target or mark at the centre, and its
 * not-reporting badge at the upper right.
 */
export type ClusterReach = (count: number, down: number) => readonly ReachCircle[];

/** How far two clusters' circles overlap (negative when they are clear). */
function reachOverlap(a: { x: number; y: number }, ac: readonly ReachCircle[], b: { x: number; y: number }, bc: readonly ReachCircle[]): number {
  let worst = -Infinity;
  for (const p of ac) {
    for (const q of bc) {
      worst = Math.max(worst, p.r + q.r - Math.hypot(a.x + p.dx - b.x - q.dx, a.y + p.dy - b.y - q.dy));
    }
  }
  return worst;
}

/**
 * Greedy clustering in map units. Points are taken worst first (so a cluster
 * forms around a node that needs a hand rather than absorbing it at its
 * edge), and each joins the nearest cluster whose centre is within `radius`;
 * the centre then moves to the members' mean. Pass the radius in map units at
 * the current zoom (screen radius divided by the scale), so clusters split as
 * the operator zooms in.
 *
 * With `reach`, two clusters whose circles overlap are then merged, most
 * overlapping pair first, until no two touch. The merge radius alone left
 * London and a two-node cluster 18 px apart on a phone with 44 px targets
 * that overlapped by 26 px, so a tap on one could open the other; and at
 * 1440 a San Jose mark sat on the 12-node Los Angeles one.
 */
export function clusterPoints(points: readonly MapPoint[], radius: number, reach?: ClusterReach): MapCluster[] {
  const ordered = [...points].sort(
    (a, b) => ATTENTION_ORDER[a.status] - ATTENTION_ORDER[b.status] || a.id.localeCompare(b.id),
  );
  type Building = { x: number; y: number; members: MapPoint[] };
  const clusters: Building[] = [];
  const recentre = (cluster: Building) => {
    cluster.x = cluster.members.reduce((sum, member) => sum + member.x, 0) / cluster.members.length;
    cluster.y = cluster.members.reduce((sum, member) => sum + member.y, 0) / cluster.members.length;
  };
  for (const point of ordered) {
    let best: Building | undefined;
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
      recentre(best);
    } else {
      clusters.push({ x: point.x, y: point.y, members: [point] });
    }
  }
  if (reach) {
    const reachOf = (cluster: Building) =>
      reach(cluster.members.length, cluster.members.filter((member) => DOWN.has(member.status)).length);
    for (;;) {
      let pair: [number, number] | undefined;
      let worst = 0;
      for (let i = 0; i < clusters.length; i += 1) {
        for (let j = i + 1; j < clusters.length; j += 1) {
          const a = clusters[i]!;
          const b = clusters[j]!;
          const overlap = reachOverlap(a, reachOf(a), b, reachOf(b));
          if (overlap > worst) {
            worst = overlap;
            pair = [i, j];
          }
        }
      }
      if (!pair) break;
      const [keep, drop] = pair;
      clusters[keep]!.members.push(...clusters[drop]!.members);
      recentre(clusters[keep]!);
      clusters.splice(drop, 1);
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

/** How the map clusters at a zoom: the merge radius and the reach, both in map units at that zoom. */
export type ClusteringAt = (scale: number) => { radius: number; reach?: ClusterReach };

/**
 * The zoom that splits a cluster: its members are clustered the way the map
 * would at each step of x1.25 from the current zoom, and the first zoom
 * where they fall apart is taken with a little room (x1.2), capped at
 * `max`. Returns undefined when no zoom up to `max` splits them (13 nodes
 * resolved to one city), where the page should list them instead.
 *
 * It used to aim the farthest two members past the merge radius, which left
 * a middle member chaining all three back into one mark: London, Falkenstein
 * and Helsinki on a phone took a tap that zoomed and still showed one "3".
 */
export function zoomToSplit(members: readonly MapPoint[], clusteringAt: ClusteringAt, current: number, max = 5): number | undefined {
  if (members.length < 2) return undefined;
  for (let scale = current * 1.25; ; scale *= 1.25) {
    const at = Math.min(scale, max);
    const { radius, reach } = clusteringAt(at);
    if (clusterPoints(members, radius, reach).length > 1) {
      const want = Math.min(max, at * 1.2);
      return want > current + 0.01 ? want : undefined;
    }
    if (at >= max) return undefined;
  }
}

/** Points closer than this (map units) are on one spot. */
const SAME_SPOT = 0.5;

/**
 * Whether a click should list the members instead of zooming: when no zoom
 * splits them, or when most of them share one spot, so a zoom would split
 * off the outliers and leave the rest as one mark. Twelve nodes on one Los
 * Angeles coordinate took three or four taps before, each zoom peeling off
 * one neighbour.
 */
export function listInsteadOfZoom(members: readonly Pick<MapPoint, "x" | "y">[], zoom: number | undefined): boolean {
  if (members.length < 2) return false;
  if (zoom === undefined) return true;
  let largest = 0;
  for (const a of members) {
    let near = 0;
    for (const b of members) if (Math.hypot(a.x - b.x, a.y - b.y) < SAME_SPOT) near += 1;
    largest = Math.max(largest, near);
  }
  return largest * 2 >= members.length;
}

/**
 * Where a cluster is, from all its members: one city, one country with
 * several cities, or several countries. Named by its first member, "3 nodes
 * in Osaka, JP" held two Tokyo nodes.
 */
export type ClusterPlace =
  | { kind: "city"; city: string; country?: string }
  | { kind: "country"; country: string }
  | { kind: "places"; count: number }
  | { kind: "unknown" };

export function clusterPlace(geos: readonly ({ city?: string; country?: string } | undefined)[]): ClusterPlace {
  const cities = new Set(geos.map((geo) => geo?.city?.trim() || "").filter(Boolean));
  const countries = new Set(geos.map((geo) => geo?.country?.trim() || "").filter(Boolean));
  if (cities.size === 1 && countries.size <= 1) return { kind: "city", city: [...cities][0]!, country: [...countries][0] };
  if (countries.size === 1) return { kind: "country", country: [...countries][0]! };
  if (countries.size > 1) return { kind: "places", count: countries.size };
  if (cities.size > 1) return { kind: "places", count: cities.size };
  return { kind: "unknown" };
}
