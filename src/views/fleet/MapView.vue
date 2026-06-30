<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import {
  Crosshair,
  Globe2,
  LocateFixed,
  MapPinned,
  RefreshCw,
  Radar,
  Route,
  Trash2,
  WifiOff,
} from "lucide-vue-next";
import { api, unwrap, type NodeGeoResolveResult, type NodeGeoView } from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { useAuthStore } from "@/stores/auth";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { WORLD_RINGS } from "@/lib/map/worldGeo";

import PageHeader from "@/components/common/PageHeader.vue";
import DataState from "@/components/common/DataState.vue";
import StatusDot from "@/components/common/StatusDot.vue";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";

const MAP_WIDTH = 1000;
const MAP_HEIGHT = 500;

const auth = useAuthStore();
const { t } = useI18n();
const geoQuery = useAsyncData(() => api.nodes.geo().then((r) => unwrap(r, "nodes")), {
  pollInterval: 10000,
});

const selectedNodeId = ref("");
const country = ref("");
const region = ref("");
const city = ref("");
const lat = ref("");
const lon = ref("");
const provider = ref("");
const asn = ref("");
const asOrg = ref("");
const pendingSave = ref(false);
const resolvingNodeId = ref("");
const resolvingAll = ref(false);
const hoveredNodeId = ref("");
const mapViewport = ref({ scale: 1, x: 0, y: 0 });
const isPanning = ref(false);
const panStart = ref({ pointerId: -1, clientX: 0, clientY: 0, x: 0, y: 0, moved: false });
const suppressMarkerClickUntil = ref(0);
const locationEditorOpen = ref(false);

const nodes = computed(() => geoQuery.data.value ?? []);
const withGeo = computed(() =>
  nodes.value.filter(hasCoordinates),
);
const withoutGeo = computed(() => nodes.value.filter((n) => !hasCoordinates(n)));
const withLookupIP = computed(() => nodes.value.filter((n) => lookupIP(n) && !hasCoordinates(n)));
const onlineCount = computed(() => nodes.value.filter((n) => n.online).length);
const offlineCount = computed(() => Math.max(0, nodes.value.length - onlineCount.value));
const countryCount = computed(() => new Set(withGeo.value.map((n) => n.geo?.country).filter(Boolean)).size);
const autoCount = computed(() => withGeo.value.filter((n) => n.geo?.source === "auto").length);
const manualCount = computed(() => withGeo.value.filter((n) => n.geo?.source === "operator" || !n.geo?.source).length);
const coveragePercent = computed(() => (nodes.value.length ? Math.round((withGeo.value.length / nodes.value.length) * 100) : 0));
const canAdminNodes = computed(() => auth.can("node:admin"));

const plotted = computed(() => {
  const keyCounts = new Map<string, number>();
  return withGeo.value.map((node) => {
    const latitude = node.geo?.lat ?? 0;
    const longitude = node.geo?.lon ?? 0;
    const key = `${latitude.toFixed(1)}:${longitude.toFixed(1)}`;
    const index = keyCounts.get(key) ?? 0;
    keyCounts.set(key, index + 1);
    const projected = project(longitude, latitude);
    const angle = index * 2.3999632297;
    const radius = index === 0 ? 0 : Math.min(18, 5 + index * 2);
    return {
      node,
      x: projected.x + Math.cos(angle) * radius,
      y: projected.y + Math.sin(angle) * radius,
      selected: selectedNodeId.value === node.id,
      label: locationLabel(node),
    };
  });
});

const mapZoom = computed(() => mapViewport.value.scale);
const mapZoomTransform = computed(() => {
  const v = mapViewport.value;
  return `translate(${v.x} ${v.y}) scale(${v.scale})`;
});
const mapCursorClass = computed(() => (isPanning.value ? "cursor-grabbing" : "cursor-grab"));

const hoveredPoint = computed(() =>
  plotted.value.find((point) => point.node.id === hoveredNodeId.value),
);

const selectedNode = computed<NodeGeoView | undefined>(() =>
  nodes.value.find((node) => node.id === selectedNodeId.value),
);
const selectedLookupIP = computed(() => (selectedNode.value ? lookupIP(selectedNode.value) : ""));
const selectedCoordinates = computed(() => {
  const node = selectedNode.value;
  if (!node || !hasCoordinates(node)) return "";
  return `${node.geo?.lat?.toFixed(4)}, ${node.geo?.lon?.toFixed(4)}`;
});

