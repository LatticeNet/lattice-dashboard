<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import {
  ArrowUpRight,
  ChevronRight,
  Info,
  Plus,
  RefreshCw,
  Server,
  ShieldCheck,
  Trash2,
  TriangleAlert,
  Waypoints,
} from "lucide-vue-next";
import {
  api,
  unwrap,
  type Line,
  type LineGroup,
  type LinesListResponse,
  type Node,
  type ProxyManagedAddRequest,
} from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { useAuthStore } from "@/stores/auth";
import { cn } from "@/lib/utils";

import PageHeader from "@/components/common/PageHeader.vue";
import DataState from "@/components/common/DataState.vue";
import StatCard from "@/components/common/StatCard.vue";
import FreshnessLabel from "@/components/common/FreshnessLabel.vue";
import CopyButton from "@/components/common/CopyButton.vue";
import ConfirmDialog from "@/components/common/ConfirmDialog.vue";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const auth = useAuthStore();
const { t } = useI18n();
const canAdmin = computed(() => auth.can("proxy:admin"));
const adminReason = computed(() => t("lines.adminReason"));

type VpnUserOption = {
  id: string;
  email: string;
  name?: string;
  enabled: boolean;
};

// Real Badge variant tokens (mirrors src/components/ui/badge/badgeVariants.ts).
type BadgeVariant =
  | "default"
  | "secondary"
  | "outline"
  | "success"
  | "warning"
  | "destructive"
  | "info";

// The Lines read-model is owned by the vpn-core plugin and reached ONLY through
// the design-10 dashboard→plugin gateway (never a bespoke /api/proxy route).
// A 4xx here (plugin inactive / missing scope) is surfaced gracefully by
// DataState — the page never crashes.
const linesQuery = useAsyncData(
  () =>
    api.plugins.call<LinesListResponse>(
      "latticenet.vpn-core",
      "latticenet.vpn-core/lines",
      "list",
    ),
  { pollInterval: 15000 },
);

const nodesQuery = useAsyncData(() => api.nodes.list().then((r) => unwrap(r, "nodes")), {
  pollInterval: 30000,
});
const usersQuery = useAsyncData(
  () =>
    api.plugins.call<{ users: VpnUserOption[]; count: number }>(
      "latticenet.vpn-core",
      "latticenet.vpn-core/users",
      "list",
    ),
  { pollInterval: 30000 },
);

const groups = computed<LineGroup[]>(() => linesQuery.data.value?.groups ?? []);
const sortedGroups = computed<LineGroup[]>(() =>
  [...groups.value].sort((a, b) =>
    (a.node_name || a.node_id).localeCompare(b.node_name || b.node_id),
  ),
);
const allLines = computed<Line[]>(() => groups.value.flatMap((g) => g.lines ?? []));
const nodes = computed<Node[]>(() => nodesQuery.data.value ?? []);
const selectableNodes = computed<Node[]>(() =>
  [...nodes.value].sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id)),
);
const vpnUsers = computed<VpnUserOption[]>(() =>
  (usersQuery.data.value?.users ?? []).filter((u) => u.enabled),
);

// ── KPI strip ────────────────────────────────────────────────────────────────
const totalLines = computed(() => linesQuery.data.value?.count ?? allLines.value.length);
const nodeCount = computed(() => groups.value.length);
const managedCount = computed(() => allLines.value.filter((l) => l.source === "managed").length);
const errorCount = computed(() => allLines.value.filter((l) => l.status === "error").length);
const isEmpty = computed(() => allLines.value.length === 0);

// ── Source / status visual treatment ──────────────────────────────────────────
function sourceVariant(source: string): BadgeVariant {
  if (source === "managed") return "default"; // solid / primary
  if (source === "imported") return "secondary";
  return "outline"; // discovered (+ anything unknown) → muted outline
}
function sourceLabel(source: string): string {
  switch (source) {
    case "managed":
      return t("lines.sourceManaged");
    case "discovered":
      return t("lines.sourceDiscovered");
    case "imported":
      return t("lines.sourceImported");
    default:
      return source || "—";
  }
}
function statusVariant(status?: string): BadgeVariant {
  switch (status) {
    case "ok":
      return "success";
    case "pending":
      return "warning";
    case "error":
      return "destructive";
    default:
      return "secondary"; // stale + unknown
  }
}
function statusLabel(status?: string): string {
  switch (status) {
    case "ok":
      return t("lines.statusOk");
    case "pending":
      return t("lines.statusPending");
    case "error":
      return t("lines.statusError");
    case "stale":
      return t("lines.statusStale");
    default:
      return status || t("lines.statusUnknown");
  }
}

