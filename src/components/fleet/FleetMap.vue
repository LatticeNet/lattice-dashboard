<script setup lang="ts">
/**
 * Where the fleet runs, as status clusters with counts (design 23, 4.1 and
 * 4.2). Home draws it as its one picture (`compact`: no pan or zoom, the
 * whole map is one link the page wraps it in); the Map page draws it
 * interactive.
 *
 * A cluster is coloured by its worst member (fleetMapModel.clusterTone) and
 * carries a red count of members not reporting, so an offline node never
 * hides under the green of the twelve beside it. Marks keep their size on
 * screen as the map zooms; clusters are recomputed at every zoom, so they
 * split as the operator zooms in.
 *
 * On the Map page:
 *   - the wheel and a pinch zoom at the pointer, a drag pans, a double click
 *     or double tap zooms in (with Shift, out); at either zoom limit the
 *     wheel scrolls the page instead, so the page never traps it;
 *   - a click on one node emits it (the page opens its sheet); on a cluster
 *     a zoom can split, it zooms there; on a pile no zoom can split (GeoIP
 *     puts a city's nodes on one point), it spreads the pile out around its
 *     spot, each member a mark of its own on a leader line;
 *   - the pointer or the keyboard focus on a mark shows what it is
 *     (FleetMapCard); hovering a pile lists its members;
 *   - the marks are one tab stop: arrow keys move to the nearest mark that
 *     way, Enter or Space acts, Escape folds a spread back, + and - zoom and
 *     0 fits the fleet;
 *   - with `arcs`, probe arcs run from the latency source to every place it
 *     probes, coloured by the last hour's p50 and dashed where loss is high.
 *
 * The canvas stays dark in both themes, like the map before it: the land,
 * the marks and their rings are drawn for a dark surface.
 */
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useElementSize, useMediaQuery } from "@vueuse/core";
import { Minus, Plus, Scan } from "lucide-vue-next";

import { WORLD_RINGS } from "@/lib/map/worldGeo";
import { countryName } from "@/lib/fleet";
import { compareByAttention, nodeStatus } from "@/lib/nodeStatus";
import { cn } from "@/lib/utils";
import {
  MAP_HEIGHT,
  MAP_WIDTH,
  arcPaths,
  clampViewport,
  clusterArcTone,
  clusterPlace,
  clusterPoints,
  clusterRadius,
  clusterTone,
  fitViewport,
  maxZoomFor,
  nearestInDirection,
  project,
  ringPath,
  spreadBox,
  spreadSlots,
  viewportBetween,
  zoomAround,
  splitView,
  type ArcTone,
  type ClusterReach,
  type ClusterTone,
  type MapCluster,
  type MapDirection,
  type ReachCircle,
  type SpreadSlot,
  type Viewport,
} from "@/views/fleet/fleetMapModel";
import type { FleetMapFacts, FleetMapNode } from "./fleetMapTypes";

/** Home's picture never shows a card, so the card is its own chunk; the Map page asks for it as it mounts. */
const loadCard = () => import("./FleetMapCard.vue");
const FleetMapCard = defineAsyncComponent(loadCard);

export type { FleetMapNode } from "./fleetMapTypes";

/** A spread pile as the page needs it: its members and the box it covers, in px from the map's top left. */
export interface FleetMapSpread {
  ids: string[];
  box: { left: number; top: number; right: number; bottom: number };
}

const props = withDefaults(
  defineProps<{
    nodes: readonly FleetMapNode[];
    /** Home's picture: no pan or zoom, no focusable marks. */
    compact?: boolean;
    /** Nodes the page has open, drawn with a ring. */
    activeIds?: readonly string[];
    /** What the page read beside the node list, for the card and the arcs. */
    facts?: FleetMapFacts;
    /** Draw the probe arcs from the latency source. */
    arcs?: boolean;
    /** A member the page's list points at, drawn as if hovered. */
    highlightId?: string | null;
    /** The side of a spread the page's list covers; a leg's card opens on the other side. */
    spreadListSide?: "left" | "right" | null;
  }>(),
  { compact: false, activeIds: () => [], facts: undefined, arcs: false, highlightId: null, spreadListSide: null },
);

const emit = defineEmits<{
  /** One node to open, or (when a pile is too big to spread in this frame) the members to list. */
  select: [ids: string[], opener: Element];
  /** A pile spread out, or null once it folds back. */
  spread: [spread: FleetMapSpread | null];
  /** The member under the pointer, for the page's list. */
  hover: [id: string | null];
}>();

const { t, locale } = useI18n();
if (!props.compact) void loadCard();

/** Screen radius, in px, inside which marks merge. */
const CLUSTER_PX = 18;
const MARK_PX = 7;

const svg = ref<SVGSVGElement | null>(null);
const { width: svgWidth, height: svgHeight } = useElementSize(svg);
/** Map units per screen pixel at zoom 1. */
const unitsPerPx = computed(() => (svgWidth.value > 0 ? MAP_WIDTH / svgWidth.value : 1));
/** The deepest zoom this width may go: the same ground detail on a phone as on a desktop. */
const maxZoom = computed(() => maxZoomFor(svgWidth.value));

const viewport = ref<Viewport>({ scale: 1, x: 0, y: 0 });
/**
 * The zoom alone. Clusters live in map units, so a pan (a new viewport
 * object per frame) leaves them as they were; a computed on this value
 * re-runs only when the zoom changes.
 */
const zoomLevel = computed(() => viewport.value.scale);

const located = computed(() =>
  props.nodes.filter((node) => typeof node.geo?.lat === "number" && typeof node.geo?.lon === "number"),
);

const points = computed(() =>
  located.value.map((node) => {
    const at = project(node.geo!.lon!, node.geo!.lat!);
    return { id: node.id, x: at.x, y: at.y, status: nodeStatus(node) };
  }),
);

/** A 44 px target where a finger is the pointer; just past the mark where a mouse is. */
const coarse = useMediaQuery("(pointer: coarse)");
const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
function hitRadius(count: number): number {
  return coarse.value ? 22 : clusterRadius(count, MARK_PX) + 4;
}

/** Screen px to map units at a zoom (the current one by default). */
function toUnits(screenPx: number, scale = viewport.value.scale): number {
  return (screenPx * unitsPerPx.value) / scale;
}

/** How far a cluster's centre target or mark reaches, in screen px (Home's picture has no target: the mark and half its stroke). */
function ownPx(count: number): number {
  return props.compact ? clusterRadius(count, MARK_PX) + 0.75 : hitRadius(count);
}

