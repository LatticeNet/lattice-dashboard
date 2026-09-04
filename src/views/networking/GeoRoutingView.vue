<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import {
  AlertTriangle,
  FileCode2,
  Globe,
  Pencil,
  Plus,
  RefreshCw,
  Route,
  Trash2,
} from "lucide-vue-next";
import {
  api,
  unwrap,
  type GeoRouting,
  type GeoRoutingPlanView,
  type GeoRoutingUpsertRequest,
  type Node,
} from "@/lib/api";
import { sha256Hex } from "@/lib/crypto";
import { isDemoObject, onlyDemos } from "@/lib/demo";
import { useAsyncData } from "@/composables/useAsyncData";
import { useAuthStore } from "@/stores/auth";
import { formatDateTime, shortId } from "@/lib/format";
import { cn } from "@/lib/utils";

import PageHeader from "@/components/common/PageHeader.vue";
import DataState from "@/components/common/DataState.vue";
import DataTable, { type DataTableColumn } from "@/components/common/DataTable.vue";
import EmptyState from "@/components/common/EmptyState.vue";
import ConfirmDialog from "@/components/common/ConfirmDialog.vue";
import CopyButton from "@/components/common/CopyButton.vue";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogScrollContent,
  DialogTitle,
} from "@/components/ui/dialog";

type Strategy = "geoip" | "all-healthy";

/**
 * Go's `omitempty` does not drop a zero time.Time, so a routing that was never
 * applied arrives as "0001-01-01T00:00:00Z" and formats into a real-looking
 * year-1 date instead of falling through to "never".
 */
function hasRealTime(value?: string): boolean {
  return !!value && !value.startsWith("0001");
}

const { t } = useI18n();
const auth = useAuthStore();
const canRead = computed(() => auth.can("geo:read"));
const canAdmin = computed(() => auth.can("geo:admin"));
const canReadNodes = computed(() => auth.can("node:read"));

/**
 * What an operator has to have before a geo-routing can be authored and
 * rendered, in the order they have to have it.
 *
 * A seeded example is the tempting alternative and the wrong one: a routing
 * has to name real node ids to be renderable at all, so a demo would be
 * indistinguishable from a live one on a control plane driving production
 * nodes. Teaching the loop costs an empty screen and risks nothing.
 */
const prerequisites = computed(() => [
  {
    title: t("networking.geoRouting.prereqNodesTitle"),
    detail: t("networking.geoRouting.prereqNodesDetail"),
  },
  {
    title: t("networking.geoRouting.prereqGeoTitle"),
    detail: t("networking.geoRouting.prereqGeoDetail"),
  },
  {
    title: t("networking.geoRouting.prereqDnsNodeTitle"),
    detail: t("networking.geoRouting.prereqDnsNodeDetail"),
  },
  {
    title: t("networking.geoRouting.prereqDatabaseTitle"),
    detail: t("networking.geoRouting.prereqDatabaseDetail"),
  },
]);

const routesQuery = useAsyncData(
  (signal) => {
    if (!canRead.value) return Promise.resolve([] as GeoRouting[]);
    return api.geoRouting.list({ signal }).then((r) => unwrap(r, "geo_routings"));
  },
  { pollInterval: 15000, immediate: canRead.value },
);
const nodesQuery = useAsyncData(
  (signal) => {
    if (!canReadNodes.value) return Promise.resolve([] as Node[]);
    return api.nodes.list({ signal }).then((r) => unwrap(r, "nodes"));
  },
  {
    pollInterval: 15000,
    immediate: canReadNodes.value,
  },
);

const routes = computed(() => routesQuery.data.value ?? []);

/**
 * Whether the only thing on this page is the demo. A control plane that drives
 * production nodes must not seed itself with fake rows, but geo-routing is the
 * one page here whose whole loop (author, render, checksum) touches no node at
 * all, so one honestly named record can show the loop working instead of an
 * empty screen. The explanation stands only while nothing real exists beside
 * it, and it names the delete call so the demo is never load-bearing.
 */
const firstRun = computed(() => onlyDemos(routes.value.map((route) => route.name)));