const PROTOCOLS: { value: string; label: string }[] = [
  { value: "reality", label: "reality" },
  { value: "vless", label: "vless" },
  { value: "vmess", label: "vmess" },
  { value: "trojan", label: "trojan" },
  { value: "hy2", label: "hysteria2 (hy2)" },
  { value: "ss", label: "shadowsocks (ss)" },
  { value: "tuic", label: "tuic" },
  { value: "anytls", label: "anytls" },
  { value: "socks", label: "socks" },
];

// ── Add / delete management bridge ───────────────────────────────────────────
const addOpen = ref(false);
const addSaving = ref(false);
const addAttempted = ref(false);
const addForm = reactive({
  node_id: "",
  protocol: "",
  port: "",
  arg1: "",
  arg2: "",
  user_ids: [] as string[],
});

type PendingBindPlan = {
  task_id: string;
  node_id: string;
  protocol: string;
  port: number;
  user_ids: string[];
  status: "pending" | "binding" | "bound" | "failed";
  error?: string;
};

const pendingBinds = ref<PendingBindPlan[]>([]);

function openAdd(nodeId = "") {
  if (!canAdmin.value) return;
  addAttempted.value = false;
  addForm.node_id = nodeId;
  addForm.protocol = "";
  addForm.port = "";
  addForm.arg1 = "";
  addForm.arg2 = "";
  addForm.user_ids = [];
  addOpen.value = true;
}

const addNodeValid = computed(() => addForm.node_id.trim().length > 0);
const addProtocolValid = computed(() => addForm.protocol.trim().length > 0);
const addPortNumber = computed(() => Number(addForm.port));
const addPortValid = computed(() =>
  addForm.port.trim().length > 0 &&
  Number.isInteger(addPortNumber.value) &&
  addPortNumber.value >= 1 &&
  addPortNumber.value <= 65535,
);
const addFormValid = computed(() => addNodeValid.value && addProtocolValid.value && addPortValid.value);
const addNodeError = computed(() =>
  addAttempted.value && !addNodeValid.value ? t("lines.errorNodeRequired") : "",
);
const addProtocolError = computed(() =>
  addAttempted.value && !addProtocolValid.value ? t("lines.errorProtocolRequired") : "",
);
const addPortError = computed(() =>
  addAttempted.value && !addPortValid.value ? t("lines.errorPortRequired") : "",
);

function userLabel(id: string): string {
  const u = vpnUsers.value.find((x) => x.id === id);
  if (!u) return id;
  return u.name ? `${u.email} · ${u.name}` : u.email;
}

function pendingStatusLabel(status: PendingBindPlan["status"]): string {
  switch (status) {
    case "binding":
      return t("lines.pendingStatusBinding");
    case "bound":
      return t("lines.pendingStatusBound");
    case "failed":
      return t("lines.pendingStatusFailed");
    default:
      return t("lines.pendingStatusPending");
  }
}

async function submitAdd() {
  addAttempted.value = true;
  if (!addFormValid.value || addSaving.value) return;

  const input: ProxyManagedAddRequest = {
    node_id: addForm.node_id,
    protocol: addForm.protocol,
    port: addPortNumber.value,
  };
  const args = [addForm.arg1, addForm.arg2].map((a) => a.trim()).filter(Boolean);
  if (args.length) input.args = args;

  addSaving.value = true;
  try {
    const res = await api.proxy.managed.add(input);
    if (addForm.user_ids.length) {
      pendingBinds.value.unshift({
        task_id: res.task_id,
        node_id: addForm.node_id,
        protocol: addForm.protocol,
        port: addPortNumber.value,
        user_ids: [...addForm.user_ids],
        status: "pending",
      });
    }
    toast.success(t("lines.toastAddQueued", { id: res.task_id }));
    addOpen.value = false;
    // Queue a follow-up probe; task ordering on the node keeps this behind the add
    // in normal operation, and the UI still treats discovery as the source of truth.
    try {
      await api.proxy.managed.probe({ node_id: addForm.node_id });
    } catch {
      // Non-blocking. Periodic discovery can still surface the line.
    }
    void linesQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("lines.toastAddFailed"));
  } finally {
    addSaving.value = false;
  }
}

