<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import {
  Activity,
  CheckCircle2,
  Funnel,
  Gauge,
  Pause,
  Play,
  Plus,
  RadioTower,
  RefreshCw,
  Search,
  Timer,
  Trash2,
  XCircle,
} from "lucide-vue-next";
import { api, unwrap, type MonitorResult, type MonitorView, type Node } from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { useAuthStore } from "@/stores/auth";
import { formatDateTime, formatPercent, formatRelativeTime, shortId } from "@/lib/format";
import { evalFilterExpression, tokenMatchesText } from "@/lib/filterExpressions";
import { cn } from "@/lib/utils";

import { latencyClass } from "@/lib/latency";

import PageHeader from "@/components/common/PageHeader.vue";
import FreshnessLabel from "@/components/common/FreshnessLabel.vue";
import ConfirmDialog from "@/components/common/ConfirmDialog.vue";
import DataState from "@/components/common/DataState.vue";
import EmptyState from "@/components/common/EmptyState.vue";
import StatCard from "@/components/common/StatCard.vue";
import TrendChart from "@/components/common/TrendChart.vue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
  () => {
    if (!canReadMonitors.value) return Promise.resolve([] as MonitorView[]);
    return api.monitors.list().then((r) => unwrap(r, "monitors"));
  },
  {
    pollInterval: 10000,
    immediate: canReadMonitors.value,
  },
);
const nodesQuery = useAsyncData(
  () => {
    if (!canReadNodes.value) return Promise.resolve([] as Node[]);
    return api.nodes.list().then((r) => unwrap(r, "nodes"));
  },
  {
    pollInterval: 15000,
    immediate: canReadNodes.value,
  },
);

// Seed from a /monitoring/:id deep link; the monitors watch validates it once
// the list loads (falling back to the first monitor if the id is unknown).
const selectedMonitorId = ref(typeof route.params.id === "string" ? route.params.id : "");
const createPending = ref(false);
const deletePending = ref(false);
const deleteOpen = ref(false);

const monitorName = ref("");
const monitorType = ref<"tcp" | "http">("tcp");
const monitorTarget = ref("");
const intervalSec = ref(30);
const timeoutSec = ref(5);
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

/** The assignment picker is a checkbox list writing into one array of ids. */
function toggleAssignedNode(id: string, on: boolean) {
  const has = selectedNodeIds.value.includes(id);
  if (on && !has) selectedNodeIds.value = [...selectedNodeIds.value, id];
  else if (!on && has) selectedNodeIds.value = selectedNodeIds.value.filter((n) => n !== id);
}

const resultsQuery = useAsyncData(
  () => {
    if (!canReadMonitors.value || !selectedMonitorId.value) return Promise.resolve([] as MonitorResult[]);
    return api.monitors.results(selectedMonitorId.value).then((r) => unwrap(r, "results"));
  },
  { pollInterval: 8000, immediate: canReadMonitors.value },
);

const monitors = computed(() => monitorsQuery.data.value ?? []);
const nodes = computed(() => nodesQuery.data.value ?? []);
const selectedMonitor = computed(() =>
  monitors.value.find((monitor) => monitor.id === selectedMonitorId.value),
);
const selectedResults = computed(() => resultsQuery.data.value ?? []);

const monitorSearch = ref("");
const monitorExpression = ref("");

const monitorExpressionError = computed(() => {
  const expr = monitorExpression.value.trim();
  if (!expr) return "";
  const result = evalFilterExpression(expr, () => true);
  return result.ok ? "" : result.error ?? t("fleet.monitoring.definitions.expressionInvalid");
});

