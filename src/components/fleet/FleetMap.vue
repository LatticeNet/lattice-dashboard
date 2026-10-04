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
 *     spot, each member a mark of its own on a leader line, first gliding a
 *     spot near the frame's edge toward the middle so no line crosses a leg;
 *     a pile the frame cannot hold apart is emitted for the page to list;
 *     a zoom, a pan or a new width folds a spread back;
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
  cardBesideSpread,
  centreOn,
  clampViewport,
  clusterAction,
  clusterArcTone,
  clusterPlace,
  clusterPoints,
  clusterRadius,
  clusterTone,
  fitViewport,
  leadersClear,
  maxZoomFor,
  nearestInDirection,
  project,
  ringPath,
  spreadBox,
  spreadCapacity,
  spreadSlots,
  viewportBetween,
  zoomAround,
  type ArcTone,
  type ClusterAction,
  type ClusterReach,
  type ClusterTone,
  type MapCluster,
  type MapDirection,
  type PxBox,
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
    /** The box the page's list of a spread's members covers, in px from the map's top left; a leg's card stays clear of it. */
    listBox?: PxBox | null;
  }>(),
  { compact: false, activeIds: () => [], facts: undefined, arcs: false, highlightId: null, listBox: null },
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
const pointById = computed(() => new Map(points.value.map((point) => [point.id, point])));

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

/**
 * A map point at the current zoom, pan left out, in the frame's map units.
 * The marks, the spread and the arcs are drawn in this space inside one group
 * that the pan translates, so a drag changes that group's transform rather
 * than every mark's position, and nothing drawn from it is recomputed while
 * the map pans. At 500 nodes a pointermove re-patched every mark (4 to 8 ms).
 */
