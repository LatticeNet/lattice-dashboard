<script setup lang="ts">
/**
 * Where the fleet runs, as status clusters with counts (design 23, 4.1 and
 * 4.2). Home draws it as its one picture (`compact`: no pan or zoom, the
 * whole map is one link the page wraps it in); the Map page draws it
 * interactive, and a click on a cluster emits its members so the page can
 * open the node's sheet or list the members of a cluster no zoom can split.
 *
 * A cluster is coloured by its worst member (fleetMapModel.clusterTone) and
 * carries a red count of members not reporting, so an offline node never
 * hides under the green of the twelve beside it. Marks keep their size on
 * screen as the map zooms; clusters are recomputed at every zoom, so they
 * split as the operator zooms in.
 *
 * The canvas stays dark in both themes, like the map before it: the land and
 * the marks are drawn for a dark surface.
 */
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useElementSize, useMediaQuery } from "@vueuse/core";
import { Minus, Plus, RotateCcw } from "lucide-vue-next";

import { WORLD_RINGS } from "@/lib/map/worldGeo";
import { nodeStatus, type NodeStatusInput } from "@/lib/nodeStatus";
import { cn } from "@/lib/utils";
import {
  MAP_HEIGHT,
  MAP_WIDTH,
  clusterPoints,
  clusterRadius,
  project,
  ringPath,
  zoomToSplit,
  type ClusterTone,
  type MapCluster,
} from "@/views/fleet/fleetMapModel";

export interface FleetMapNode extends NodeStatusInput {
  id: string;
  name?: string;
  geo?: { lat?: number; lon?: number; city?: string; region?: string; country?: string };
}

const props = withDefaults(
  defineProps<{
    nodes: readonly FleetMapNode[];
    /** Home's picture: no pan or zoom, no focusable marks. */
    compact?: boolean;
    /** Members of the cluster the page has open, drawn with a ring. */
    activeIds?: readonly string[];
  }>(),
  { compact: false, activeIds: () => [] },
);

const emit = defineEmits<{ select: [ids: string[], opener: Element] }>();

const { t } = useI18n();

/** Screen radius, in px, inside which marks merge. */
const CLUSTER_PX = 18;
const MARK_PX = 7;

const frame = ref<HTMLElement | null>(null);
const { width: frameWidth } = useElementSize(frame);
/** Map units per screen pixel at zoom 1. */
const unitsPerPx = computed(() => (frameWidth.value > 0 ? MAP_WIDTH / frameWidth.value : 1));

const viewport = ref({ scale: 1, x: 0, y: 0 });

const located = computed(() =>
  props.nodes.filter((node) => typeof node.geo?.lat === "number" && typeof node.geo?.lon === "number"),
);

const points = computed(() =>
  located.value.map((node) => {
    const at = project(node.geo!.lon!, node.geo!.lat!);
    return { id: node.id, x: at.x, y: at.y, status: nodeStatus(node) };
  }),
);

/**
 * Clusters in paint order: the biggest last, so it sits on top. A neighbour
 * painted later used to cover the centre of a 12-node cluster with its hit
 * circle, and a click on the "12" opened the neighbour instead.
 */
const clusters = computed<MapCluster[]>(() =>
  clusterPoints(points.value, (CLUSTER_PX * unitsPerPx.value) / viewport.value.scale).sort(
    (a, b) => a.ids.length - b.ids.length || a.key.localeCompare(b.key),
  ),
);

/** A 44 px target where a finger is the pointer; just past the mark where a mouse is. */
const coarse = useMediaQuery("(pointer: coarse)");
function hitRadius(cluster: MapCluster): number {
  return coarse.value ? 22 : clusterRadius(cluster.ids.length, MARK_PX) + 4;
}

const byId = computed(() => new Map(props.nodes.map((node) => [node.id, node])));
const landPaths = WORLD_RINGS.map((ring) => ringPath(ring)).filter(Boolean);

