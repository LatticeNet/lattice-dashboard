<script setup lang="ts">
/**
 * Geo-Routing (design 23, section 4.4): one DNS apex answered by the nearest
 * healthy node, rendered as a CoreDNS zone.
 *
 * While nothing real exists (no routing, or only the demo) the page leads
 * with a checklist read from live state: answering nodes online with a
 * public IP, coordinates on them, a node that runs Lattice's CoreDNS to load
 * the zone, and, honestly, that the GeoLite2 file on that node cannot be
 * checked. The demo row reads "preview, reaches no node", never a green
 * "configured" beside "last applied: never". A row opens the routing in the
 * sheet on `?open=`; Preview config, Edit and Delete sit in one row menu.
 */
import { computed, reactive, ref } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import { useNow } from "@vueuse/core";
import {
  AlertTriangle,
  FileCode2,
  Globe,
  Pencil,
  Plus,
  RefreshCw,
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
import { isDemoObject } from "@/lib/demo";
import { useAsyncData } from "@/composables/useAsyncData";
import { useAuthStore } from "@/stores/auth";
import { formatAge, shortId } from "@/lib/format";
import { cn } from "@/lib/utils";

import { useProof } from "@/composables/useProof";
import { useRouteOpen } from "@/composables/useRouteOpen";
import { provideNodeDirectory } from "@/composables/useNodeDirectory";
import { describeNodeStatus } from "@/lib/nodeStatus";
import { proofReason } from "@/components/common/proofModel";
import { isObservedEngine } from "./dnsExternalModel";
import PageHeader from "@/components/common/PageHeader.vue";
import ProofLine, { type ProofSegment } from "@/components/common/ProofLine.vue";
import AttentionList, { type AttentionItem } from "@/components/common/AttentionList.vue";
import DataState from "@/components/common/DataState.vue";
import DataTable, { type DataTableColumn } from "@/components/common/DataTable.vue";
import NodeLabel from "@/components/common/NodeLabel.vue";
import ObjectSheet from "@/components/common/ObjectSheet.vue";
import RowMenu, { type RowMenuItem } from "@/components/common/RowMenu.vue";
import SetupChecklist, { type SetupItem } from "@/components/networking/SetupChecklist.vue";
import ConfirmDialog from "@/components/common/ConfirmDialog.vue";
import CopyButton from "@/components/common/CopyButton.vue";
import { Button } from "@/components/ui/button";
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

const { t, locale } = useI18n();
const auth = useAuthStore();
const canRead = computed(() => auth.can("geo:read"));
const canAdmin = computed(() => auth.can("geo:admin"));
const canReadNodes = computed(() => auth.can("node:read"));

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

const nodes = computed(() => nodesQuery.data.value ?? []);

const sortedRoutes = computed(() =>
  [...routes.value].sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id)),
);

function nodeName(id: string): string {
  return nodes.value.find((node) => node.id === id)?.name || id;
}

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
/* ------------------------------------------------------------------ */
/* Head, attention, setup checklist, sheet (design 23, section 4.4)    */
/* ------------------------------------------------------------------ */

provideNodeDirectory(computed(() => nodesQuery.data.value));
const proof = useProof(routesQuery);
const sheet = useRouteOpen();
const now = useNow({ interval: 60_000 });

/** Self-host DNS, to say whether a routing's DNS node can serve its zone. Needs dns:admin. */
const canReadDns = computed(() => auth.can("dns:admin"));
const dnsQuery = useAsyncData(
  (signal) => api.dns.deployments({ signal }).then((r) => unwrap(r, "deployments")),
  { pollInterval: 60_000, immediate: canReadDns.value },
);

/** Nodes that run a CoreDNS Lattice deployed (the only engine that can load a rendered zone). */
const dnsNodeIds = computed<Set<string> | null>(() => {
  if (!canReadDns.value || dnsQuery.data.value === undefined) return null;
  return new Set(dnsQuery.data.value.filter((dep) => !isObservedEngine(dep.engine)).map((dep) => dep.node_id));
});

