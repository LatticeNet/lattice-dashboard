/**
 * Pure model for the fleet map (design 23, sections 4.1 and 4.2): where the
 * nodes are, drawn as status clusters with counts.
 *
 * Thirteen nodes in Los Angeles used to be thirteen 2-unit dots on one spot,
 * read as a single blob of whatever colour was drawn last. A cluster is one
 * mark with a count, coloured by the worst state among its members, with the
 * number not reporting beside it, so an offline node is never hidden under
 * twelve green ones. Home draws the clusters as its one picture; the Map page
 * recomputes them per zoom, and a click on one opens its node, zooms in on
 * it, or spreads it out when no zoom can split it.
 *
 * GeoIP puts every node of one city on the city's one coordinate, so twelve
 * Los Angeles nodes stayed one "12" at any zoom: two marks need 22 px apart
 * with a mouse and 44 px with a finger, and identical points are 0 px apart
 * at every zoom. A spread (spreadSlots) fans such a pile out around its spot,
 * each member its own mark on a leader line, without moving the spot.
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

type Building = { x: number; y: number; members: MapPoint[] };

function recentre(cluster: Building): void {
  cluster.x = cluster.members.reduce((sum, member) => sum + member.x, 0) / cluster.members.length;
  cluster.y = cluster.members.reduce((sum, member) => sum + member.y, 0) / cluster.members.length;
}

/** Two clusters whose reaches overlap, as measured when both were at the versions recorded. */
type OverlapPair = { overlap: number; i: number; j: number; vi: number; vj: number };

/**
 * Whether `a` merges before `b`: the deeper overlap first, and on a tie the
 * pair a scan over all pairs (i, then j, both in creation order) meets first.
 */
function mergesBefore(a: OverlapPair, b: OverlapPair): boolean {
  if (a.overlap !== b.overlap) return a.overlap > b.overlap;
  return a.i !== b.i ? a.i < b.i : a.j < b.j;
}

function heapPush(heap: OverlapPair[], pair: OverlapPair): void {
  heap.push(pair);
  let at = heap.length - 1;
  while (at > 0) {
    const parent = (at - 1) >> 1;
    if (!mergesBefore(heap[at]!, heap[parent]!)) break;
    [heap[at], heap[parent]] = [heap[parent]!, heap[at]!];
    at = parent;
  }
}

function heapPop(heap: OverlapPair[]): OverlapPair | undefined {
  const top = heap[0];
  const last = heap.pop();
  if (top === undefined || last === undefined || heap.length === 0) return top;
  heap[0] = last;
  for (let at = 0; ; ) {
    const left = at * 2 + 1;
    const right = left + 1;
    let first = at;
    if (left < heap.length && mergesBefore(heap[left]!, heap[first]!)) first = left;
    if (right < heap.length && mergesBefore(heap[right]!, heap[first]!)) first = right;
    if (first === at) break;
    [heap[at], heap[first]] = [heap[first]!, heap[at]!];
    at = first;
  }
  return top;
}

/**
 * Merge clusters whose reaches overlap, the most overlapping pair first,
 * until no two touch. Same result as rescanning every pair after each merge,
 * which was O(c^3) with a fresh reach per pair per scan and ran on every
 * pinch frame: here each cluster's reach is computed once and again only
 * when a merge changes it, every pair is measured once, and a merge measures
 * only the merged cluster against the rest. Pairs measured against a cluster
 * that has since merged are skipped when they come up.
 */