function monitorFieldValues(monitor: MonitorView, rawField: string): string[] {
  const field = rawField.trim().toLowerCase().replace(/[\s-]+/g, "_");
  switch (field) {
    case "id":
    case "monitor":
    case "monitor_id":
      return [monitor.id, shortId(monitor.id)];
    case "name":
      return [monitor.name];
    case "type":
    case "protocol":
      return [monitor.type];
    case "target":
    case "host":
    case "url":
      return [monitor.target];
    case "status":
    case "state":
      return [monitor.enabled ? "enabled" : "disabled", monitor.enabled ? "on" : "off"];
    case "enabled":
      return [String(monitor.enabled), monitor.enabled ? "true" : "false"];
    case "interval":
    case "interval_sec":
      return [String(monitor.interval_sec)];
    case "timeout":
    case "timeout_sec":
      return [String(monitor.timeout_sec)];
    case "scope":
    case "assign":
    case "assignment":
      return [monitor.assign_all ? "all" : "selected"];
    case "node":
    case "node_id":
      return monitor.assign_all ? ["all"] : monitor.node_ids ?? [];
    case "created":
    case "created_at":
      return [monitor.created_at ?? ""];
    case "updated":
    case "updated_at":
      return [monitor.updated_at ?? ""];
    default:
      return [];
  }
}

function monitorHaystack(monitor: MonitorView): string {
  return [
    monitor.id,
    shortId(monitor.id),
    monitor.name,
    monitor.type,
    monitor.target,
    monitor.enabled ? "enabled on" : "disabled off",
    monitor.assign_all ? "all" : "selected",
    monitor.interval_sec,
    monitor.timeout_sec,
    ...(monitor.node_ids ?? []),
    monitor.created_at,
    monitor.updated_at,
  ]
    .filter((value) => value !== undefined && value !== null && value !== "")
    .join(" ");
}

function monitorMatchesExpression(monitor: MonitorView): boolean {
  const expr = monitorExpression.value.trim();
  if (!expr || monitorExpressionError.value) return true;
  const result = evalFilterExpression(expr, (rawToken) => {
    const splitAt = rawToken.indexOf(":");
    if (splitAt > 0) {
      const values = monitorFieldValues(monitor, rawToken.slice(0, splitAt));
      const needle = rawToken.slice(splitAt + 1).trim();
      return values.length > 0 && values.some((value) => tokenMatchesText(value, needle));
    }
    return tokenMatchesText(monitorHaystack(monitor), rawToken);
  });
  return result.ok ? result.value : true;
}

const sortedMonitors = computed(() => {
  const q = monitorSearch.value.trim().toLowerCase();
  return [...monitors.value]
    .filter(
      (m) =>
        monitorMatchesExpression(m) &&
        (!q || [m.name, m.id, m.target, m.type].some((v) => (v ?? "").toLowerCase().includes(q))),
    )
    .sort((a, b) => {
      if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
      return (a.name || a.id).localeCompare(b.name || b.id);
    });
});

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
const canSubmit = computed(
  () =>
    !!monitorName.value.trim() &&
    !!monitorTarget.value.trim() &&
    (assignAll.value || selectedNodeIds.value.length > 0),
);

// Chronological latency series for the TrendChart: successful results only,
// ordered oldest → newest, with null/undefined latency dropped.
const latencyTrend = computed<number[]>(() =>
  sortedResultsAsc.value
    .filter((result) => result.success)
    .map((result) => result.latency_ms)
    .filter((value): value is number => value !== undefined && Number.isFinite(value)),
);

function formatTrendLatency(n: number): string {
  return `${Math.round(n)}ms`;
}

watch(
  monitors,
  (list) => {
    if (list.length === 0) {
      selectedMonitorId.value = "";
      return;
    }
    const first = list[0];
    if (first && (!selectedMonitorId.value || !list.some((monitor) => monitor.id === selectedMonitorId.value))) {
      selectedMonitorId.value = first.id;
    }
  },
  { immediate: true },
);

watch(selectedMonitorId, (id) => {
  resultsQuery.refresh();
  // Keep the URL in sync so the current monitor is shareable/bookmarkable.
  // replace (not push) avoids polluting history as the operator scans monitors.
  if (id && route.params.id !== id) {
    router.replace({ name: "monitor-detail", params: { id } }).catch(() => {});
  }
});