async function resolvePendingBinds() {
  for (const plan of pendingBinds.value) {
    if (plan.status !== "pending") continue;
    const line = allLines.value.find(
      (l) =>
        l.node_id === plan.node_id &&
        (l.type || "").toLowerCase() === plan.protocol.toLowerCase() &&
        l.listen_port === plan.port,
    );
    if (!line?.line_hash_id) continue;
    plan.status = "binding";
    try {
      for (const userID of plan.user_ids) {
        await api.plugins.call("latticenet.vpn-core", "latticenet.vpn-core/users-admin", "bind", {
          user_id: userID,
          line_hash_id: line.line_hash_id,
        });
      }
      plan.status = "bound";
      toast.success(t("lines.toastBindComplete", { count: plan.user_ids.length }));
      void usersQuery.refresh();
    } catch (error) {
      plan.status = "failed";
      plan.error = error instanceof Error ? error.message : t("lines.toastBindFailed");
      toast.error(plan.error);
    }
  }
}

watch(allLines, () => {
  void resolvePendingBinds();
});

const deleteOpen = ref(false);
const deleteTarget = ref<Line | null>(null);
const deleting = ref(false);

function canDeleteLine(line: Line | null): boolean {
  return !!line && line.source === "discovered" && !!(line.name || line.tag);
}

function askDeleteLine(line: Line | null) {
  if (!canAdmin.value || !canDeleteLine(line)) return;
  deleteTarget.value = line;
  deleteOpen.value = true;
}

async function confirmDeleteLine() {
  const line = deleteTarget.value;
  const name = line?.name || line?.tag || "";
  if (!line || !name || deleting.value) return;
  deleting.value = true;
  try {
    const res = await api.proxy.managed.delete({ node_id: line.node_id, name });
    toast.success(t("lines.toastDeleteQueued", { id: res.task_id }));
    deleteOpen.value = false;
    detailOpen.value = false;
    try {
      await api.proxy.managed.probe({ node_id: line.node_id });
    } catch {
      // Non-blocking; periodic discovery can update the view.
    }
    void linesQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("lines.toastDeleteFailed"));
  } finally {
    deleting.value = false;
  }
}

// ── Detail drawer (the app's modal primitive; no separate Sheet exists) ───────
const selected = ref<Line | null>(null);
const detailOpen = ref(false);
function openDetail(line: Line) {
  selected.value = line;
  detailOpen.value = true;
}

const metadataEntries = computed<[string, string][]>(() =>
  selected.value?.metadata ? Object.entries(selected.value.metadata) : [],
);

const detailRows = computed<{ label: string; value: string }[]>(() => {
  const l = selected.value;
  if (!l) return [];
  const listen = l.listen_host
    ? l.listen_port
      ? `${l.listen_host}:${l.listen_port}`
      : l.listen_host
    : l.listen_port
      ? `:${l.listen_port}`
      : "—";
  const rows: { label: string; value: string }[] = [
    { label: t("lines.fieldNode"), value: l.node_id },
    { label: t("lines.fieldSource"), value: sourceLabel(l.source) },
    { label: t("lines.fieldCore"), value: l.core || "—" },
    { label: t("lines.fieldName"), value: l.name || "—" },
    { label: t("lines.fieldTag"), value: l.tag || "—" },
    { label: t("lines.fieldType"), value: l.type || "—" },
    { label: t("lines.fieldListen"), value: listen },
    { label: t("lines.fieldPublic"), value: l.public_host || "—" },
    { label: t("lines.fieldDomain"), value: l.domain || "—" },
    { label: t("lines.fieldOutbound"), value: l.outbound_ref || "—" },
    {
      label: t("lines.fieldUsers"),
      value: l.user_known ? String(l.user_count) : t("lines.usersUnknown"),
    },
    { label: t("lines.fieldStatus"), value: statusLabel(l.status) },
  ];
  if (l.last_error) rows.push({ label: t("lines.fieldLastError"), value: l.last_error });
  return rows;
});
</script>