const nodes = computed(() => nodesQuery.data.value ?? []);

const sortedRoutes = computed(() =>
  [...routes.value].sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id)),
);

function nodeName(id: string): string {
  return nodes.value.find((node) => node.id === id)?.name || shortId(id, 14);
}

function strategyVariant(strategy: string): "info" | "secondary" {
  return strategy === "geoip" ? "info" : "secondary";
}

/**
 * The routings table, through the shared DataTable.
 *
 * It was a hand-rolled `<table>` in an `overflow-x-auto`, which on a phone
 * showed Name, Hostname and Strategy and cut everything after them off past
 * the card edge with no scrollbar and no hint that a swipe was available. The
 * whole Actions cell went with it, including the delete button the first-run
 * copy tells the reader to use, so the page's own instruction pointed at a
 * control the reader could not see. DataTable stacks each row into a
 * definition list below `md`, which is the layout that keeps a nine-column row
 * readable at 375.
 */
const columns = computed<DataTableColumn<GeoRouting>[]>(() => [
  { key: "name", label: t("networking.geoRouting.colName"), sortable: true, searchable: true, value: (route) => route.name || route.id },
  { key: "hostname", label: t("networking.geoRouting.colHostname"), sortable: true, searchable: true },
  { key: "strategy", label: t("networking.geoRouting.colStrategy"), sortable: true, searchable: true },
  { key: "nodes", label: t("networking.geoRouting.colNodes"), align: "right", sortable: true, value: (route) => route.node_ids?.length ?? 0 },
  { key: "dns", label: t("networking.geoRouting.colDns"), align: "right", sortable: true, value: (route) => route.dns_node_ids?.length ?? 0 },
  { key: "status", label: t("networking.geoRouting.colStatus"), sortable: true, value: (route) => route.status ?? "" },
  { key: "lastApplied", label: t("networking.geoRouting.colLastApplied"), sortable: true, value: (route) => (hasRealTime(route.last_applied_at) ? route.last_applied_at : "") },
  { key: "lastError", label: t("networking.geoRouting.colLastError"), value: (route) => route.last_error ?? "" },
  { key: "actions", label: t("networking.geoRouting.colActions"), align: "right" },
]);

// ── Create / edit dialog ────────────────────────────────────────────────────
const formOpen = ref(false);
const editingId = ref<string | undefined>();
const saving = ref(false);

const form = reactive({
  name: "",
  hostname: "",
  strategy: "geoip" as Strategy,
  node_ids: [] as string[],
  dns_node_ids: [] as string[],
  ttl: 60,
  geoip_db_path: "",
  publish_ns: false,
  ddns_profile_id: "",
});
const nodeIdsInput = computed({
  get: () => form.node_ids.join(", "),
  set: (value: string) => {
    form.node_ids = parseNodeIdList(value);
  },
});
const dnsNodeIdsInput = computed({
  get: () => form.dns_node_ids.join(", "),
  set: (value: string) => {
    form.dns_node_ids = parseNodeIdList(value);
  },
});

function parseNodeIdList(value: string): string[] {
  return [...new Set(value.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean))];
}

function resetForm() {
  form.name = "";
  form.hostname = "";
  form.strategy = "geoip";
  form.node_ids = [];
  form.dns_node_ids = [];
  form.ttl = 60;
  form.geoip_db_path = "";
  form.publish_ns = false;
  form.ddns_profile_id = "";
}

function openCreate() {
  if (!canAdmin.value) return;
  editingId.value = undefined;
  resetForm();
  formOpen.value = true;
}

function openEdit(route: GeoRouting) {
  if (!canAdmin.value) return;
  editingId.value = route.id;
  form.name = route.name;
  form.hostname = route.hostname;
  form.strategy = (route.strategy === "all-healthy" ? "all-healthy" : "geoip") as Strategy;
  form.node_ids = [...(route.node_ids ?? [])];
  form.dns_node_ids = [...(route.dns_node_ids ?? [])];
  form.ttl = route.ttl ?? 60;
  form.geoip_db_path = route.geoip_db_path ?? "";
  form.publish_ns = route.publish_ns ?? false;
  form.ddns_profile_id = route.ddns_profile_id ?? "";
  formOpen.value = true;
}

