<script setup lang="ts">
import { computed, reactive, ref } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import {
  Boxes,
  FileCode2,
  Network,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Shield,
  ShieldCheck,
  Trash2,
} from "lucide-vue-next";
import {
  api,
  unwrap,
  type ApprovalView,
  type GuardRule,
  type GuardZone,
  type NodeGuardView,
  type NFTInputsUpsertBody,
  type NFTInputsView,
  type SecurityGroupView,
} from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { usePlanDigest } from "@/composables/usePlanDigest";
import { useAuthStore } from "@/stores/auth";
import { formatDateTime, shortId } from "@/lib/format";
import { cn } from "@/lib/utils";

import PageHeader from "@/components/common/PageHeader.vue";
import FreshnessLabel from "@/components/common/FreshnessLabel.vue";
import ConfirmDialog from "@/components/common/ConfirmDialog.vue";
import PlanReviewDialog from "@/components/common/PlanReviewDialog.vue";
import DataTable, { type DataTableColumn } from "@/components/common/DataTable.vue";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogScrollContent,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const { t } = useI18n();
const auth = useAuthStore();
const canPlan = computed(() => auth.can("network:plan"));
const canNetGuardRead = computed(() => auth.can("netguard:read"));
const canNetGuardAdmin = computed(() => auth.can("netguard:admin"));

const inputsQuery = useAsyncData(() => api.nft.inputs().then((r) => unwrap(r, "inputs")), {
  pollInterval: 15000,
});
const guardGroupsQuery = useAsyncData(() => api.netguard.groups().then((r) => unwrap(r, "groups")), {
  immediate: canNetGuardRead.value,
  pollInterval: 15000,
});
const guardZonesQuery = useAsyncData(() => api.netguard.zones().then((r) => unwrap(r, "zones")), {
  immediate: canNetGuardRead.value,
  pollInterval: 15000,
});
const guardNodesQuery = useAsyncData(() => api.netguard.nodes().then((r) => unwrap(r, "nodes")), {
  immediate: canNetGuardRead.value,
  pollInterval: 15000,
});
const nodesQuery = useAsyncData(() => api.nodes.list().then((r) => unwrap(r, "nodes")), {
  pollInterval: 0,
});

const rows = computed(() => inputsQuery.data.value ?? []);
const nodes = computed(() => nodesQuery.data.value ?? []);
const guardGroups = computed(() => guardGroupsQuery.data.value ?? []);
const guardZones = computed(() => guardZonesQuery.data.value ?? []);
const guardNodes = computed(() => guardNodesQuery.data.value ?? []);

const sortedRows = computed(() =>
  [...rows.value].sort((a, b) =>
    (a.node_name || a.node_id).localeCompare(b.node_name || b.node_id),
  ),
);

function nodeLabel(row: NFTInputsView): string {
  return row.node_name || row.node_id;
}

function nodeGuardLabel(row: NodeGuardView): string {
  return row.node_name || row.node_id;
}

const managedBindings = computed(() => guardNodes.value.filter((node) => node.binding?.managed).length);
const legacyBindings = computed(() => guardNodes.value.filter((node) => node.source === "legacy" || !node.binding?.managed).length);
const totalGuardRules = computed(() =>
  guardGroups.value.reduce((sum, group) => sum + (group.rules?.length ?? 0), 0),
);
const trustedZoneRefs = computed(() =>
  guardNodes.value.reduce((sum, node) => sum + (node.binding?.zone_ids?.length ?? 0), 0),
);
function rangeLabel(range: { from: number; to: number }): string {
  return range.from === range.to ? String(range.from) : `${range.from}-${range.to}`;
}

function rulePorts(rule: GuardRule): string {
  const ranges = rule.ports ?? [];
  if (ranges.length === 0) return "all";
  return ranges.map(rangeLabel).join(", ");
}