const regions = computed(() => {
  const groups = new Map<string, { key: string; label: string; nodes: NodeGeoView[]; online: number }>();
  for (const node of withGeo.value) {
    const key = `${node.geo?.country || "??"}:${node.geo?.region || ""}`;
    const label = [node.geo?.country, node.geo?.region].filter(Boolean).join(" · ") || t("fleet.map.unknownRegion");
    const group = groups.get(key) ?? { key, label, nodes: [], online: 0 };
    group.nodes.push(node);
    if (node.online) group.online += 1;
    groups.set(key, group);
  }
  return Array.from(groups.values()).sort((a, b) => b.nodes.length - a.nodes.length || a.label.localeCompare(b.label));
});

const landPaths = computed(() => WORLD_RINGS.map(ringToPath).filter(Boolean));

function hasCoordinates(node: NodeGeoView) {
  return typeof node.geo?.lat === "number" && typeof node.geo?.lon === "number";
}

function project(lonValue: number, latValue: number) {
  const lonClamped = Math.max(-180, Math.min(180, lonValue));
  const latClamped = Math.max(-90, Math.min(90, latValue));
  const x = ((lonClamped + 180) / 360) * MAP_WIDTH;
  const y = ((90 - latClamped) / 180) * MAP_HEIGHT;
  return { x, y };
}

// Rings are flat [lon,lat,lon,lat,...] pairs (compact bundled world geometry).
function ringToPath(ring: readonly number[]) {
  let d = "";
  for (let i = 0; i + 1 < ring.length; i += 2) {
    const lon = ring[i];
    const lat = ring[i + 1];
    if (lon === undefined || lat === undefined) break;
    const point = project(lon, lat);
    d += `${i === 0 ? "M" : "L"}${point.x.toFixed(1)} ${point.y.toFixed(1)} `;
  }
  return d ? `${d}Z` : "";
}

function lookupIP(node: NodeGeoView) {
  return node.public_ip || node.public_ipv6 || "";
}

function locationLabel(node: NodeGeoView) {
  return [node.geo?.city, node.geo?.region, node.geo?.country].filter(Boolean).join(", ") || t("fleet.map.noCoordinates");
}

function sourceLabel(source?: string) {
  if (source === "auto") return t("fleet.map.source.auto");
  if (source === "operator" || !source) return t("fleet.map.source.operator");
  return source;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function clampViewport(next: { scale: number; x: number; y: number }) {
  const scale = clamp(Math.round(next.scale * 100) / 100, 1, 5);
  if (scale <= 1) return { scale: 1, x: 0, y: 0 };
  const slack = 28;
  return {
    scale,
    x: clamp(next.x, MAP_WIDTH * (1 - scale) - slack, slack),
    y: clamp(next.y, MAP_HEIGHT * (1 - scale) - slack, slack),
  };
}

function applyViewport(next: { scale: number; x: number; y: number }) {
  mapViewport.value = clampViewport(next);
}

function svgPoint(event: WheelEvent | PointerEvent) {
  const target = event.currentTarget as SVGSVGElement;
  const rect = target.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) / rect.width) * MAP_WIDTH,
    y: ((event.clientY - rect.top) / rect.height) * MAP_HEIGHT,
    rect,
  };
}

function setZoom(next: number, anchor = { x: MAP_WIDTH / 2, y: MAP_HEIGHT / 2 }) {
  const current = mapViewport.value;
  const scale = clamp(Math.round(next * 100) / 100, 1, 5);
  const worldX = (anchor.x - current.x) / current.scale;
  const worldY = (anchor.y - current.y) / current.scale;
  applyViewport({
    scale,
    x: anchor.x - worldX * scale,
    y: anchor.y - worldY * scale,
  });
}

function resetViewport() {
  applyViewport({ scale: 1, x: 0, y: 0 });
}

function onMapWheel(event: WheelEvent) {
  const point = svgPoint(event);
  if (event.ctrlKey || event.metaKey) {
    const factor = Math.exp(-event.deltaY * 0.006);
    setZoom(mapViewport.value.scale * factor, point);
    return;
  }
  const dx = (event.deltaX / point.rect.width) * MAP_WIDTH;
  const dy = (event.deltaY / point.rect.height) * MAP_HEIGHT;
  applyViewport({
    ...mapViewport.value,
    x: mapViewport.value.x - dx,
    y: mapViewport.value.y - dy,
  });
}

function onMapPointerDown(event: PointerEvent) {
  if (event.button !== 0) return;
  const target = event.currentTarget as SVGSVGElement;
  target.setPointerCapture?.(event.pointerId);
  isPanning.value = true;
  panStart.value = {
    pointerId: event.pointerId,
    clientX: event.clientX,
    clientY: event.clientY,
    x: mapViewport.value.x,
    y: mapViewport.value.y,
    moved: false,
  };
}