/**
 * What a cluster occupies on screen, in map units: its target or mark, and
 * the not-reporting badge drawn at its upper right. Clusters whose circles
 * overlap merge, so no target sits on another and no badge on a neighbour.
 */
function reachAt(scale: number): ClusterReach {
  return (count, down) => {
    const circles: ReachCircle[] = [{ dx: 0, dy: 0, r: toUnits(ownPx(count), scale) }];
    if (down > 0 && count > 1) {
      const offset = toUnits(clusterRadius(count, MARK_PX) * 0.8, scale);
      circles.push({ dx: offset, dy: -offset, r: toUnits(6.5, scale) });
    }
    return circles;
  };
}

/** How the map clusters at a zoom; the zoom that splits a cluster is searched with the same rule. */
function clusteringAt(scale: number) {
  return { radius: toUnits(CLUSTER_PX, scale), reach: reachAt(scale) };
}

/**
 * Clusters in paint order: the biggest last, so it sits on top. A neighbour
 * painted later used to cover the centre of a 12-node cluster with its hit
 * circle, and a click on the "12" opened the neighbour instead.
 */
const clusters = computed<MapCluster[]>(() => {
  const { radius, reach } = clusteringAt(zoomLevel.value);
  return clusterPoints(points.value, radius, reach).sort((a, b) => a.ids.length - b.ids.length || a.key.localeCompare(b.key));
});

const byId = computed(() => new Map(props.nodes.map((node) => [node.id, node])));
/**
 * The land as two paths: one fill whose stroke, in map units, closes the
 * slivers that simplifying each country on its own left along shared
 * borders (dark wedges at depth), and the borders drawn over it.
 */
const landPath = WORLD_RINGS.map((ring) => ringPath(ring)).filter(Boolean).join(" ");

const TONE: Record<ClusterTone, { fill: string; stroke: string }> = {
  success: { fill: "fill-success/30", stroke: "stroke-success" },
  warning: { fill: "fill-warning/30", stroke: "stroke-warning" },
  destructive: { fill: "fill-destructive/35", stroke: "stroke-destructive" },
  muted: { fill: "fill-muted-foreground/25", stroke: "stroke-muted-foreground" },
};

/** A single member's mark: a fuller fill, so a spread's legs read as machines, not piles. */
const LEG_TONE: Record<ClusterTone, string> = {
  success: "fill-success/70 stroke-success",
  warning: "fill-warning/70 stroke-warning",
  destructive: "fill-destructive/70 stroke-destructive",
  muted: "fill-muted-foreground/50 stroke-muted-foreground",
};

function screenX(x: number): number {
  return viewport.value.x + x * viewport.value.scale;
}
function screenY(y: number): number {
  return viewport.value.y + y * viewport.value.scale;
}
/** A size in screen px, in map units, so marks stay the same size as the map zooms. */
function px(value: number): number {
  return value * unitsPerPx.value;
}
/** A map point in px from the map's top left. */
function framePx(x: number, y: number): { x: number; y: number } {
  return { x: screenX(x) / unitsPerPx.value, y: screenY(y) / unitsPerPx.value };
}

/** Named from every member: a city, a country, or how many places. */
function placeOf(ids: readonly string[]): string {
  const where = clusterPlace(ids.map((id) => byId.value.get(id)?.geo));
  switch (where.kind) {
    case "city":
      return [where.city, where.country].filter(Boolean).join(", ");
    case "country":
      return countryName(where.country, locale.value);
    case "places":
      return t("fleet.map.cluster.places", { n: where.count });
    default:
      return "";
  }
}

function nodeLabel(id: string): string {
  const node = byId.value.get(id);
  return t("fleet.map.cluster.one", { name: node?.name || id, place: placeOf([id]) || t("fleet.map.cluster.somewhere") });
}

/* ------------------------------ pan and zoom ------------------------------ */

let animation = 0;
let afterAnimation: (() => void) | null = null;
/** Where the running glide ends, so a second click on + zooms on from there rather than from mid-glide. */
let animationTarget: Viewport | null = null;

function stopAnimation(): void {
  if (animation) cancelAnimationFrame(animation);
  animation = 0;
  afterAnimation = null;
  animationTarget = null;
}

function setViewport(next: Viewport): void {
  stopAnimation();
  viewport.value = clampViewport(next, maxZoom.value);
}

/**
 * Glide to a viewport in 240 ms, easing out; any wheel, drag, pinch or key
 * zoom stops it where it is and carries on from there. Reduced motion jumps.
 */
function animateTo(target: Viewport, done?: () => void): void {
  stopAnimation();
  const to = clampViewport(target, maxZoom.value);
  const from = { ...viewport.value };
  if (reducedMotion.value || (Math.abs(from.scale - to.scale) < 1e-3 && Math.abs(from.x - to.x) < 0.5 && Math.abs(from.y - to.y) < 0.5)) {
    viewport.value = to;
    done?.();
    return;
  }
  afterAnimation = done ?? null;
  animationTarget = to;
  const started = performance.now();
  const step = (now: number) => {
    const t = Math.min(1, (now - started) / 240);
    viewport.value = viewportBetween(from, to, 1 - Math.pow(1 - t, 3));
    if (t < 1) {
      animation = requestAnimationFrame(step);
      return;
    }
    animation = 0;
    animationTarget = null;
    const then = afterAnimation;
    afterAnimation = null;
    then?.();
  };
  animation = requestAnimationFrame(step);
}

/** Zoom by a factor around the frame's centre, or around a map point; from the end of a glide still running. */
function zoomBy(factor: number, anchor = { x: MAP_WIDTH / 2, y: MAP_HEIGHT / 2 }): void {
  const base = animationTarget ?? viewport.value;
  animateTo(zoomAround(base, base.scale * factor, anchor, maxZoom.value));
}

function fitFleet(): void {
  animateTo(fitViewport(points.value, maxZoom.value));
}

// A narrower frame lowers nothing below x5, but a wider one may lower the deepest zoom.
watch(maxZoom, () => {
  if (viewport.value.scale > maxZoom.value) setViewport(viewport.value);
});

onBeforeUnmount(stopAnimation);

function svgPointAt(clientX: number, clientY: number): { x: number; y: number } {
  const rect = svg.value?.getBoundingClientRect();
  if (!rect || rect.width === 0) return { x: MAP_WIDTH / 2, y: MAP_HEIGHT / 2 };
  return { x: ((clientX - rect.left) / rect.width) * MAP_WIDTH, y: ((clientY - rect.top) / rect.height) * MAP_HEIGHT };
}