<template>
  <div class="p-6 space-y-6">
    <PageHeader :title="$t('lines.title')" :description="$t('lines.description')">
      <template #status>
        <FreshnessLabel :last-updated="linesQuery.lastUpdated.value" />
      </template>
      <template #actions>
        <Button
          variant="outline"
          size="sm"
          :disabled="linesQuery.refreshing.value"
          @click="linesQuery.refresh"
        >
          <RefreshCw
            :class="cn('size-4', linesQuery.refreshing.value && 'animate-spin')"
            aria-hidden="true"
          />
          {{ $t('common.actions.refresh') }}
        </Button>
        <Button
          v-if="canAdmin"
          size="sm"
          @click="openAdd()"
        >
          <Plus class="size-4" aria-hidden="true" />
          {{ $t('lines.addLine') }}
        </Button>
      </template>
    </PageHeader>

    <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <StatCard :label="$t('lines.kpiLines')" :value="totalLines" :icon="Waypoints" />
      <StatCard :label="$t('lines.kpiNodes')" :value="nodeCount" :icon="Server" />
      <StatCard :label="$t('lines.kpiManaged')" :value="managedCount" :icon="ShieldCheck" tone="success" />
      <StatCard
        :label="$t('lines.kpiErrors')"
        :value="errorCount"
        :icon="TriangleAlert"
        :tone="errorCount > 0 ? 'destructive' : undefined"
      />
    </div>

    <div
      v-if="canAdmin"
      class="flex items-start gap-2 rounded-md border border-border bg-muted/40 p-3 text-xs text-muted-foreground"
    >
      <Info class="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <div class="space-y-0.5">
        <p class="font-medium text-foreground">{{ $t('lines.manageNoteTitle') }}</p>
        <p>{{ $t('lines.manageNoteBody') }}</p>
      </div>
    </div>

    <Card v-if="pendingBinds.length">
      <CardHeader>
        <CardTitle class="text-sm">{{ $t('lines.pendingBindingsTitle') }}</CardTitle>
      </CardHeader>
      <CardContent>
        <div class="space-y-2">
          <div
            v-for="plan in pendingBinds"
            :key="plan.task_id"
            class="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-xs"
          >
            <div class="min-w-0">
              <div class="font-mono">{{ plan.node_id }} · {{ plan.protocol }}:{{ plan.port }}</div>
              <div class="truncate text-muted-foreground">
                {{ $t('lines.pendingBinding', { count: plan.user_ids.length, task: plan.task_id }) }}
              </div>
              <div v-if="plan.error" class="mt-1 break-words text-destructive">{{ plan.error }}</div>
            </div>
            <Badge :variant="plan.status === 'failed' ? 'destructive' : plan.status === 'bound' ? 'success' : 'warning'">
              {{ pendingStatusLabel(plan.status) }}
            </Badge>
          </div>
        </div>
      </CardContent>
    </Card>

    <DataState
      :loading="linesQuery.loading.value"
      :error="linesQuery.error.value"
      :has-data="linesQuery.data.value !== undefined"
      :is-empty="isEmpty"
      :empty-title="$t('lines.emptyTitle')"
      :empty-description="$t('lines.emptyDescription')"
      @retry="linesQuery.refresh"
    >
      <div class="grid gap-3 2xl:grid-cols-2">
        <Card v-for="group in sortedGroups" :key="group.node_id" class="overflow-hidden">
          <CardHeader class="px-4 py-3">
            <div class="flex flex-wrap items-start justify-between gap-3">
              <div class="min-w-0 space-y-1">
                <CardTitle class="flex items-center gap-2">
                  <Server class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <RouterLink
                    :to="{ name: 'node-detail', params: { id: group.node_id } }"
                    class="inline-flex min-w-0 items-center gap-1 truncate text-sm hover:text-primary hover:underline"
                    :title="$t('lines.viewNode')"
                  >
                    <span class="truncate font-medium">{{ group.node_name || group.node_id }}</span>
                    <ArrowUpRight class="size-3.5 shrink-0 opacity-60" aria-hidden="true" />
                  </RouterLink>
                </CardTitle>
                <div class="font-mono text-xs text-muted-foreground">{{ group.node_id }}</div>
              </div>
              <Badge variant="secondary" class="shrink-0">
                {{ $t('lines.groupLineCount', { count: group.lines.length }, group.lines.length) }}
              </Badge>
              <Button
                v-if="canAdmin"
                size="sm"
                variant="outline"
                @click="openAdd(group.node_id)"
              >
                <Plus class="size-4" aria-hidden="true" />
                {{ $t('lines.addHere') }}
              </Button>
            </div>
          </CardHeader>

          <CardContent class="px-4 pb-4">
            <div class="overflow-x-auto">
              <table class="w-full min-w-[980px] text-sm">
                <thead>
                  <tr class="border-b border-border text-xs text-muted-foreground">
                    <th scope="col" class="px-3 py-2 text-left font-medium">{{ $t('lines.colSource') }}</th>
                    <th scope="col" class="px-3 py-2 text-left font-medium">{{ $t('lines.colCore') }}</th>
                    <th scope="col" class="px-3 py-2 text-left font-medium">{{ $t('lines.colName') }}</th>
                    <th scope="col" class="px-3 py-2 text-left font-medium">{{ $t('lines.colTag') }}</th>
                    <th scope="col" class="px-3 py-2 text-left font-medium">{{ $t('lines.colType') }}</th>
                    <th scope="col" class="px-3 py-2 text-left font-medium">{{ $t('lines.colListen') }}</th>
                    <th scope="col" class="px-3 py-2 text-left font-medium">{{ $t('lines.colPublic') }}</th>
                    <th scope="col" class="px-3 py-2 text-left font-medium">{{ $t('lines.colOutbound') }}</th>
                    <th scope="col" class="px-3 py-2 text-right font-medium">{{ $t('lines.colUsers') }}</th>
                    <th scope="col" class="px-3 py-2 text-left font-medium">{{ $t('lines.colStatus') }}</th>
                    <th scope="col" class="px-3 py-2"><span class="sr-only">{{ $t('lines.viewDetail') }}</span></th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="line in group.lines"
                    :key="line.id || line.line_hash_id"
                    role="button"
                    tabindex="0"
                    class="cursor-pointer border-b border-border last:border-0 hover:bg-muted/40 focus:bg-muted/40 focus:outline-none"
                    :aria-label="$t('lines.viewDetail')"
                    @click="openDetail(line)"
                    @keydown.enter.prevent="openDetail(line)"
                    @keydown.space.prevent="openDetail(line)"
                  >
                    <td class="px-3 py-2">
                      <Badge :variant="sourceVariant(line.source)">{{ sourceLabel(line.source) }}</Badge>
                    </td>
                    <td class="px-3 py-2">
                      <Badge v-if="line.core" variant="outline">{{ line.core }}</Badge>
                      <span v-else class="text-muted-foreground">—</span>
                    </td>
                    <td class="px-3 py-2">
                      <span class="font-medium">{{ line.name || "—" }}</span>
                    </td>
                    <td class="px-3 py-2">
                      <span class="font-mono text-xs text-muted-foreground">{{ line.tag || "—" }}</span>
                    </td>
                    <td class="px-3 py-2">
                      <span class="font-mono text-xs text-muted-foreground">{{ line.type || "—" }}</span>
                    </td>
                    <td class="px-3 py-2">
                      <span class="font-mono text-xs">
                        {{ line.listen_host || "—" }}<span
                          v-if="line.listen_port"
                          class="text-muted-foreground"
                        >:{{ line.listen_port }}</span>
                      </span>
                    </td>
                    <td class="px-3 py-2">
                      <div class="font-mono text-xs">{{ line.public_host || "—" }}</div>
                      <div v-if="line.domain" class="font-mono text-xs text-muted-foreground">{{ line.domain }}</div>
                    </td>
                    <td class="px-3 py-2">
                      <span class="font-mono text-xs">{{ line.outbound_ref || "—" }}</span>
                    </td>
                    <td class="px-3 py-2 text-right">
                      <Tooltip v-if="!line.user_known">
                        <TooltipTrigger as-child>
                          <span class="cursor-help font-mono text-xs text-muted-foreground">
                            {{ $t('lines.usersUnknown') }}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent>{{ $t('lines.usersUnknownHint') }}</TooltipContent>
                      </Tooltip>
                      <span v-else class="font-mono text-xs tabular">{{ line.user_count }}</span>
                    </td>
                    <td class="px-3 py-2">
                      <Tooltip v-if="line.status === 'error' && line.last_error">
                        <TooltipTrigger as-child>
                          <Badge :variant="statusVariant(line.status)" class="cursor-help">
                            {{ statusLabel(line.status) }}
                          </Badge>
                        </TooltipTrigger>
                        <TooltipContent class="max-w-xs">{{ line.last_error }}</TooltipContent>
                      </Tooltip>
                      <Badge v-else :variant="statusVariant(line.status)">{{ statusLabel(line.status) }}</Badge>
                    </td>
                    <td class="px-3 py-2 text-right">
                      <ChevronRight class="ml-auto size-4 text-muted-foreground" aria-hidden="true" />
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      </div>
    </DataState>

    <!-- Line detail drawer -->
    <Dialog v-model:open="detailOpen">
      <DialogScrollContent class="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{{ $t('lines.detailTitle') }}</DialogTitle>
          <DialogDescription>
            {{ $t('lines.detailDescription', { name: selected?.name || selected?.line_hash_id }) }}
          </DialogDescription>
        </DialogHeader>

        <div v-if="selected" class="space-y-4">
          <div class="rounded-md border border-border">
            <div class="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
              <span class="text-sm font-medium">{{ $t('lines.fieldLineHashId') }}</span>
              <CopyButton :value="selected.line_hash_id" :label="$t('common.actions.copy')" />
            </div>
            <code class="block break-all p-3 font-mono text-xs">{{ selected.line_hash_id }}</code>
          </div>

          <dl class="overflow-hidden rounded-md border border-border">
            <div
              v-for="(row, idx) in detailRows"
              :key="row.label"
              class="flex items-start justify-between gap-4 px-3 py-2.5"
              :class="cn(idx % 2 === 1 && 'bg-muted/30', idx > 0 && 'border-t border-border')"
            >
              <dt class="shrink-0 text-xs font-medium text-muted-foreground">{{ row.label }}</dt>
              <dd class="min-w-0 break-words text-right font-mono text-xs">{{ row.value }}</dd>
            </div>
          </dl>

          <div class="space-y-2">
            <p class="text-xs font-medium text-muted-foreground">{{ $t('lines.jumpEdgesTitle') }}</p>
            <div v-if="selected.jump_edges && selected.jump_edges.length" class="space-y-1">
              <div
                v-for="edge in selected.jump_edges"
                :key="edge"
                class="flex items-center justify-between gap-2 rounded-md bg-muted/40 px-3 py-2"
              >
                <code class="block break-all font-mono text-xs">{{ edge }}</code>
                <CopyButton :value="edge" />
              </div>
            </div>
            <p v-else class="text-xs text-muted-foreground">{{ $t('lines.noJumpEdges') }}</p>
          </div>

          <div v-if="metadataEntries.length" class="space-y-2">
            <p class="text-xs font-medium text-muted-foreground">{{ $t('lines.fieldMetadata') }}</p>
            <dl class="overflow-hidden rounded-md border border-border">
              <div
                v-for="([k, v], idx) in metadataEntries"
                :key="k"
                class="flex items-start justify-between gap-4 px-3 py-2"
                :class="cn(idx % 2 === 1 && 'bg-muted/30', idx > 0 && 'border-t border-border')"
              >
                <dt class="shrink-0 font-mono text-xs text-muted-foreground">{{ k }}</dt>
                <dd class="min-w-0 break-words text-right font-mono text-xs">{{ v }}</dd>
              </div>
            </dl>
          </div>
        </div>

        <DialogFooter>
          <Button
            v-if="canAdmin && canDeleteLine(selected)"
            type="button"
            variant="destructive"
            :title="$t('lines.deleteLine')"
            @click="askDeleteLine(selected)"
          >
            <Trash2 class="size-4" aria-hidden="true" />
            {{ $t('lines.deleteLine') }}
          </Button>
          <Button type="button" variant="outline" @click="detailOpen = false">
            {{ $t('common.actions.close') }}
          </Button>
        </DialogFooter>
      </DialogScrollContent>
    </Dialog>

    <Dialog v-model:open="addOpen">
      <DialogScrollContent class="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{{ $t('lines.addDialogTitle') }}</DialogTitle>
          <DialogDescription>{{ $t('lines.addDialogDescription') }}</DialogDescription>
        </DialogHeader>

        <form class="space-y-5" @submit.prevent="submitAdd">
          <div class="grid gap-3 sm:grid-cols-3">
            <div class="grid gap-2 sm:col-span-3">
              <Label for="line-node">{{ $t('lines.fieldNode') }}</Label>
              <Select v-model="addForm.node_id">
                <SelectTrigger
                  id="line-node"
                  :aria-invalid="!!addNodeError"
                  :class="cn(addNodeError && 'border-destructive')"
                >
                  <SelectValue :placeholder="$t('lines.selectNode')" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="node in selectableNodes" :key="node.id" :value="node.id">
                    {{ node.name || node.id }} · {{ node.id }}
                  </SelectItem>
                </SelectContent>
              </Select>
              <p v-if="addNodeError" class="text-xs text-destructive">{{ addNodeError }}</p>
            </div>

            <div class="grid gap-2">
              <Label for="line-protocol">{{ $t('lines.fieldProtocol') }}</Label>
              <Select v-model="addForm.protocol">
                <SelectTrigger
                  id="line-protocol"
                  :aria-invalid="!!addProtocolError"
                  :class="cn(addProtocolError && 'border-destructive')"
                >
                  <SelectValue :placeholder="$t('lines.selectProtocol')" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="p in PROTOCOLS" :key="p.value" :value="p.value">
                    {{ p.label }}
                  </SelectItem>
                </SelectContent>
              </Select>
              <p v-if="addProtocolError" class="text-xs text-destructive">{{ addProtocolError }}</p>
            </div>

            <div class="grid gap-2">
              <Label for="line-port">{{ $t('lines.fieldPort') }}</Label>
              <Input
                id="line-port"
                v-model="addForm.port"
                type="number"
                min="1"
                max="65535"
                :aria-invalid="!!addPortError"
                :class="cn(addPortError && 'border-destructive')"
                :placeholder="$t('lines.fieldPortPlaceholder')"
              />
              <p v-if="addPortError" class="text-xs text-destructive">{{ addPortError }}</p>
            </div>

            <div class="grid gap-2">
              <Label for="line-arg1">{{ $t('lines.fieldArg1') }}</Label>
              <Input
                id="line-arg1"
                v-model="addForm.arg1"
                autocomplete="off"
                :placeholder="$t('lines.fieldArg1Placeholder')"
              />
            </div>
          </div>

          <div class="grid gap-2">
            <Label for="line-arg2">{{ $t('lines.fieldArg2') }}</Label>
            <Input
              id="line-arg2"
              v-model="addForm.arg2"
              autocomplete="off"
              :placeholder="$t('lines.fieldArg2Placeholder')"
            />
            <p class="text-xs text-muted-foreground">{{ $t('lines.argsHint') }}</p>
          </div>

          <div class="space-y-2 rounded-md border border-border p-3">
            <div class="flex items-start justify-between gap-3">
              <div>
                <p class="text-sm font-medium">{{ $t('lines.fieldBindUsers') }}</p>
                <p class="text-xs text-muted-foreground">{{ $t('lines.bindAfterDiscoveryHint') }}</p>
              </div>
              <Badge variant="secondary">{{ addForm.user_ids.length }}</Badge>
            </div>
            <div v-if="vpnUsers.length" class="grid max-h-52 gap-2 overflow-y-auto pr-1 sm:grid-cols-2">
              <label
                v-for="user in vpnUsers"
                :key="user.id"
                class="flex cursor-pointer items-center gap-2 rounded-md border border-border px-3 py-2 text-sm hover:bg-muted/50"
              >
                <input v-model="addForm.user_ids" type="checkbox" :value="user.id" class="size-4" />
                <span class="min-w-0 truncate">{{ userLabel(user.id) }}</span>
              </label>
            </div>
            <p v-else class="text-xs text-muted-foreground">{{ $t('lines.noUsers') }}</p>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" @click="addOpen = false">
              {{ $t('common.actions.cancel') }}
            </Button>
            <Button type="submit" :disabled="!addFormValid || addSaving">
              <RefreshCw v-if="addSaving" class="size-4 animate-spin" aria-hidden="true" />
              <Plus v-else class="size-4" aria-hidden="true" />
              {{ $t('lines.addSubmit') }}
            </Button>
          </DialogFooter>
        </form>
      </DialogScrollContent>
    </Dialog>

    <ConfirmDialog
      v-model:open="deleteOpen"
      :title="$t('lines.deleteTitle')"
      :description="$t('lines.deleteConfirm', { name: deleteTarget?.name || deleteTarget?.tag })"
      :confirm-label="$t('common.actions.delete')"
      :cancel-label="$t('common.actions.cancel')"
      :pending="deleting"
      @confirm="confirmDeleteLine"
    />
  </div>
</template>