const realRoutes = computed(() => routes.value.filter((route) => !isDemoObject(route.name)));
const demoRoutes = computed(() => routes.value.filter((route) => isDemoObject(route.name)));

type RouteState = "demo" | "failed" | "applied" | "unapplied";

function routeState(route: GeoRouting): RouteState {
  if (isDemoObject(route.name)) return "demo";
  if (route.last_error) return "failed";
  return hasRealTime(route.last_applied_at) ? "applied" : "unapplied";
}

const STATE_TONE: Record<RouteState, string> = {
  demo: "text-muted-foreground",
  failed: "text-destructive",
  applied: "text-muted-foreground",
  unapplied: "text-muted-foreground",
};

function stateText(route: GeoRouting): string {
  const state = routeState(route);
  if (state === "applied") {
    const ms = Date.parse(route.last_applied_at!);
    return t("networking.geoPage.state.appliedAgo", { age: formatAge(now.value.getTime() - ms, locale.value) });
  }
  return t(`networking.geoPage.state.${state}`);
}

const proofSegments = computed<ProofSegment[]>(() => {
  const n = realRoutes.value.length;
  const parts: ProofSegment[] = [{ key: "routings", text: t("networking.geoPage.proof.routings", { n }, n) }];
  if (demoRoutes.value.length) parts.push({ key: "demo", text: t("networking.geoPage.proof.demo", { n: demoRoutes.value.length }, demoRoutes.value.length), tone: "muted" });
  const failed = realRoutes.value.filter((route) => route.last_error).length;
  const applied = realRoutes.value.filter((route) => routeState(route) === "applied").length;
  if (applied) parts.push({ key: "applied", text: t("networking.geoPage.proof.applied", { n: applied }) });
  if (failed) parts.push({ key: "failed", text: t("networking.geoPage.proof.failed", { n: failed }), tone: "destructive" });
  return parts;
});

function refreshAll(): void {
  if (canRead.value) void routesQuery.refresh();
  if (canReadNodes.value) void nodesQuery.refresh();
  if (canReadDns.value) void dnsQuery.refresh();
}

/** DNS nodes of a routing that run no Lattice CoreDNS, or null when Self-host DNS was not read. */
function dnsNodesWithoutDns(route: GeoRouting): string[] | null {
  const ids = dnsNodeIds.value;
  if (!ids) return null;
  return (route.dns_node_ids ?? []).filter((id) => !ids.has(id));
}

const attention = computed<AttentionItem[]>(() => {
  const items: AttentionItem[] = [];
  for (const route of sortedRoutes.value) {
    if (isDemoObject(route.name)) continue;
    const open = { label: t("networking.geoPage.attention.open"), run: () => sheet.open(route.id) };
    if (route.last_error) {
      items.push({
        key: `failed:${route.id}`,
        tone: "danger",
        claim: t("networking.geoPage.attention.failedClaim", { hostname: route.hostname }),
        proof: route.last_error.split("\n")[0],
        action: open,
      });
    }
    const missing = dnsNodesWithoutDns(route);
    if (missing && missing.length) {
      items.push({
        key: `nodns:${route.id}`,
        tone: "warning",
        claim: t("networking.geoPage.attention.noDnsClaim", { hostname: route.hostname }),
        proof: t("networking.geoPage.attention.noDnsProof", { nodes: missing.map(nodeName).join(", ") }, missing.length),
        action: { label: t("networking.geoPage.setup.dnsAction"), to: { name: "network-dns" } },
      });
    }
  }
  return items;
});

/** The checklist stands while nothing real exists: empty, or only the demo. */
const showSetup = computed(() => routesQuery.data.value !== undefined && realRoutes.value.length === 0);