/**
 * The wheel zooms at the pointer: a notch of a mouse wheel is about x1.28,
 * a trackpad pinch (which the browser sends as a wheel with Ctrl) follows
 * the fingers. A sideways trackpad swipe on a zoomed map pans. At a limit
 * the wheel is left to the page, except a pinch, which would zoom the page.
 */
function onWheel(event: WheelEvent): void {
  if (props.compact) return;
  const pinch = event.ctrlKey || event.metaKey;
  const current = viewport.value;
  if (!pinch && current.scale > 1 && Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
    event.preventDefault();
    const rect = svg.value!.getBoundingClientRect();
    setViewport({ ...current, x: current.x - (event.deltaX / rect.width) * MAP_WIDTH });
    return;
  }
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
  const next = Math.max(1, Math.min(maxZoom.value, current.scale * Math.exp(-event.deltaY * unit * (pinch ? 0.01 : 0.0025))));
  if (pinch) event.preventDefault();
  if (Math.abs(next - current.scale) < 1e-3) return;
  event.preventDefault();
  hideCard();
  setViewport(zoomAround(current, next, svgPointAt(event.clientX, event.clientY), maxZoom.value));
}

type Gesture =
  | { kind: "press"; pointerId: number; clientX: number; clientY: number; from: Viewport; moved: boolean; onMark: boolean }
  | { kind: "pinch"; ids: [number, number]; distance: number; mid: { x: number; y: number }; from: Viewport };

const pointers = new Map<number, { x: number; y: number }>();
let gesture: Gesture | null = null;
const panning = ref(false);
let suppressClickUntil = 0;
let lastTap: { at: number; x: number; y: number } | null = null;

function pinchFrom(ids: [number, number]): Gesture {
  const a = pointers.get(ids[0])!;
  const b = pointers.get(ids[1])!;
  return {
    kind: "pinch",
    ids,
    distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
    mid: svgPointAt((a.x + b.x) / 2, (a.y + b.y) / 2),
    from: { ...viewport.value },
  };
}

function onPointerDown(event: PointerEvent): void {
  if (props.compact || (event.pointerType === "mouse" && event.button !== 0)) return;
  stopAnimation();
  // A primary pointer going down means no other is: drop any whose release was missed outside the map.
  if (event.isPrimary) pointers.clear();
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (pointers.size === 2) {
    const ids = [...pointers.keys()] as [number, number];
    for (const id of ids) svg.value?.setPointerCapture?.(id);
    gesture = pinchFrom(ids);
    hideCard();
    return;
  }
  if (pointers.size > 2) return;
  gesture = {
    kind: "press",
    pointerId: event.pointerId,
    clientX: event.clientX,
    clientY: event.clientY,
    from: { ...viewport.value },
    moved: false,
    onMark: !!(event.target as Element | null)?.closest?.("[data-marker]"),
  };
}

function onPointerMove(event: PointerEvent): void {
  if (!pointers.has(event.pointerId)) return;
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (gesture?.kind === "pinch") {
    const a = pointers.get(gesture.ids[0]);
    const b = pointers.get(gesture.ids[1]);
    if (!a || !b) return;
    const scale = gesture.from.scale * (Math.hypot(a.x - b.x, a.y - b.y) / gesture.distance);
    const mid = svgPointAt((a.x + b.x) / 2, (a.y + b.y) / 2);
    // The map point that was under the fingers' middle stays under it as they move and spread.
    const worldX = (gesture.mid.x - gesture.from.x) / gesture.from.scale;
    const worldY = (gesture.mid.y - gesture.from.y) / gesture.from.scale;
    const next = Math.max(1, Math.min(maxZoom.value, scale));
    setViewport({ scale: next, x: mid.x - worldX * next, y: mid.y - worldY * next });
    return;
  }
  if (gesture?.kind !== "press" || gesture.pointerId !== event.pointerId) return;
  const dxPx = event.clientX - gesture.clientX;
  const dyPx = event.clientY - gesture.clientY;
  if (!gesture.moved) {
    if (Math.abs(dxPx) + Math.abs(dyPx) <= 4) return;
    gesture.moved = true;
    // Captured only once it is a drag, so a press that stays put is a click on the mark under it.
    if (viewport.value.scale > 1) {
      svg.value?.setPointerCapture?.(event.pointerId);
      panning.value = true;
      hideCard();
    }
  }
  if (!panning.value) return;
  const rect = svg.value!.getBoundingClientRect();
  setViewport({
    scale: gesture.from.scale,
    x: gesture.from.x + (dxPx / rect.width) * MAP_WIDTH,
    y: gesture.from.y + (dyPx / rect.height) * MAP_HEIGHT,
  });
}

function onPointerUp(event: PointerEvent): void {
  if (!pointers.has(event.pointerId)) return;
  pointers.delete(event.pointerId);
  if (svg.value?.hasPointerCapture?.(event.pointerId)) svg.value.releasePointerCapture(event.pointerId);
  const ended = gesture;
  if (ended?.kind === "pinch") {
    suppressClickUntil = Date.now() + 250;
    // One finger stays down: it carries on as a pan from here, never a tap.
    const [rest] = [...pointers.entries()];
    gesture = rest
      ? { kind: "press", pointerId: rest[0], clientX: rest[1].x, clientY: rest[1].y, from: { ...viewport.value }, moved: true, onMark: false }
      : null;
    panning.value = !!rest && viewport.value.scale > 1;
    if (panning.value && rest) svg.value?.setPointerCapture?.(rest[0]);
    return;
  }
  if (ended?.kind !== "press" || ended.pointerId !== event.pointerId) return;
  gesture = null;
  panning.value = false;
  if (ended.moved) {
    suppressClickUntil = Date.now() + 180;
    return;
  }
  if (event.type === "pointercancel" || ended.onMark) return;
  onBackgroundTap(event);
}

/**
 * A tap on open map: it folds a spread back and puts the card away; a
 * second one within 300 ms and 24 px zooms in there (with Shift, out).
 */