const TONE: Record<ClusterTone, { fill: string; stroke: string; text: string }> = {
  success: { fill: "fill-success/30", stroke: "stroke-success", text: "fill-success" },
  warning: { fill: "fill-warning/30", stroke: "stroke-warning", text: "fill-warning" },
  destructive: { fill: "fill-destructive/35", stroke: "stroke-destructive", text: "fill-destructive" },
  muted: { fill: "fill-muted-foreground/25", stroke: "stroke-muted-foreground", text: "fill-muted-foreground" },
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

function place(cluster: MapCluster): string {
  const first = byId.value.get(cluster.ids[0]!);
  return [first?.geo?.city, first?.geo?.country].filter(Boolean).join(", ");
}

function clusterLabel(cluster: MapCluster): string {
  const where = place(cluster);
  if (cluster.ids.length === 1) {
    const node = byId.value.get(cluster.ids[0]!);
    return t("fleet.map.cluster.one", { name: node?.name || cluster.ids[0], place: where || t("fleet.map.cluster.somewhere") });
  }
  const base = t("fleet.map.cluster.many", { n: cluster.ids.length, place: where || t("fleet.map.cluster.somewhere") });
  return cluster.down > 0 ? `${base}, ${t("fleet.map.cluster.down", { n: cluster.down })}` : base;
}

function isActive(cluster: MapCluster): boolean {
  return cluster.ids.some((id) => props.activeIds.includes(id));
}

/* ------------------------------ pan and zoom ------------------------------ */

const MAX_ZOOM = 5;
const panning = ref(false);
const pan = { pointerId: -1, clientX: 0, clientY: 0, x: 0, y: 0, moved: false };
let suppressClickUntil = 0;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function setViewport(next: { scale: number; x: number; y: number }): void {
  const scale = clamp(Math.round(next.scale * 100) / 100, 1, MAX_ZOOM);
  if (scale <= 1) {
    viewport.value = { scale: 1, x: 0, y: 0 };
    return;
  }
  const slack = 28;
  viewport.value = {
    scale,
    x: clamp(next.x, MAP_WIDTH * (1 - scale) - slack, slack),
    y: clamp(next.y, MAP_HEIGHT * (1 - scale) - slack, slack),
  };
}

function zoomTo(scale: number, anchor = { x: MAP_WIDTH / 2, y: MAP_HEIGHT / 2 }): void {
  const current = viewport.value;
  const worldX = (anchor.x - current.x) / current.scale;
  const worldY = (anchor.y - current.y) / current.scale;
  const next = clamp(scale, 1, MAX_ZOOM);
  setViewport({ scale: next, x: anchor.x - worldX * next, y: anchor.y - worldY * next });
}

/** Centre a map point and zoom to `scale`. */
function focusOn(x: number, y: number, scale: number): void {
  const next = clamp(scale, 1, MAX_ZOOM);
  setViewport({ scale: next, x: MAP_WIDTH / 2 - x * next, y: MAP_HEIGHT / 2 - y * next });
}

function svgPoint(event: WheelEvent | PointerEvent) {
  const rect = (event.currentTarget as SVGSVGElement).getBoundingClientRect();
  return { x: ((event.clientX - rect.left) / rect.width) * MAP_WIDTH, y: ((event.clientY - rect.top) / rect.height) * MAP_HEIGHT, rect };
}

function onWheel(event: WheelEvent): void {
  if (props.compact) return;
  const point = svgPoint(event);
  if (event.ctrlKey || event.metaKey) {
    event.preventDefault();
    zoomTo(viewport.value.scale * Math.exp(-event.deltaY * 0.006), point);
    return;
  }
  if (viewport.value.scale <= 1) return; // let the page scroll
  event.preventDefault();
  setViewport({
    ...viewport.value,
    x: viewport.value.x - (event.deltaX / point.rect.width) * MAP_WIDTH,
    y: viewport.value.y - (event.deltaY / point.rect.height) * MAP_HEIGHT,
  });
}

function onPointerDown(event: PointerEvent): void {
  if (props.compact || event.button !== 0 || viewport.value.scale <= 1) return;
  (event.currentTarget as SVGSVGElement).setPointerCapture?.(event.pointerId);
  panning.value = true;
  Object.assign(pan, { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, x: viewport.value.x, y: viewport.value.y, moved: false });
}

function onPointerMove(event: PointerEvent): void {
  if (!panning.value || pan.pointerId !== event.pointerId) return;
  const rect = (event.currentTarget as SVGSVGElement).getBoundingClientRect();
  const dx = ((event.clientX - pan.clientX) / rect.width) * MAP_WIDTH;
  const dy = ((event.clientY - pan.clientY) / rect.height) * MAP_HEIGHT;
  if (Math.abs(dx) + Math.abs(dy) > 2) pan.moved = true;
  setViewport({ scale: viewport.value.scale, x: pan.x + dx, y: pan.y + dy });
}

function onPointerUp(event: PointerEvent): void {
  if (pan.pointerId !== event.pointerId) return;
  (event.currentTarget as SVGSVGElement).releasePointerCapture?.(event.pointerId);
  if (pan.moved) suppressClickUntil = Date.now() + 180;
  panning.value = false;
  pan.pointerId = -1;
}

/**
 * One node: the page opens it. Several that a zoom would split: zoom in on
 * them. Several on one spot: the page lists them.
 */
function onCluster(cluster: MapCluster, event: Event): void {
  if (props.compact || Date.now() < suppressClickUntil) return;
  if (cluster.ids.length > 1) {
    const members = points.value.filter((point) => cluster.ids.includes(point.id));
    const zoom = zoomToSplit(members, (CLUSTER_PX * unitsPerPx.value) / viewport.value.scale, viewport.value.scale, MAX_ZOOM);
    if (zoom !== undefined) {
      focusOn(cluster.x, cluster.y, zoom);
      return;
    }
  }
  emit("select", cluster.ids, event.currentTarget as Element);
}

defineExpose({ reset: () => setViewport({ scale: 1, x: 0, y: 0 }) });
</script>

<template>
  <div ref="frame" class="relative overflow-hidden rounded-lg border border-border bg-[oklch(0.18_0.025_265)]">
    <svg
      :viewBox="`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`"
      :class="cn('block aspect-[2/1] w-full select-none', !compact && (viewport.scale > 1 ? 'touch-none' : 'touch-pan-y'), !compact && viewport.scale > 1 && (panning ? 'cursor-grabbing' : 'cursor-grab'))"
      role="img"
      :aria-label="$t('fleet.map.aria', { located: located.length, total: nodes.length })"
      data-testid="fleet-map"
      @wheel="onWheel"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
    >
      <g :transform="`translate(${viewport.x} ${viewport.y}) scale(${viewport.scale})`">
        <path
          v-for="(d, index) in landPaths"
          :key="index"
          :d="d"
          fill="oklch(0.32 0.03 215 / 0.72)"
          stroke="oklch(0.64 0.05 210 / 0.5)"
          stroke-width="0.5"
          stroke-linejoin="round"
          vector-effect="non-scaling-stroke"
        />
      </g>

      <g
        v-for="cluster in clusters"
        :key="cluster.key"
        :role="compact ? undefined : 'button'"
        :tabindex="compact ? undefined : 0"
        :aria-label="compact ? undefined : clusterLabel(cluster)"
        :class="cn('fleet-map-mark', !compact && 'cursor-pointer')"
        :data-cluster="cluster.key"
        :data-count="cluster.ids.length"
        @click.stop="onCluster(cluster, $event)"
        @keydown.enter.prevent="onCluster(cluster, $event)"
        @keydown.space.prevent="onCluster(cluster, $event)"
      >
        <title>{{ clusterLabel(cluster) }}</title>
        <!-- 44 px across on a phone, just past the mark with a mouse. -->
        <circle v-if="!compact" :cx="screenX(cluster.x)" :cy="screenY(cluster.y)" :r="px(hitRadius(cluster))" fill="transparent" />
        <circle
          v-if="isActive(cluster)"
          :cx="screenX(cluster.x)"
          :cy="screenY(cluster.y)"
          :r="px(clusterRadius(cluster.ids.length, MARK_PX) + 4)"
          fill="none"
          class="stroke-foreground"
          :stroke-width="px(1.5)"
        />
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
    </svg>

    <!-- Below the canvas on a phone, where three 44 px buttons over a 170 px
         map covered the marks at its right edge (Sydney, Tokyo); over the
         ocean in the corner from 640 px up. -->
    <div v-if="!compact" class="flex justify-end gap-1 border-t border-white/10 p-1.5 sm:absolute sm:right-2 sm:bottom-2 sm:flex-col sm:border-0 sm:p-0">
      <button
        type="button"
        class="grid size-8 place-items-center rounded-md border border-white/15 bg-black/50 text-white outline-none hover:bg-black/70 focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:size-11"
        :aria-label="$t('fleet.map.zoomIn')"
        :disabled="viewport.scale >= MAX_ZOOM"
        @click="zoomTo(viewport.scale * 1.6)"
      >
        <Plus class="size-4" aria-hidden="true" />
      </button>
      <button
        type="button"
        class="grid size-8 place-items-center rounded-md border border-white/15 bg-black/50 text-white outline-none hover:bg-black/70 focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:size-11"
        :aria-label="$t('fleet.map.zoomOut')"
        :disabled="viewport.scale <= 1"
        @click="zoomTo(viewport.scale / 1.6)"
      >
        <Minus class="size-4" aria-hidden="true" />
      </button>
      <button
        v-if="viewport.scale > 1"
        type="button"
        class="grid size-8 place-items-center rounded-md border border-white/15 bg-black/50 text-white outline-none hover:bg-black/70 focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:size-11"
        :aria-label="$t('fleet.map.resetView')"
        @click="setViewport({ scale: 1, x: 0, y: 0 })"
      >
        <RotateCcw class="size-4" aria-hidden="true" />
      </button>
    </div>
  </div>
</template>

<style scoped>
/* SVG cannot carry a box-shadow ring, so a focused mark gets an outline. */
.fleet-map-mark:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: 2px;
}
</style>