function remoteLabel(rule: GuardRule): string {
  const remote = rule.remote ?? { kind: "any" };
  switch (remote.kind) {
    case "zone":
      return `zone:${remote.zone_id || "any"}`;
    case "cidr":
      return remote.cidr || "cidr";
    case "node":
      return `node:${shortId(remote.node_id || "", 12)}`;
    case "group":
      return `group:${shortId(remote.group_id || "", 12)}`;
    case "domain":
      return remote.domain || "domain";
    default:
      return remote.kind || "any";
  }
}

function zoneSurface(zone: GuardZone): string {
  const parts = [...(zone.interfaces ?? []), ...(zone.cidrs ?? [])];
  return parts.length ? parts.join(", ") : t("networking.guard.resolvedPerNode");
}

function sourceVariant(source?: string): "outline" | "secondary" | "warning" {
  return source === "legacy" ? "warning" : source === "stored" ? "secondary" : "outline";
}

async function refreshAll() {
  await Promise.all([
    inputsQuery.refresh(),
    canNetGuardRead.value ? guardGroupsQuery.refresh() : Promise.resolve(),
    canNetGuardRead.value ? guardZonesQuery.refresh() : Promise.resolve(),
    canNetGuardRead.value ? guardNodesQuery.refresh() : Promise.resolve(),
  ]);
}

const columns = computed<DataTableColumn<NFTInputsView>[]>(() => [
  {
    key: "node",
    label: t("networking.guard.colNode"),
    sortable: true,
    searchable: true,
    value: (row) => nodeLabel(row),
  },
  { key: "interface_name", label: t("networking.guard.colInterface"), sortable: true },
  { key: "wireguard_cidr", label: t("networking.guard.colWireguardCidr") },
  { key: "public_ports", label: t("networking.guard.colPublicPorts") },
  { key: "wireguard_ports", label: t("networking.guard.colWireguardPorts") },
  {
    key: "updated_at",
    label: t("networking.guard.colUpdated"),
    sortable: true,
    align: "right",
  },
  { key: "actions", label: t("networking.guard.colActions"), align: "right" },
]);

// ── Create / edit dialog state ────────────────────────────────────────────
interface GuardForm {
  node_id: string;
  interface_name: string;
  wireguard_cidr: string;
  public_tcp: string;
  public_udp: string;
  wireguard_tcp: string;
  wireguard_udp: string;
}

const dialogOpen = ref(false);
const editingId = ref<string | undefined>(undefined);
const saving = ref(false);
const form = reactive<GuardForm>(emptyForm());

function emptyForm(): GuardForm {
  return {
    node_id: "",
    interface_name: "eth0",
    wireguard_cidr: "10.66.0.0/24",
    public_tcp: "",
    public_udp: "",
    wireguard_tcp: "",
    wireguard_udp: "",
  };
}

function joinPorts(ports?: number[]): string {
  return (ports ?? []).join(", ");
}

/** Parse a comma-separated port list into a sorted, deduped number[]. */
function parsePorts(input: string): number[] {
  const set = new Set<number>();
  for (const piece of input.split(",")) {
    const trimmed = piece.trim();
    if (!trimmed) continue;
    const value = Number(trimmed);
    if (Number.isInteger(value) && value >= 1 && value <= 65535) set.add(value);
  }
  return [...set].sort((a, b) => a - b);
}

/** Collect entries that are non-empty yet not a valid port (for inline feedback). */
function ignoredPorts(input: string): string[] {
  const out: string[] = [];
  for (const piece of input.split(",")) {
    const trimmed = piece.trim();
    if (!trimmed) continue;
    const value = Number(trimmed);
    if (!(Number.isInteger(value) && value >= 1 && value <= 65535)) out.push(trimmed);
  }
  return out;
}

const ignoredPublicTcp = computed(() => ignoredPorts(form.public_tcp));
const ignoredPublicUdp = computed(() => ignoredPorts(form.public_udp));
const ignoredWireguardTcp = computed(() => ignoredPorts(form.wireguard_tcp));
const ignoredWireguardUdp = computed(() => ignoredPorts(form.wireguard_udp));