function onBackgroundTap(event: PointerEvent): void {
  const now = Date.now();
  const previous = lastTap;
  if (previous && now - previous.at < 300 && Math.hypot(event.clientX - previous.x, event.clientY - previous.y) < 24) {
    lastTap = null;
    zoomBy(event.shiftKey ? 1 / 2 : 2, svgPointAt(event.clientX, event.clientY));
    return;
  }
  lastTap = { at: now, x: event.clientX, y: event.clientY };
  hideCard();
  if (spread.value) collapseSpread(false);
}

/* --------------------------------- spread --------------------------------- */

interface Spread {
  key: string;
  /** Members in slot order, worst first. */
  ids: string[];
  /** The shared spot, in map units. */
  x: number;
  y: number;
  scale: number;
  width: number;
  slots: SpreadSlot[];
}

const spread = ref<Spread | null>(null);
/** False while the legs sit on the spot (just opened, or folding back), so the move out and in is a transition. */
const spreadOpen = ref(false);
/** Which opening the pending frame belongs to: a spread folded or replaced before it lands stays shut. */
let spreadSeq = 0;
let foldTimer: ReturnType<typeof setTimeout> | undefined;

const legHit = computed(() => (coarse.value ? 22 : hitRadius(1)));

function membersInOrder(ids: readonly string[]): string[] {
  return ids
    .map((id) => byId.value.get(id))
    .filter((node): node is FleetMapNode => !!node)
    .sort((a, b) => compareByAttention(a, b) || (a.name || a.id).localeCompare(b.name || b.id))
    .map((node) => node.id);
}

function spreadState(at: Spread): FleetMapSpread {
  const anchor = framePx(at.x, at.y);
  const box = spreadBox(anchor, at.slots, legHit.value);
  // The svg sits inside the frame's 1 px border.
  return { ids: at.ids, box: { left: box.left + 1, top: box.top + 1, right: box.right + 1, bottom: box.bottom + 1 } };
}

/**
 * Spread a pile out around its spot; false when this frame cannot hold its
 * members apart. From the keyboard, focus moves to the first leg; from a
 * click or a tap it rests on the map itself, so Escape and the arrow keys
 * still work without a focus ring appearing on a leg nobody chose.
 */
function openSpread(cluster: MapCluster, fromKeyboard: boolean): boolean {
  const ids = membersInOrder(cluster.ids);
  const anchor = framePx(cluster.x, cluster.y);
  const slots = spreadSlots(
    ids.length,
    anchor,
    { width: svgWidth.value, height: svgHeight.value },
    coarse.value ? 46 : 26,
    legHit.value + 1,
  );
  if (!slots) return false;
  clearTimeout(foldTimer);
  const next: Spread = { key: cluster.key, ids, x: cluster.x, y: cluster.y, scale: viewport.value.scale, width: svgWidth.value, slots };
  spread.value = next;
  spreadOpen.value = false;
  const seq = ++spreadSeq;
  hideCard();
  emit("spread", spreadState(next));
  if (reducedMotion.value) spreadOpen.value = true;
  // Two frames: the legs paint on the spot first, so moving out is a transition.
  else requestAnimationFrame(() => requestAnimationFrame(() => (spreadOpen.value = seq === spreadSeq && !!spread.value)));
  if (fromKeyboard) focusMarker(`n:${ids[0]}`);
  else {
    focusKey.value = `n:${ids[0]}`;
    svg.value?.focus({ preventScroll: true });
  }
  return true;
}

/** Fold the spread back onto its spot; focus returns to the pile when asked. */
function collapseSpread(returnFocus: boolean, animate = true): void {
  const open = spread.value;
  if (!open) return;
  spreadSeq += 1;
  spreadOpen.value = false;
  emit("spread", null);
  clearTimeout(foldTimer);
  const finish = () => {
    if (spread.value !== open) return;
    spread.value = null;
    if (returnFocus) focusMarker(`c:${open.key}`);
  };
  if (!animate || reducedMotion.value) finish();
  else foldTimer = setTimeout(finish, 200);
}

// A zoom or a new width moves every other mark, so a spread folds at once rather than float over a new layout.
watch([zoomLevel, svgWidth], () => {
  const open = spread.value;
  if (open && (Math.abs(open.scale - zoomLevel.value) > 1e-3 || Math.abs(open.width - svgWidth.value) > 0.5)) collapseSpread(false, false);
});

// A member gone from the list leaves its leg empty; under two left, there is nothing to spread.
watch(byId, (nodes) => {
  const open = spread.value;
  if (open && open.ids.filter((id) => nodes.has(id)).length < 2) collapseSpread(false, false);
});

onBeforeUnmount(() => clearTimeout(foldTimer));

/** Clusters drawn as marks: all of them but the one spread out. */
const visibleClusters = computed(() => (spread.value ? clusters.value.filter((cluster) => cluster.key !== spread.value!.key) : clusters.value));

/** The spread's legs: member, slot, and where the leg's mark is in frame px. */
const legs = computed(() => {
  const open = spread.value;
  if (!open) return [];
  const anchor = framePx(open.x, open.y);
  return open.ids
    .map((id, index) => ({ id, slot: open.slots[index]!, node: byId.value.get(id) }))
    .filter((leg): leg is { id: string; slot: SpreadSlot; node: FleetMapNode } => !!leg.node)
    .map((leg) => ({ ...leg, at: { x: anchor.x + leg.slot.dx, y: anchor.y + leg.slot.dy } }));
});

/* ---------------------------- clicks and the keys ---------------------------- */

type Action = "open" | "zoom" | "spread" | "list";

/**
 * What a click on a cluster does: open its one node; zoom in while a zoom
 * can split it, so every member that has a place of its own is drawn there;
 * spread it once none can (members on one spot, or closer than two targets
 * at the deepest zoom). Twelve on one Los Angeles point and one in San Jose
 * take a zoom, then a spread: a spread straight away would hang San Jose on
 * a leader line from Los Angeles.
 */
function actionFor(cluster: MapCluster): { action: Action; view?: Viewport } {
  if (cluster.ids.length === 1) return { action: "open" };
  const members = points.value.filter((point) => cluster.ids.includes(point.id));
  // Room for a whole target at the frame's edge.
  const view = splitView(members, clusteringAt, viewport.value.scale, maxZoom.value, px(hitRadius(1) + 6));
  return view ? { action: "zoom", view } : { action: "spread" };
}