const setupItems = computed<SetupItem[]>(() => {
  const nodesRead = canReadNodes.value && nodesQuery.data.value !== undefined;
  const answering = nodes.value.filter((node) => describeNodeStatus(node).reporting && !!node.public_ip).length;
  const located = nodes.value.filter((node) => Number.isFinite(node.geo?.lat) && Number.isFinite(node.geo?.lon)).length;
  const dnsIds = dnsNodeIds.value;
  const notRead = (error: unknown) => (error ? t("networking.setup.notRead", { reason: proofReason(error) }) : undefined);
  return [
    {
      key: "answer",
      label: t("networking.geoPage.setup.answer"),
      ready: nodesRead ? answering > 0 : null,
      detail: nodesRead ? t("networking.geoPage.setup.answerDetail", { n: answering, total: nodes.value.length }) : canReadNodes.value ? notRead(nodesQuery.error.value) : t("networking.geoPage.setup.nodesScope"),
    },
    {
      key: "geo",
      label: t("networking.geoPage.setup.coordinates"),
      ready: nodesRead ? located > 0 : null,
      detail: nodesRead ? t("networking.geoPage.setup.coordinatesDetail", { n: located, total: nodes.value.length }) : undefined,
    },
    {
      key: "dns",
      label: t("networking.geoPage.setup.dns"),
      ready: dnsIds ? dnsIds.size > 0 : null,
      detail: dnsIds
        ? dnsIds.size > 0
          ? t("networking.geoPage.setup.dnsDetail", { nodes: [...dnsIds].map(nodeName).join(", ") })
          : t("networking.geoPage.setup.dnsNone")
        : canReadDns.value
          ? notRead(dnsQuery.error.value)
          : t("networking.geoPage.setup.dnsScope"),
      action: { label: t("networking.geoPage.setup.dnsAction"), to: { name: "network-dns" } },
    },
    {
      key: "mmdb",
      label: t("networking.geoPage.setup.database"),
      ready: null,
      detail: t("networking.geoPage.setup.databaseDetail"),
    },
  ];
});

const columns = computed<DataTableColumn<GeoRouting>[]>(() => [
  { key: "name", label: t("networking.geoRouting.colName"), sortable: true, searchable: true, value: (route) => route.name || route.id },
  { key: "hostname", label: t("networking.geoRouting.colHostname"), sortable: true, searchable: true },
  { key: "strategy", label: t("networking.geoRouting.colStrategy"), sortable: true },
  { key: "nodes", label: t("networking.geoRouting.colNodes"), align: "right", sortable: true, value: (route) => route.node_ids?.length ?? 0 },
  { key: "dns", label: t("networking.geoPage.colDnsNode"), searchable: true, value: (route) => (route.dns_node_ids ?? []).map(nodeName).join(" ") },
  { key: "status", label: t("networking.geoRouting.colStatus"), sortable: true, value: (route) => routeState(route) },
  { key: "actions", label: "", class: "w-12", pin: "end" },
]);

const openRoute = computed(() => routes.value.find((route) => route.id === sheet.openId.value));
const sheetState = computed(() => {
  if (!sheet.openId.value) return "ready" as const;
  if (openRoute.value) return routesQuery.error.value ? ("stale" as const) : ("ready" as const);
  if (routesQuery.data.value === undefined) return routesQuery.error.value ? ("gone" as const) : ("loading" as const);
  return "gone" as const;
});

function menuFor(route: GeoRouting): RowMenuItem[] {
  return [
    { key: "preview", label: t("networking.geoRouting.previewConfig"), icon: FileCode2, hidden: !canRead.value, disabled: planning.value === route.id, run: () => void openPlan(route) },
    { key: "edit", label: t("common.actions.edit"), icon: Pencil, hidden: !canAdmin.value, run: () => openEdit(route) },
    { key: "delete", label: t("common.actions.delete"), icon: Trash2, danger: true, hidden: !canAdmin.value, run: () => (deleteTarget.value = route) },
  ];
}