function onMapPointerMove(event: PointerEvent) {
  if (!isPanning.value || panStart.value.pointerId !== event.pointerId) return;
  const target = event.currentTarget as SVGSVGElement;
  const rect = target.getBoundingClientRect();
  const dx = ((event.clientX - panStart.value.clientX) / rect.width) * MAP_WIDTH;
  const dy = ((event.clientY - panStart.value.clientY) / rect.height) * MAP_HEIGHT;
  if (Math.abs(dx) + Math.abs(dy) > 2) panStart.value.moved = true;
  applyViewport({
    scale: mapViewport.value.scale,
    x: panStart.value.x + dx,
    y: panStart.value.y + dy,
  });
}

function onMapPointerUp(event: PointerEvent) {
  if (panStart.value.pointerId !== event.pointerId) return;
  const target = event.currentTarget as SVGSVGElement;
  target.releasePointerCapture?.(event.pointerId);
  if (panStart.value.moved) suppressMarkerClickUntil.value = Date.now() + 180;
  isPanning.value = false;
  panStart.value.pointerId = -1;
}

function markerScreenX(x: number) {
  const v = mapViewport.value;
  return v.x + x * v.scale;
}

function markerScreenY(y: number) {
  const v = mapViewport.value;
  return v.y + y * v.scale;
}

function selectMarkerNode(node: NodeGeoView) {
  if (Date.now() < suppressMarkerClickUntil.value) return;
  selectNode(node);
}

function selectNode(node: NodeGeoView) {
  selectedNodeId.value = node.id;
  country.value = node.geo?.country ?? "";
  region.value = node.geo?.region ?? "";
  city.value = node.geo?.city ?? "";
  lat.value = node.geo?.lat?.toString() ?? "";
  lon.value = node.geo?.lon?.toString() ?? "";
  provider.value = node.geo?.provider ?? "";
  asn.value = node.geo?.asn?.toString() ?? "";
  asOrg.value = node.geo?.as_org ?? "";
}

function selectFirstNode(groupNodes: NodeGeoView[]) {
  const node = groupNodes[0];
  if (node) selectNode(node);
}

function parseNumber(value: string): number | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
}

async function saveGeo() {
  if (!selectedNodeId.value) return;
  const parsedLat = parseNumber(lat.value);
  const parsedLon = parseNumber(lon.value);
  if (parsedLat === undefined || parsedLon === undefined) {
    toast.error(t("fleet.map.toast.coordinatesRequired"));
    return;
  }
  pendingSave.value = true;
  try {
    await api.nodes.updateGeo(selectedNodeId.value, {
      country: country.value.trim() || undefined,
      region: region.value.trim() || undefined,
      city: city.value.trim() || undefined,
      lat: parsedLat,
      lon: parsedLon,
      provider: provider.value.trim() || undefined,
      asn: parseNumber(asn.value),
      as_org: asOrg.value.trim() || undefined,
    });
    toast.success(t("fleet.map.toast.locationSaved"));
    await geoQuery.refresh();
    const refreshed = nodes.value.find((node) => node.id === selectedNodeId.value);
    if (refreshed) selectNode(refreshed);
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("fleet.map.toast.saveFailed"));
  } finally {
    pendingSave.value = false;
  }
}

async function clearGeo() {
  if (!selectedNodeId.value) return;
  pendingSave.value = true;
  try {
    await api.nodes.clearGeo(selectedNodeId.value);
    toast.success(t("fleet.map.toast.locationCleared"));
    country.value = "";
    region.value = "";
    city.value = "";
    lat.value = "";
    lon.value = "";
    provider.value = "";
    asn.value = "";
    asOrg.value = "";
    await geoQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("fleet.map.toast.clearFailed"));
  } finally {
    pendingSave.value = false;
  }
}

async function resolveSelected() {
  if (!selectedNodeId.value) return;
  resolvingNodeId.value = selectedNodeId.value;
  try {
    const response = await api.nodes.resolveGeo({ node_id: selectedNodeId.value, overwrite: true });
    await handleResolveResults(response.results);
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("fleet.map.toast.resolveFailed"));
  } finally {
    resolvingNodeId.value = "";
  }
}

async function resolveMissing() {
  resolvingAll.value = true;
  try {
    const response = await api.nodes.resolveGeo({ all: true, missing_only: true });
    await handleResolveResults(response.results);
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("fleet.map.toast.resolveFailed"));
  } finally {
    resolvingAll.value = false;
  }
}