function activateCluster(cluster: MapCluster, opener: Element, fromKeyboard = false): void {
  if (props.compact || Date.now() < suppressClickUntil) return;
  const { action, view } = actionFor(cluster);
  if (action === "zoom" && view) {
    const wasFocused = opener.contains(document.activeElement);
    hideCard();
    animateTo(view, () => {
      // The pile split under the focus: move it to the mark nearest where the pile was.
      if (wasFocused) focusNearest(framePx(cluster.x, cluster.y));
    });
    return;
  }
  if (action === "spread" && openSpread(cluster, fromKeyboard)) return;
  hideCard();
  emit("select", action === "open" ? cluster.ids : membersInOrder(cluster.ids), opener);
}

function activateLeg(id: string, opener: Element): void {
  if (Date.now() < suppressClickUntil) return;
  hideCard();
  emit("select", [id], opener);
}

/**
 * The compact map sits inside a link to the Map page, so a click on a mark
 * has to reach that link; only the interactive map keeps it to itself.
 */
function onClusterClick(cluster: MapCluster, event: MouseEvent): void {
  if (props.compact) return;
  event.stopPropagation();
  activateCluster(cluster, event.currentTarget as Element);
}

/** Every mark the keys can reach, in frame px; a spread's legs alone while one is open. */
const markers = computed(() => {
  if (legs.value.length) return legs.value.map((leg) => ({ key: `n:${leg.id}`, ...leg.at }));
  return visibleClusters.value.map((cluster) => ({ key: `c:${cluster.key}`, ...framePx(cluster.x, cluster.y) }));
});

/** The one mark in the tab order: the last one focused while it is still drawn, else the westmost. */
const focusKey = ref<string | null>(null);
const tabKey = computed(() => {
  const list = markers.value;
  if (focusKey.value && list.some((marker) => marker.key === focusKey.value)) return focusKey.value;
  return [...list].sort((a, b) => a.x - b.x || a.y - b.y)[0]?.key;
});

function focusMarker(key: string): void {
  focusKey.value = key;
  void nextTick(() => {
    const element = svg.value?.querySelector<SVGElement>(`[data-marker="${CSS.escape(key)}"]`);
    element?.focus({ preventScroll: true });
  });
}

function focusNearest(at: { x: number; y: number }): void {
  let best: string | undefined;
  let bestDistance = Infinity;
  for (const marker of markers.value) {
    const distance = Math.hypot(marker.x - at.x, marker.y - at.y);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = marker.key;
    }
  }
  if (best) focusMarker(best);
}

const ARROWS: Record<string, MapDirection> = { ArrowLeft: "left", ArrowRight: "right", ArrowUp: "up", ArrowDown: "down" };

function onMarkerKeydown(event: KeyboardEvent, key: string, activate: () => void): void {
  const direction = ARROWS[event.key];
  if (direction) {
    event.preventDefault();
    event.stopPropagation();
    const from = markers.value.find((marker) => marker.key === key);
    if (!from) return;
    const next = nearestInDirection(from, markers.value.filter((marker) => marker.key !== key), direction);
    if (next) focusMarker(next);
    return;
  }
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    event.stopPropagation();
    activate();
    return;
  }
  if (event.key === "Escape" && (spread.value || card.value)) {
    event.preventDefault();
    event.stopPropagation();
    if (spread.value) collapseSpread(true);
    else hideCard();
  }
}

/**
 * + and - zoom around the focused mark (or the centre), 0 fits the fleet.
 * With the map itself focused (after a click spread a pile), Escape folds
 * the spread back and an arrow key steps onto the marks.
 */
function onMapKeydown(event: KeyboardEvent): void {
  if (props.compact || event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.target === svg.value) {
    if (event.key === "Escape" && spread.value) {
      event.preventDefault();
      collapseSpread(true);
      return;
    }
    if (ARROWS[event.key] && tabKey.value) {
      event.preventDefault();
      focusMarker(tabKey.value);
      return;
    }
  }
  const focused = (event.target as Element | null)?.closest?.("[data-marker]")?.getAttribute("data-marker");
  const marker = markers.value.find((entry) => entry.key === focused);
  const anchor = marker ? { x: marker.x * unitsPerPx.value, y: marker.y * unitsPerPx.value } : undefined;
  if (event.key === "+" || event.key === "=") zoomBy(1.6, anchor);
  else if (event.key === "-" || event.key === "_") zoomBy(1 / 1.6, anchor);
  else if (event.key === "0") fitFleet();
  else return;
  event.preventDefault();
}

/* ---------------------------------- card ---------------------------------- */

type Hot = { kind: "cluster"; key: string } | { kind: "node"; id: string } | { kind: "arc"; key: string };

const hovered = ref<Hot | null>(null);
const focused = ref<Hot | null>(null);
let hideTimer: ReturnType<typeof setTimeout> | undefined;

function sameHot(a: Hot | null, b: Hot): boolean {
  if (!a || a.kind !== b.kind) return false;
  return a.kind === "node" ? a.id === (b as { id: string }).id : a.key === (b as { key: string }).key;
}

function onMarkEnter(event: PointerEvent, hot: Hot): void {
  if (props.compact || (event.pointerType !== "mouse" && event.pointerType !== "pen") || panning.value) return;
  clearTimeout(hideTimer);
  hovered.value = hot;
  emit("hover", hot.kind === "node" ? hot.id : null);
}

/** A short grace, so the pointer can cross from one leg to the next without the card blinking. */
function onMarkLeave(): void {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    hovered.value = null;
    emit("hover", null);
  }, 80);
}

/** The keyboard's focus shows the same card; a click's focus does not. */
function onMarkFocus(event: FocusEvent, key: string, hot: Hot): void {
  focusKey.value = key;
  if ((event.target as Element).matches(":focus-visible")) focused.value = hot;
}

function onMarkBlur(): void {
  focused.value = null;
}

function hideCard(): void {
  clearTimeout(hideTimer);
  hovered.value = null;
  focused.value = null;
}

onBeforeUnmount(() => clearTimeout(hideTimer));

function isHot(hot: Hot): boolean {
  if (hot.kind === "node" && props.highlightId === hot.id) return true;
  return sameHot(hovered.value, hot) || sameHot(focused.value, hot);
}

function isActive(ids: readonly string[]): boolean {
  return ids.some((id) => props.activeIds.includes(id));
}

/** The ring around a mark: solid and thicker for the keyboard's focus, solid for an open node, faint for the pointer. */
function ringFor(ids: readonly string[], hot: Hot): { cls: string; width: number } | undefined {
  if (sameHot(focused.value, hot)) return { cls: "stroke-white", width: 2.5 };
  if (isActive(ids)) return { cls: "stroke-white", width: 1.5 };
  if (isHot(hot)) return { cls: "stroke-white/60", width: 1.5 };
  return undefined;
}