function openCreate() {
  editingId.value = undefined;
  Object.assign(form, emptyForm());
  dialogOpen.value = true;
}

function openEdit(row: NFTInputsView) {
  editingId.value = row.node_id;
  Object.assign(form, {
    node_id: row.node_id,
    interface_name: row.interface_name || "eth0",
    wireguard_cidr: row.wireguard_cidr || "10.66.0.0/24",
    public_tcp: joinPorts(row.public_tcp),
    public_udp: joinPorts(row.public_udp),
    wireguard_tcp: joinPorts(row.wireguard_tcp),
    wireguard_udp: joinPorts(row.wireguard_udp),
  } satisfies GuardForm);
  dialogOpen.value = true;
}

function buildBody(): NFTInputsUpsertBody {
  return {
    node_id: form.node_id,
    interface_name: form.interface_name.trim() || "eth0",
    wireguard_cidr: form.wireguard_cidr.trim() || "10.66.0.0/24",
    public_tcp: parsePorts(form.public_tcp),
    public_udp: parsePorts(form.public_udp),
    wireguard_tcp: parsePorts(form.wireguard_tcp),
    wireguard_udp: parsePorts(form.wireguard_udp),
  };
}

const canSubmit = computed(() => !!form.node_id && canPlan.value);

async function submit() {
  if (!canSubmit.value) return;
  saving.value = true;
  try {
    await api.nft.upsertInputs(buildBody());
    toast.success(editingId.value ? t("networking.guard.toastUpdated") : t("networking.guard.toastCreated"));
    dialogOpen.value = false;
    inputsQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("networking.guard.toastSaveFailed"));
  } finally {
    saving.value = false;
  }
}

// ── Delete confirm ────────────────────────────────────────────────────────
const deleteTarget = ref<NFTInputsView | undefined>(undefined);
const deleting = ref(false);

function requestDelete(row: NFTInputsView) {
  deleteTarget.value = row;
}

async function confirmDelete() {
  if (!deleteTarget.value) return;
  deleting.value = true;
  try {
    await api.nft.deleteInputs(deleteTarget.value.node_id);
    toast.success(t("networking.guard.toastDeleted"));
    deleteTarget.value = undefined;
    inputsQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("networking.guard.toastDeleteFailed"));
  } finally {
    deleting.value = false;
  }
}

// ── Plan dialog ───────────────────────────────────────────────────────────
const planDigest = usePlanDigest();
const planning = ref<string | undefined>(undefined);
const netguardPlanning = ref<string | undefined>(undefined);
const adopting = ref<string | undefined>(undefined);
const planApproval = ref<ApprovalView | undefined>(undefined);
const planSha = ref("");

async function plan(row: NFTInputsView) {
  if (!canPlan.value) return;
  planning.value = row.node_id;
  try {
    const body: NFTInputsUpsertBody = {
      node_id: row.node_id,
      interface_name: row.interface_name,
      wireguard_cidr: row.wireguard_cidr,
      public_tcp: row.public_tcp ?? [],
      public_udp: row.public_udp ?? [],
      wireguard_tcp: row.wireguard_tcp ?? [],
      wireguard_udp: row.wireguard_udp ?? [],
    };
    const approval = await api.nft.plan(body);
    planApproval.value = approval;
    planSha.value = await planDigest.digestFor(approval);
    toast.success(t("networking.shared.toastPlanCreated"));
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("networking.shared.toastPlanFailed"));
  } finally {
    planning.value = undefined;
  }
}

async function adoptNetGuardNode(row: NodeGuardView) {
  if (!canNetGuardAdmin.value) return;
  adopting.value = row.node_id;
  try {
    await api.netguard.adopt(row.node_id);
    toast.success(t("networking.guard.toastAdopted"));
    await refreshAll();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("networking.guard.toastAdoptFailed"));
  } finally {
    adopting.value = undefined;
  }
}

