<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import {
  Activity,
  Globe,
  LockKeyhole,
  Pause,
  Play,
  Plus,
  RadioTower,
  RefreshCw,
  Trash2,
} from "lucide-vue-next";
import { api, unwrap, type MonitorResult, type MonitorView, type Node } from "@/lib/api";
import {
  AGENT_DEFAULT_INTERVAL_SEC,
  AGENT_DEFAULT_TIMEOUT_SEC,
  MONITOR_TYPES,
  TLS_DEFAULT_THRESHOLD_DAYS,
  TLS_MAX_THRESHOLD_DAYS,
  buildMonitorCreate,
  canSubmitMonitor,
  isServerEvaluated,
  switchMonitorType,
  tlsTargetError,
  type ProbeAssignment,
} from "./monitorTypeModel";
import { useAsyncData } from "@/composables/useAsyncData";
import { useAuthStore } from "@/stores/auth";
import { formatDateTime, formatPercent, formatRelativeTime, shortId } from "@/lib/format";
import { cn } from "@/lib/utils";


import PageHeader from "@/components/common/PageHeader.vue";
import ProofLine, { type ProofSegment } from "@/components/common/ProofLine.vue";
import DataTable, { type DataTableColumn } from "@/components/common/DataTable.vue";
import ObjectSheet from "@/components/common/ObjectSheet.vue";
import RowMenu, { type RowMenuItem } from "@/components/common/RowMenu.vue";
import { useProof } from "@/composables/useProof";
import { useOwnedRoute } from "@/composables/useOwnedRoute";
import { bindRouteOpen } from "@/composables/useRouteOpen";
import ConfirmDialog from "@/components/common/ConfirmDialog.vue";
import EmptyState from "@/components/common/EmptyState.vue";
import TrendChart from "@/components/common/TrendChart.vue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

const auth = useAuthStore();
const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const canReadMonitors = computed(() => auth.can("monitor:read"));
const canReadNodes = computed(() => auth.can("node:read"));
const canAdminMonitors = computed(() => auth.can("monitor:admin"));

const monitorsQuery = useAsyncData(
  (signal) => {
    if (!canReadMonitors.value) return Promise.resolve([] as MonitorView[]);
    return api.monitors.list({ signal }).then((r) => unwrap(r, "monitors"));
  },
  {
    pollInterval: 10000,
    immediate: canReadMonitors.value,
  },
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

// One monitor open in the sheet on ?open=. An old /monitoring/:id link (the
// Upcoming list's TLS rows) lands on /monitoring?open=<id> instead.
const owned = useOwnedRoute();
const sheet = bindRouteOpen(owned);
watch(
  () => route.params.id,
  (id) => {
    if (typeof id === "string" && id) router.replace({ name: "monitoring", query: { ...route.query, open: id } }).catch(() => {});
  },
  { immediate: true },
);
const selectedMonitorId = computed(() => sheet.openId.value ?? "");
const createOpen = ref(false);
const createPending = ref(false);
const deletePending = ref(false);
const deleteOpen = ref(false);

const monitorName = ref("");
const monitorType = ref<string>("tcp");
const monitorTarget = ref("");
const intervalSec = ref(AGENT_DEFAULT_INTERVAL_SEC);
const timeoutSec = ref(AGENT_DEFAULT_TIMEOUT_SEC);
const thresholdDays = ref(TLS_DEFAULT_THRESHOLD_DAYS);

const assignAll = ref(true);
const selectedNodeIds = ref<string[]>([]);
const selectedNodeIdsInput = computed({
  get: () => selectedNodeIds.value.join(", "),
  set: (value: string) => {
    selectedNodeIds.value = parseNodeIdList(value);
  },
});

function parseNodeIdList(value: string): string[] {
  return [...new Set(value.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean))];
}
/**
 * What a certificate watch does to the assignment and the cadence.
 *
 * The server dials a tls target itself, so it takes no node assignment and
 * wants an hourly cadence. Saying that by overwriting cost the operator their
 * work: a node list worked through on a long fleet was emptied by one mis-click
 * on the type selector and never came back. switchMonitorType holds the
 * agent-probe state aside instead and hands it back on the way in.
 */
const agentProbeStash = ref<ProbeAssignment | undefined>(undefined);

watch(monitorType, (type, previous) => {
  const { state, stash } = switchMonitorType(
    previous ?? "",
    type,
    {
      assignAll: assignAll.value,
      nodeIds: selectedNodeIds.value,
      intervalSec: intervalSec.value,
      timeoutSec: timeoutSec.value,
    },
    agentProbeStash.value,
  );
  agentProbeStash.value = stash;
  assignAll.value = state.assignAll;
  selectedNodeIds.value = state.nodeIds;
  intervalSec.value = state.intervalSec;
  timeoutSec.value = state.timeoutSec;
});