const canSubmit = computed(
  () =>
    !!form.name.trim() &&
    !!form.hostname.trim() &&
    form.node_ids.length > 0 &&
    form.dns_node_ids.length > 0 &&
    form.ttl >= 10 &&
    form.ttl <= 3600,
);

function toggleId(list: "node_ids" | "dns_node_ids", id: string) {
  const current = form[list];
  form[list] = current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
}

async function submitForm() {
  if (!canSubmit.value || !canAdmin.value) return;
  saving.value = true;
  try {
    const req: GeoRoutingUpsertRequest = {
      id: editingId.value,
      name: form.name.trim(),
      hostname: form.hostname.trim(),
      strategy: form.strategy,
      node_ids: form.node_ids,
      dns_node_ids: form.dns_node_ids,
      ttl: Number(form.ttl),
      publish_ns: form.publish_ns,
    };
    if (form.strategy === "geoip" && form.geoip_db_path.trim()) {
      req.geoip_db_path = form.geoip_db_path.trim();
    }
    if (form.ddns_profile_id.trim()) {
      req.ddns_profile_id = form.ddns_profile_id.trim();
    }
    await api.geoRouting.upsert(req);
    toast.success(editingId.value ? t("networking.geoRouting.toastUpdated") : t("networking.geoRouting.toastCreated"));
    formOpen.value = false;
    if (canRead.value) routesQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("networking.geoRouting.toastSaveFailed"));
  } finally {
    saving.value = false;
  }
}

// ── Delete confirmation ─────────────────────────────────────────────────────
const deleteTarget = ref<GeoRouting | undefined>();
const deleting = ref(false);

async function confirmDelete() {
  if (!deleteTarget.value) return;
  deleting.value = true;
  try {
    await api.geoRouting.delete(deleteTarget.value.id);
    toast.success(t("networking.geoRouting.toastDeleted"));
    deleteTarget.value = undefined;
    if (canRead.value) routesQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("networking.geoRouting.toastDeleteFailed"));
  } finally {
    deleting.value = false;
  }
}

// ── Plan preview (pure render, NOT an approval) ────────────────────────────
const planOpen = ref(false);
const planning = ref<string | undefined>();
const plan = ref<GeoRoutingPlanView | undefined>();
const planDigest = ref("");

async function openPlan(route: GeoRouting) {
  if (!canRead.value) return;
  planning.value = route.id;
  try {
    const result = await api.geoRouting.plan(route.id);
    plan.value = result;
    planDigest.value = await sha256Hex(result.config || "");
    planOpen.value = true;
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("networking.geoRouting.toastPlanFailed"));
  } finally {
    planning.value = undefined;
  }
}

const continentEntries = computed(() =>
  Object.entries(plan.value?.continent_choice ?? {}).sort((a, b) => a[0].localeCompare(b[0])),
);
</script>