// Honor in-session URL changes (back/forward, a pasted link) when the id is a
// known monitor. Guarded against the id we just wrote, so there is no loop.
watch(
  () => route.params.id,
  (id) => {
    if (
      typeof id === "string" &&
      id &&
      id !== selectedMonitorId.value &&
      monitors.value.some((monitor) => monitor.id === id)
    ) {
      selectedMonitorId.value = id;
    }
  },
);

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
  return nodes.value.find((node) => node.id === id)?.name || shortId(id, 14);
}

function assignmentLabel(monitor: MonitorView): string {
  if (monitor.assign_all) return t("fleet.monitoring.assignment.allNodes");
  const count = monitor.node_ids?.length ?? 0;
  return t("fleet.monitoring.assignment.nodeCount", { count });
}

function resultVariant(result?: MonitorResult): "success" | "destructive" | "secondary" {
  if (!result) return "secondary";
  return result.success ? "success" : "destructive";
}

function resultLabel(result?: MonitorResult): string {
  if (!result) return t("fleet.monitoring.result.noResult");
  return result.success ? t("fleet.monitoring.result.passing") : t("fleet.monitoring.result.failing");
}

/**
 * Map a latency band token to LITERAL Tailwind classes. latency.ts is the SSOT
 * for the band thresholds; we expand to full static strings here so Tailwind v4's
 * content scanner can see every candidate (runtime-built `bg-${token}` would not
 * be generated). Background tile + matching text color for the legend/labels.
 */
const LATENCY_BG: Record<string, string> = {
  success: "bg-success/80",
  "chart-2": "bg-chart-2/80",
  warning: "bg-warning/80",
  destructive: "bg-destructive/80",
  "muted-foreground": "bg-muted-foreground/80",
};
const LATENCY_TEXT: Record<string, string> = {
  success: "text-success",
  "chart-2": "text-chart-2",
  warning: "text-warning",
  destructive: "text-destructive",
  "muted-foreground": "text-muted-foreground",
};

/** Heat-strip tile color: a failed probe is loss (destructive); a passing probe
 *  is graded by its latency band via the shared latency scale (src/lib/latency.ts). */
function resultBarClass(result: MonitorResult): string {
  if (!result.success) return "bg-destructive/80";
  return LATENCY_BG[latencyClass(result.latency_ms)] ?? "bg-muted-foreground/80";
}

/** Latency text color (graded) for numeric latency labels. */
function latencyText(ms?: number): string {
  return LATENCY_TEXT[latencyClass(ms)] ?? "text-muted-foreground";
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
function focusCreateMonitor() {
  const el = document.getElementById("monitor-name");
  if (!(el instanceof HTMLInputElement)) return;
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: "center", behavior: "smooth" });
}

async function createMonitor() {
  if (!canSubmit.value) return;
  createPending.value = true;
  try {
    const created = await api.monitors.create({
      name: monitorName.value.trim(),
      type: monitorType.value,
      target: monitorTarget.value.trim(),
      interval_sec: Number(intervalSec.value),
      timeout_sec: Number(timeoutSec.value),
      assign_all: assignAll.value,
      node_ids: assignAll.value ? undefined : selectedNodeIds.value,
    });
    monitorName.value = "";
    monitorType.value = "tcp";
    monitorTarget.value = "";
    intervalSec.value = 30;
    timeoutSec.value = 5;
    assignAll.value = true;
    selectedNodeIds.value = [];
    selectedMonitorId.value = created.id;
    toast.success(t("fleet.monitoring.toast.created"));
    refreshAll();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("fleet.monitoring.toast.createFailed"));
  } finally {
    createPending.value = false;
  }
}

async function deleteMonitor() {
  if (!selectedMonitor.value) return;
  deletePending.value = true;
  try {
    await api.monitors.delete(selectedMonitor.value.id);
    toast.success(t("fleet.monitoring.toast.deleted"));
    selectedMonitorId.value = "";
    deleteOpen.value = false;
    refreshAll();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("fleet.monitoring.toast.deleteFailed"));
  } finally {
    deletePending.value = false;
  }
}
</script>