const isCertWatch = computed(() => isServerEvaluated(monitorType.value));
/** Set once the operator has typed something that is not host:port. */
const tlsTargetProblem = computed(() =>
  isCertWatch.value && monitorTarget.value.trim() ? tlsTargetError(monitorTarget.value) : undefined,
);


/** The assignment picker is a checkbox list writing into one array of ids. */
function toggleAssignedNode(id: string, on: boolean) {
  const has = selectedNodeIds.value.includes(id);
  if (on && !has) selectedNodeIds.value = [...selectedNodeIds.value, id];
  else if (!on && has) selectedNodeIds.value = selectedNodeIds.value.filter((n) => n !== id);
}

const resultsQuery = useAsyncData(
  (signal) => {
    if (!canReadMonitors.value || !selectedMonitorId.value) return Promise.resolve([] as MonitorResult[]);
    return api.monitors.results(selectedMonitorId.value, { signal }).then((r) => unwrap(r, "results"));
  },
  { pollInterval: 8000, immediate: canReadMonitors.value },
);

const monitors = computed(() => monitorsQuery.data.value ?? []);
const nodes = computed(() => nodesQuery.data.value ?? []);
const selectedMonitor = computed(() =>
  monitors.value.find((monitor) => monitor.id === selectedMonitorId.value),
);
const selectedResults = computed(() => resultsQuery.data.value ?? []);

/** Enabled first, then by name. Search is the table's own. */
const sortedMonitors = computed(() =>
  [...monitors.value].sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    return (a.name || a.id).localeCompare(b.name || b.id);
  }),
);

const sortedResultsAsc = computed(() =>
  [...selectedResults.value].sort((a, b) => timestamp(a.at) - timestamp(b.at)),
);
const sortedResultsDesc = computed(() => [...sortedResultsAsc.value].reverse());
const recentResults = computed(() => sortedResultsAsc.value.slice(-120));
const latestResult = computed(() => sortedResultsAsc.value[sortedResultsAsc.value.length - 1]);

/* ---- Results log: node scope + status filter + pause/tail ----
   Addresses the "log stacks endlessly / many nodes interleaved" problem: filter
   by node + outcome, cap the rendered window, and freeze it on demand so a dense
   table stops swapping under the reader. */
const SLOW_MS = 250;
const LOG_CAP = 200;
const logStatus = ref<"all" | "failures" | "slow">("all");
const logNode = ref("all");
const paused = ref(false);
const frozen = ref<MonitorResult[] | null>(null);

const logNodeOptions = computed(() => [
  ...new Set(selectedResults.value.map((r) => r.node_id).filter(Boolean)),
]);
const filteredResults = computed(() =>
  sortedResultsDesc.value.filter((r) => {
    if (logNode.value !== "all" && r.node_id !== logNode.value) return false;
    if (logStatus.value === "failures" && r.success) return false;
    if (logStatus.value === "slow" && (r.latency_ms ?? 0) < SLOW_MS) return false;
    return true;
  }),
);
const displayResults = computed(() =>
  paused.value && frozen.value ? frozen.value : filteredResults.value.slice(0, LOG_CAP),
);
/** The rendered window is capped, so the count label has to say so. While
 *  paused the frozen snapshot can outlive the live match set, so the total
 *  never reads lower than what is actually on screen. */
const logMatchTotal = computed(() =>
  Math.max(displayResults.value.length, filteredResults.value.length),
);
const logCapped = computed(() => displayResults.value.length < logMatchTotal.value);
const newSincePause = computed(() => {
  const snap = frozen.value;
  const first = snap?.[0];
  if (!paused.value || !first) return 0;
  const newest = timestamp(first.at);
  return filteredResults.value.filter((r) => timestamp(r.at) > newest).length;
});
function togglePause() {
  if (paused.value) {
    paused.value = false;
    frozen.value = null;
  } else {
    frozen.value = filteredResults.value.slice(0, LOG_CAP);
    paused.value = true;
  }
}

// Deep-link: /monitoring?node=<id> seeds the results-log node filter once that
// node appears in the loaded results (e.g. from a node's "Monitoring" cross-link).
// Only seeds while the filter is still on its "all" default so it never clobbers
// a manual choice, and seeds at most once per id.
const seededLogNode = ref<string | undefined>(undefined);
watch(
  [logNodeOptions, () => route.query.node],
  ([opts, nodeQ]) => {
    const id = typeof nodeQ === "string" ? nodeQ : undefined;
    if (!id || id === seededLogNode.value) return;
    if (logNode.value === "all" && opts.includes(id)) {
      logNode.value = id;
      seededLogNode.value = id;
    }
  },
  { immediate: true },
);