/**
 * Two destructive classes (design 23, section 3.8). A routing that was never
 * applied lives only on this server: deleting it is irreversible inside
 * Lattice. One that was applied left its zone in the CoreDNS on its DNS
 * nodes, and the server's delete removes only the record, so those nodes
 * keep answering the hostname: that is the class that leaves config on a
 * node, which names each node, says what keeps answering, and asks for the
 * typed name.
 */
const deleteApplied = computed(() => !!deleteTarget.value && routeState(deleteTarget.value) !== "demo" && hasRealTime(deleteTarget.value.last_applied_at));
const deleteImpact = computed(() => {
  const route = deleteTarget.value;
  if (!route) return [];
  if (!deleteApplied.value) {
    return [t("networking.geoPage.delete.impactRecord", { hostname: route.hostname }), t("networking.geoPage.delete.impactNodes")];
  }
  const ms = Date.parse(route.last_applied_at ?? "");
  const applied = Number.isFinite(ms) ? formatAge(now.value.getTime() - ms, locale.value) : "";
  const dnsNodes = route.dns_node_ids ?? [];
  const lines = dnsNodes.length
    ? dnsNodes.map((id) => t("networking.geoPage.delete.impactAnswering", { node: nodeName(id), hostname: route.hostname, age: applied }))
    : [t("networking.geoPage.delete.impactAnsweringUnknown", { hostname: route.hostname, age: applied })];
  lines.push(t("networking.geoPage.delete.impactNoRemoval"));
  return lines;
});
</script>