<template>
  <div class="p-6 space-y-6">
    <PageHeader
      :title="$t('networking.geoRouting.title')"
      :description="$t('networking.geoRouting.description')"
    >
      <template #actions>
        <Button
          v-if="canRead"
          variant="outline"
          size="sm"
          :disabled="routesQuery.refreshing.value"
          @click="routesQuery.refresh"
        >
          <RefreshCw :class="cn('size-4', routesQuery.refreshing.value && 'animate-spin')" aria-hidden="true" />
          {{ $t('common.actions.refresh') }}
        </Button>
        <Button
          v-if="canAdmin"
          size="sm"
          @click="openCreate"
        >
          <Plus class="size-4" aria-hidden="true" />
          {{ $t('networking.geoRouting.newRouting') }}
        </Button>
      </template>
    </PageHeader>

    <!--
      First run. The demo is one real record on the real control plane, so the
      page has to say what it is, what a routing does, and what a routing of
      the operator's own would have to name. It disappears the moment a record
      that is not a demo exists.
    -->
    <Card v-if="firstRun" class="border-dashed">
      <CardHeader>
        <CardTitle class="flex items-center gap-2">
          <FileCode2 class="size-4 text-muted-foreground" aria-hidden="true" />
          {{ $t('networking.geoRouting.demo.title') }}
        </CardTitle>
        <CardDescription>{{ $t('networking.geoRouting.demo.what') }}</CardDescription>
      </CardHeader>
      <CardContent class="space-y-2 text-sm text-muted-foreground">
        <p>{{ $t('networking.geoRouting.demo.real') }}</p>
        <p>{{ $t('networking.geoRouting.demo.remove') }}</p>
      </CardContent>
    </Card>

    <Card>
      <CardHeader>
        <CardTitle class="flex items-center gap-2">
          <Route class="size-4 text-muted-foreground" aria-hidden="true" />
          {{ $t('networking.geoRouting.routings') }}
        </CardTitle>
        <CardDescription>
          {{ routes.length === 1 ? $t('networking.geoRouting.apexRecord', { count: routes.length }) : $t('networking.geoRouting.apexRecords', { count: routes.length }) }}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <DataTable
          state-key="geoRoutings"
          :columns="columns"
          :rows="sortedRoutes"
          :row-key="(route) => route.id"
          :loading="routesQuery.loading.value"
          :error="routesQuery.error.value"
          :has-data="routesQuery.data.value !== undefined"
          searchable
          :search-placeholder="$t('common.actions.search')"
          :empty-title="$t('networking.geoRouting.emptyTitle')"
          :empty-description="$t('networking.geoRouting.emptyDescription')"
          :no-match-title="$t('networking.shared.noMatchTitle')"
          :no-match-description="$t('networking.shared.noMatchDescription')"
          @retry="routesQuery.refresh"
        >
          <template #empty>
            <EmptyState
              :icon="Route"
              :title="$t('networking.geoRouting.emptyTitle')"
              :description="$t('networking.geoRouting.emptyDescription')"
              :steps="prerequisites"
            >
              <Button v-if="canAdmin" size="sm" @click="openCreate">
                <Plus aria-hidden="true" class="size-4" />
                {{ $t('networking.geoRouting.newRouting') }}
              </Button>
            </EmptyState>
          </template>
          <template #cell-name="{ row: route }">
            <div class="flex items-center gap-1.5">
              <span class="font-medium">{{ route.name || route.id }}</span>
              <Badge v-if="isDemoObject(route.name)" variant="outline">
                {{ $t('networking.geoRouting.demo.badge') }}
              </Badge>
            </div>
            <div class="font-mono text-xs text-muted-foreground">{{ shortId(route.id, 16) }}</div>
          </template>
          <template #cell-hostname="{ row: route }">
            <span class="font-mono text-xs">{{ route.hostname }}</span>
          </template>
          <template #cell-strategy="{ row: route }">
            <Badge :variant="strategyVariant(route.strategy)">{{ route.strategy }}</Badge>
          </template>
          <template #cell-nodes="{ row: route }">
            <span class="tabular">{{ route.node_ids?.length ?? 0 }}</span>
          </template>
          <template #cell-dns="{ row: route }">
            <span class="tabular">{{ route.dns_node_ids?.length ?? 0 }}</span>
          </template>
          <template #cell-status="{ row: route }">
            <Badge v-if="route.status" :variant="route.status === 'configured' ? 'success' : 'warning'">
              {{ route.status }}
            </Badge>
            <span v-else class="text-xs text-muted-foreground">{{ $t('common.misc.none') }}</span>
          </template>
          <template #cell-lastApplied="{ row: route }">
            <span class="text-xs text-muted-foreground">
              {{ hasRealTime(route.last_applied_at) ? formatDateTime(route.last_applied_at) : $t('common.misc.never') }}
            </span>
          </template>
          <template #cell-lastError="{ row: route }">
            <span
              v-if="route.last_error"
              class="line-clamp-3 block max-w-[180px] break-words text-xs text-destructive"
              :title="route.last_error"
            >
              {{ route.last_error }}
            </span>
            <span v-else class="text-xs text-muted-foreground">{{ $t('common.misc.none') }}</span>
          </template>
          <template #cell-actions="{ row: route }">
            <div class="flex flex-wrap justify-end gap-1">
              <Button
                v-if="canRead"
                variant="ghost"
                size="sm"
                :disabled="planning === route.id"
                @click="openPlan(route)"
              >
                <RefreshCw v-if="planning === route.id" class="size-4 animate-spin" aria-hidden="true" />
                <FileCode2 v-else class="size-4" aria-hidden="true" />
                {{ $t('networking.geoRouting.previewConfig') }}
              </Button>
              <Button
                v-if="canAdmin"
                variant="ghost"
                size="icon-sm"
                :aria-label="$t('common.actions.edit')"
                @click="openEdit(route)"
              >
                <Pencil class="size-4" />
              </Button>
              <Button
                v-if="canAdmin"
                variant="ghost"
                size="icon-sm"
                :aria-label="$t('common.actions.delete')"
                @click="deleteTarget = route"
              >
                <Trash2 class="size-4 text-destructive" />
              </Button>
            </div>
          </template>
        </DataTable>
      </CardContent>
    </Card>

    <!-- Create / edit dialog -->
    <Dialog v-model:open="formOpen">
      <DialogScrollContent class="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{{ editingId ? $t('networking.geoRouting.editTitle') : $t('networking.geoRouting.newTitle') }}</DialogTitle>
          <DialogDescription>
            {{ $t('networking.geoRouting.dialogDescription') }}
          </DialogDescription>
        </DialogHeader>

        <form class="space-y-4" @submit.prevent="submitForm">
          <div class="grid gap-3 sm:grid-cols-2">
            <div class="grid gap-2">
              <Label for="geo-name">{{ $t('networking.geoRouting.name') }}</Label>
              <Input id="geo-name" v-model="form.name" required placeholder="apex-edge" />
            </div>
            <div class="grid gap-2">
              <Label for="geo-hostname">{{ $t('networking.geoRouting.hostname') }}</Label>
              <Input id="geo-hostname" v-model="form.hostname" required placeholder="app.example.com" />
            </div>
          </div>

          <div class="grid gap-3 sm:grid-cols-2">
            <div class="grid gap-2">
              <Label for="geo-strategy">{{ $t('networking.geoRouting.strategy') }}</Label>
              <Select v-model="form.strategy">
                <SelectTrigger id="geo-strategy" class="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="geoip">{{ $t('networking.geoRouting.strategyGeoip') }}</SelectItem>
                  <SelectItem value="all-healthy">{{ $t('networking.geoRouting.strategyAllHealthy') }}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div class="grid gap-2">
              <Label for="geo-ttl">{{ $t('networking.geoRouting.ttlSeconds') }}</Label>
              <Input id="geo-ttl" v-model.number="form.ttl" type="number" min="10" max="3600" />
            </div>
          </div>

          <div v-if="form.strategy === 'geoip'" class="grid gap-2">
            <Label for="geo-db">{{ $t('networking.geoRouting.geoipDbPath') }}</Label>
            <Input
              id="geo-db"
              v-model="form.geoip_db_path"
              :placeholder="$t('networking.geoRouting.geoipDbPlaceholder')"
            />
            <p class="text-xs text-muted-foreground">
              {{ $t('networking.geoRouting.geoipDbHint') }}
            </p>
          </div>

          <div class="grid gap-2">
            <Label>{{ $t('networking.geoRouting.participatingNodes') }}</Label>
            <p class="text-xs text-muted-foreground">{{ $t('networking.geoRouting.participatingNodesHint') }}</p>
            <DataState
              v-if="canReadNodes"
              :loading="nodesQuery.loading.value"
              :error="nodesQuery.error.value"
              :has-data="nodesQuery.data.value !== undefined"
              :is-empty="nodes.length === 0"
              :empty-title="$t('networking.geoRouting.noNodesTitle')"
              :empty-description="$t('networking.geoRouting.noNodesDescription')"
              :skeleton-rows="2"
              @retry="nodesQuery.refresh"
            >
              <div class="grid max-h-48 gap-1 overflow-auto rounded-md border border-border p-2">
                <label
                  v-for="node in nodes"
                  :key="node.id"
                  class="flex cursor-pointer items-center gap-2 rounded-md p-2 text-sm hover:bg-muted/40"
                >
                  <Checkbox
                    :model-value="form.node_ids.includes(node.id)"
                    @update:model-value="toggleId('node_ids', node.id)"
                  />
                  <span class="min-w-0 flex-1 truncate" :title="node.name || node.id">{{ node.name || node.id }}</span>
                  <Badge :variant="node.online ? 'success' : 'secondary'">{{ node.online ? $t('networking.geoRouting.on') : $t('networking.geoRouting.off') }}</Badge>
                </label>
              </div>
            </DataState>
            <div v-else class="grid gap-2">
              <Input
                id="geo-node-ids"
                v-model="nodeIdsInput"
                :placeholder="$t('networking.geoRouting.nodeIdsPlaceholder')"
              />
              <p class="text-xs text-muted-foreground">{{ $t('networking.geoRouting.nodeIdsManualHint') }}</p>
            </div>
          </div>

          <div class="grid gap-2">
            <Label>{{ $t('networking.geoRouting.authoritativeNodes') }}</Label>
            <p class="text-xs text-muted-foreground">{{ $t('networking.geoRouting.authoritativeNodesHint') }}</p>
            <DataState
              v-if="canReadNodes"
              :loading="nodesQuery.loading.value"
              :error="nodesQuery.error.value"
              :has-data="nodesQuery.data.value !== undefined"
              :is-empty="nodes.length === 0"
              :empty-title="$t('networking.geoRouting.noNodesTitle')"
              :empty-description="$t('networking.geoRouting.noNodesDescription')"
              :skeleton-rows="2"
              @retry="nodesQuery.refresh"
            >
              <div class="grid max-h-48 gap-1 overflow-auto rounded-md border border-border p-2">
                <label
                  v-for="node in nodes"
                  :key="node.id"
                  class="flex cursor-pointer items-center gap-2 rounded-md p-2 text-sm hover:bg-muted/40"
                >
                  <Checkbox
                    :model-value="form.dns_node_ids.includes(node.id)"
                    @update:model-value="toggleId('dns_node_ids', node.id)"
                  />
                  <span class="min-w-0 flex-1 truncate" :title="node.name || node.id">{{ node.name || node.id }}</span>
                  <Badge :variant="node.online ? 'success' : 'secondary'">{{ node.online ? $t('networking.geoRouting.on') : $t('networking.geoRouting.off') }}</Badge>
                </label>
              </div>
            </DataState>
            <div v-else class="grid gap-2">
              <Input
                id="geo-dns-node-ids"
                v-model="dnsNodeIdsInput"
                :placeholder="$t('networking.geoRouting.nodeIdsPlaceholder')"
              />
              <p class="text-xs text-muted-foreground">{{ $t('networking.geoRouting.nodeIdsManualHint') }}</p>
            </div>
          </div>

          <div class="grid gap-3 sm:grid-cols-2">
            <div class="grid gap-2">
              <Label for="geo-ddns">{{ $t('networking.geoRouting.ddnsProfileId') }}</Label>
              <Input id="geo-ddns" v-model="form.ddns_profile_id" :placeholder="$t('networking.geoRouting.ddnsProfilePlaceholder')" />
            </div>
            <label class="flex cursor-pointer items-center gap-2 self-end pb-2 text-sm">
              <Checkbox v-model="form.publish_ns" />
              {{ $t('networking.geoRouting.publishNs') }}
            </label>
          </div>

          <DialogFooter>
            <DialogClose as-child>
              <Button type="button" variant="outline">{{ $t('common.actions.cancel') }}</Button>
            </DialogClose>
            <Button type="submit" :disabled="saving || !canSubmit">
              <RefreshCw v-if="saving" class="size-4 animate-spin" aria-hidden="true" />
              <Plus v-else class="size-4" aria-hidden="true" />
              {{ editingId ? $t('common.actions.saveChanges') : $t('common.actions.create') }}
            </Button>
          </DialogFooter>
        </form>
      </DialogScrollContent>
    </Dialog>

    <!-- Delete confirmation -->
    <ConfirmDialog
      :open="!!deleteTarget"
      :title="$t('networking.geoRouting.deleteTitle')"
      :description="$t('networking.geoRouting.deleteDescription', {
        name: deleteTarget?.name || deleteTarget?.id || '',
        hostname: deleteTarget?.hostname ?? '',
      })"
      :confirm-label="$t('common.actions.delete')"
      :cancel-label="$t('common.actions.cancel')"
      :pending="deleting"
      @update:open="(v) => { if (!v) deleteTarget = undefined; }"
      @confirm="confirmDelete"
    />

    <!-- Plan preview (pure render, not an approval) -->
    <Dialog v-model:open="planOpen">
      <DialogScrollContent class="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle class="flex items-center gap-2">
            <FileCode2 class="size-5 text-muted-foreground" aria-hidden="true" />
            {{ $t('networking.geoRouting.previewTitle') }}
          </DialogTitle>
          <DialogDescription v-if="plan">
            {{ $t('networking.geoRouting.previewSubtitle', { hostname: plan.hostname, strategy: plan.strategy }) }}
          </DialogDescription>
        </DialogHeader>

        <div v-if="plan" class="space-y-4">
          <div class="flex items-start gap-2 rounded-md border border-info/40 bg-info/5 p-3 text-sm">
            <Globe class="mt-0.5 size-4 shrink-0 text-info" aria-hidden="true" />
            <i18n-t keypath="networking.geoRouting.renderOnlyHint" tag="p" class="text-muted-foreground" scope="global">
              <template #renderOnly>
                <span class="font-medium text-foreground">{{ $t('networking.geoRouting.renderOnlyLead') }}</span>
              </template>
            </i18n-t>
          </div>

          <div class="rounded-md border border-border">
            <div class="flex items-center justify-between gap-3 border-b border-border px-3 py-2">
              <span class="text-sm font-medium">{{ $t('networking.geoRouting.serverBlock') }}</span>
              <CopyButton :value="plan.config || ''" />
            </div>
            <pre class="max-h-[420px] overflow-auto whitespace-pre-wrap p-4 font-mono text-xs leading-relaxed">{{ plan.config }}</pre>
          </div>

          <div class="flex flex-wrap items-center gap-2 rounded-md bg-muted/40 p-3 text-xs">
            <span class="font-medium">{{ $t('networking.shared.planTextSha256') }}</span>
            <code class="break-all font-mono">{{ planDigest || plan.sha256 }}</code>
            <CopyButton :value="planDigest || plan.sha256 || ''" />
          </div>

          <div v-if="plan.warnings && plan.warnings.length" class="space-y-2">
            <p class="flex items-center gap-2 text-sm font-medium text-warning">
              <AlertTriangle class="size-4" aria-hidden="true" />
              {{ $t('networking.geoRouting.warnings') }}
            </p>
            <ul class="space-y-1 rounded-md border border-warning/40 bg-warning/5 p-3 text-xs text-muted-foreground">
              <li v-for="(warning, index) in plan.warnings" :key="index" class="break-words">{{ warning }}</li>
            </ul>
          </div>

          <div v-if="continentEntries.length" class="space-y-2">
            <p class="text-sm font-medium">{{ $t('networking.geoRouting.perContinentTitle') }}</p>
            <div class="overflow-x-auto rounded-md border border-border">
              <table class="w-full text-sm">
                <thead>
                  <tr class="border-b border-border text-left text-xs text-muted-foreground">
                    <th scope="col" class="px-3 py-2 font-medium">{{ $t('networking.geoRouting.colContinent') }}</th>
                    <th scope="col" class="px-3 py-2 font-medium">{{ $t('networking.geoRouting.colChoiceNode') }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="[continent, node] in continentEntries"
                    :key="continent"
                    class="border-b border-border last:border-b-0"
                  >
                    <td class="px-3 py-2 font-mono text-xs">{{ continent }}</td>
                    <td class="px-3 py-2">{{ nodeName(node) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <DialogFooter>
          <DialogClose as-child>
            <Button type="button" variant="outline">{{ $t('common.actions.close') }}</Button>
          </DialogClose>
        </DialogFooter>
      </DialogScrollContent>
    </Dialog>
  </div>
</template>