const enabledCount = computed(() => monitors.value.filter((monitor) => monitor.enabled).length);
const failureCount = computed(() => selectedResults.value.filter((result) => !result.success).length);
const selectedSuccessRate = computed(() => {
  if (selectedResults.value.length === 0) return t("common.misc.none");
  const ok = selectedResults.value.filter((result) => result.success).length;
  return formatPercent((ok / selectedResults.value.length) * 100, 1);
});
const averageLatency = computed(() => {
  const values = selectedResults.value
    .map((result) => result.latency_ms)
    .filter((value): value is number => value !== undefined && Number.isFinite(value));
  if (values.length === 0) return t("common.misc.none");
  return formatLatency(values.reduce((sum, value) => sum + value, 0) / values.length);
});
const monitorForm = computed(() => ({
  name: monitorName.value,
  type: monitorType.value,
  target: monitorTarget.value,
  intervalSec: Number(intervalSec.value),
  timeoutSec: Number(timeoutSec.value),
  thresholdDays: Number(thresholdDays.value),
  assignAll: assignAll.value,
  nodeIds: selectedNodeIds.value,
}));
const canSubmit = computed(() => canSubmitMonitor(monitorForm.value));

// Chronological latency series for the TrendChart: successful results only,
// ordered oldest → newest, with null/undefined latency dropped.
const latencyTrend = computed<number[]>(() =>
  sortedResultsAsc.value
    .filter((result) => result.success)
    .map((result) => result.latency_ms)
    .filter((value): value is number => value !== undefined && Number.isFinite(value)),
);

/**
 * The number alone: TrendChart appends its `unit` ("ms") to whatever this
 * returns, and a unit here too printed "min 118msms".
 */
function formatTrendLatency(n: number): string {
  return String(Math.round(n));
}

watch(selectedMonitorId, (id) => {
  if (id) void resultsQuery.refresh();
});

function timestamp(input?: string): number {
  if (!input) return 0;
  const value = new Date(input).getTime();
  return Number.isNaN(value) ? 0 : value;
}

function formatLatency(ms?: number): string {
  if (ms === undefined || !Number.isFinite(ms)) return t("common.misc.none");
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  return `${ms.toFixed(ms < 10 ? 1 : 0)}ms`;
}

function nodeName(id: string): string {
  // A tls result has no node: the control plane dialled the endpoint itself.
  if (!id) return t("fleet.monitoring.result.controlPlane");
  return nodes.value.find((node) => node.id === id)?.name || shortId(id, 14);
}

function assignmentLabel(monitor: MonitorView): string {
  if (isServerEvaluated(monitor.type)) return t("fleet.monitoring.assignment.controlPlane");
  if (monitor.assign_all) return t("fleet.monitoring.assignment.allNodes");
  const count = monitor.node_ids?.length ?? 0;
  return t("fleet.monitoring.assignment.nodeCount", { count });
}


/**
 * How a result's latency reads. A passing probe is plain text up to the
 * slow line (SLOW_MS): a pass at 120 ms painted amber beside a green
 * "passing" said two things at once (design 23, 4.2). Slow passes are amber,
 * failures red.
 */
function latencyTone(result: MonitorResult): string {
  if (!result.success) return "text-destructive";
  return (result.latency_ms ?? 0) >= SLOW_MS ? "text-warning-text" : "text-foreground";
}

/** Heat-strip tile: green for a pass under the slow line, amber above it, red for a failure. */
function stripClass(result: MonitorResult): string {
  if (!result.success) return "bg-destructive/80";
  return (result.latency_ms ?? 0) >= SLOW_MS ? "bg-warning/80" : "bg-success/70";
}

function refreshAll() {
  if (canReadMonitors.value) {
    monitorsQuery.refresh();
    resultsQuery.refresh();
  }
  if (canReadNodes.value) nodesQuery.refresh();
}

/**
 * Take the operator to the form the empty state just pointed at. With no
 * monitors the create card is the only thing on the page worth doing, and on a
 * narrow viewport it sits below everything else.
 */
function openCreate(type?: string) {
  if (type) monitorType.value = type;
  createOpen.value = true;
}