const HINT: Record<Action, string> = {
  open: "fleet.map.card.hintOpen",
  zoom: "fleet.map.card.hintZoom",
  spread: "fleet.map.card.hintSpread",
  list: "fleet.map.card.hintList",
};

/** What the card shows and where, in px from this component's top left. */
const card = computed(() => {
  const hot = hovered.value ?? focused.value;
  if (!hot || props.compact || panning.value) return null;
  let mode: "node" | "pile" | "arc";
  let ids: string[];
  let at: { x: number; y: number };
  let reach: number;
  let hint: string;
  if (hot.kind === "node") {
    const leg = legs.value.find((entry) => entry.id === hot.id);
    if (!leg) return null;
    mode = "node";
    ids = [leg.id];
    at = leg.at;
    reach = legHit.value;
    hint = t(HINT.open);
  } else {
    const cluster = visibleClusters.value.find((entry) => entry.key === hot.key);
    if (!cluster) return null;
    ids = membersInOrder(cluster.ids);
    at = framePx(cluster.x, cluster.y);
    reach = hitRadius(cluster.ids.length);
    if (hot.kind === "arc") {
      mode = "arc";
      hint = t("fleet.map.card.hintArc");
    } else {
      mode = cluster.ids.length === 1 ? "node" : "pile";
      hint = t(HINT[actionFor(cluster).action]);
    }
  }
  const nodes = ids.map((id) => byId.value.get(id)).filter((node): node is FleetMapNode => !!node);
  // Beside the mark, on whichever side has room; above it in the lower half of the map.
  // A leg's card goes beside the whole spread, on the side the page's list leaves free, so it covers neither.
  const width = 256;
  let left = at.x + reach + 10 + width <= svgWidth.value ? at.x + reach + 10 : at.x - reach - 10 - width;
  if (hot.kind === "node" && spread.value) {
    const box = spreadBox(framePx(spread.value.x, spread.value.y), spread.value.slots, legHit.value);
    const leftSide = box.left - 10 - width;
    const rightSide = box.right + 10;
    if (props.spreadListSide === "right") left = leftSide >= 4 ? leftSide : rightSide;
    else if (props.spreadListSide === "left") left = rightSide + width <= svgWidth.value ? rightSide : leftSide;
    else left = rightSide + width <= svgWidth.value ? rightSide : leftSide;
  }
  const style: Record<string, string> = { left: `${Math.max(4, left) + 1}px` };
  if (at.y > svgHeight.value / 2) style.bottom = `${Math.max(4, svgHeight.value - at.y - 16)}px`;
  else style.top = `${Math.max(4, at.y - 16) + 1}px`;
  return { mode, nodes, place: placeOf(ids), hint, style };
});

/* ---------------------------------- arcs ---------------------------------- */

const ARC_CLASS: Record<ArcTone["tone"], string> = {
  success: "stroke-success",
  "chart-2": "stroke-chart-2",
  warning: "stroke-warning",
  destructive: "stroke-destructive",
  failing: "stroke-destructive",
  unknown: "stroke-white/45",
};

/** Where the latency source is drawn: its cluster, or the spot of the spread holding it. */
const source = computed(() => {
  const id = props.facts?.latency?.sourceId;
  if (!id || props.compact || !props.arcs) return undefined;
  if (spread.value?.ids.includes(id)) return { key: spread.value.key, x: spread.value.x, y: spread.value.y, count: spread.value.ids.length };
  const cluster = clusters.value.find((entry) => entry.ids.includes(id));
  return cluster ? { key: cluster.key, x: cluster.x, y: cluster.y, count: cluster.ids.length } : undefined;
});

/** One arc per place the source probes, drawn as its worst member. */
const arcs = computed(() => {
  const latency = props.facts?.latency;
  const from = source.value;
  if (!latency || !from) return [];
  const targets: { key: string; x: number; y: number; ids: readonly string[] }[] = visibleClusters.value.map((cluster) => cluster);
  if (spread.value) targets.push({ key: spread.value.key, x: spread.value.x, y: spread.value.y, ids: spread.value.ids });
  const start = { x: screenX(from.x), y: screenY(from.y) };
  const out: { key: string; tone: ArcTone; paths: string[] }[] = [];
  for (const target of targets) {
    if (target.key === from.key) continue;
    const tone = clusterArcTone(target.ids.map((id) => latency.readings.get(id)), latency.lossAttention);
    if (!tone) continue;
    out.push({ key: target.key, tone, paths: arcPaths(start, { x: screenX(target.x), y: screenY(target.y) }, MAP_WIDTH * viewport.value.scale) });
  }
  return out;
});

function arcDash(tone: ArcTone): string | undefined {
  if (tone.tone === "failing" || tone.tone === "unknown") return `${px(1.5)} ${px(3.5)}`;
  if (tone.lossy) return `${px(7)} ${px(4)}`;
  return undefined;
}

function clusterLabel(cluster: MapCluster): string {
  const where = placeOf(cluster.ids) || t("fleet.map.cluster.somewhere");
  if (cluster.ids.length === 1) return nodeLabel(cluster.ids[0]!);
  const base = t("fleet.map.cluster.many", { n: cluster.ids.length, place: where });
  const parts = [base];
  if (cluster.down > 0) parts.push(t("fleet.map.cluster.down", { n: cluster.down }));
  if (!props.compact) parts.push(t(HINT[actionFor(cluster).action]));
  return parts.join(", ");
}

function legTone(node: FleetMapNode): string {
  return LEG_TONE[clusterTone([nodeStatus(node)])];
}

defineExpose({
  reset: () => setViewport({ scale: 1, x: 0, y: 0 }),
  collapse: () => collapseSpread(false),
});
</script>

