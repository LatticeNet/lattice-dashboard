<script setup lang="ts">
import { computed, ref } from "vue";
import { toast } from "vue-sonner";
import { Globe2, LocateFixed, RefreshCw, Trash2 } from "lucide-vue-next";
import { api, unwrap, type NodeGeoView } from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { useAuthStore } from "@/stores/auth";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

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

const auth = useAuthStore();
const geoQuery = useAsyncData(() => api.nodes.geo().then((r) => unwrap(r, "nodes")), {
  pollInterval: 10000,
});

const selectedNodeId = ref("");
const country = ref("");
const city = ref("");
const lat = ref("");
const lon = ref("");
const provider = ref("");
const asn = ref("");
const asOrg = ref("");
const pending = ref(false);

const nodes = computed(() => geoQuery.data.value ?? []);
const withGeo = computed(() => nodes.value.filter((n) => n.geo?.lat !== undefined && n.geo?.lon !== undefined));
const canAdminNodes = computed(() => auth.can("node:admin"));

const plotted = computed(() =>
  withGeo.value.map((node) => {
    const latitude = node.geo?.lat ?? 0;
    const longitude = node.geo?.lon ?? 0;
    return {
      node,
      x: ((longitude + 180) / 360) * 100,
      y: ((90 - latitude) / 180) * 100,
    };
  }),
);

const selectedNode = computed<NodeGeoView | undefined>(() =>
  nodes.value.find((node) => node.id === selectedNodeId.value),
);

function selectNode(node: NodeGeoView) {
  selectedNodeId.value = node.id;
  country.value = node.geo?.country ?? "";
  city.value = node.geo?.city ?? "";
  lat.value = node.geo?.lat?.toString() ?? "";
  lon.value = node.geo?.lon?.toString() ?? "";
  provider.value = node.geo?.provider ?? "";
  asn.value = node.geo?.asn?.toString() ?? "";
  asOrg.value = node.geo?.as_org ?? "";
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
    toast.error("Latitude and longitude are required");
    return;
  }
  pending.value = true;
  try {
    await api.nodes.updateGeo(selectedNodeId.value, {
      country: country.value.trim() || undefined,
      city: city.value.trim() || undefined,
      lat: parsedLat,
      lon: parsedLon,
      provider: provider.value.trim() || undefined,
      asn: parseNumber(asn.value),
      as_org: asOrg.value.trim() || undefined,
    });
    toast.success("Node location saved");
    geoQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "Location update failed");
  } finally {
    pending.value = false;
  }
}

async function clearGeo() {
  if (!selectedNodeId.value) return;
  pending.value = true;
  try {
    await api.nodes.clearGeo(selectedNodeId.value);
    toast.success("Node location cleared");
    country.value = "";
    city.value = "";
    lat.value = "";
    lon.value = "";
    provider.value = "";
    asn.value = "";
    asOrg.value = "";
    geoQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "Location clear failed");
  } finally {
    pending.value = false;
  }
}
</script>