<template>
  <div class="space-y-5 p-4 sm:p-6">
    <PageHeader :title="$t('networking.geoRouting.title')">
      <template #description>
        <p class="text-sm text-muted-foreground">{{ $t('networking.geoRouting.description') }}</p>
        <ProofLine v-if="canRead" v-bind="proof" :segments="proofSegments" @retry="refreshAll" />
      </template>
      <template #actions>
        <Button v-if="canRead" variant="outline" size="sm" :disabled="routesQuery.refreshing.value" @click="refreshAll">
          <RefreshCw :class="cn('size-4', routesQuery.refreshing.value && 'animate-spin')" aria-hidden="true" />
          {{ $t('common.actions.refresh') }}
        </Button>
        <Button v-if="canAdmin && !showSetup && routesQuery.data.value !== undefined" size="sm" @click="openCreate">
          <Plus class="size-4" aria-hidden="true" />
          {{ $t('networking.geoRouting.newRouting') }}
        </Button>
      </template>
    </PageHeader>

    <AttentionList :items="attention" />

    <SetupChecklist
      v-if="showSetup"
      :title="routes.length ? $t('networking.geoPage.setupTitleDemo') : $t('networking.geoRouting.emptyTitle')"
      :description="routes.length ? $t('networking.geoPage.demoNote', { name: demoRoutes[0]?.name ?? '' }) : $t('networking.geoPage.emptyDescription')"
      :items="setupItems"
    >
      <Button v-if="canAdmin" size="sm" variant="outline" type="button" @click="openCreate">
        <Plus aria-hidden="true" />
        {{ $t('networking.geoRouting.newRouting') }}
      </Button>
    </SetupChecklist>

    <DataTable
      v-if="!(showSetup && routes.length === 0)"
      state-key="geoRoutings"
      :columns="columns"
      :rows="sortedRoutes"
      :row-key="(route) => route.id"
      :loading="routesQuery.loading.value"
      :error="routesQuery.error.value"
      :has-data="routesQuery.data.value !== undefined"
      :searchable="realRoutes.length > 0"
      :expression-filter="false"
      :search-placeholder="$t('networking.geoPage.searchPlaceholder')"
      :row-click="(route, el) => sheet.open(route.id, el)"
      :active-row-id="sheet.openId.value"
      :show-summary="false"
      :empty-title="canRead ? $t('networking.geoRouting.emptyTitle') : $t('networking.geoPage.needRead')"
      :empty-description="canRead ? $t('networking.geoPage.emptyDescription') : ''"
      :no-match-title="$t('networking.shared.noMatchTitle')"
      :no-match-description="$t('networking.shared.noMatchDescription')"
      @retry="refreshAll"
    >
      <template #cell-name="{ row: route }">
        <div class="flex items-center gap-1.5">
          <span class="font-medium">{{ route.name || route.id }}</span>
          <Badge v-if="isDemoObject(route.name)" variant="outline">{{ $t('networking.geoRouting.demo.badge') }}</Badge>
        </div>
      </template>
      <template #cell-hostname="{ row: route }">
        <span class="whitespace-nowrap font-mono text-xs">{{ route.hostname }}</span>
      </template>
      <template #cell-strategy="{ row: route }">
        <span class="whitespace-nowrap text-xs">{{ route.strategy }}</span>
      </template>
      <template #cell-nodes="{ row: route }">
        <span class="font-mono text-xs tabular-nums">{{ route.node_ids?.length ?? 0 }}</span>
      </template>
      <template #cell-dns="{ row: route }">
        <div class="flex flex-col text-xs">
          <NodeLabel v-for="id in route.dns_node_ids ?? []" :key="id" :id="id" />
        </div>
      </template>
      <template #cell-status="{ row: route }">
        <span :class="cn('whitespace-nowrap text-xs', STATE_TONE[routeState(route)])">{{ stateText(route) }}</span>
      </template>
      <template #cell-actions="{ row: route }">
        <RowMenu :name="route.name || route.id" :items="menuFor(route)" />
      </template>
    </DataTable>

    <ObjectSheet
      :open="!!sheet.openId.value"
      :title="openRoute ? (openRoute.name || openRoute.id) : (sheet.openId.value ?? '')"
      :subtitle="openRoute?.hostname"
      :state="sheetState"
      :error="routesQuery.error.value ? proofReason(routesQuery.error.value) : null"
      :read-only="!canAdmin"
      :return-focus="sheet.returnFocus"
      :gone-title="$t('networking.geoPage.goneTitle')"
      :gone-description="$t('networking.geoPage.goneDescription')"
      @close="sheet.close"
    >
      <div v-if="openRoute" class="space-y-5 text-sm">
        <p v-if="isDemoObject(openRoute.name)" class="text-muted-foreground">{{ $t('networking.geoPage.sheet.demo') }}</p>
        <p :class="STATE_TONE[routeState(openRoute)]">{{ stateText(openRoute) }}</p>
        <pre
          v-if="openRoute.last_error"
          class="whitespace-pre-wrap break-words rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 font-mono text-xs text-foreground"
        >{{ openRoute.last_error }}</pre>
        <dl class="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
          <div>
            <dt class="text-xs text-muted-foreground">{{ $t('networking.geoRouting.colStrategy') }}</dt>
            <dd>{{ openRoute.strategy }} <span class="text-muted-foreground">· TTL {{ openRoute.ttl ?? 60 }}s</span></dd>
          </div>
          <div class="min-w-0">
            <dt class="text-xs text-muted-foreground">{{ $t('networking.geoPage.sheet.database') }}</dt>
            <dd class="break-all font-mono text-xs">{{ openRoute.geoip_db_path || '/etc/coredns/GeoLite2-City.mmdb' }}</dd>
          </div>
          <div v-if="openRoute.last_rendered_sha" class="min-w-0">
            <dt class="text-xs text-muted-foreground">{{ $t('networking.geoPage.sheet.rendered') }}</dt>
            <dd class="font-mono text-xs">{{ shortId(openRoute.last_rendered_sha, 12) }}</dd>
          </div>
          <div>
            <dt class="text-xs text-muted-foreground">{{ $t('networking.geoPage.sheet.delegation') }}</dt>
            <dd>{{ openRoute.publish_ns ? $t('networking.geoPage.sheet.delegationOn') : $t('networking.geoPage.sheet.delegationOff') }}</dd>
          </div>
        </dl>
        <section class="space-y-1.5">
          <h3 class="text-xs font-medium text-muted-foreground">{{ $t('networking.geoPage.sheet.answering', { n: openRoute.node_ids?.length ?? 0 }) }}</h3>
          <ul class="divide-y divide-border rounded-md border border-border">
            <li v-for="id in openRoute.node_ids ?? []" :key="id" class="px-3 py-2 text-xs"><NodeLabel :id="id" link /></li>
          </ul>
        </section>
        <section class="space-y-1.5">
          <h3 class="text-xs font-medium text-muted-foreground">{{ $t('networking.geoPage.sheet.serving', { n: openRoute.dns_node_ids?.length ?? 0 }) }}</h3>
          <ul class="divide-y divide-border rounded-md border border-border">
            <li v-for="id in openRoute.dns_node_ids ?? []" :key="id" class="flex flex-wrap items-center gap-x-2 px-3 py-2 text-xs">
              <NodeLabel :id="id" link />
              <span v-if="dnsNodeIds && !dnsNodeIds.has(id)" class="text-warning-text">{{ $t('networking.geoPage.sheet.noDns') }}</span>
              <span v-else-if="dnsNodeIds" class="text-muted-foreground">{{ $t('networking.geoPage.sheet.runsDns') }}</span>
            </li>
          </ul>
        </section>
      </div>
      <template v-if="openRoute" #actions>
        <Button variant="outline" size="sm" type="button" :disabled="planning === openRoute.id" @click="openPlan(openRoute)">
          <RefreshCw v-if="planning === openRoute.id" class="animate-spin" aria-hidden="true" />
          <FileCode2 v-else aria-hidden="true" />
          {{ $t('networking.geoRouting.previewConfig') }}
        </Button>
        <Button variant="outline" size="sm" type="button" @click="openEdit(openRoute)">
          <Pencil aria-hidden="true" />
          {{ $t('common.actions.edit') }}
        </Button>
        <RowMenu :name="openRoute.name || openRoute.id" :items="menuFor(openRoute).filter((item) => item.key === 'delete')" />
      </template>
    </ObjectSheet>

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
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div class="grid gap-2">
              <Label for="geo-name">{{ $t('networking.geoRouting.name') }}</Label>
              <Input id="geo-name" v-model="form.name" required placeholder="apex-edge" />
            </div>
            <div class="grid gap-2">
              <Label for="geo-hostname">{{ $t('networking.geoRouting.hostname') }}</Label>
              <Input id="geo-hostname" v-model="form.hostname" required placeholder="app.example.com" />
            </div>
          </div>

          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
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
              <div class="grid max-h-48 gap-1 relative overflow-auto rounded-md border border-border p-2">
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
              <div class="grid max-h-48 gap-1 relative overflow-auto rounded-md border border-border p-2">
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

          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
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

    <!-- Delete: irreversible inside Lattice for a routing never applied; one that was applied leaves its zone on the DNS nodes (design 23, 3.8). -->
    <ConfirmDialog
      :open="!!deleteTarget"
      :title="$t('networking.geoPage.delete.title', { name: deleteTarget?.name || deleteTarget?.id || '' })"
      :description="deleteApplied ? $t('networking.geoPage.delete.descriptionApplied') : undefined"
      :impact="deleteImpact"
      :impact-title="deleteApplied ? $t('networking.geoPage.delete.impactTitleApplied') : $t('networking.geoPage.delete.impactTitle')"
      :typed-confirm="deleteApplied ? deleteTarget?.name || deleteTarget?.id : undefined"
      :confirm-label="deleteApplied ? $t('networking.geoPage.delete.confirmApplied') : $t('common.actions.delete')"
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
            <pre class="max-h-[420px] relative overflow-auto whitespace-pre-wrap p-4 font-mono text-xs leading-relaxed">{{ plan.config }}</pre>
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
            <div class="relative overflow-x-auto rounded-md border border-border">
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