function zx(x: number): number {
  return x * zoomLevel.value;
}
function zy(y: number): number {
  return y * zoomLevel.value;
}
/** A size in screen px, in map units, so marks stay the same size as the map zooms. */
function px(value: number): number {
  return value * unitsPerPx.value;
}
/** A map point in px at the current zoom, pan left out: what the arrow keys and the nearest-mark search compare. */
function zoomPx(x: number, y: number): { x: number; y: number } {
  return { x: zx(x) / unitsPerPx.value, y: zy(y) / unitsPerPx.value };
}
/** Zoom-space px (zoomPx) to px from the map's top left, the pan added. */
function panPx(at: { x: number; y: number }): { x: number; y: number } {
  return { x: at.x + viewport.value.x / unitsPerPx.value, y: at.y + viewport.value.y / unitsPerPx.value };
}
/** A map point in px from the map's top left. */
function framePx(x: number, y: number): { x: number; y: number } {
  return panPx(zoomPx(x, y));
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
  /** The view and the width it was laid out for: a zoom, a pan or a new width folds it. */
  view: Viewport;
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
/** Leader lines keep this far from every other leg's mark: its radius, half its stroke and a hair. */
const LEADER_CLEARANCE = MARK_PX + 1;

/** Where a spread's legs go around a spot at `anchor` (px from the map's top left), or undefined when the frame cannot hold them. */
function slotsAt(count: number, anchor: { x: number; y: number }): SpreadSlot[] | undefined {
  return spreadSlots(count, anchor, { width: svgWidth.value, height: svgHeight.value }, coarse.value ? 46 : 26, legHit.value + 1, LEADER_CLEARANCE);
}

/** The view that brings a cluster's spot as near the frame's middle as the pan allows at this zoom. */
function centredOn(cluster: MapCluster): Viewport {
  return centreOn(cluster.x, cluster.y, zoomLevel.value, maxZoom.value);
}

/** Whether a pile could spread once its spot sits where centredOn puts it; independent of the pan, so labels need not follow it. */
function spreadFits(cluster: MapCluster): boolean {
  const view = centredOn(cluster);
  const anchor = { x: (view.x + cluster.x * view.scale) / unitsPerPx.value, y: (view.y + cluster.y * view.scale) / unitsPerPx.value };
  // Capacity only: clearance never turns a fit into a miss.
  const frame = { width: svgWidth.value, height: svgHeight.value };
  return spreadCapacity(anchor, frame, coarse.value ? 46 : 26, legHit.value + 1) >= cluster.ids.length;
}

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
  const slots = slotsAt(ids.length, framePx(cluster.x, cluster.y));
  if (!slots) return false;
  clearTimeout(foldTimer);
  const next: Spread = { key: cluster.key, ids, x: cluster.x, y: cluster.y, view: { ...viewport.value }, width: svgWidth.value, slots };
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

/**
 * Fold the spread back onto its spot; focus returns to the pile when asked.
 * The page's member list closes at once, so focus that was in it moves to
 * the map straight away, and to the pile once the legs are back on it,
 * never left on the page's body in between.
 */
function collapseSpread(returnFocus: boolean, animate = true): void {
  const open = spread.value;
  if (!open) return;
  spreadSeq += 1;
  spreadOpen.value = false;
  if (returnFocus && svg.value && !svg.value.contains(document.activeElement)) svg.value.focus({ preventScroll: true });
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

// A zoom or a new width moves every other mark, so a spread folds at once rather than float over a new layout. A pan
// folds it too: its slots were fitted to the frame where it opened, and the page's list beside it stays where it was.
watch(
  () => [viewport.value.scale, viewport.value.x, viewport.value.y, svgWidth.value] as const,
  ([scale, x, y, width]) => {
    const open = spread.value;
    if (!open) return;
    const moved = Math.abs(open.view.scale - scale) > 1e-3 || Math.abs(open.view.x - x) > 0.5 || Math.abs(open.view.y - y) > 0.5;
    if (moved || Math.abs(open.width - width) > 0.5) collapseSpread(false, false);
  },
);

// A member gone from the list leaves its leg empty; under two left, there is nothing to spread.
watch(byId, (nodes) => {
  const open = spread.value;
  if (open && open.ids.filter((id) => nodes.has(id)).length < 2) collapseSpread(false, false);
});

onBeforeUnmount(() => clearTimeout(foldTimer));

/** Clusters drawn as marks: all of them but the one spread out. */
const visibleClusters = computed(() => (spread.value ? clusters.value.filter((cluster) => cluster.key !== spread.value!.key) : clusters.value));

/** The spread's legs: member, slot, and where the leg's mark is in zoom-space px (zoomPx; panPx adds the pan). */
const legs = computed(() => {
  const open = spread.value;
  if (!open) return [];
  const anchor = zoomPx(open.x, open.y);
  return open.ids
    .map((id, index) => ({ id, slot: open.slots[index]!, node: byId.value.get(id) }))
    .filter((leg): leg is { id: string; slot: SpreadSlot; node: FleetMapNode } => !!leg.node)
    .map((leg) => ({ ...leg, at: { x: anchor.x + leg.slot.dx, y: anchor.y + leg.slot.dy } }));
});

/* ---------------------------- clicks and the keys ---------------------------- */

type Action = ClusterAction["action"];

/**
 * What a click on each drawn cluster does (fleetMapModel.clusterAction),
 * worked out once per zoom rather than on every render: the labels and the
 * card read it, and at 500 nodes working it out per render cost a frame.
 * It reads the zoom alone, never the pan, so a drag leaves it as it was.
 */
const actions = computed(() => {
  const scale = zoomLevel.value;
  const max = maxZoom.value;
  // Room for a whole target at the frame's edge.
  const margin = px(hitRadius(1) + 6);
  const byKey = new Map<string, ClusterAction>();
  for (const cluster of clusters.value) {
    const members = cluster.ids.length > 1 ? cluster.ids.map((id) => pointById.value.get(id)).filter((point) => point !== undefined) : [];
    byKey.set(cluster.key, cluster.ids.length > 1 ? clusterAction(members, clusteringAt, scale, max, margin, () => spreadFits(cluster)) : { action: "open" });
  }
  return byKey;
});

function actionFor(cluster: MapCluster): ClusterAction {
  return actions.value.get(cluster.key) ?? { action: cluster.ids.length === 1 ? "open" : "list" };
}

function activateCluster(cluster: MapCluster, opener: Element, fromKeyboard = false): void {
  if (props.compact || Date.now() < suppressClickUntil) return;
  const plan = actionFor(cluster);
  if (plan.action === "zoom") {
    const wasFocused = opener.contains(document.activeElement);
    hideCard();
    animateTo(plan.view, () => {
      // The pile split under the focus: move it to the mark nearest where the pile was.
      if (wasFocused) focusNearest(zoomPx(cluster.x, cluster.y));
    });
    return;
  }
  if (plan.action === "spread") {
    const here = slotsAt(cluster.ids.length, framePx(cluster.x, cluster.y));
    const centred = centredOn(cluster);
    const canGlide = Math.abs(centred.x - viewport.value.x) > 0.5 || Math.abs(centred.y - viewport.value.y) > 0.5;
    if (here && (leadersClear(here, LEADER_CLEARANCE) || !canGlide) && openSpread(cluster, fromKeyboard)) return;
    if (canGlide) {
      // Near the frame's edge the legs crowd to one side, so a leader line crosses a leg or they do not fit at all:
      // glide the spot toward the middle, then spread it there.
      hideCard();
      animateTo(centred, () => {
        if (!openSpread(cluster, fromKeyboard)) emit("select", membersInOrder(cluster.ids), opener);
      });
      return;
    }
  }
  hideCard();
  emit("select", plan.action === "open" ? cluster.ids : membersInOrder(cluster.ids), opener);
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

/**
 * Every mark the keys can reach, in zoom-space px (zoomPx: the pan moves
 * them all alike, so directions and distances hold without it); a spread's
 * legs alone while one is open.
 */
const markers = computed(() => {
  if (legs.value.length) return legs.value.map((leg) => ({ key: `n:${leg.id}`, ...leg.at }));
  return visibleClusters.value.map((cluster) => ({ key: `c:${cluster.key}`, ...zoomPx(cluster.x, cluster.y) }));
});

/** The one mark in the tab order: the last one focused while it is still drawn, else the westmost. */
const focusKey = ref<string | null>(null);
const tabKey = computed(() => {
  const list = markers.value;
  if (focusKey.value && list.some((marker) => marker.key === focusKey.value)) return focusKey.value;
  return [...list].sort((a, b) => a.x - b.x || a.y - b.y)[0]?.key;
});

/**
 * Move focus to a mark. A mark that already holds focus fires no focus
 * event: after Enter zoomed a pile whose key survived the zoom, Vue kept the
 * same element and the ring never came back. Its focus state is noted here
 * as the focus event would have.
 */
function focusMarker(key: string): void {
  focusKey.value = key;
  void nextTick(() => {
    const element = svg.value?.querySelector<SVGElement>(`[data-marker="${CSS.escape(key)}"]`);
    if (!element) return;
    element.focus({ preventScroll: true });
    if (element === document.activeElement) noteFocus(element, key);
  });
}

/** Focus the mark nearest a point in zoom-space px. */
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
  // Markers are in zoom-space px; the zoom anchor is in the frame's map units, the pan included.
  const anchor = marker ? { x: marker.x * unitsPerPx.value + viewport.value.x, y: marker.y * unitsPerPx.value + viewport.value.y } : undefined;
  if (event.key === "+" || event.key === "=") zoomBy(1.6, anchor);
  else if (event.key === "-" || event.key === "_") zoomBy(1 / 1.6, anchor);
  else if (event.key === "0") fitFleet();
  else return;
  event.preventDefault();
}

/* ---------------------------------- card ---------------------------------- */

type Hot = { kind: "cluster"; key: string } | { kind: "node"; id: string } | { kind: "arc"; key: string };

const hovered = ref<Hot | null>(null);
/** The mark whose card the keyboard's focus shows; put away with the card (a wheel zoom, a pan) while focus stays. */
const focused = ref<Hot | null>(null);
/**
 * The mark holding the keyboard's focus, for its ring: set on focus, cleared
 * on blur only. Kept apart from the card, which a zoom puts away while the
 * focus stays, so the ring never vanishes from a mark that still has focus.
 */
const keyFocus = ref<Hot | null>(null);
let hideTimer: ReturnType<typeof setTimeout> | undefined;

function hotOf(markerKey: string): Hot {
  return markerKey.startsWith("n:") ? { kind: "node", id: markerKey.slice(2) } : { kind: "cluster", key: markerKey.slice(2) };
}

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

/** The keyboard's focus shows a ring and the same card the pointer does; a click's focus shows neither. */
function noteFocus(element: Element, key: string): void {
  focusKey.value = key;
  if (!element.matches(":focus-visible")) return;
  keyFocus.value = hotOf(key);
  focused.value = hotOf(key);
}

function onMarkFocus(event: FocusEvent, key: string): void {
  noteFocus(event.target as Element, key);
}

function onMarkBlur(): void {
  keyFocus.value = null;
  focused.value = null;
}

// A focused mark that is no longer drawn (folded into a spread, merged by a zoom) loses its ring and card with it.
watch(markers, (list) => {
  const held = keyFocus.value;
  if (!held) return;
  const key = held.kind === "node" ? `n:${held.id}` : `c:${held.key}`;
  if (!list.some((marker) => marker.key === key)) {
    keyFocus.value = null;
    focused.value = null;
  }
});

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
  if (sameHot(keyFocus.value, hot)) return { cls: "stroke-white", width: 2.5 };
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

/** The card's width (FleetMapCard is w-64) and a generous height for a node's card, for placing it before it is laid out. */
const CARD_W = 256;
const CARD_H = 230;

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
    at = panPx(leg.at);
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
  const style: Record<string, string> = {};
  if (hot.kind === "node" && spread.value) {
    // A leg's card goes beside the whole spread, clear of its legs and of the page's list (fleetMapModel.cardBesideSpread).
    const box = spreadBox(framePx(spread.value.x, spread.value.y), spread.value.slots, legHit.value);
    // The page measures from the frame's outer edge; the svg sits inside its 1 px border.
    const list = props.listBox ? { left: props.listBox.left - 1, top: props.listBox.top - 1, right: props.listBox.right - 1, bottom: props.listBox.bottom - 1 } : null;
    const place = cardBesideSpread(box, at, list, { width: svgWidth.value, height: svgHeight.value }, { width: CARD_W, height: CARD_H });
    style.left = `${place.left + 1}px`;
    if (place.top !== undefined) style.top = `${place.top + 1}px`;
    else style.bottom = `${place.bottom}px`;
    return { mode, nodes, place: placeOf(ids), hint, style };
  }
  // Beside the mark, on whichever side has room; above it in the lower half of the map.
  const left = at.x + reach + 10 + CARD_W <= svgWidth.value ? at.x + reach + 10 : at.x - reach - 10 - CARD_W;
  style.left = `${Math.max(4, left) + 1}px`;
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

/**
 * One arc per place the source probes, drawn as its worst member, in zoom
 * space (zx). None until the layer is ready: while the rollups are still
 * being read every pair would draw as "nothing heard".
 */
const arcs = computed(() => {
  const latency = props.facts?.latency;
  const from = source.value;
  if (!latency || !from || props.facts?.latencyState !== "ready") return [];
  const targets: { key: string; x: number; y: number; ids: readonly string[] }[] = visibleClusters.value.map((cluster) => cluster);
  if (spread.value) targets.push({ key: spread.value.key, x: spread.value.x, y: spread.value.y, ids: spread.value.ids });
  const start = { x: zx(from.x), y: zy(from.y) };
  const out: { key: string; tone: ArcTone; paths: string[] }[] = [];
  for (const target of targets) {
    if (target.key === from.key) continue;
    const tone = clusterArcTone(target.ids.map((id) => latency.readings.get(id)), latency.lossAttention);
    if (!tone) continue;
    out.push({ key: target.key, tone, paths: arcPaths(start, { x: zx(target.x), y: zy(target.y) }, MAP_WIDTH * zoomLevel.value) });
  }
  return out;
});

/**
 * The source's name beside its mark: below and to the right, or to the left
 * where it would run past the frame's right edge (cd-hs-sh at Shanghai was
 * cut off on a phone), and above where it would run past the foot.
 */
const sourceLabel = computed(() => {
  const from = source.value;
  if (!from) return undefined;
  const radius = clusterRadius(from.count, MARK_PX);
  // A monospace advance is about 0.6 em; 10.5 px type.
  const width = (props.facts?.latency?.sourceName ?? "").length * 10.5 * 0.62;
  const at = framePx(from.x, from.y);
  const left = at.x + radius + 9 + width > svgWidth.value - 4;
  const up = at.y + radius + 16 > svgHeight.value - 4;
  return {
    x: zx(from.x) + px(left ? -(radius + 9) : radius + 9),
    y: zy(from.y) + px(up ? -(radius + 6) : radius + 12),
    anchor: left ? "end" : "start",
  };
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

/** Every drawn cluster's label, worked out when the clusters, the names or the actions change, never per pan frame. */
const labels = computed(() => new Map(visibleClusters.value.map((cluster) => [cluster.key, clusterLabel(cluster)])));

function legTone(node: FleetMapNode): string {
  return LEG_TONE[clusterTone([nodeStatus(node)])];
}

defineExpose({
  reset: () => setViewport({ scale: 1, x: 0, y: 0 }),
  /** Fold an open spread; with `returnFocus`, focus goes back to its pile (the page's list closing it from the keyboard). */
  collapse: (returnFocus = false) => collapseSpread(returnFocus),
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

        <!--
          Everything drawn per mark sits in one group the pan translates, at
          positions that change only with the zoom (zx, zy): a drag rewrites
          this one transform, not every mark.
        -->
        <g :transform="`translate(${viewport.x} ${viewport.y})`">
          <!-- Probe arcs, under the marks so a mark always takes the pointer first. -->
          <g v-if="arcs.length" data-testid="fleet-map-arcs">
            <g
              v-for="arc in arcs"
              :key="arc.key"
              :class="spread && arc.key !== spread.key ? 'fleet-map-dim' : undefined"
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
            :aria-label="compact ? undefined : labels.get(cluster.key)"
            :class="['fleet-map-mark', !compact && 'cursor-pointer', spread && 'fleet-map-dim']"
            :data-cluster="cluster.key"
            :data-count="cluster.ids.length"
            :data-marker="compact ? undefined : `c:${cluster.key}`"
            :data-hot="isHot({ kind: 'cluster', key: cluster.key }) || undefined"
            @click="onClusterClick(cluster, $event)"
            @keydown="onMarkerKeydown($event, `c:${cluster.key}`, () => activateCluster(cluster, $event.currentTarget as Element, true))"
            @pointerenter="onMarkEnter($event, { kind: 'cluster', key: cluster.key })"
            @pointerleave="onMarkLeave"
            @focus="onMarkFocus($event, `c:${cluster.key}`)"
            @blur="onMarkBlur"
          >
            <title v-if="compact">{{ labels.get(cluster.key) }}</title>
            <!-- 44 px across on a phone, just past the mark with a mouse. -->
            <circle v-if="!compact" :cx="zx(cluster.x)" :cy="zy(cluster.y)" :r="px(hitRadius(cluster.ids.length))" fill="transparent" />
            <circle
              v-if="ringFor(cluster.ids, { kind: 'cluster', key: cluster.key })"
              :cx="zx(cluster.x)"
              :cy="zy(cluster.y)"
              :r="px(clusterRadius(cluster.ids.length, MARK_PX) + 4.5)"
              fill="none"
              :class="ringFor(cluster.ids, { kind: 'cluster', key: cluster.key })!.cls"
              :stroke-width="px(ringFor(cluster.ids, { kind: 'cluster', key: cluster.key })!.width)"
            />
            <g class="fleet-map-body">
              <circle
                :cx="zx(cluster.x)"
                :cy="zy(cluster.y)"
                :r="px(clusterRadius(cluster.ids.length, MARK_PX))"
                :class="[TONE[cluster.tone].fill, TONE[cluster.tone].stroke]"
                :stroke-width="px(1.5)"
              />
              <text
                v-if="cluster.ids.length > 1"
                :x="zx(cluster.x)"
                :y="zy(cluster.y)"
                text-anchor="middle"
                dominant-baseline="central"
                class="fill-white font-mono font-semibold"
                :font-size="px(10)"
              >{{ cluster.ids.length }}</text>
              <g v-if="cluster.down > 0 && cluster.ids.length > 1">
                <circle
                  :cx="zx(cluster.x) + px(clusterRadius(cluster.ids.length, MARK_PX) * 0.8)"
                  :cy="zy(cluster.y) - px(clusterRadius(cluster.ids.length, MARK_PX) * 0.8)"
                  :r="px(6.5)"
                  class="fill-destructive"
                />
                <text
                  :x="zx(cluster.x) + px(clusterRadius(cluster.ids.length, MARK_PX) * 0.8)"
                  :y="zy(cluster.y) - px(clusterRadius(cluster.ids.length, MARK_PX) * 0.8)"
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
            :transform="`translate(${zx(spread.x)} ${zy(spread.y)})`"
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
              @focus="onMarkFocus($event, `n:${leg.id}`)"
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
          <g v-if="source && sourceLabel && arcs.length" class="pointer-events-none" data-testid="fleet-map-source">
            <circle
              :cx="zx(source.x)"
              :cy="zy(source.y)"
              :r="px(clusterRadius(source.count, MARK_PX) + 5)"
              fill="none"
              class="stroke-white/80"
              :stroke-width="px(1)"
              :stroke-dasharray="`${px(2)} ${px(2)}`"
            />
            <text
              :x="sourceLabel.x"
              :y="sourceLabel.y"
              :text-anchor="sourceLabel.anchor"
              class="fill-white font-mono"
              :font-size="px(10.5)"
              :stroke-width="px(3)"
              stroke="oklch(0.18 0.025 265)"
              paint-order="stroke"
            >{{ facts?.latency?.sourceName }}</text>
          </g>
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