<template>
  <div class="p-6 space-y-6">
    <PageHeader title="Fleet Map" description="Operator-owned node locations, rendered without external map tiles">
      <template #actions>
        <Button variant="outline" size="sm" :disabled="geoQuery.refreshing.value" @click="geoQuery.refresh">
          <RefreshCw :class="cn('size-4', geoQuery.refreshing.value && 'animate-spin')" />
          Refresh
        </Button>
      </template>
    </PageHeader>

    <div class="grid gap-6 xl:grid-cols-[minmax(0,1fr)_420px]">
      <Card>
        <CardHeader>
          <CardTitle class="flex items-center gap-2">
            <Globe2 class="size-4 text-muted-foreground" />
            Nodes by Location
          </CardTitle>
          <CardDescription>{{ withGeo.length }} of {{ nodes.length }} nodes have coordinates</CardDescription>
        </CardHeader>
        <CardContent>
          <DataState
            :loading="geoQuery.loading.value"
            :error="geoQuery.error.value"
            :is-empty="nodes.length === 0"
            empty-title="No nodes visible"
            empty-description="Nodes with coordinates appear on the map."
            @retry="geoQuery.refresh"
          >
            <div class="relative aspect-[1.8] overflow-hidden rounded-lg border border-border bg-muted/20">
              <svg viewBox="0 0 100 55" class="absolute inset-0 size-full">
                <defs>
                  <pattern id="geo-grid" width="10" height="10" patternUnits="userSpaceOnUse">
                    <path d="M 10 0 L 0 0 0 10" fill="none" stroke="currentColor" stroke-width="0.12" />
                  </pattern>
                </defs>
                <rect width="100" height="55" class="fill-muted/20 text-border" />
                <rect width="100" height="55" fill="url(#geo-grid)" class="text-border" />
                <path
                  d="M8 19 C18 10 34 8 45 15 C55 8 78 9 92 20 C85 30 72 34 60 31 C50 38 33 39 22 31 C14 32 8 28 8 19Z"
                  class="fill-primary/10 stroke-primary/25"
                  stroke-width="0.5"
                />
                <g v-for="point in plotted" :key="point.node.id">
                  <circle
                    :cx="point.x"
                    :cy="(point.y / 100) * 55"
                    r="1.2"
                    :class="point.node.online ? 'fill-success' : 'fill-destructive'"
                  />
                  <circle
                    v-if="point.node.online"
                    :cx="point.x"
                    :cy="(point.y / 100) * 55"
                    r="2.3"
                    class="fill-success/20"
                  />
                </g>
              </svg>
            </div>

            <div class="mt-4 grid gap-2 sm:grid-cols-2">
              <button
                v-for="node in nodes"
                :key="node.id"
                type="button"
                :class="cn('rounded-md border border-border p-3 text-left transition-colors hover:bg-muted/40', selectedNodeId === node.id && 'border-primary bg-primary/5')"
                @click="selectNode(node)"
              >
                <div class="flex items-center justify-between gap-2">
                  <span class="flex min-w-0 items-center gap-2">
                    <StatusDot :active="node.online" :pulse="node.online" />
                    <span class="truncate text-sm font-medium">{{ node.name || node.id }}</span>
                  </span>
                  <Badge v-if="node.role" variant="outline">{{ node.role }}</Badge>
                </div>
                <p class="mt-1 text-xs text-muted-foreground">
                  <template v-if="node.geo">
                    {{ node.geo.city || "unknown city" }} {{ node.geo.country || "" }}
                  </template>
                  <template v-else>No coordinates</template>
                </p>
              </button>
            </div>
          </DataState>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle class="flex items-center gap-2">
            <LocateFixed class="size-4 text-muted-foreground" />
            Location Editor
          </CardTitle>
          <CardDescription>Set or clear operator-owned coordinates for a node.</CardDescription>
        </CardHeader>
        <CardContent>
          <form v-if="canAdminNodes" class="space-y-4" @submit.prevent="saveGeo">
            <div class="grid gap-2">
              <Label for="geo-node">Node</Label>
              <select
                id="geo-node"
                v-model="selectedNodeId"
                class="h-9 rounded-md border border-input bg-background px-3 text-sm"
                @change="selectedNode && selectNode(selectedNode)"
              >
                <option value="">Select a node</option>
                <option v-for="node in nodes" :key="node.id" :value="node.id">
                  {{ node.name || node.id }}
                </option>
              </select>
            </div>

            <div class="grid grid-cols-2 gap-3">
              <div class="grid gap-2">
                <Label for="geo-lat">Latitude</Label>
                <Input id="geo-lat" v-model="lat" inputmode="decimal" placeholder="37.7749" />
              </div>
              <div class="grid gap-2">
                <Label for="geo-lon">Longitude</Label>
                <Input id="geo-lon" v-model="lon" inputmode="decimal" placeholder="-122.4194" />
              </div>
            </div>

            <div class="grid grid-cols-2 gap-3">
              <div class="grid gap-2">
                <Label for="geo-country">Country</Label>
                <Input id="geo-country" v-model="country" maxlength="2" placeholder="US" />
              </div>
              <div class="grid gap-2">
                <Label for="geo-city">City</Label>
                <Input id="geo-city" v-model="city" placeholder="San Francisco" />
              </div>
            </div>

            <div class="grid gap-2">
              <Label for="geo-provider">Provider</Label>
              <Input id="geo-provider" v-model="provider" placeholder="cloud or colo" />
            </div>
            <div class="grid grid-cols-2 gap-3">
              <div class="grid gap-2">
                <Label for="geo-asn">ASN</Label>
                <Input id="geo-asn" v-model="asn" inputmode="numeric" />
              </div>
              <div class="grid gap-2">
                <Label for="geo-asorg">AS Org</Label>
                <Input id="geo-asorg" v-model="asOrg" />
              </div>
            </div>

            <div v-if="selectedNode?.geo?.updated_at" class="text-xs text-muted-foreground">
              Last updated {{ formatDateTime(selectedNode.geo.updated_at) }}
            </div>

            <div class="flex flex-wrap gap-2">
              <Button type="submit" :disabled="pending || !selectedNodeId">
                <RefreshCw v-if="pending" class="size-4 animate-spin" />
                <LocateFixed v-else class="size-4" />
                Save location
              </Button>
              <Button type="button" variant="outline" :disabled="pending || !selectedNodeId" @click="clearGeo">
                <Trash2 class="size-4" />
                Clear
              </Button>
            </div>
          </form>
          <div v-else class="rounded-md border border-border p-4 text-sm text-muted-foreground">
            `node:admin` is required to edit locations.
          </div>
        </CardContent>
      </Card>
    </div>
  </div>
</template>
