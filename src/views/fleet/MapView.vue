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

const selectedNode = computed<NodeGeoView | undefined>(() =>
  nodes.value.find((node) => node.id === selectedNodeId.value),
);
const selectedLookupIP = computed(() => (selectedNode.value ? lookupIP(selectedNode.value) : ""));

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

    <div class="grid gap-3 md:grid-cols-4">
      <div class="rounded-lg border border-border bg-card p-4">
        <p class="text-xs font-medium uppercase text-muted-foreground">{{ $t('fleet.map.stats.coverage') }}</p>
        <div class="mt-2 flex items-end justify-between gap-3">
          <p class="text-2xl font-semibold">{{ coveragePercent }}%</p>
          <p class="text-xs text-muted-foreground">{{ withGeo.length }}/{{ nodes.length }}</p>
        </div>
        <div class="mt-3 h-1.5 overflow-hidden rounded-full bg-muted">
          <div class="h-full rounded-full bg-primary" :style="{ width: `${coveragePercent}%` }" />
        </div>
      </div>
      <div class="rounded-lg border border-border bg-card p-4">
        <p class="text-xs font-medium uppercase text-muted-foreground">{{ $t('fleet.map.stats.online') }}</p>
        <div class="mt-2 flex items-end justify-between gap-3">
          <p class="text-2xl font-semibold">{{ onlineCount }}</p>
          <p class="text-xs text-muted-foreground">{{ $t('fleet.map.stats.offline', { count: offlineCount }) }}</p>
        </div>
      </div>
      <div class="rounded-lg border border-border bg-card p-4">
        <p class="text-xs font-medium uppercase text-muted-foreground">{{ $t('fleet.map.stats.regions') }}</p>
        <div class="mt-2 flex items-end justify-between gap-3">
          <p class="text-2xl font-semibold">{{ countryCount }}</p>
          <p class="text-xs text-muted-foreground">{{ $t('fleet.map.stats.countries') }}</p>
        </div>
      </div>
      <div class="rounded-lg border border-border bg-card p-4">
        <p class="text-xs font-medium uppercase text-muted-foreground">{{ $t('fleet.map.stats.sources') }}</p>
        <div class="mt-2 flex items-end justify-between gap-3">
          <p class="text-2xl font-semibold">{{ autoCount }}</p>
          <p class="text-xs text-muted-foreground">{{ $t('fleet.map.stats.manual', { count: manualCount }) }}</p>
        </div>
      </div>
    </div>

    <div class="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
      <Card class="overflow-hidden">
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
                class="aspect-[2/1] w-full"
                role="img"
                :aria-label="$t('fleet.map.mapAria')"
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
                    @click="selectNode(point.node)"
                    @keydown.enter.prevent="selectNode(point.node)"
                    @keydown.space.prevent="selectNode(point.node)"
                  >
                    <title>{{ point.node.name || point.node.id }} · {{ point.label }}</title>
                    <!-- gentle halo (online) -->
                    <circle
                      v-if="point.node.online"
                      :cx="point.x"
                      :cy="point.y"
                      :r="point.selected ? 6 : 5"
                      :fill="point.selected ? 'oklch(0.8 0.15 162 / 0.24)' : 'oklch(0.8 0.15 162 / 0.13)'"
                    />
                    <!-- node dot: small + refined -->
                    <circle
                      :cx="point.x"
                      :cy="point.y"
                      :r="point.selected ? 4 : 2.8"
                      :fill="point.node.online ? 'oklch(0.74 0.15 162)' : 'oklch(0.6 0.16 25)'"
                      :stroke="point.selected ? 'oklch(0.96 0.02 95)' : 'oklch(0.16 0.02 260 / 0.65)'"
                      :stroke-width="point.selected ? 1.5 : 1"
                      :opacity="point.node.online ? 1 : 0.82"
                    />
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
            </div>
          </DataState>
        </CardContent>
      </Card>

      <div class="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle class="flex items-center gap-2">
              <Route class="size-4 text-muted-foreground" aria-hidden="true" />
              {{ $t('fleet.map.regions.title') }}
            </CardTitle>
            <CardDescription>{{ $t('fleet.map.regions.description') }}</CardDescription>
          </CardHeader>
          <CardContent class="space-y-3">
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

    <Card>
      <CardHeader>
        <CardTitle class="flex items-center gap-2">
          <LocateFixed class="size-4 text-muted-foreground" aria-hidden="true" />
          {{ $t('fleet.map.editor.title') }}
        </CardTitle>
        <CardDescription>{{ $t('fleet.map.editor.description') }}</CardDescription>
      </CardHeader>
      <CardContent>
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
              <Badge v-if="selectedNode.geo" variant="outline">{{ sourceLabel(selectedNode.geo.source) }}</Badge>
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
            <Button type="button" variant="outline" :disabled="!selectedNodeId || !selectedLookupIP || resolvingNodeId === selectedNodeId" @click="resolveSelected">
              <Crosshair :class="cn('size-4', resolvingNodeId === selectedNodeId && 'animate-spin')" aria-hidden="true" />
              {{ $t('fleet.map.editor.auto') }}
            </Button>
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