async function createMonitor() {
  if (!canSubmit.value) return;
  createPending.value = true;
  try {
    const created = await api.monitors.create(buildMonitorCreate(monitorForm.value));
    monitorName.value = "";
    // Dropped before the type changes: the form is being emptied on purpose,
    // so the state held aside for a round trip through tls is not owed back.
    agentProbeStash.value = undefined;
    monitorType.value = "tcp";
    monitorTarget.value = "";
    intervalSec.value = AGENT_DEFAULT_INTERVAL_SEC;
    timeoutSec.value = AGENT_DEFAULT_TIMEOUT_SEC;
    thresholdDays.value = TLS_DEFAULT_THRESHOLD_DAYS;
    assignAll.value = true;
    selectedNodeIds.value = [];
    createOpen.value = false;
    toast.success(t("fleet.monitoring.toast.created"));
    refreshAll();
    sheet.open(created.id);
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("fleet.monitoring.toast.createFailed"));
  } finally {
    createPending.value = false;
  }
}

async function deleteMonitor() {
  const target = deleteTarget.value ?? selectedMonitor.value;
  if (!target) return;
  deletePending.value = true;
  try {
    await api.monitors.delete(target.id);
    toast.success(t("fleet.monitoring.toast.deleted"));
    deleteOpen.value = false;
    if (sheet.openId.value === target.id) sheet.close();
    refreshAll();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("fleet.monitoring.toast.deleteFailed"));
  } finally {
    deletePending.value = false;
  }
}

/* ------------------------------------------------------------------ */
/* Head, list and sheet (design 23, 4.2)                               */
/* ------------------------------------------------------------------ */

const proof = useProof(monitorsQuery);
const proofSegments = computed<ProofSegment[]>(() => {
  const out: ProofSegment[] = [{ key: "monitors", text: t("fleet.monitoring.proof.monitors", { n: monitors.value.length }, monitors.value.length) }];
  if (monitors.value.length) out.push({ key: "enabled", text: t("fleet.monitoring.proof.enabled", { n: enabledCount.value }) });
  return out;
});

const columns = computed<DataTableColumn<MonitorView>[]>(() => [
  { key: "name", label: t("fleet.monitoring.table.name"), sortable: true, searchable: true, value: (m) => m.name || m.id },
  { key: "type", label: t("fleet.monitoring.table.type"), sortable: true, searchable: true },
  { key: "target", label: t("fleet.monitoring.table.target"), searchable: true },
  { key: "assignment", label: t("fleet.monitoring.table.checks"), value: (m) => assignmentLabel(m) },
  { key: "interval", label: t("fleet.monitoring.table.every"), sortable: true, value: (m) => m.interval_sec },
  { key: "actions", label: "", class: "w-12", pin: "end" },
]);

const deleteTarget = ref<MonitorView | undefined>();
function requestDelete(monitor: MonitorView) {
  deleteTarget.value = monitor;
  deleteOpen.value = true;
}

function menuFor(monitor: MonitorView): RowMenuItem[] {
  return [
    { key: "delete", label: t("common.actions.delete"), icon: Trash2, danger: true, hidden: !canAdminMonitors.value, run: () => requestDelete(monitor) },
  ];
}

/**
 * The monitor's state from each node's newest result, not from the single
 * newest row: two nodes reporting in the same minute, one passing and one
 * timing out, read "passing" before.
 */
const latestByNode = computed(() => {
  const map = new Map<string, MonitorResult>();
  for (const result of sortedResultsAsc.value) map.set(result.node_id ?? "", result);
  return [...map.values()];
});
const failingNow = computed(() => latestByNode.value.filter((result) => !result.success).length);
const stateBadge = computed<{ variant: "success" | "destructive" | "secondary"; label: string }>(() => {
  if (latestByNode.value.length === 0) return { variant: "secondary", label: t("fleet.monitoring.result.noResult") };
  if (failingNow.value === 0) return { variant: "success", label: t("fleet.monitoring.result.passing") };
  if (latestByNode.value.length === 1) return { variant: "destructive", label: t("fleet.monitoring.result.failing") };
  return { variant: "destructive", label: t("fleet.monitoring.sheet.failingOn", { n: failingNow.value, total: latestByNode.value.length }) };
});

const sheetState = computed(() => {
  if (!selectedMonitorId.value || monitorsQuery.data.value === undefined) return "loading" as const;
  if (!selectedMonitor.value) return "gone" as const;
  return monitorsQuery.error.value ? ("stale" as const) : ("ready" as const);
});

/** What deleting a monitor takes with it (design 23, 3.8: inside Lattice, irreversible). */
const deleteImpact = computed(() => {
  const monitor = deleteTarget.value;
  if (!monitor) return [];
  const lines = [t("fleet.monitoring.confirm.impactHistory")];
  if (monitor.type === "tls") lines.push(t("fleet.monitoring.confirm.impactUpcoming"));
  return lines;
});
</script>