async function planNetGuardNode(row: NodeGuardView) {
  if (!canNetGuardAdmin.value || !canPlan.value) return;
  netguardPlanning.value = row.node_id;
  try {
    const result = await api.netguard.plan(row.node_id);
    planApproval.value = result.approval;
    planSha.value = await planDigest.digestFor(result.approval);
    toast.success(t("networking.shared.toastPlanCreated"));
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("networking.shared.toastPlanFailed"));
  } finally {
    netguardPlanning.value = undefined;
  }
}

const planBadges = computed(() => {
  const a = planApproval.value;
  if (!a) return [];
  return [
    { label: a.status, variant: "warning" as const },
    { label: `${a.plugin} · ${a.action}`, variant: "outline" as const },
    { label: t("networking.shared.idLabel", { id: shortId(a.id, 12) }), variant: "secondary" as const },
  ];
});

function closePlan(open: boolean) {
  if (!open) {
    planApproval.value = undefined;
    planSha.value = "";
  }
}
</script>

<template>
  <div class="p-6 space-y-6">
    <PageHeader
      :title="$t('networking.guard.title')"
      :description="$t('networking.guard.description')"
    >
      <template #status>
        <Badge variant="outline">latticenet.netguard</Badge>
        <FreshnessLabel :last-updated="inputsQuery.lastUpdated.value" />
      </template>
      <template #actions>
        <Button
          variant="outline"
          size="sm"
          :disabled="inputsQuery.refreshing.value || guardNodesQuery.refreshing.value"
          @click="refreshAll"
        >
          <RefreshCw :class="cn('size-4', (inputsQuery.refreshing.value || guardNodesQuery.refreshing.value) && 'animate-spin')" aria-hidden="true" />
          {{ $t('common.actions.refresh') }}
        </Button>
        <Button
          v-if="canPlan"
          size="sm"
          @click="openCreate"
        >
          <Plus class="size-4" aria-hidden="true" />
          {{ $t('networking.guard.newInputs') }}
        </Button>
      </template>
    </PageHeader>

    <div class="grid gap-3 md:grid-cols-4">
      <Card>
        <CardContent class="space-y-2 p-4">
          <div class="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <FileCode2 class="size-4" aria-hidden="true" />
            {{ $t('networking.guard.statRenderer') }}
          </div>
          <div class="font-mono text-lg font-semibold">lattice_guard</div>
          <p class="text-xs text-muted-foreground">{{ $t('networking.guard.statRendererHint') }}</p>
        </CardContent>
      </Card>
      <Card>
        <CardContent class="space-y-2 p-4">
          <div class="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <Network class="size-4" aria-hidden="true" />
            {{ $t('networking.guard.statZones') }}
          </div>
          <div class="text-lg font-semibold tabular-nums">{{ guardZones.length }}</div>
          <p class="text-xs text-muted-foreground">{{ $t('networking.guard.statTrustedZones', { count: trustedZoneRefs }) }}</p>
        </CardContent>
      </Card>
      <Card>
        <CardContent class="space-y-2 p-4">
          <div class="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <Boxes class="size-4" aria-hidden="true" />
            {{ $t('networking.guard.statGroups') }}
          </div>
          <div class="text-lg font-semibold tabular-nums">{{ guardGroups.length }}</div>
          <p class="text-xs text-muted-foreground">{{ $t('networking.guard.statRules', { count: totalGuardRules }) }}</p>
        </CardContent>
      </Card>
      <Card>
        <CardContent class="space-y-2 p-4">
          <div class="flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            <ShieldCheck class="size-4" aria-hidden="true" />
            {{ $t('networking.guard.statBindings') }}
          </div>
          <div class="text-lg font-semibold tabular-nums">{{ managedBindings }} / {{ guardNodes.length }}</div>
          <p class="text-xs text-muted-foreground">{{ $t('networking.guard.statLegacy', { count: legacyBindings }) }}</p>
        </CardContent>
      </Card>
    </div>

    <Card class="border-sidebar-primary/20 bg-sidebar-primary/[0.025]">
      <CardHeader>
        <CardTitle class="flex items-center gap-2">
          <ShieldCheck class="size-4 text-sidebar-primary" aria-hidden="true" />
          {{ $t('networking.guard.modelTitle') }}
        </CardTitle>
        <CardDescription>
          {{ $t('networking.guard.modelDescription') }}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div v-if="!canNetGuardRead" class="rounded-md border border-warning/35 bg-warning/5 p-3 text-sm text-muted-foreground">
          {{ $t('networking.guard.modelNoScope') }}
        </div>
        <div v-else-if="guardGroupsQuery.error.value || guardZonesQuery.error.value || guardNodesQuery.error.value" class="rounded-md border border-warning/35 bg-warning/5 p-3 text-sm text-muted-foreground">
          {{ $t('networking.guard.modelUnavailable') }}
        </div>
        <div v-else class="grid gap-4 lg:grid-cols-3">
          <section class="space-y-3">
            <div class="flex items-center justify-between gap-2">
              <h2 class="text-sm font-medium">{{ $t('networking.guard.zonesTitle') }}</h2>
              <Badge variant="outline">{{ guardZones.length }}</Badge>
            </div>
            <div class="space-y-2">
              <div
                v-for="zone in guardZones.slice(0, 5)"
                :key="zone.id"
                class="rounded-md border border-border bg-background/55 p-3"
              >
                <div class="flex items-center gap-2">
                  <span class="font-mono text-sm font-medium">{{ zone.name || zone.id }}</span>
                  <Badge v-if="zone.builtin" variant="secondary">{{ $t('networking.guard.builtin') }}</Badge>
                </div>
                <p class="mt-1 font-mono text-xs text-muted-foreground">{{ zoneSurface(zone) }}</p>
              </div>
              <p v-if="!guardZones.length" class="text-sm text-muted-foreground">{{ $t('networking.guard.noZones') }}</p>
            </div>
          </section>

          <section class="space-y-3">
            <div class="flex items-center justify-between gap-2">
              <h2 class="text-sm font-medium">{{ $t('networking.guard.groupsTitle') }}</h2>
              <Badge variant="outline">{{ totalGuardRules }}</Badge>
            </div>
            <div class="space-y-2">
              <div
                v-for="group in guardGroups.slice(0, 5)"
                :key="group.id"
                class="rounded-md border border-border bg-background/55 p-3"
              >
                <div class="flex items-start justify-between gap-2">
                  <div class="min-w-0">
                    <p class="truncate text-sm font-medium">{{ group.name || group.id }}</p>
                    <p class="truncate font-mono text-xs text-muted-foreground">{{ group.id }}</p>
                  </div>
                  <Badge :variant="sourceVariant(group.source)">{{ group.source }}</Badge>
                </div>
                <div class="mt-2 space-y-1">
                  <div
                    v-for="rule in (group.rules ?? []).slice(0, 2)"
                    :key="rule.id"
                    class="flex flex-wrap items-center gap-1 text-xs text-muted-foreground"
                  >
                    <Badge :variant="rule.action === 'deny' ? 'destructive' : 'success'">{{ rule.action }}</Badge>
                    <span class="font-mono">{{ rule.protocol }}</span>
                    <span class="font-mono">{{ rulePorts(rule) }}</span>
                    <span>{{ remoteLabel(rule) }}</span>
                  </div>
                  <p v-if="(group.rules?.length ?? 0) > 2" class="text-xs text-muted-foreground">
                    {{ $t('networking.guard.moreRules', { count: (group.rules?.length ?? 0) - 2 }) }}
                  </p>
                </div>
              </div>
              <p v-if="!guardGroups.length" class="text-sm text-muted-foreground">{{ $t('networking.guard.noGroups') }}</p>
            </div>
          </section>

          <section class="space-y-3">
            <div class="flex items-center justify-between gap-2">
              <h2 class="text-sm font-medium">{{ $t('networking.guard.bindingsTitle') }}</h2>
              <Badge variant="outline">{{ managedBindings }} {{ $t('networking.guard.managedShort') }}</Badge>
            </div>
            <div class="space-y-2">
              <div
                v-for="node in guardNodes.slice(0, 5)"
                :key="node.node_id"
                class="rounded-md border border-border bg-background/55 p-3"
              >
                <div class="flex items-start justify-between gap-2">
                  <div class="min-w-0">
                    <p class="truncate text-sm font-medium">{{ nodeGuardLabel(node) }}</p>
                    <p class="truncate font-mono text-xs text-muted-foreground">{{ shortId(node.node_id, 16) }}</p>
                  </div>
                  <Badge :variant="node.binding?.managed ? 'success' : 'warning'">
                    {{ node.binding?.managed ? $t('networking.guard.managed') : $t('networking.guard.observeOnly') }}
                  </Badge>
                </div>
                <div class="mt-2 flex flex-wrap gap-1">
                  <Badge v-for="group in node.groups" :key="group.id" variant="outline">{{ group.name || group.id }}</Badge>
                  <Badge v-for="zone in node.zones" :key="zone.id" variant="secondary">{{ zone.name || zone.id }}</Badge>
                </div>
                <div v-if="canNetGuardAdmin || canPlan" class="mt-3 flex justify-end gap-1">
                  <Button
                    v-if="canNetGuardAdmin && !node.binding?.managed"
                    variant="outline"
                    size="sm"
                    :disabled="adopting === node.node_id"
                    @click="adoptNetGuardNode(node)"
                  >
                    <RefreshCw v-if="adopting === node.node_id" class="size-4 animate-spin" aria-hidden="true" />
                    <ShieldCheck v-else class="size-4" aria-hidden="true" />
                    {{ $t('networking.guard.adopt') }}
                  </Button>
                  <Button
                    v-if="canNetGuardAdmin && canPlan && node.binding?.managed"
                    variant="outline"
                    size="sm"
                    :disabled="netguardPlanning === node.node_id"
                    @click="planNetGuardNode(node)"
                  >
                    <RefreshCw v-if="netguardPlanning === node.node_id" class="size-4 animate-spin" aria-hidden="true" />
                    <Play v-else class="size-4" aria-hidden="true" />
                    {{ $t('networking.guard.planNetGuard') }}
                  </Button>
                </div>
              </div>
              <p v-if="!guardNodes.length" class="text-sm text-muted-foreground">{{ $t('networking.guard.noBindings') }}</p>
            </div>
          </section>
        </div>
      </CardContent>
    </Card>

    <Card>
      <CardHeader>
        <CardTitle class="flex items-center gap-2">
          <Shield class="size-4 text-muted-foreground" aria-hidden="true" />
          {{ $t('networking.guard.cardTitle') }}
        </CardTitle>
        <CardDescription>
          {{ $t('networking.guard.cardDescription') }}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <DataTable
          :columns="columns"
          :rows="sortedRows"
          :row-key="(row) => row.node_id"
          :loading="inputsQuery.loading.value"
          :error="inputsQuery.error.value"
          searchable
          :search-placeholder="$t('common.actions.search')"
          :empty-title="$t('networking.guard.emptyTitle')"
          :empty-description="$t('networking.guard.emptyDescription')"
          :no-match-title="$t('networking.shared.noMatchTitle')"
          :no-match-description="$t('networking.shared.noMatchDescription')"
          :actions-label="$t('networking.guard.colActions')"
          @retry="inputsQuery.refresh"
        >
          <template #cell-node="{ row }">
            <div class="font-medium">{{ nodeLabel(row) }}</div>
            <div class="font-mono text-xs text-muted-foreground">{{ shortId(row.node_id, 16) }}</div>
          </template>

          <template #cell-interface_name="{ row }">
            <span class="font-mono text-xs">{{ row.interface_name }}</span>
          </template>

          <template #cell-wireguard_cidr="{ row }">
            <span class="font-mono text-xs">{{ row.wireguard_cidr }}</span>
          </template>

          <template #cell-public_ports="{ row }">
            <div class="flex flex-col gap-1">
              <div class="flex flex-wrap items-center gap-1">
                <span class="text-xs text-muted-foreground">tcp</span>
                <template v-if="row.public_tcp?.length">
                  <Badge v-for="p in row.public_tcp" :key="`pt-${p}`" variant="outline">{{ p }}</Badge>
                </template>
                <span v-else class="text-xs text-muted-foreground">—</span>
              </div>
              <div class="flex flex-wrap items-center gap-1">
                <span class="text-xs text-muted-foreground">udp</span>
                <template v-if="row.public_udp?.length">
                  <Badge v-for="p in row.public_udp" :key="`pu-${p}`" variant="outline">{{ p }}</Badge>
                </template>
                <span v-else class="text-xs text-muted-foreground">—</span>
              </div>
            </div>
          </template>

          <template #cell-wireguard_ports="{ row }">
            <div class="flex flex-col gap-1">
              <div class="flex flex-wrap items-center gap-1">
                <span class="text-xs text-muted-foreground">tcp</span>
                <template v-if="row.wireguard_tcp?.length">
                  <Badge v-for="p in row.wireguard_tcp" :key="`wt-${p}`" variant="secondary">{{ p }}</Badge>
                </template>
                <span v-else class="text-xs text-muted-foreground">—</span>
              </div>
              <div class="flex flex-wrap items-center gap-1">
                <span class="text-xs text-muted-foreground">udp</span>
                <template v-if="row.wireguard_udp?.length">
                  <Badge v-for="p in row.wireguard_udp" :key="`wu-${p}`" variant="secondary">{{ p }}</Badge>
                </template>
                <span v-else class="text-xs text-muted-foreground">—</span>
              </div>
            </div>
          </template>

          <template #cell-updated_at="{ row }">
            <span class="text-xs text-muted-foreground">{{ formatDateTime(row.updated_at) }}</span>
          </template>

          <template #cell-actions="{ row }">
            <div class="flex items-center justify-end gap-1">
              <Button
                v-if="canPlan"
                variant="outline"
                size="sm"
                :disabled="planning === row.node_id"
                @click="plan(row)"
              >
                <RefreshCw v-if="planning === row.node_id" class="size-4 animate-spin" aria-hidden="true" />
                <Play v-else class="size-4" aria-hidden="true" />
                {{ $t('networking.shared.plan') }}
              </Button>
              <Button
                v-if="canPlan"
                variant="ghost"
                size="icon-sm"
                :aria-label="$t('common.actions.edit')"
                @click="openEdit(row)"
              >
                <Pencil class="size-4" />
              </Button>
              <Button
                v-if="canPlan"
                variant="ghost"
                size="icon-sm"
                :aria-label="$t('common.actions.delete')"
                @click="requestDelete(row)"
              >
                <Trash2 class="size-4 text-destructive" />
              </Button>
            </div>
          </template>
        </DataTable>
      </CardContent>
    </Card>

    <!-- Create / edit dialog -->
    <Dialog v-model:open="dialogOpen">
      <DialogScrollContent class="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{{ editingId ? $t('networking.guard.editTitle') : $t('networking.guard.newTitle') }}</DialogTitle>
          <DialogDescription>
            {{ $t('networking.guard.dialogDescription') }}
          </DialogDescription>
        </DialogHeader>

        <form class="space-y-4" @submit.prevent="submit">
          <div class="grid gap-2">
            <Label for="guard-node">{{ $t('networking.guard.nodeLabel') }}</Label>
            <Select v-model="form.node_id" :disabled="!!editingId">
              <SelectTrigger id="guard-node" class="w-full">
                <SelectValue :placeholder="$t('networking.guard.selectNode')" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem v-for="node in nodes" :key="node.id" :value="node.id">
                  {{ node.name || node.id }}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div class="grid gap-3 sm:grid-cols-2">
            <div class="grid gap-2">
              <Label for="guard-iface">{{ $t('networking.guard.interfaceName') }}</Label>
              <Input id="guard-iface" v-model="form.interface_name" placeholder="eth0" />
            </div>
            <div class="grid gap-2">
              <Label for="guard-cidr">{{ $t('networking.guard.wireguardCidr') }}</Label>
              <Input id="guard-cidr" v-model="form.wireguard_cidr" placeholder="10.66.0.0/24" />
            </div>
          </div>

          <div class="grid gap-3 sm:grid-cols-2">
            <div class="grid gap-2">
              <Label for="guard-public-tcp">{{ $t('networking.guard.publicTcpPorts') }}</Label>
              <Input id="guard-public-tcp" v-model="form.public_tcp" placeholder="80, 443" />
              <p v-if="ignoredPublicTcp.length" class="text-xs text-warning">
                {{ $t('networking.guard.portsIgnored', { ports: ignoredPublicTcp.join(', ') }) }}
              </p>
            </div>
            <div class="grid gap-2">
              <Label for="guard-public-udp">{{ $t('networking.guard.publicUdpPorts') }}</Label>
              <Input id="guard-public-udp" v-model="form.public_udp" placeholder="51820" />
              <p v-if="ignoredPublicUdp.length" class="text-xs text-warning">
                {{ $t('networking.guard.portsIgnored', { ports: ignoredPublicUdp.join(', ') }) }}
              </p>
            </div>
            <div class="grid gap-2">
              <Label for="guard-wg-tcp">{{ $t('networking.guard.wireguardTcpPorts') }}</Label>
              <Input id="guard-wg-tcp" v-model="form.wireguard_tcp" placeholder="22" />
              <p v-if="ignoredWireguardTcp.length" class="text-xs text-warning">
                {{ $t('networking.guard.portsIgnored', { ports: ignoredWireguardTcp.join(', ') }) }}
              </p>
            </div>
            <div class="grid gap-2">
              <Label for="guard-wg-udp">{{ $t('networking.guard.wireguardUdpPorts') }}</Label>
              <Input id="guard-wg-udp" v-model="form.wireguard_udp" placeholder="53" />
              <p v-if="ignoredWireguardUdp.length" class="text-xs text-warning">
                {{ $t('networking.guard.portsIgnored', { ports: ignoredWireguardUdp.join(', ') }) }}
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" @click="dialogOpen = false">{{ $t('common.actions.cancel') }}</Button>
            <Button type="submit" :disabled="!canSubmit || saving">
              <RefreshCw v-if="saving" class="size-4 animate-spin" aria-hidden="true" />
              {{ editingId ? $t('common.actions.saveChanges') : $t('networking.guard.createInputs') }}
            </Button>
          </DialogFooter>
        </form>
      </DialogScrollContent>
    </Dialog>

    <!-- Delete confirm dialog -->
    <ConfirmDialog
      :open="!!deleteTarget"
      :title="$t('networking.guard.deleteTitle')"
      :description="`${$t('networking.guard.deleteDescription')} ${deleteTarget ? nodeLabel(deleteTarget) : ''}? ${$t('networking.guard.deleteIrreversible')}`"
      :confirm-label="$t('common.actions.delete')"
      :cancel-label="$t('common.actions.cancel')"
      :pending="deleting"
      @update:open="(v) => { if (!v) deleteTarget = undefined; }"
      @confirm="confirmDelete"
    />

    <!-- Plan review dialog -->
    <PlanReviewDialog
      :open="!!planApproval"
      :plan-text="planApproval?.plan"
      :digest="planSha"
      :badges="planBadges"
      :title="$t('networking.shared.planCreated')"
      :description="$t('networking.shared.planReviewHint')"
      :plan-label="$t('networking.shared.planLabel')"
      :close-label="$t('common.actions.close')"
      :approvals-label="$t('networking.shared.goToApprovals')"
      approvals-to="/approvals"
      @update:open="closePlan"
    />
  </div>
</template>