async function handleResolveResults(results: NodeGeoResolveResult[]) {
  const updated = results.filter((result) => result.status === "updated").length;
  const disabled = results.some((result) => result.status === "resolver_disabled");
  const failed = results.filter((result) => result.status === "lookup_failed" || result.status === "store_failed").length;
  const noPublicIp = results.filter((result) => result.status === "no_public_ip").length;
  if (disabled) {
    toast.error(t("fleet.map.toast.resolverDisabled"));
    return;
  }
  if (updated > 0) {
    toast.success(t("fleet.map.toast.resolved", { count: updated }));
    await geoQuery.refresh();
    const refreshed = nodes.value.find((node) => node.id === selectedNodeId.value);
    if (refreshed) selectNode(refreshed);
    return;
  }
  if (failed > 0) {
    toast.error(t("fleet.map.toast.resolvePartial", { count: failed }));
    return;
  }
  if (noPublicIp > 0) {
    toast.error(t("fleet.map.toast.resolveNoPublicIp", { count: noPublicIp }));
    return;
  }
  toast.info(t("fleet.map.toast.resolveNoop"));
}
</script>

<template>
  <div class="space-y-6 p-6">
    <PageHeader :title="$t('fleet.map.title')" :description="$t('fleet.map.description')">
      <template #actions>
        <Button
          v-if="canAdminNodes"
          variant="outline"
          size="sm"
          :disabled="resolvingAll || withLookupIP.length === 0"
          @click="resolveMissing"
        >
          <Radar :class="cn('size-4', resolvingAll && 'animate-spin')" aria-hidden="true" />
          {{ $t('fleet.map.actions.resolveMissing') }}
        </Button>
        <Button variant="outline" size="sm" :disabled="geoQuery.refreshing.value" @click="geoQuery.refresh">
          <RefreshCw :class="cn('size-4', geoQuery.refreshing.value && 'animate-spin')" aria-hidden="true" />
          {{ $t('common.actions.refresh') }}
        </Button>
      </template>
    </PageHeader>

    <div class="grid gap-2 md:grid-cols-4">
      <div class="rounded-lg border border-border bg-card p-3">
        <p class="text-xs font-medium uppercase text-muted-foreground">{{ $t('fleet.map.stats.coverage') }}</p>
        <div class="mt-1.5 flex items-end justify-between gap-3">
          <p class="text-xl font-semibold">{{ coveragePercent }}%</p>
          <p class="text-xs text-muted-foreground">{{ withGeo.length }}/{{ nodes.length }}</p>
        </div>
        <div class="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
          <div class="h-full rounded-full bg-primary" :style="{ width: `${coveragePercent}%` }" />
        </div>
      </div>
      <div class="rounded-lg border border-border bg-card p-3">
        <p class="text-xs font-medium uppercase text-muted-foreground">{{ $t('fleet.map.stats.online') }}</p>
        <div class="mt-1.5 flex items-baseline gap-2">
          <p class="text-xl font-semibold">{{ onlineCount }}</p>
          <p class="text-xs text-muted-foreground">{{ $t('fleet.map.stats.offline', { count: offlineCount }) }}</p>
        </div>
      </div>
      <div class="rounded-lg border border-border bg-card p-3">
        <p class="text-xs font-medium uppercase text-muted-foreground">{{ $t('fleet.map.stats.regions') }}</p>
        <div class="mt-1.5 flex items-baseline gap-2">
          <p class="text-xl font-semibold">{{ countryCount }}</p>
          <p class="text-xs text-muted-foreground">{{ $t('fleet.map.stats.countries') }}</p>
        </div>
      </div>
      <div class="rounded-lg border border-border bg-card p-3">
        <p class="text-xs font-medium uppercase text-muted-foreground">{{ $t('fleet.map.stats.sources') }}</p>
        <div class="mt-1.5 flex items-baseline gap-2">
          <p class="text-xl font-semibold">{{ autoCount }}</p>
          <p class="text-xs text-muted-foreground">{{ $t('fleet.map.stats.manual', { count: manualCount }) }}</p>
        </div>
      </div>
    </div>

    <div class="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
      <Card class="self-start overflow-hidden">
        <CardHeader>
          <CardTitle class="flex items-center gap-2">
            <Globe2 class="size-4 text-muted-foreground" aria-hidden="true" />
            {{ $t('fleet.map.byLocation') }}
          </CardTitle>
          <CardDescription>{{ $t('fleet.map.coordinatesSummary', { withGeo: withGeo.length, total: nodes.length }) }}</CardDescription>
        </CardHeader>
        <CardContent>
          <DataState
            :loading="geoQuery.loading.value"
            :error="geoQuery.error.value"
            :is-empty="nodes.length === 0"
            :empty-title="$t('fleet.map.emptyTitle')"
            :empty-description="$t('fleet.map.emptyDescription')"
            @retry="geoQuery.refresh"
          >
            <div class="relative overflow-hidden rounded-lg border border-border bg-[oklch(0.18_0.025_265)] text-slate-100">
              <svg
                :viewBox="`0 0 ${MAP_WIDTH} ${MAP_HEIGHT}`"
                :class="cn('aspect-[2/1] w-full select-none touch-none', mapCursorClass)"
                role="img"
                :aria-label="$t('fleet.map.mapAria')"
                @wheel.prevent="onMapWheel"
                @pointerdown="onMapPointerDown"
                @pointermove="onMapPointerMove"
                @pointerup="onMapPointerUp"
                @pointercancel="onMapPointerUp"
              >
                <defs>
                  <linearGradient id="fleet-ocean" x1="0" x2="1" y1="0" y2="1">
                    <stop offset="0%" stop-color="oklch(0.24 0.04 255)" />
                    <stop offset="54%" stop-color="oklch(0.18 0.035 265)" />
                    <stop offset="100%" stop-color="oklch(0.14 0.025 250)" />
                  </linearGradient>
                  <pattern id="fleet-grid" width="62.5" height="52" patternUnits="userSpaceOnUse">
                    <path d="M 62.5 0 L 0 0 0 52" fill="none" stroke="oklch(0.78 0.03 250 / 0.12)" stroke-width="1" />
                  </pattern>
                  <filter id="fleet-marker-shadow" x="-80%" y="-80%" width="260%" height="260%">
                    <feDropShadow dx="0" dy="5" stdDeviation="5" flood-color="rgb(0 0 0)" flood-opacity="0.36" />
                  </filter>
                  <filter id="fleet-glow" x="-160%" y="-160%" width="420%" height="420%">
                    <feGaussianBlur stdDeviation="3.4" result="blur" />
                    <feMerge>
                      <feMergeNode in="blur" />
                      <feMergeNode in="SourceGraphic" />
                    </feMerge>
                  </filter>
                </defs>

                <rect :width="MAP_WIDTH" :height="MAP_HEIGHT" fill="url(#fleet-ocean)" />
                <rect :width="MAP_WIDTH" :height="MAP_HEIGHT" fill="url(#fleet-grid)" />

                <g :transform="mapZoomTransform">
                  <g opacity="0.34">
                    <path v-for="x in [125, 250, 375, 500, 625, 750, 875]" :key="`meridian-${x}`" :d="`M ${x} 32 V 488`" stroke="oklch(0.84 0.035 250 / 0.28)" stroke-width="1" />
                    <path v-for="y in [104, 208, 312, 416]" :key="`parallel-${y}`" :d="`M 42 ${y} H 958`" stroke="oklch(0.84 0.035 250 / 0.22)" stroke-width="1" />
                  </g>

                  <g>
                    <path
                      v-for="(landPath, index) in landPaths"
                      :key="`land-${index}`"
                      :d="landPath"
                      fill="oklch(0.32 0.03 215 / 0.72)"
                      stroke="oklch(0.64 0.05 210 / 0.55)"
                      stroke-width="0.5"
                      stroke-linejoin="round"
                      vector-effect="non-scaling-stroke"
                    />
                  </g>

                  <g v-for="point in plotted" :key="point.node.id">
                    <!-- subtle expanding pulse for online nodes (the 'live' feel) -->
                    <circle
                      v-if="point.node.online"
                      :cx="point.x"
                      :cy="point.y"
                      class="map-ping"
                      r="2.8"
                      fill="none"
                      stroke="oklch(0.8 0.15 162 / 0.5)"
                      stroke-width="1.2"
                    />
                    <g
                      role="button"
                      tabindex="0"
                      class="cursor-pointer outline-none"
                      :aria-label="$t('fleet.map.markerAria', { node: point.node.name || point.node.id, location: point.label })"
                      @click.stop="selectMarkerNode(point.node)"
                      @mouseenter="hoveredNodeId = point.node.id"
                      @mouseleave="hoveredNodeId = ''"
                      @focus="hoveredNodeId = point.node.id"
                      @blur="hoveredNodeId = ''"
                      @keydown.enter.prevent="selectMarkerNode(point.node)"
                      @keydown.space.prevent="selectMarkerNode(point.node)"
                    >
                      <title>{{ point.node.name || point.node.id }} · {{ point.label }}</title>
                      <!-- gentle halo (online) -->
                      <circle
                        v-if="point.node.online"
                        :cx="point.x"
                        :cy="point.y"
                        :r="point.selected || hoveredNodeId === point.node.id ? 7 : 5"
                        :fill="point.selected ? 'oklch(0.8 0.15 162 / 0.26)' : 'oklch(0.8 0.15 162 / 0.13)'"
                      />
                      <!-- node dot: small + refined -->
                      <circle
                        :cx="point.x"
                        :cy="point.y"
                        :r="point.selected || hoveredNodeId === point.node.id ? 4.6 : 2.8"
                        :fill="point.node.online ? 'oklch(0.74 0.15 162)' : 'oklch(0.6 0.16 25)'"
                        :stroke="point.selected ? 'oklch(0.96 0.02 95)' : 'oklch(0.16 0.02 260 / 0.65)'"
                        :stroke-width="point.selected ? 1.5 : 1"
                        :opacity="point.node.online ? 1 : 0.82"
                      />
                    </g>
                  </g>
                </g>
              </svg>

              <div v-if="withGeo.length === 0" class="absolute inset-0 grid place-items-center p-6 text-center">
                <div class="max-w-sm rounded-lg border border-white/10 bg-black/30 p-4 backdrop-blur">
                  <MapPinned class="mx-auto size-5 text-white/80" aria-hidden="true" />
                  <p class="mt-2 text-sm font-medium">{{ $t('fleet.map.mapEmptyTitle') }}</p>
                  <p class="mt-1 text-xs text-white/65">{{ $t('fleet.map.mapEmptyDescription') }}</p>
                </div>
              </div>

              <div class="absolute left-4 top-4 flex flex-wrap gap-2">
                <Badge variant="secondary" class="bg-black/35 text-white hover:bg-black/35">
                  {{ $t('fleet.map.legend.online') }}
                </Badge>
                <Badge variant="secondary" class="bg-black/35 text-white hover:bg-black/35">
                  {{ $t('fleet.map.legend.offline') }}
                </Badge>
              </div>

              <div class="absolute right-4 top-4 flex items-center gap-1 rounded-md border border-white/10 bg-black/35 p-1 backdrop-blur">
                <button
                  type="button"
                  class="rounded px-2 py-1 text-xs font-medium text-white/85 hover:bg-white/10 disabled:opacity-40"
                  :disabled="mapZoom <= 1"
                  :aria-label="$t('fleet.map.zoomOut')"
                  @click="setZoom(mapZoom - 0.2)"
                >
                  -
                </button>
                <span class="min-w-10 text-center text-xs tabular text-white/70">{{ Math.round(mapZoom * 100) }}%</span>
                <button
                  type="button"
                  class="rounded px-2 py-1 text-xs font-medium text-white/85 hover:bg-white/10 disabled:opacity-40"
                  :disabled="mapZoom >= 5"
                  :aria-label="$t('fleet.map.zoomIn')"
                  @click="setZoom(mapZoom + 0.2)"
                >
                  +
                </button>
                <button
                  type="button"
                  class="rounded px-2 py-1 text-xs font-medium text-white/85 hover:bg-white/10 disabled:opacity-40"
                  :disabled="mapZoom <= 1 && mapViewport.x === 0 && mapViewport.y === 0"
                  :aria-label="$t('fleet.map.resetView')"
                  @click="resetViewport"
                >
                  {{ $t('fleet.map.resetShort') }}
                </button>
              </div>

              <div class="absolute bottom-4 left-4 rounded-md border border-white/10 bg-black/35 px-3 py-2 text-xs text-white/70 backdrop-blur">
                {{ $t('fleet.map.canvasHint') }}
              </div>

              <div
                v-if="hoveredPoint"
                class="pointer-events-none absolute z-10 w-64 rounded-lg border border-white/10 bg-black/75 p-3 text-xs text-white shadow-xl backdrop-blur"
                :style="{
                  left: `${(markerScreenX(hoveredPoint.x) / MAP_WIDTH) * 100}%`,
                  top: `${(markerScreenY(hoveredPoint.y) / MAP_HEIGHT) * 100}%`,
                  transform: 'translate(-50%, calc(-100% - 12px))',
                }"
              >
                <div class="flex items-start justify-between gap-3">
                  <div class="min-w-0">
                    <p class="truncate text-sm font-semibold">{{ hoveredPoint.node.name || hoveredPoint.node.id }}</p>
                    <p class="mt-1 text-white/65">{{ hoveredPoint.label }}</p>
                  </div>
                  <Badge variant="secondary" class="shrink-0 bg-white/10 text-white hover:bg-white/10">
                    {{ hoveredPoint.node.online ? $t('common.status.online') : $t('common.status.offline') }}
                  </Badge>
                </div>
                <div class="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-white/70">
                  <span>{{ $t('fleet.map.hover.ip') }}</span>
                  <span class="truncate text-right font-mono">{{ lookupIP(hoveredPoint.node) || '—' }}</span>
                  <span>{{ $t('fleet.map.hover.source') }}</span>
                  <span class="truncate text-right">{{ sourceLabel(hoveredPoint.node.geo?.source) }}</span>
                  <span>{{ $t('fleet.map.hover.coords') }}</span>
                  <span class="truncate text-right font-mono">
                    {{ hoveredPoint.node.geo?.lat?.toFixed(2) }}, {{ hoveredPoint.node.geo?.lon?.toFixed(2) }}
                  </span>
                </div>
              </div>
            </div>
          </DataState>
        </CardContent>
      </Card>

      <div class="space-y-4 xl:max-h-[min(74vh,720px)] xl:overflow-y-auto xl:pr-1">
        <Card>
          <CardHeader>
            <CardTitle class="flex items-center gap-2">
              <Route class="size-4 text-muted-foreground" aria-hidden="true" />
              {{ $t('fleet.map.regions.title') }}
            </CardTitle>
            <CardDescription>{{ $t('fleet.map.regions.description') }}</CardDescription>
          </CardHeader>
          <CardContent class="max-h-[420px] space-y-3 overflow-y-auto pr-1">
            <div v-if="regions.length === 0" class="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
              {{ $t('fleet.map.regions.empty') }}
            </div>
            <button
              v-for="group in regions"
              :key="group.key"
              type="button"
              class="w-full rounded-md border border-border p-3 text-left transition-colors hover:bg-muted/40"
              @click="selectFirstNode(group.nodes)"
            >
              <div class="flex items-center justify-between gap-3">
                <span class="text-sm font-medium">{{ group.label }}</span>
                <Badge variant="outline">{{ group.online }}/{{ group.nodes.length }}</Badge>
              </div>
              <p class="mt-1 truncate text-xs text-muted-foreground">
                {{ group.nodes.map((node) => node.name || node.id).join(", ") }}
              </p>
            </button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle class="flex items-center gap-2">
              <WifiOff class="size-4 text-muted-foreground" aria-hidden="true" />
              {{ $t('fleet.map.unlocated.title') }}
            </CardTitle>
            <CardDescription>{{ $t('fleet.map.unlocated.description', { count: withoutGeo.length }) }}</CardDescription>
          </CardHeader>
          <CardContent class="space-y-2">
            <div v-if="withoutGeo.length === 0" class="rounded-md border border-border p-3 text-sm text-muted-foreground">
              {{ $t('fleet.map.unlocated.empty') }}
            </div>
            <button
              v-for="node in withoutGeo.slice(0, 8)"
              :key="node.id"
              type="button"
              class="flex w-full items-center justify-between gap-3 rounded-md border border-border p-3 text-left transition-colors hover:bg-muted/40"
              @click="selectNode(node)"
            >
              <span class="min-w-0">
                <span class="flex items-center gap-2">
                  <StatusDot :online="node.online" :pulse="node.online" />
                  <span class="truncate text-sm font-medium">{{ node.name || node.id }}</span>
                </span>
                <span class="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                  <template v-if="lookupIP(node)">{{ lookupIP(node) }}</template>
                  <Badge v-else variant="outline" class="border-destructive/40 text-destructive">
                    {{ $t('fleet.map.unlocated.noPublicIp') }}
                  </Badge>
                </span>
              </span>
              <Badge v-if="node.role" variant="outline">{{ node.role }}</Badge>
            </button>
          </CardContent>
        </Card>
      </div>
    </div>

    <Card class="overflow-hidden">
      <div class="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div class="flex min-w-0 items-start gap-3">
          <div class="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <LocateFixed class="size-4" aria-hidden="true" />
          </div>
          <div class="min-w-0 space-y-1">
            <div class="flex flex-wrap items-center gap-2">
              <p class="font-medium leading-none">{{ $t('fleet.map.editor.title') }}</p>
              <Badge v-if="selectedNode?.geo" variant="outline">{{ sourceLabel(selectedNode.geo.source) }}</Badge>
              <Badge v-else variant="outline">{{ $t('fleet.map.noCoordinates') }}</Badge>
            </div>
            <p class="truncate text-sm text-muted-foreground">
              <template v-if="selectedNode">
                {{ selectedNode.name || selectedNode.id }}
                <span class="text-muted-foreground/70"> · </span>
                {{ selectedCoordinates || locationLabel(selectedNode) }}
                <span v-if="selectedLookupIP" class="text-muted-foreground/70"> · {{ selectedLookupIP }}</span>
              </template>
              <template v-else>
                {{ $t('fleet.map.editor.description') }}
              </template>
            </p>
          </div>
        </div>

        <div class="flex flex-wrap items-center gap-2 sm:justify-end">
          <Button
            v-if="canAdminNodes"
            type="button"
            variant="outline"
            size="sm"
            :disabled="!selectedNodeId || !selectedLookupIP || resolvingNodeId === selectedNodeId"
            @click="resolveSelected"
          >
            <Crosshair :class="cn('size-4', resolvingNodeId === selectedNodeId && 'animate-spin')" aria-hidden="true" />
            {{ $t('fleet.map.editor.auto') }}
          </Button>
          <Button type="button" variant="outline" size="sm" @click="locationEditorOpen = !locationEditorOpen">
            {{ locationEditorOpen ? $t('common.actions.close') : $t('fleet.map.editor.title') }}
          </Button>
        </div>
      </div>

      <div
        class="grid transition-[grid-template-rows] duration-200 ease-out"
        :class="locationEditorOpen ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'"
      >
        <div class="overflow-hidden">
          <CardContent class="border-t border-border pt-4">
            <form v-if="canAdminNodes" class="grid gap-4 lg:grid-cols-[minmax(220px,320px)_1fr_auto]" @submit.prevent="saveGeo">
              <div class="grid gap-2">
                <Label for="geo-node">{{ $t('fleet.map.editor.node') }}</Label>
                <select
                  id="geo-node"
                  v-model="selectedNodeId"
                  class="h-9 rounded-md border border-input bg-background px-3 text-sm"
                  @change="selectedNode && selectNode(selectedNode)"
                >
                  <option value="">{{ $t('fleet.map.editor.selectNode') }}</option>
                  <option v-for="node in nodes" :key="node.id" :value="node.id">
                    {{ node.name || node.id }}
                  </option>
                </select>
                <div v-if="selectedNode" class="space-y-1 text-xs text-muted-foreground">
                  <p>{{ selectedLookupIP || $t('fleet.map.unlocated.noIp') }}</p>
                  <p v-if="selectedNode.geo?.updated_at">
                    {{ $t('fleet.map.editor.lastUpdated', { time: formatDateTime(selectedNode.geo.updated_at) }) }}
                  </p>
                </div>
              </div>

              <div class="grid gap-3 md:grid-cols-4">
                <div class="grid gap-2">
                  <Label for="geo-lat">{{ $t('fleet.map.editor.latitude') }}</Label>
                  <Input id="geo-lat" v-model="lat" inputmode="decimal" placeholder="37.7749" />
                </div>
                <div class="grid gap-2">
                  <Label for="geo-lon">{{ $t('fleet.map.editor.longitude') }}</Label>
                  <Input id="geo-lon" v-model="lon" inputmode="decimal" placeholder="-122.4194" />
                </div>
                <div class="grid gap-2">
                  <Label for="geo-country">{{ $t('fleet.map.editor.country') }}</Label>
                  <Input id="geo-country" v-model="country" maxlength="2" placeholder="US" />
                </div>
                <div class="grid gap-2">
                  <Label for="geo-region">{{ $t('fleet.map.editor.region') }}</Label>
                  <Input id="geo-region" v-model="region" :placeholder="$t('fleet.map.editor.regionPlaceholder')" />
                </div>
                <div class="grid gap-2">
                  <Label for="geo-city">{{ $t('fleet.map.editor.city') }}</Label>
                  <Input id="geo-city" v-model="city" :placeholder="$t('fleet.map.editor.cityPlaceholder')" />
                </div>
                <div class="grid gap-2">
                  <Label for="geo-provider">{{ $t('fleet.map.editor.provider') }}</Label>
                  <Input id="geo-provider" v-model="provider" :placeholder="$t('fleet.map.editor.providerPlaceholder')" />
                </div>
                <div class="grid gap-2">
                  <Label for="geo-asn">{{ $t('fleet.map.editor.asn') }}</Label>
                  <Input id="geo-asn" v-model="asn" inputmode="numeric" />
                </div>
                <div class="grid gap-2">
                  <Label for="geo-asorg">{{ $t('fleet.map.editor.asOrg') }}</Label>
                  <Input id="geo-asorg" v-model="asOrg" />
                </div>
              </div>

              <div class="flex flex-col gap-2 lg:items-end lg:justify-end">
                <Button type="submit" :disabled="pendingSave || !selectedNodeId">
                  <RefreshCw v-if="pendingSave" class="size-4 animate-spin" aria-hidden="true" />
                  <LocateFixed v-else class="size-4" aria-hidden="true" />
                  {{ $t('fleet.map.editor.save') }}
                </Button>
                <Button type="button" variant="outline" :disabled="pendingSave || !selectedNodeId" @click="clearGeo">
                  <Trash2 class="size-4" aria-hidden="true" />
                  {{ $t('fleet.map.editor.clear') }}
                </Button>
              </div>
            </form>
            <div v-else class="rounded-md border border-border p-4 text-sm text-muted-foreground">
              {{ $t('fleet.map.editor.adminRequired') }}
            </div>
          </CardContent>
        </div>
      </div>
    </Card>
  </div>
</template>

<style scoped>
/* Subtle expanding ping on online node markers — refined, not flashy. */
.map-ping {
  transform-box: fill-box;
  transform-origin: center;
  animation: map-ping 2.6s ease-out infinite;
}
@keyframes map-ping {
  0% {
    transform: scale(1);
    opacity: 0.55;
  }
  70%,
  100% {
    transform: scale(3.4);
    opacity: 0;
  }
}
@media (prefers-reduced-motion: reduce) {
  .map-ping {
    animation: none;
    opacity: 0;
  }
}
</style>