<template>
  <div class="relative">
    <div class="relative overflow-hidden rounded-lg border border-border bg-[oklch(0.18_0.025_265)]">
      <svg
        ref="svg"
        :viewBox="`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`"
        :class="cn('block aspect-[2/1] w-full select-none outline-none', !compact && (viewport.scale > 1 ? 'touch-none' : 'touch-pan-y'), !compact && viewport.scale > 1 && (panning ? 'cursor-grabbing' : 'cursor-grab'))"
        :role="compact ? 'img' : 'group'"
        :aria-label="$t('fleet.map.aria', { located: located.length, total: nodes.length })"
        :aria-describedby="compact ? undefined : 'fleet-map-keys'"
        :tabindex="compact ? undefined : -1"
        data-testid="fleet-map"
        :data-zoom="viewport.scale"
        @wheel="onWheel"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerUp"
        @keydown="onMapKeydown"
      >
        <g :transform="`translate(${viewport.x} ${viewport.y}) scale(${viewport.scale})`" aria-hidden="true">
          <path :d="landPath" fill="oklch(0.32 0.03 215 / 0.72)" stroke="oklch(0.32 0.03 215 / 0.72)" stroke-width="0.6" stroke-linejoin="round" />
          <path
            :d="landPath"
            fill="none"
            stroke="oklch(0.64 0.05 210 / 0.5)"
            stroke-width="0.5"
            stroke-linejoin="round"
            vector-effect="non-scaling-stroke"
          />
        </g>

        <!-- Probe arcs, under the marks so a mark always takes the pointer first. -->
        <g v-if="arcs.length" data-testid="fleet-map-arcs">
          <g
            v-for="arc in arcs"
            :key="arc.key"
            :data-arc="arc.key"
            :data-tone="arc.tone.tone"
            @pointerenter="onMarkEnter($event, { kind: 'arc', key: arc.key })"
            @pointerleave="onMarkLeave"
          >
            <path
              v-for="(d, index) in arc.paths"
              :key="index"
              :d="d"
              fill="none"
              :class="ARC_CLASS[arc.tone.tone]"
              :stroke-width="px(isHot({ kind: 'arc', key: arc.key }) ? 2.5 : 1.5)"
              :stroke-dasharray="arcDash(arc.tone)"
              stroke-linecap="round"
              :opacity="isHot({ kind: 'arc', key: arc.key }) ? 1 : 0.8"
            />
            <path v-for="(d, index) in arc.paths" :key="`hit${index}`" :d="d" fill="none" stroke="transparent" :stroke-width="px(10)" pointer-events="stroke" />
          </g>
        </g>

        <g
          v-for="cluster in visibleClusters"
          :key="cluster.key"
          :role="compact ? undefined : 'button'"
          :tabindex="compact ? undefined : tabKey === `c:${cluster.key}` ? 0 : -1"
          :aria-label="compact ? undefined : clusterLabel(cluster)"
          :class="cn('fleet-map-mark', !compact && 'cursor-pointer', spread && 'fleet-map-dim')"
          :data-cluster="cluster.key"
          :data-count="cluster.ids.length"
          :data-marker="compact ? undefined : `c:${cluster.key}`"
          :data-hot="isHot({ kind: 'cluster', key: cluster.key }) || undefined"
          @click="onClusterClick(cluster, $event)"
          @keydown="onMarkerKeydown($event, `c:${cluster.key}`, () => activateCluster(cluster, $event.currentTarget as Element, true))"
          @pointerenter="onMarkEnter($event, { kind: 'cluster', key: cluster.key })"
          @pointerleave="onMarkLeave"
          @focus="onMarkFocus($event, `c:${cluster.key}`, { kind: 'cluster', key: cluster.key })"
          @blur="onMarkBlur"
        >
          <title v-if="compact">{{ clusterLabel(cluster) }}</title>
          <!-- 44 px across on a phone, just past the mark with a mouse. -->
          <circle v-if="!compact" :cx="screenX(cluster.x)" :cy="screenY(cluster.y)" :r="px(hitRadius(cluster.ids.length))" fill="transparent" />
          <circle
            v-if="ringFor(cluster.ids, { kind: 'cluster', key: cluster.key })"
            :cx="screenX(cluster.x)"
            :cy="screenY(cluster.y)"
            :r="px(clusterRadius(cluster.ids.length, MARK_PX) + 4.5)"
            fill="none"
            :class="ringFor(cluster.ids, { kind: 'cluster', key: cluster.key })!.cls"
            :stroke-width="px(ringFor(cluster.ids, { kind: 'cluster', key: cluster.key })!.width)"
          />
          <g class="fleet-map-body">
            <circle
              :cx="screenX(cluster.x)"
              :cy="screenY(cluster.y)"
              :r="px(clusterRadius(cluster.ids.length, MARK_PX))"
              :class="cn(TONE[cluster.tone].fill, TONE[cluster.tone].stroke)"
              :stroke-width="px(1.5)"
            />
            <text
              v-if="cluster.ids.length > 1"
              :x="screenX(cluster.x)"
              :y="screenY(cluster.y)"
              text-anchor="middle"
              dominant-baseline="central"
              class="fill-white font-mono font-semibold"
              :font-size="px(10)"
            >{{ cluster.ids.length }}</text>
            <g v-if="cluster.down > 0 && cluster.ids.length > 1">
              <circle
                :cx="screenX(cluster.x) + px(clusterRadius(cluster.ids.length, MARK_PX) * 0.8)"
                :cy="screenY(cluster.y) - px(clusterRadius(cluster.ids.length, MARK_PX) * 0.8)"
                :r="px(6.5)"
                class="fill-destructive"
              />
              <text
                :x="screenX(cluster.x) + px(clusterRadius(cluster.ids.length, MARK_PX) * 0.8)"
                :y="screenY(cluster.y) - px(clusterRadius(cluster.ids.length, MARK_PX) * 0.8)"
                text-anchor="middle"
                dominant-baseline="central"
                class="fill-white font-mono font-semibold"
                :font-size="px(8.5)"
              >{{ cluster.down }}</text>
            </g>
          </g>
        </g>

        <!-- A pile spread out: the shared spot, a leader line to each member, each member its own mark. -->
        <g
          v-if="spread"
          class="fleet-map-spread"
          :data-open="spreadOpen || undefined"
          :transform="`translate(${screenX(spread.x)} ${screenY(spread.y)})`"
          data-testid="fleet-map-spread"
          :data-count="legs.length"
        >
          <line
            v-for="leg in legs"
            :key="`line-${leg.id}`"
            class="fleet-map-leader stroke-white/50"
            x1="0"
            y1="0"
            :x2="px(leg.slot.dx)"
            :y2="px(leg.slot.dy)"
            :stroke-width="px(1)"
          />
          <circle :r="px(3.5)" class="fill-white/85">
            <title>{{ $t('fleet.map.spread.spot', { n: legs.length, place: placeOf(spread.ids) || $t('fleet.map.cluster.somewhere') }) }}</title>
          </circle>
          <g
            v-for="leg in legs"
            :key="leg.id"
            role="button"
            :tabindex="tabKey === `n:${leg.id}` ? 0 : -1"
            :aria-label="nodeLabel(leg.id)"
            class="fleet-map-leg fleet-map-mark cursor-pointer"
            :style="{ '--dx': `${px(leg.slot.dx)}px`, '--dy': `${px(leg.slot.dy)}px` }"
            :data-marker="`n:${leg.id}`"
            :data-node="leg.id"
            :data-hot="isHot({ kind: 'node', id: leg.id }) || undefined"
            @click.stop="activateLeg(leg.id, $event.currentTarget as Element)"
            @keydown="onMarkerKeydown($event, `n:${leg.id}`, () => activateLeg(leg.id, $event.currentTarget as Element))"
            @pointerenter="onMarkEnter($event, { kind: 'node', id: leg.id })"
            @pointerleave="onMarkLeave"
            @focus="onMarkFocus($event, `n:${leg.id}`, { kind: 'node', id: leg.id })"
            @blur="onMarkBlur"
          >
            <circle :r="px(legHit)" fill="transparent" />
            <circle
              v-if="ringFor([leg.id], { kind: 'node', id: leg.id })"
              :r="px(MARK_PX + 4.5)"
              fill="none"
              :class="ringFor([leg.id], { kind: 'node', id: leg.id })!.cls"
              :stroke-width="px(ringFor([leg.id], { kind: 'node', id: leg.id })!.width)"
            />
            <g class="fleet-map-body">
              <circle :r="px(MARK_PX)" :class="legTone(leg.node)" :stroke-width="px(1.5)" />
            </g>
          </g>
        </g>

        <!-- The latency source, named, while the arcs are drawn. -->
        <g v-if="source && arcs.length" class="pointer-events-none" data-testid="fleet-map-source">
          <circle
            :cx="screenX(source.x)"
            :cy="screenY(source.y)"
            :r="px(clusterRadius(source.count, MARK_PX) + 5)"
            fill="none"
            class="stroke-white/80"
            :stroke-width="px(1)"
            :stroke-dasharray="`${px(2)} ${px(2)}`"
          />
          <text
            :x="screenX(source.x) + px(clusterRadius(source.count, MARK_PX) + 9)"
            :y="screenY(source.y) + px(clusterRadius(source.count, MARK_PX) + 12)"
            class="fill-white font-mono"
            :font-size="px(10.5)"
            :stroke-width="px(3)"
            stroke="oklch(0.18 0.025 265)"
            paint-order="stroke"
          >{{ facts?.latency?.sourceName }}</text>
        </g>
      </svg>

      <!-- Below the canvas on a phone, where buttons over a 171 px map covered
           the marks at its edges; over the map's top corners from 640 px up. -->
      <div
        v-if="!compact"
        class="flex items-center gap-1 border-t border-white/10 p-1.5 sm:pointer-events-none sm:absolute sm:inset-x-2 sm:top-2 sm:items-start sm:border-0 sm:p-0"
      >
        <div class="min-w-0 sm:pointer-events-auto"><slot name="controls" /></div>
        <div class="ms-auto flex shrink-0 gap-1 sm:pointer-events-auto sm:flex-col">
          <button
            type="button"
            class="grid size-8 place-items-center rounded-md border border-white/15 bg-black/50 text-white outline-none hover:bg-black/70 focus-visible:ring-2 focus-visible:ring-white disabled:opacity-40 pointer-coarse:size-11"
            :aria-label="$t('fleet.map.zoomIn')"
            data-testid="map-zoom-in"
            :title="$t('fleet.map.zoomIn')"
            :disabled="viewport.scale >= maxZoom - 1e-3"
            @click="zoomBy(1.6)"
          >
            <Plus class="size-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            class="grid size-8 place-items-center rounded-md border border-white/15 bg-black/50 text-white outline-none hover:bg-black/70 focus-visible:ring-2 focus-visible:ring-white disabled:opacity-40 pointer-coarse:size-11"
            :aria-label="$t('fleet.map.zoomOut')"
            data-testid="map-zoom-out"
            :title="$t('fleet.map.zoomOut')"
            :disabled="viewport.scale <= 1"
            @click="zoomBy(1 / 1.6)"
          >
            <Minus class="size-4" aria-hidden="true" />
          </button>
          <button
            type="button"
            class="grid size-8 place-items-center rounded-md border border-white/15 bg-black/50 text-white outline-none hover:bg-black/70 focus-visible:ring-2 focus-visible:ring-white pointer-coarse:size-11"
            :aria-label="$t('fleet.map.fitFleet')"
            data-testid="map-fit"
            :title="$t('fleet.map.fitFleet')"
            :disabled="points.length === 0"
            @click="fitFleet"
          >
            <Scan class="size-4" aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>

    <FleetMapCard
      v-if="card"
      class="absolute z-30"
      :style="card.style"
      :mode="card.mode"
      :nodes="card.nodes"
      :place="card.place"
      :facts="facts"
      :hint="card.hint"
    />
  </div>