<template>
  <div class="p-6 space-y-6">
    <PageHeader :title="$t('fleet.monitoring.title')" :description="$t('fleet.monitoring.description')">
      <template #status>
        <FreshnessLabel :last-updated="monitorsQuery.lastUpdated.value" />
      </template>
      <template #actions>
        <Button
          v-if="canReadMonitors"
          variant="outline"
          size="sm"
          :disabled="monitorsQuery.refreshing.value || resultsQuery.refreshing.value"
          @click="refreshAll"
        >
          <RefreshCw
            :class="cn('size-4', (monitorsQuery.refreshing.value || resultsQuery.refreshing.value) && 'animate-spin')"
            aria-hidden="true"
          />
          {{ $t('common.actions.refresh') }}
        </Button>
      </template>
    </PageHeader>

    <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <StatCard :label="$t('fleet.monitoring.stats.monitors')" :value="monitors.length" :icon="RadioTower" />
      <StatCard :label="$t('fleet.monitoring.stats.enabled')" :value="enabledCount" :icon="Activity" tone="success" />
      <StatCard :label="$t('fleet.monitoring.stats.selectedSuccess')" :value="selectedSuccessRate" :icon="CheckCircle2" :tone="failureCount > 0 ? 'warning' : 'success'" />
      <StatCard :label="$t('fleet.monitoring.stats.averageLatency')" :value="averageLatency" :icon="Gauge" />
    </div>

    <div class="grid gap-6 xl:grid-cols-[minmax(0,1fr)_420px]">
      <Card>
        <CardHeader>
          <CardTitle class="flex items-center gap-2">
            <RadioTower class="size-4 text-muted-foreground" aria-hidden="true" />
            {{ $t('fleet.monitoring.definitions.title') }}
          </CardTitle>
          <CardDescription>{{ $t('fleet.monitoring.definitions.description', { enabled: enabledCount, total: monitors.length }) }}</CardDescription>
        </CardHeader>
        <CardContent>
          <div class="mb-3 space-y-2">
            <div class="flex flex-col gap-2 lg:flex-row">
              <div class="relative min-w-[220px] flex-1">
                <Search class="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" aria-hidden="true" />
                <Input v-model="monitorSearch" class="pl-8" :placeholder="$t('fleet.monitoring.definitions.searchPlaceholder')" />
              </div>
              <div class="relative min-w-[260px] flex-1">
                <Funnel class="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" aria-hidden="true" />
                <Input
                  v-model="monitorExpression"
                  class="pl-8 font-mono text-xs"
                  :class="monitorExpressionError && 'border-destructive focus-visible:ring-destructive/20'"
                  :placeholder="$t('fleet.monitoring.definitions.expressionPlaceholder')"
                  :aria-label="$t('fleet.monitoring.definitions.expressionLabel')"
                />
              </div>
            </div>
            <p class="text-xs" :class="monitorExpressionError ? 'text-destructive' : 'text-muted-foreground'">
              {{ monitorExpressionError || $t('fleet.monitoring.definitions.expressionHelp') }}
            </p>
          </div>
          <DataState
            :loading="monitorsQuery.loading.value"
            :error="monitorsQuery.error.value"
            :has-data="monitorsQuery.data.value !== undefined"
            :is-empty="sortedMonitors.length === 0"
            @retry="monitorsQuery.refresh"
          >
            <!-- Two different nothings: a filter that hid everything, and a
                 server with no monitors at all. Only the second one gets a
                 create action, and only for a token that can use it. -->
            <template #empty>
              <EmptyState
                :icon="monitors.length ? Search : RadioTower"
                :title="monitors.length ? $t('fleet.monitoring.definitions.noMatchTitle') : $t('fleet.monitoring.definitions.emptyTitle')"
                :description="
                  monitors.length
                    ? $t('fleet.monitoring.definitions.noMatchDescription')
                    : canAdminMonitors
                      ? $t('fleet.monitoring.definitions.emptyDescription')
                      : $t('fleet.monitoring.definitions.emptyReadOnly')
                "
              >
                <Button v-if="!monitors.length && canAdminMonitors" size="sm" @click="focusCreateMonitor">
                  <Plus class="size-4" aria-hidden="true" />
                  {{ $t('fleet.monitoring.definitions.emptyAction') }}
                </Button>
              </EmptyState>
            </template>

            <div class="space-y-3">
              <button
                v-for="monitor in sortedMonitors"
                :key="monitor.id"
                type="button"
                :class="cn(
                  'w-full rounded-lg border border-border p-4 text-left transition-colors hover:bg-muted/35',
                  selectedMonitorId === monitor.id && 'border-primary bg-primary/5',
                )"
                @click="selectedMonitorId = monitor.id"
              >
                <div class="flex flex-wrap items-start justify-between gap-3">
                  <div class="min-w-0">
                    <div class="flex min-w-0 items-center gap-2">
                      <Activity
                        :class="cn('size-4 shrink-0', monitor.enabled ? 'text-success' : 'text-muted-foreground')"
                        aria-hidden="true"
                      />
                      <span class="truncate font-medium" :title="monitor.name || monitor.id">{{ monitor.name || monitor.id }}</span>
                    </div>
                    <p class="mt-1 break-all font-mono text-xs text-muted-foreground">
                      {{ monitor.target }}
                    </p>
                  </div>
                  <div class="flex flex-wrap justify-end gap-1.5">
                    <Badge variant="outline">{{ monitor.type }}</Badge>
                    <Badge :variant="monitor.enabled ? 'success' : 'secondary'">
                      {{ monitor.enabled ? $t('common.status.enabled') : $t('common.status.disabled') }}
                    </Badge>
                    <Badge
                      v-if="selectedMonitorId === monitor.id"
                      :variant="resultVariant(latestResult)"
                    >
                      {{ resultLabel(latestResult) }}
                    </Badge>
                  </div>
                </div>

                <div class="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <span class="inline-flex items-center gap-1">
                    <Timer class="size-3" aria-hidden="true" />
                    {{ $t('fleet.monitoring.definitions.interval', { interval: monitor.interval_sec, timeout: monitor.timeout_sec }) }}
                  </span>
                  <span>{{ assignmentLabel(monitor) }}</span>
                  <span v-if="monitor.updated_at">{{ $t('fleet.monitoring.definitions.updated', { time: formatRelativeTime(monitor.updated_at) }) }}</span>
                </div>
              </button>
            </div>
          </DataState>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle class="flex items-center gap-2">
            <Plus class="size-4 text-muted-foreground" aria-hidden="true" />
            {{ $t('fleet.monitoring.create.title') }}
          </CardTitle>
          <CardDescription>{{ $t('fleet.monitoring.create.description') }}</CardDescription>
        </CardHeader>
        <CardContent>
          <form v-if="canAdminMonitors" class="space-y-4" @submit.prevent="createMonitor">
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
                :placeholder="monitorType === 'tcp' ? $t('fleet.monitoring.create.targetTcpPlaceholder') : $t('fleet.monitoring.create.targetHttpPlaceholder')"
              />
            </div>

            <div class="grid gap-3 sm:grid-cols-2">
              <div class="grid gap-2">
                <Label for="monitor-type">{{ $t('fleet.monitoring.create.type') }}</Label>
                <Select v-model="monitorType">
                  <SelectTrigger id="monitor-type">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="tcp">TCP</SelectItem>
                    <SelectItem value="http">HTTP</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div class="grid gap-2">
                <Label>{{ $t('fleet.monitoring.create.assignment') }}</Label>
                <div class="grid grid-cols-2 rounded-md border border-input p-1">
                  <button
                    type="button"
                    :class="cn('rounded px-2 py-1.5 text-sm transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50', assignAll && 'bg-primary text-primary-foreground')"
                    :aria-pressed="assignAll"
                    @click="assignAll = true"
                  >
                    {{ $t('fleet.monitoring.create.all') }}
                  </button>
                  <button
                    type="button"
                    :class="cn('rounded px-2 py-1.5 text-sm transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50', !assignAll && 'bg-primary text-primary-foreground')"
                    :aria-pressed="!assignAll"
                    @click="assignAll = false"
                  >
                    {{ $t('fleet.monitoring.create.selected') }}
                  </button>
                </div>
              </div>
            </div>

            <div class="grid gap-3 sm:grid-cols-2">
              <div class="grid gap-2">
                <Label for="monitor-interval">{{ $t('fleet.monitoring.create.intervalSec') }}</Label>
                <Input id="monitor-interval" v-model="intervalSec" type="number" min="5" max="86400" />
              </div>
              <div class="grid gap-2">
                <Label for="monitor-timeout">{{ $t('fleet.monitoring.create.timeoutSec') }}</Label>
                <Input id="monitor-timeout" v-model="timeoutSec" type="number" min="1" max="300" />
              </div>
            </div>

            <div v-if="!assignAll">
              <DataState
                v-if="canReadNodes"
                :loading="nodesQuery.loading.value"
                :error="nodesQuery.error.value"
                :has-data="nodesQuery.data.value !== undefined"
                :is-empty="nodes.length === 0"
                :empty-title="$t('fleet.monitoring.create.noNodesTitle')"
                :empty-description="$t('fleet.monitoring.create.noNodesDescription')"
                :skeleton-rows="2"
                @retry="nodesQuery.refresh"
              >
                <div class="grid max-h-64 gap-2 overflow-auto rounded-md border border-border p-2">
                  <label
                    v-for="node in nodes"
                    :key="node.id"
                    class="flex items-center gap-2 rounded-md p-2 text-sm hover:bg-muted/40"
                  >
                    <Checkbox
                      :model-value="selectedNodeIds.includes(node.id)"
                      @update:model-value="(value) => toggleAssignedNode(node.id, value === true)"
                    />
                    <span class="min-w-0 flex-1 truncate" :title="node.name || node.id">{{ node.name || node.id }}</span>
                    <Badge :variant="node.online ? 'success' : 'secondary'">{{ node.online ? $t('fleet.monitoring.result.on') : $t('fleet.monitoring.result.off') }}</Badge>
                  </label>
                </div>
              </DataState>
              <div v-else class="grid gap-2">
                <Label for="monitor-node-ids">{{ $t('fleet.monitoring.create.nodeIds') }}</Label>
                <Input
                  id="monitor-node-ids"
                  v-model="selectedNodeIdsInput"
                  :placeholder="$t('fleet.monitoring.create.nodeIdsPlaceholder')"
                />
                <p class="text-xs text-muted-foreground">{{ $t('fleet.monitoring.create.nodeIdsManualHint') }}</p>
              </div>
            </div>

            <Button type="submit" :disabled="createPending || !canSubmit">
              <RefreshCw v-if="createPending" class="size-4 animate-spin" aria-hidden="true" />
              <Plus v-else class="size-4" aria-hidden="true" />
              {{ $t('fleet.monitoring.create.submit') }}
            </Button>
          </form>

          <EmptyState
            v-else
            :title="$t('fleet.monitoring.create.readOnlyTitle')"
            :description="$t('fleet.monitoring.create.readOnlyDescription')"
          />
        </CardContent>
      </Card>
    </div>

    <Card>
      <CardHeader>
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle class="flex items-center gap-2">
              <Activity class="size-4 text-muted-foreground" aria-hidden="true" />
              {{ $t('fleet.monitoring.history.title') }}
            </CardTitle>
            <CardDescription>
              <template v-if="selectedMonitor">
                {{ selectedMonitor.name }} - {{ selectedMonitor.target }}
              </template>
              <template v-else>{{ $t('fleet.monitoring.history.selectPrompt') }}</template>
            </CardDescription>
          </div>
          <Button
            v-if="canAdminMonitors && selectedMonitor"
            variant="destructive"
            size="sm"
            :disabled="deletePending"
            @click="deleteOpen = true"
          >
            <RefreshCw v-if="deletePending" class="size-4 animate-spin" aria-hidden="true" />
            <Trash2 v-else class="size-4" aria-hidden="true" />
            {{ $t('common.actions.delete') }}
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        <DataState
          :loading="resultsQuery.loading.value && !!selectedMonitor"
          :error="resultsQuery.error.value"
          :has-data="resultsQuery.data.value !== undefined"
          :is-empty="!selectedMonitor || selectedResults.length === 0"
          :empty-title="selectedMonitor ? $t('fleet.monitoring.history.emptyTitle') : $t('fleet.monitoring.history.noSelectionTitle')"
          :empty-description="selectedMonitor ? $t('fleet.monitoring.history.emptyDescription') : $t('fleet.monitoring.history.noSelectionDescription')"
          @retry="resultsQuery.refresh"
        >
          <div class="space-y-5">
            <div class="rounded-lg border border-border bg-muted/20 p-4">
              <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p class="text-sm font-medium">{{ $t('fleet.monitoring.history.latencyTrend') }}</p>
                  <p class="text-xs text-muted-foreground">
                    {{ $t('fleet.monitoring.history.successfulProbes') }}
                    <template v-if="latencyTrend.length">
                      {{ $t('fleet.monitoring.history.points', { count: latencyTrend.length }) }}
                    </template>
                  </p>
                </div>
                <Badge :variant="resultVariant(latestResult)">{{ resultLabel(latestResult) }}</Badge>
              </div>
              <TrendChart
                :values="latencyTrend"
                tone="info"
                unit="ms"
                :height="140"
                :format-value="formatTrendLatency"
              />
            </div>

            <div class="rounded-lg border border-border p-4">
              <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p class="text-sm font-medium">{{ $t('fleet.monitoring.history.recentChecks') }}</p>
                  <p class="text-xs text-muted-foreground">{{ $t('fleet.monitoring.history.recentResults', { count: recentResults.length }) }}</p>
                </div>
                <div class="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                  <span>{{ $t('fleet.monitoring.history.successSuffix', { rate: selectedSuccessRate }) }}</span>
                  <span>{{ $t('fleet.monitoring.history.averageSuffix', { latency: averageLatency }) }}</span>
                </div>
              </div>
              <div class="grid grid-cols-[repeat(24,minmax(0,1fr))] gap-1">
                <Tooltip
                  v-for="result in recentResults.slice(-48)"
                  :key="`${result.monitor_id}:${result.node_id}:${result.at}`"
                >
                  <TooltipTrigger as-child>
                    <span :class="cn('h-8 rounded-sm', resultBarClass(result))" />
                  </TooltipTrigger>
                  <TooltipContent>
                    <p class="font-medium">{{ nodeName(result.node_id) }}</p>
                    <p class="text-xs">
                      <span :class="result.success ? latencyText(result.latency_ms) : 'text-destructive'">
                        {{ result.success ? $t('fleet.monitoring.result.ok') : $t('common.status.failed') }}
                      </span>
                      · {{ formatLatency(result.latency_ms) }}
                    </p>
                  </TooltipContent>
                </Tooltip>
              </div>
              <p class="mt-3 text-xs text-muted-foreground">
                {{ $t('fleet.monitoring.history.failuresInHistory', { count: failureCount }) }}
              </p>
            </div>

            <div class="flex flex-wrap items-center gap-2">
              <div class="flex rounded-md border border-border p-0.5 text-xs">
                <button
                  v-for="opt in (['all', 'failures', 'slow'] as const)"
                  :key="opt"
                  type="button"
                  :class="cn('rounded px-2 py-1 transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50', logStatus === opt ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:text-foreground')"
                  :aria-pressed="logStatus === opt"
                  @click="logStatus = opt"
                >
                  {{ $t(`fleet.monitoring.log.${opt}`) }}
                </button>
              </div>
              <Select v-model="logNode">
                <SelectTrigger class="h-8 w-[170px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{{ $t('fleet.monitoring.log.allNodes') }}</SelectItem>
                  <SelectItem v-for="nid in logNodeOptions" :key="nid" :value="nid">{{ nodeName(nid) }}</SelectItem>
                </SelectContent>
              </Select>
              <Button type="button" size="sm" :variant="paused ? 'default' : 'outline'" @click="togglePause">
                <component :is="paused ? Play : Pause" class="size-4" aria-hidden="true" />
                {{ paused ? $t('fleet.monitoring.log.resume') : $t('fleet.monitoring.log.pause') }}
              </Button>
              <span v-if="paused && newSincePause > 0" class="text-xs text-muted-foreground">
                {{ $t('fleet.monitoring.log.newSince', { count: newSincePause }) }}
              </span>
              <span class="ms-auto text-xs text-muted-foreground">
                {{ logCapped
                  ? $t('fleet.monitoring.log.showingCapped', { count: displayResults.length, total: logMatchTotal, cap: LOG_CAP })
                  : $t('fleet.monitoring.log.showingOf', { count: displayResults.length, total: logMatchTotal }) }}
              </span>
            </div>
            <div class="overflow-x-auto rounded-lg border border-border">
              <div class="min-w-[640px]">
                <div class="grid grid-cols-[1fr_96px_96px_132px] gap-3 border-b border-border bg-muted/40 px-3 py-2 text-xs font-medium text-muted-foreground">
                  <span>{{ $t('fleet.monitoring.history.colNode') }}</span>
                  <span>{{ $t('fleet.monitoring.history.colStatus') }}</span>
                  <span>{{ $t('fleet.monitoring.history.colLatency') }}</span>
                  <span>{{ $t('fleet.monitoring.history.colObserved') }}</span>
                </div>
                <div
                  v-for="result in displayResults"
                  :key="`${result.monitor_id}:${result.node_id}:${result.at}`"
                  class="grid grid-cols-[1fr_96px_96px_132px] gap-3 border-b border-border px-3 py-3 text-sm last:border-b-0"
                >
                  <div class="min-w-0">
                    <p class="truncate font-medium" :title="nodeName(result.node_id)">{{ nodeName(result.node_id) }}</p>
                    <p v-if="result.error" class="mt-1 break-words text-xs text-destructive">{{ result.error }}</p>
                  </div>
                  <div>
                    <Badge :variant="result.success ? 'success' : 'destructive'">
                      <CheckCircle2 v-if="result.success" class="size-3" aria-hidden="true" />
                      <XCircle v-else class="size-3" aria-hidden="true" />
                      {{ result.success ? $t('fleet.monitoring.result.ok') : $t('fleet.monitoring.result.fail') }}
                    </Badge>
                  </div>
                  <span class="font-mono text-xs text-muted-foreground">{{ formatLatency(result.latency_ms) }}</span>
                  <span class="text-xs text-muted-foreground">{{ formatDateTime(result.at) }}</span>
                </div>
                <div v-if="displayResults.length === 0" class="px-3 py-6 text-center text-xs text-muted-foreground">
                  {{ $t('fleet.monitoring.log.empty') }}
                </div>
              </div>
            </div>
          </div>
        </DataState>
      </CardContent>
    </Card>

    <ConfirmDialog
      v-model:open="deleteOpen"
      :title="$t('fleet.monitoring.confirm.deleteTitle')"
      :description="selectedMonitor ? $t('fleet.monitoring.confirm.delete', { name: selectedMonitor.name || selectedMonitor.id }) : ''"
      :confirm-label="$t('common.actions.delete')"
      :cancel-label="$t('common.actions.cancel')"
      :pending="deletePending"
      @confirm="deleteMonitor"
    />
  </div>
</template>