<template>
  <div class="space-y-5 p-4 sm:p-6">
    <PageHeader :title="$t('fleet.monitoring.title')">
      <template #description>
        <p class="text-sm text-muted-foreground">{{ $t('fleet.monitoring.description') }}</p>
        <ProofLine v-if="canReadMonitors" v-bind="proof" :segments="proofSegments" @retry="refreshAll" />
      </template>
      <template v-if="canReadMonitors" #actions>
        <Button v-if="canAdminMonitors && monitors.length" size="sm" type="button" @click="openCreate()">
          <Plus class="size-4" aria-hidden="true" />
          {{ $t('fleet.monitoring.create.title') }}
        </Button>
        <Button variant="outline" size="sm" type="button" :disabled="monitorsQuery.refreshing.value" @click="refreshAll">
          <RefreshCw :class="cn('size-4', monitorsQuery.refreshing.value && 'animate-spin')" aria-hidden="true" />
          {{ $t('common.actions.refresh') }}
        </Button>
      </template>
    </PageHeader>

    <EmptyState
      v-if="!canReadMonitors"
      :icon="RadioTower"
      :title="$t('fleet.monitoring.noAccessTitle')"
      :description="$t('fleet.monitoring.noAccessDescription')"
    />

    <!-- No monitors yet: one sentence and the two watches worth starting with. -->
    <section
      v-else-if="monitorsQuery.data.value !== undefined && monitors.length === 0"
      class="rounded-lg border border-dashed border-border px-5 py-8 text-center"
      aria-labelledby="monitoring-empty"
    >
      <RadioTower class="mx-auto size-6 text-muted-foreground" aria-hidden="true" />
      <h2 id="monitoring-empty" class="mt-3 text-sm font-medium">{{ $t('fleet.monitoring.empty.title') }}</h2>
      <p class="mx-auto mt-1 max-w-lg text-sm text-muted-foreground">
        {{ canAdminMonitors ? $t('fleet.monitoring.empty.description') : $t('fleet.monitoring.definitions.emptyReadOnly') }}
      </p>
      <div v-if="canAdminMonitors" class="mt-4 flex flex-wrap justify-center gap-2">
        <Button size="sm" type="button" @click="openCreate('http')">
          <Globe class="size-4" aria-hidden="true" />
          {{ $t('fleet.monitoring.empty.http') }}
        </Button>
        <Button variant="outline" size="sm" type="button" @click="openCreate('tls')">
          <LockKeyhole class="size-4" aria-hidden="true" />
          {{ $t('fleet.monitoring.empty.tls') }}
        </Button>
      </div>
    </section>

    <DataTable
      v-else
      state-key="monitors"
      :columns="columns"
      :rows="sortedMonitors"
      :row-key="(monitor) => monitor.id"
      :loading="monitorsQuery.loading.value"
      :error="monitorsQuery.error.value ?? null"
      :has-data="monitorsQuery.data.value !== undefined"
      searchable
      :expression-filter="false"
      :search-placeholder="$t('fleet.monitoring.definitions.searchPlaceholder')"
      :row-click="(monitor, el) => sheet.open(monitor.id, el)"
      :active-row-id="sheet.openId.value"
      @retry="monitorsQuery.refresh"
    >
      <template #cell-name="{ row }">
        <span class="flex min-w-0 items-center gap-2">
          <Activity :class="cn('size-4 shrink-0', row.enabled ? 'text-success' : 'text-muted-foreground')" aria-hidden="true" />
          <span class="truncate font-medium">{{ row.name || row.id }}</span>
          <span v-if="!row.enabled" class="shrink-0 text-xs text-muted-foreground">{{ $t('common.status.disabled') }}</span>
        </span>
      </template>
      <template #cell-type="{ row }">
        <span class="font-mono text-xs uppercase">{{ row.type }}</span>
        <span v-if="row.type === 'tls'" class="ms-1.5 text-xs text-muted-foreground">{{ $t('fleet.monitoring.definitions.threshold', { days: row.threshold_days ?? 14 }) }}</span>
      </template>
      <template #cell-target="{ row }">
        <span class="font-mono text-xs">{{ row.target }}</span>
      </template>
      <template #cell-assignment="{ row }">
        <span class="text-xs text-muted-foreground">{{ assignmentLabel(row) }}</span>
      </template>
      <template #cell-interval="{ row }">
        <span class="whitespace-nowrap text-xs text-muted-foreground">{{ $t('fleet.monitoring.definitions.interval', { interval: row.interval_sec, timeout: row.timeout_sec }) }}</span>
      </template>
      <template #cell-actions="{ row }">
        <RowMenu :name="row.name || row.id" :items="menuFor(row)" />
      </template>
    </DataTable>

    <!-- One monitor: its latest state, trend and results. -->
    <ObjectSheet
      :open="!!sheet.openId.value"
      :title="selectedMonitor?.name || selectedMonitor?.id || sheet.openId.value || ''"
      :subtitle="selectedMonitor ? `${selectedMonitor.type.toUpperCase()} · ${selectedMonitor.target}` : undefined"
      :state="sheetState"
      :error="monitorsQuery.error.value?.message ?? null"
      :return-focus="sheet.returnFocus"
      :gone-title="$t('fleet.monitoring.sheet.goneTitle')"
      :gone-description="$t('fleet.monitoring.sheet.goneDescription')"
      @close="sheet.close"
    >
      <div v-if="selectedMonitor" class="space-y-5 text-sm">
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
          <Badge :variant="stateBadge.variant">{{ stateBadge.label }}</Badge>
          <span v-if="latestResult" class="text-xs text-muted-foreground">{{ formatRelativeTime(latestResult.at) }}</span>
          <span class="text-xs text-muted-foreground">{{ assignmentLabel(selectedMonitor) }}</span>
        </div>
        <p v-if="resultsQuery.error.value" class="text-xs text-destructive">{{ resultsQuery.error.value.message }}</p>
        <p v-else-if="resultsQuery.data.value !== undefined && selectedResults.length === 0" class="text-muted-foreground">
          {{ $t('fleet.monitoring.history.emptyDescription') }}
        </p>
        <template v-if="selectedResults.length">
          <dl class="grid grid-cols-3 gap-3">
            <div><dt class="text-xs text-muted-foreground">{{ $t('fleet.monitoring.sheet.success') }}</dt><dd class="font-mono tabular">{{ selectedSuccessRate }}</dd></div>
            <div><dt class="text-xs text-muted-foreground">{{ $t('fleet.monitoring.sheet.average') }}</dt><dd class="font-mono tabular">{{ averageLatency }}</dd></div>
            <div><dt class="text-xs text-muted-foreground">{{ $t('fleet.monitoring.sheet.failures') }}</dt><dd :class="cn('font-mono tabular', failureCount > 0 && 'text-destructive')">{{ failureCount }}</dd></div>
          </dl>

          <section class="space-y-2" :aria-label="$t('fleet.monitoring.history.latencyTrend')">
            <p class="text-xs text-muted-foreground">
              {{ $t('fleet.monitoring.history.latencyTrend') }} · {{ $t('fleet.monitoring.history.successfulProbes') }}
              <template v-if="latencyTrend.length">{{ $t('fleet.monitoring.history.points', { count: latencyTrend.length }) }}</template>
            </p>
            <TrendChart :values="latencyTrend" tone="info" unit="ms" :height="120" :format-value="formatTrendLatency" />
          </section>

          <section class="space-y-2" :aria-label="$t('fleet.monitoring.history.recentChecks')">
            <p class="text-xs text-muted-foreground">{{ $t('fleet.monitoring.history.recentResults', { count: Math.min(recentResults.length, 48) }) }}</p>
            <div class="grid grid-cols-[repeat(24,minmax(0,1fr))] gap-1">
              <Tooltip v-for="result in recentResults.slice(-48)" :key="`${result.monitor_id}:${result.node_id}:${result.at}`">
                <TooltipTrigger as-child>
                  <span :class="cn('h-6 rounded-sm', stripClass(result))" />
                </TooltipTrigger>
                <TooltipContent>
                  <p class="font-medium">{{ nodeName(result.node_id) }}</p>
                  <p class="text-xs">
                    {{ result.success ? $t('fleet.monitoring.result.ok') : $t('common.status.failed') }} · {{ formatLatency(result.latency_ms) }}
                  </p>
                </TooltipContent>
              </Tooltip>
            </div>
          </section>

          <section class="space-y-2" :aria-label="$t('fleet.monitoring.sheet.results')">
            <div class="flex flex-wrap items-center gap-2">
              <div class="flex rounded-md border border-border p-0.5 text-xs" role="group" :aria-label="$t('fleet.monitoring.sheet.results')">
                <button
                  v-for="opt in (['all', 'failures', 'slow'] as const)"
                  :key="opt"
                  type="button"
                  :class="cn('rounded px-2 py-1 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-10', logStatus === opt ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:text-foreground')"
                  :aria-pressed="logStatus === opt"
                  @click="logStatus = opt"
                >
                  {{ $t(`fleet.monitoring.log.${opt}`) }}
                </button>
              </div>
              <Select v-model="logNode">
                <SelectTrigger class="h-8 w-[170px]" :aria-label="$t('fleet.monitoring.log.allNodes')"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{{ $t('fleet.monitoring.log.allNodes') }}</SelectItem>
                  <SelectItem v-for="nid in logNodeOptions" :key="nid" :value="nid">{{ nodeName(nid) }}</SelectItem>
                </SelectContent>
              </Select>
              <Button type="button" size="sm" variant="outline" @click="togglePause">
                <component :is="paused ? Play : Pause" class="size-4" aria-hidden="true" />
                {{ paused ? $t('fleet.monitoring.log.resume') : $t('fleet.monitoring.log.pause') }}
              </Button>
              <span v-if="paused && newSincePause > 0" class="text-xs text-muted-foreground">{{ $t('fleet.monitoring.log.newSince', { count: newSincePause }) }}</span>
            </div>
            <p class="text-xs text-muted-foreground">
              {{ logCapped
                ? $t('fleet.monitoring.log.showingCapped', { count: displayResults.length, total: logMatchTotal, cap: LOG_CAP })
                : $t('fleet.monitoring.log.showingOf', { count: displayResults.length, total: logMatchTotal }) }}
            </p>
            <ul class="divide-y divide-border rounded-md border border-border">
              <li
                v-for="result in displayResults"
                :key="`${result.monitor_id}:${result.node_id}:${result.at}`"
                class="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 px-3 py-2"
              >
                <span class="min-w-0">
                  <span class="block truncate font-medium">{{ nodeName(result.node_id) }}</span>
                  <span v-if="result.error" class="block break-words text-xs text-destructive">{{ result.error }}</span>
                  <span class="block text-xs text-muted-foreground">{{ formatDateTime(result.at) }}</span>
                </span>
                <span class="text-right">
                  <span :class="cn('block text-xs font-medium', result.success ? 'text-foreground' : 'text-destructive')">
                    {{ result.success ? $t('fleet.monitoring.result.ok') : $t('fleet.monitoring.result.fail') }}
                  </span>
                  <span v-if="result.latency_ms !== undefined" :class="cn('block font-mono text-xs tabular', latencyTone(result))">{{ formatLatency(result.latency_ms) }}</span>
                </span>
              </li>
              <li v-if="displayResults.length === 0" class="px-3 py-5 text-center text-xs text-muted-foreground">{{ $t('fleet.monitoring.log.empty') }}</li>
            </ul>
          </section>
        </template>
      </div>
      <template v-if="canAdminMonitors && selectedMonitor" #actions>
        <Button variant="outline" size="sm" type="button" class="text-destructive" :disabled="deletePending" @click="requestDelete(selectedMonitor)">
          <Trash2 class="size-4" aria-hidden="true" />
          {{ $t('common.actions.delete') }}
        </Button>
      </template>
    </ObjectSheet>

    <!-- Create in a sheet, from the header or the empty state. -->
    <ObjectSheet :open="createOpen" :title="$t('fleet.monitoring.create.title')" @close="createOpen = false">
      <form id="monitor-create" class="space-y-4" @submit.prevent="createMonitor">
        <p class="text-sm text-muted-foreground">{{ $t('fleet.monitoring.create.description') }}</p>
        <div class="grid gap-2">
          <Label for="monitor-type">{{ $t('fleet.monitoring.create.type') }}</Label>
          <Select v-model="monitorType">
            <SelectTrigger id="monitor-type"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem v-for="option in MONITOR_TYPES" :key="option" :value="option">{{ option.toUpperCase() }}</SelectItem>
            </SelectContent>
          </Select>
          <p v-if="isCertWatch" class="text-xs text-muted-foreground">{{ $t('fleet.monitoring.create.tlsHint') }}</p>
        </div>
        <div class="grid gap-2">
          <Label for="monitor-name">{{ $t('fleet.monitoring.create.name') }}</Label>
          <Input id="monitor-name" v-model="monitorName" required :placeholder="$t('fleet.monitoring.create.namePlaceholder')" />
        </div>
        <div class="grid gap-2">
          <Label for="monitor-target">{{ $t('fleet.monitoring.create.target') }}</Label>
          <Input
            id="monitor-target"
            v-model="monitorTarget"
            required
            :aria-invalid="!!tlsTargetProblem"
            :aria-describedby="tlsTargetProblem ? 'monitor-target-error' : undefined"
            :placeholder="isCertWatch ? $t('fleet.monitoring.create.targetTlsPlaceholder') : monitorType === 'tcp' ? $t('fleet.monitoring.create.targetTcpPlaceholder') : $t('fleet.monitoring.create.targetHttpPlaceholder')"
          />
          <p v-if="tlsTargetProblem" id="monitor-target-error" role="alert" class="text-xs text-destructive">{{ $t('fleet.monitoring.create.targetTlsError') }}</p>
        </div>
        <div v-if="isCertWatch" class="grid gap-2">
          <Label for="monitor-threshold">{{ $t('fleet.monitoring.create.thresholdDays') }}</Label>
          <Input id="monitor-threshold" v-model="thresholdDays" type="number" min="1" :max="TLS_MAX_THRESHOLD_DAYS" />
          <p class="text-xs text-muted-foreground">{{ $t('fleet.monitoring.create.thresholdHint', { days: thresholdDays }) }}</p>
        </div>
        <div v-else class="grid gap-2">
          <Label>{{ $t('fleet.monitoring.create.assignment') }}</Label>
          <div class="grid grid-cols-2 rounded-md border border-input p-1" role="group">
            <button
              type="button"
              :class="cn('rounded px-2 py-1.5 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-10', assignAll && 'bg-secondary font-medium text-foreground')"
              :aria-pressed="assignAll"
              @click="assignAll = true"
            >
              {{ $t('fleet.monitoring.create.all') }}
            </button>
            <button
              type="button"
              :class="cn('rounded px-2 py-1.5 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-10', !assignAll && 'bg-secondary font-medium text-foreground')"
              :aria-pressed="!assignAll"
              @click="assignAll = false"
            >
              {{ $t('fleet.monitoring.create.selected') }}
            </button>
          </div>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <div class="grid gap-2">
            <Label for="monitor-interval">{{ $t('fleet.monitoring.create.intervalSec') }}</Label>
            <Input id="monitor-interval" v-model="intervalSec" type="number" min="5" max="86400" />
          </div>
          <div class="grid gap-2">
            <Label for="monitor-timeout">{{ $t('fleet.monitoring.create.timeoutSec') }}</Label>
            <Input id="monitor-timeout" v-model="timeoutSec" type="number" min="1" max="300" />
          </div>
        </div>
        <div v-if="!assignAll && !isCertWatch">
          <div v-if="canReadNodes" class="grid max-h-64 gap-1 overflow-auto rounded-md border border-border p-1.5">
            <p v-if="nodes.length === 0" class="p-2 text-xs text-muted-foreground">{{ $t('fleet.monitoring.create.noNodesDescription') }}</p>
            <label v-for="node in nodes" :key="node.id" class="flex items-center gap-2 rounded-md p-2 text-sm hover:bg-muted/40">
              <Checkbox :model-value="selectedNodeIds.includes(node.id)" @update:model-value="(value) => toggleAssignedNode(node.id, value === true)" />
              <span class="min-w-0 flex-1 truncate" :title="node.name || node.id">{{ node.name || node.id }}</span>
              <span class="text-xs text-muted-foreground">{{ node.online ? $t('fleet.monitoring.result.on') : $t('fleet.monitoring.result.off') }}</span>
            </label>
          </div>
          <div v-else class="grid gap-2">
            <Label for="monitor-node-ids">{{ $t('fleet.monitoring.create.nodeIds') }}</Label>
            <Input id="monitor-node-ids" v-model="selectedNodeIdsInput" :placeholder="$t('fleet.monitoring.create.nodeIdsPlaceholder')" />
            <p class="text-xs text-muted-foreground">{{ $t('fleet.monitoring.create.nodeIdsManualHint') }}</p>
          </div>
        </div>
      </form>
      <template #actions>
        <Button variant="outline" size="sm" type="button" @click="createOpen = false">{{ $t('common.actions.cancel') }}</Button>
        <Button type="submit" form="monitor-create" size="sm" :disabled="createPending || !canSubmit">
          <RefreshCw v-if="createPending" class="size-4 animate-spin" aria-hidden="true" />
          <Plus v-else class="size-4" aria-hidden="true" />
          {{ $t('fleet.monitoring.create.submit') }}
        </Button>
      </template>
    </ObjectSheet>

    <ConfirmDialog
      v-model:open="deleteOpen"
      :title="$t('fleet.monitoring.confirm.deleteTitle')"
      :description="deleteTarget ? $t('fleet.monitoring.confirm.delete', { name: deleteTarget.name || deleteTarget.id }) : ''"
      :impact="deleteImpact"
      :confirm-label="$t('common.actions.delete')"
      :cancel-label="$t('common.actions.cancel')"
      :pending="deletePending"
      @confirm="deleteMonitor"
    />
  </div>
</template>