</template>

<style scoped>
/* The keyboard's focus is drawn as a solid white ring around the mark (ringFor), round like the mark, on a canvas dark in both themes. */
.fleet-map-mark:focus-visible {
  outline: none;
}

.fleet-map-body {
  transform-box: fill-box;
  transform-origin: center;
  transition: transform 120ms ease-out;
}
.fleet-map-mark[data-hot] .fleet-map-body {
  transform: scale(1.18);
}

/* While a pile is spread, the rest of the map steps back: faded, and a tap on it folds the spread rather than acting on a mark half hidden under a leg. */
.fleet-map-dim {
  opacity: 0.4;
  pointer-events: none;
  transition: opacity 150ms ease-out;
}

.fleet-map-leg {
  transform: translate(var(--dx), var(--dy));
  transition: transform 200ms cubic-bezier(0.2, 0.9, 0.3, 1);
}
.fleet-map-leader {
  transform: scale(1);
  transition: transform 200ms cubic-bezier(0.2, 0.9, 0.3, 1);
}
.fleet-map-spread:not([data-open]) .fleet-map-leg {
  transform: translate(0px, 0px);
}
.fleet-map-spread:not([data-open]) .fleet-map-leader {
  transform: scale(0);
}

@media (prefers-reduced-motion: reduce) {
  .fleet-map-body,
  .fleet-map-dim,
  .fleet-map-leg,
  .fleet-map-leader {
    transition: none;
  }
}
</style>