function separate(clusters: Building[], reach: ClusterReach): Building[] {
  const live = clusters.map((cluster) => ({
    cluster,
    circles: reach(cluster.members.length, cluster.members.filter((member) => DOWN.has(member.status)).length),
    version: 0,
    alive: true,
  }));
  const heap: OverlapPair[] = [];
  // Always measured lower index first, as the full scan did, so a tie and its float result match it.
  const measure = (i: number, j: number) => {
    const a = live[i]!;
    const b = live[j]!;
    const overlap = reachOverlap(a.cluster, a.circles, b.cluster, b.circles);
    if (overlap > 0) heapPush(heap, { overlap, i, j, vi: a.version, vj: b.version });
  };
  for (let i = 0; i < live.length; i += 1) for (let j = i + 1; j < live.length; j += 1) measure(i, j);
  for (let pair = heapPop(heap); pair; pair = heapPop(heap)) {
    const keep = live[pair.i]!;
    const drop = live[pair.j]!;
    if (!keep.alive || !drop.alive || keep.version !== pair.vi || drop.version !== pair.vj) continue;
    keep.cluster.members.push(...drop.cluster.members);
    recentre(keep.cluster);
    drop.alive = false;
    keep.version += 1;
    keep.circles = reach(keep.cluster.members.length, keep.cluster.members.filter((member) => DOWN.has(member.status)).length);
    for (let k = 0; k < live.length; k += 1) {
      if (k === pair.i || !live[k]!.alive) continue;
      if (k < pair.i) measure(k, pair.i);
      else measure(pair.i, k);
    }
  }
  return live.filter((entry) => entry.alive).map((entry) => entry.cluster);
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
  const greedy: Building[] = [];
  for (const point of ordered) {
    let best: Building | undefined;
    let bestDistance = Infinity;
    for (const cluster of greedy) {
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
      greedy.push({ x: point.x, y: point.y, members: [point] });
    }
  }
  const clusters = reach ? separate(greedy, reach) : greedy;
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
 * The zoom that splits a cluster as far as any zoom will: its members are
 * clustered the way the map would at `max`, then at each step of x1.25 from
 * the current zoom, and the first zoom where they fall into as many marks
 * as at `max` is taken with a little room (x1.2), capped at `max`. Returns
 * undefined when no zoom up to `max` splits them (13 nodes resolved to one
 * city), where the map spreads them out instead.
 *
 * It used to aim the farthest two members past the merge radius, which left
 * a middle member chaining all three back into one mark: London, Falkenstein
 * and Helsinki on a phone took a tap that zoomed and still showed one "3".
 * It then stopped at the first split, which on a phone peeled one city off
 * a Los Angeles pile per tap: five taps to reach the six on one spot.
 */
export function zoomToSplit(members: readonly MapPoint[], clusteringAt: ClusteringAt, current: number, max = 5): number | undefined {
  if (members.length < 2) return undefined;
  const deepest = clusteringAt(max);
  const apart = clusterPoints(members, deepest.radius, deepest.reach).length;
  if (apart < 2) return undefined;
  for (let scale = current * 1.25; ; scale *= 1.25) {
    const at = Math.min(scale, max);
    const { radius, reach } = clusteringAt(at);
    if (clusterPoints(members, radius, reach).length >= apart) {
      const want = Math.min(max, at * 1.2);
      return want > current + 0.01 ? want : undefined;
    }
    if (at >= max) return undefined;
  }
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

/* -------------------------------- the view -------------------------------- */

/**
 * How finely the bundled land may be drawn, in screen px per degree of
 * longitude. The rings are Natural Earth 110m simplified to 0.35 degrees, so
 * at 32 px per degree a coastline is at most about 11 px off: still a
 * picture of the coast, and already finer than a GeoIP location (a city
 * centroid, often tens of kilometres from the machine). Deeper zoom would
 * show the simplification without showing anything true about the nodes.
 */
export const MAX_PX_PER_DEGREE = 32;
/** The floor for the deepest zoom, whatever the width: the old fixed limit. */
export const MIN_MAX_ZOOM = 5;

/**
 * The deepest zoom for a map this many px wide: the same ground detail on a
 * phone as on a desktop. A fixed x5 gave a 343 px phone map under 5 px per
 * degree, so Tokyo and Osaka never parted there; at 1392 px it is about x8.3
 * and on that phone about x33.6.
 */
export function maxZoomFor(frameWidthPx: number): number {
  if (!(frameWidthPx > 0)) return MIN_MAX_ZOOM;
  const zoom = (MAX_PX_PER_DEGREE * 360) / frameWidthPx;
  return Math.max(MIN_MAX_ZOOM, Math.round(zoom * 100) / 100);
}

/** Where the map is drawn: map units are scaled by `scale`, then moved by x and y (in map units of the frame). */
export interface Viewport {
  scale: number;
  x: number;
  y: number;
}

/** Map units of slack past each edge, so a mark at the edge can still be panned off the corner controls. */
export const PAN_SLACK = 28;

function clampTo(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** A viewport the map may show: zoom between 1 and `maxZoom`, the map covering the frame. At x1 the whole world, unpanned. */
export function clampViewport(next: Viewport, maxZoom: number): Viewport {
  const scale = clampTo(next.scale, 1, maxZoom);
  if (scale <= 1) return { scale: 1, x: 0, y: 0 };
  return {
    scale,
    x: clampTo(next.x, MAP_WIDTH * (1 - scale) - PAN_SLACK, PAN_SLACK),
    y: clampTo(next.y, MAP_HEIGHT * (1 - scale) - PAN_SLACK, PAN_SLACK),
  };
}

/** Zoom to `scale` keeping the map point under `anchor` (frame map units) where it is: the pointer, a pinch's middle. */
export function zoomAround(current: Viewport, scale: number, anchor: { x: number; y: number }, maxZoom: number): Viewport {
  const worldX = (anchor.x - current.x) / current.scale;
  const worldY = (anchor.y - current.y) / current.scale;
  const next = clampTo(scale, 1, maxZoom);
  return clampViewport({ scale: next, x: anchor.x - worldX * next, y: anchor.y - worldY * next }, maxZoom);
}

/** Centre a map point at `scale`. */
export function centreOn(x: number, y: number, scale: number, maxZoom: number): Viewport {
  const next = clampTo(scale, 1, maxZoom);
  return clampViewport({ scale: next, x: MAP_WIDTH / 2 - x * next, y: MAP_HEIGHT / 2 - y * next }, maxZoom);
}

/**
 * The view that holds every point with a margin: the fleet's bounding box,
 * centred. A fleet spread over three continents is the whole world, at x1;
 * one in a single region fills the frame with that region. One point alone,
 * or points on one spot, get x4: close enough to see the coast around them.
 */
export function fitViewport(points: readonly { x: number; y: number }[], maxZoom: number, margin = 40): Viewport {
  if (points.length === 0) return { scale: 1, x: 0, y: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);
  }
  const width = maxX - minX;
  const height = maxY - minY;
  const scale = width < 1 && height < 1 ? 4 : Math.min(MAP_WIDTH / (width + margin * 2), MAP_HEIGHT / (height + margin * 2));
  // Under x1.25 the crop hides a sliver of world and shows nothing new: the whole world, which also lets a finger scroll the page.
  if (scale < 1.25) return { scale: 1, x: 0, y: 0 };
  return centreOn((minX + maxX) / 2, (minY + maxY) / 2, scale, maxZoom);
}

/**
 * A step between two viewports, `t` from 0 to 1: the zoom moves by equal
 * ratios and the map point at the frame's centre moves in a straight line,
 * so a zoom into a far cluster neither swings wide nor rushes at the end.
 */
export function viewportBetween(from: Viewport, to: Viewport, t: number): Viewport {
  if (t >= 1) return to;
  if (t <= 0) return from;
  const scale = from.scale * Math.pow(to.scale / from.scale, t);
  const fromX = (MAP_WIDTH / 2 - from.x) / from.scale;
  const fromY = (MAP_HEIGHT / 2 - from.y) / from.scale;
  const toX = (MAP_WIDTH / 2 - to.x) / to.scale;
  const toY = (MAP_HEIGHT / 2 - to.y) / to.scale;
  const centreX = fromX + (toX - fromX) * t;
  const centreY = fromY + (toY - fromY) * t;
  return { scale, x: MAP_WIDTH / 2 - centreX * scale, y: MAP_HEIGHT / 2 - centreY * scale };
}

/** The first zoom past `current` where the members fall into more than one mark, or undefined. */
function firstSplitZoom(members: readonly MapPoint[], clusteringAt: ClusteringAt, current: number, max: number): number | undefined {
  for (let scale = current * 1.25; ; scale *= 1.25) {
    const at = Math.min(scale, max);
    const { radius, reach } = clusteringAt(at);
    if (clusterPoints(members, radius, reach).length > 1) return at;
    if (at >= max) return undefined;
  }
}

/**
 * Where a click on a cluster takes the map: as deep as splits it as far as
 * any zoom will (zoomToSplit), but no deeper than keeps every member in the
 * frame with `marginUnits` (frame map units) to spare, and never shallower
 * than its first split, so each click makes progress. When even the first
 * split cannot hold them all, the view centres on the biggest mark there.
 * Undefined when no zoom splits them: the map spreads them instead.
 *
 * Centred on the cluster's middle at the deepest split, a phone's x1 pile
 * of Los Angeles, its region and Honolulu showed neither: the middle of the
 * Pacific at x33.
 */
export function splitView(members: readonly MapPoint[], clusteringAt: ClusteringAt, current: number, max: number, marginUnits: number): Viewport | undefined {
  const deepest = zoomToSplit(members, clusteringAt, current, max);
  if (deepest === undefined) return undefined;
  const first = firstSplitZoom(members, clusteringAt, current, max) ?? deepest;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const member of members) {
    minX = Math.min(minX, member.x);
    maxX = Math.max(maxX, member.x);
    minY = Math.min(minY, member.y);
    maxY = Math.max(maxY, member.y);
  }
  const room = (span: number, frame: number) => (span > 1e-9 ? Math.max(0, frame - marginUnits * 2) / span : Infinity);
  const fits = Math.min(room(maxX - minX, MAP_WIDTH), room(maxY - minY, MAP_HEIGHT));
  const scale = Math.max(first, Math.min(deepest, fits));
  if (scale <= fits) return centreOn((minX + maxX) / 2, (minY + maxY) / 2, scale, max);
  const { radius, reach } = clusteringAt(scale);
  const biggest = clusterPoints(members, radius, reach).sort((a, b) => b.ids.length - a.ids.length)[0]!;
  return centreOn(biggest.x, biggest.y, scale, max);
}

/* --------------------------------- spread --------------------------------- */

/** One member's place in a spread, in screen px from the shared spot. */
export interface SpreadSlot {
  dx: number;
  dy: number;
}

/**
 * Where a spread puts `count` members around their shared spot (`anchor`, in
 * screen px inside a frame of `frame` px): the cells of a hex grid `spacing`
 * px apart, nearest first, keeping every target whole inside the frame
 * (`inset` px from each edge). Six members make one ring with the first at
 * twelve o'clock; twelve add the six nearest cells of the next ring, between
 * the first six, so every leader line runs clear of the inner marks.
 *
 * A circle of twelve 44 px targets needs about 190 px across, more than a
 * 343 px phone map is tall (171 px); hex cells pack the same targets into
 * the frame and slide to one side of a spot near its edge. Returns undefined
 * when the frame cannot hold them all (the page lists them instead).
 *
 * Slots come in the order members should take them: inner ring first, then
 * clockwise from twelve o'clock, so the member that needs a hand most (the
 * caller sorts them) sits at the top.
 */
export function spreadSlots(
  count: number,
  anchor: { x: number; y: number },
  frame: { width: number; height: number },
  spacing: number,
  inset: number,
  maxRings = 12,
): SpreadSlot[] | undefined {
  if (count < 1 || !(spacing > 0)) return count < 1 ? [] : undefined;
  // A hex lattice turned so one neighbour is straight up: basis (0, -s) and (s * sqrt(3) / 2, -s / 2).
  const ax = 0;
  const ay = -spacing;
  const bx = (spacing * Math.sqrt(3)) / 2;
  const by = -spacing / 2;
  const fits = (dx: number, dy: number) => {
    const x = anchor.x + dx;
    const y = anchor.y + dy;
    return x >= inset && x <= frame.width - inset && y >= inset && y <= frame.height - inset;
  };
  const cells: (SpreadSlot & { distance: number; angle: number })[] = [];
  for (let q = -maxRings; q <= maxRings; q += 1) {
    for (let r = -maxRings; r <= maxRings; r += 1) {
      const ring = (Math.abs(q) + Math.abs(r) + Math.abs(q + r)) / 2;
      if (ring === 0 || ring > maxRings) continue;
      const dx = q * ax + r * bx;
      const dy = q * ay + r * by;
      if (!fits(dx, dy)) continue;
      // Clockwise from straight up, 0 to 2 pi; rounded so cells of one ring tie exactly.
      let angle = Math.atan2(dx, -dy);
      if (angle < -1e-9) angle += Math.PI * 2;
      cells.push({ dx, dy, distance: Math.round(Math.hypot(dx, dy) * 1000) / 1000, angle: Math.round(angle * 1e6) / 1e6 });
    }
  }
  if (cells.length < count) return undefined;
  cells.sort((a, b) => a.distance - b.distance || a.angle - b.angle);
  return cells.slice(0, count).map(({ dx, dy }) => ({ dx: Math.round(dx * 100) / 100 || 0, dy: Math.round(dy * 100) / 100 || 0 }));
}

/** The box a spread covers around its spot, in the same px, its targets included. */
export function spreadBox(anchor: { x: number; y: number }, slots: readonly SpreadSlot[], reach: number): { left: number; top: number; right: number; bottom: number } {
  let left = anchor.x - reach;
  let right = anchor.x + reach;
  let top = anchor.y - reach;
  let bottom = anchor.y + reach;
  for (const slot of slots) {
    left = Math.min(left, anchor.x + slot.dx - reach);
    right = Math.max(right, anchor.x + slot.dx + reach);
    top = Math.min(top, anchor.y + slot.dy - reach);
    bottom = Math.max(bottom, anchor.y + slot.dy + reach);
  }
  return { left, top, right, bottom };
}

/* ------------------------------- the keyboard ------------------------------ */

export type MapDirection = "left" | "right" | "up" | "down";

const DIRECTION: Record<MapDirection, { x: number; y: number }> = {
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
};

/**
 * The marker an arrow key moves to: the nearest one within about 60 degrees
 * of that direction, counting sideways distance double; only when nothing
 * lies in that cone, the nearest anywhere on that side. Up from Falkenstein
 * goes to Helsinki, not to London two px higher and 48 px to the left.
 * Undefined when nothing lies that way.
 */
export function nearestInDirection(
  from: { x: number; y: number },
  candidates: readonly { key: string; x: number; y: number }[],
  direction: MapDirection,
): string | undefined {
  const axis = DIRECTION[direction];
  let inCone: string | undefined;
  let inConeScore = Infinity;
  let onSide: string | undefined;
  let onSideScore = Infinity;
  for (const candidate of candidates) {
    const dx = candidate.x - from.x;
    const dy = candidate.y - from.y;
    const along = dx * axis.x + dy * axis.y;
    if (along <= 0.5) continue;
    const across = Math.abs(dx * axis.y - dy * axis.x);
    const score = along + across * 2;
    if (across <= along * 2 && score < inConeScore) {
      inConeScore = score;
      inCone = candidate.key;
    }
    if (score < onSideScore) {
      onSideScore = score;
      onSide = candidate.key;
    }
  }
  return inCone ?? onSide;
}

/* ---------------------------------- arcs ---------------------------------- */

function curve(x1: number, y1: number, x2: number, y2: number, bend: number): string {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const length = Math.hypot(dx, dy);
  if (length < 1e-6) return "";
  // The normal that points up the screen (north): (dy, -dx) or (-dy, dx).
  let nx = dy / length;
  let ny = -dx / length;
  if (ny > 0) {
    nx = -nx;
    ny = -ny;
  }
  const cx = (x1 + x2) / 2 + nx * length * bend;
  const cy = (y1 + y2) / 2 + ny * length * bend;
  const f = (value: number) => value.toFixed(1);
  return `M${f(x1)} ${f(y1)} Q${f(cx)} ${f(cy)} ${f(x2)} ${f(y2)}`;
}

/**
 * The path of a probe arc between two points on the drawn map (screen or map
 * units, with `worldWidth` the width of the whole world in the same units),
 * bowed north by a fifth of its length. A pair more than half the world
 * apart goes the short way round, across the map's edge, in two pieces:
 * Shanghai to Los Angeles crosses the Pacific, not Eurasia and the Atlantic.
 */
export function arcPaths(from: { x: number; y: number }, to: { x: number; y: number }, worldWidth = MAP_WIDTH, bend = 0.2): string[] {
  const dx = to.x - from.x;
  let toX = to.x;
  if (dx > worldWidth / 2) toX -= worldWidth;
  else if (dx < -worldWidth / 2) toX += worldWidth;
  const main = curve(from.x, from.y, toX, to.y, bend);
  if (!main) return [];
  if (toX === to.x) return [main];
  return [main, curve(from.x + (to.x - toX), from.y, to.x, to.y, bend)];
}

/** What one target's latency reads from the source: the matrix cell's kind, its band and its loss. */
export interface ArcReading {
  kind: "measured" | "failing" | "unknown" | "paused" | "notProbeable" | "self";
  band?: "success" | "chart-2" | "warning" | "destructive";
  loss?: number;
}

/** How one arc is drawn. */
export interface ArcTone {
  tone: "success" | "chart-2" | "warning" | "destructive" | "failing" | "unknown";
  /** A measured member loses at least `lossAttention` of its probes. */
  lossy: boolean;
}

const BAND_RANK = { success: 0, "chart-2": 1, warning: 2, destructive: 3 } as const;

/**
 * One arc per target cluster, drawn as its worst member: every probe failing
 * beats any measurement, and among measurements the slowest band wins, so a
 * slow node is never hidden behind the green of its neighbours (the same rule
 * the marks follow). A cluster nothing was heard from reads unknown, never a
 * colour. Members that are not probed from the source (paused, not
 * probeable, the source itself) are left out; none probed means no arc.
 */
export function clusterArcTone(readings: readonly (ArcReading | undefined)[], lossAttention: number): ArcTone | undefined {
  let probed = false;
  let failing = false;
  let worst: ArcReading["band"];
  let lossy = false;
  for (const reading of readings) {
    if (!reading) continue;
    if (reading.kind === "failing") {
      probed = true;
      failing = true;
    } else if (reading.kind === "measured") {
      probed = true;
      if (reading.band && (worst === undefined || BAND_RANK[reading.band] > BAND_RANK[worst])) worst = reading.band;
      if ((reading.loss ?? 0) >= lossAttention) lossy = true;
    } else if (reading.kind === "unknown") {
      probed = true;
    }
  }
  if (!probed) return undefined;
  if (failing) return { tone: "failing", lossy };
  return { tone: worst ?? "unknown", lossy };
}
