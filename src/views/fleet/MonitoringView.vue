<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import {
  Activity,
  CheckCircle2,
  Gauge,
  Plus,
  RadioTower,
  RefreshCw,
  Timer,
  Trash2,
  XCircle,
} from "lucide-vue-next";
import { api, unwrap, type MonitorResult, type MonitorView } from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { useAuthStore } from "@/stores/auth";
import { formatDateTime, formatPercent, formatRelativeTime, shortId } from "@/lib/format";
import { cn } from "@/lib/utils";

import PageHeader from "@/components/common/PageHeader.vue";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const auth = useAuthStore();
const { t } = useI18n();

const monitorsQuery = useAsyncData(() => api.monitors.list().then((r) => unwrap(r, "monitors")), {
  pollInterval: 10000,
});
const nodesQuery = useAsyncData(() => api.nodes.list().then((r) => unwrap(r, "nodes")), {
  pollInterval: 15000,
});

const selectedMonitorId = ref("");
const createPending = ref(false);
const deletePending = ref(false);

const monitorName = ref("");
const monitorType = ref<"tcp" | "http">("tcp");
const monitorTarget = ref("");
const intervalSec = ref(30);
const timeoutSec = ref(5);
const assignAll = ref(true);
const selectedNodeIds = ref<string[]>([]);

const resultsQuery = useAsyncData(
  () => {
    if (!selectedMonitorId.value) return Promise.resolve([] as MonitorResult[]);
    return api.monitors.results(selectedMonitorId.value).then((r) => unwrap(r, "results"));
  },
  { pollInterval: 8000 },
);

const monitors = computed(() => monitorsQuery.data.value ?? []);
const nodes = computed(() => nodesQuery.data.value ?? []);
const selectedMonitor = computed(() =>
  monitors.value.find((monitor) => monitor.id === selectedMonitorId.value),
);
const selectedResults = computed(() => resultsQuery.data.value ?? []);

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

const enabledCount = computed(() => monitors.value.filter((monitor) => monitor.enabled).length);
const failureCount = computed(() => selectedResults.value.filter((result) => !result.success).length);
const selectedSuccessRate = computed(() => {
  if (selectedResults.value.length === 0) return "n/a";
  const ok = selectedResults.value.filter((result) => result.success).length;
  return formatPercent((ok / selectedResults.value.length) * 100, 1);
});
const averageLatency = computed(() => {
  const values = selectedResults.value
    .map((result) => result.latency_ms)
    .filter((value): value is number => value !== undefined && Number.isFinite(value));
  if (values.length === 0) return "n/a";
  return formatLatency(values.reduce((sum, value) => sum + value, 0) / values.length);
});
const canAdminMonitors = computed(() => auth.can("monitor:admin"));
const canSubmit = computed(
  () =>
    !!monitorName.value.trim() &&
    !!monitorTarget.value.trim() &&
    (assignAll.value || selectedNodeIds.value.length > 0),
);

const sparklinePoints = computed(() => {
  const values = recentResults.value
    .map((result) => result.latency_ms)
    .filter((value): value is number => value !== undefined && Number.isFinite(value));
  if (values.length < 2) return "";
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = Math.max(1, max - min);
  return values
    .map((value, index) => {
      const x = (index / Math.max(1, values.length - 1)) * 100;
      const y = 24 - ((value - min) / span) * 20 - 2;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
});

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

watch(selectedMonitorId, () => {
  resultsQuery.refresh();
});

function timestamp(input?: string): number {
  if (!input) return 0;
  const value = new Date(input).getTime();
  return Number.isNaN(value) ? 0 : value;
}

function formatLatency(ms?: number): string {
  if (ms === undefined || !Number.isFinite(ms)) return "n/a";
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

function resultBarClass(result: MonitorResult): string {
  if (result.success) return "bg-success/80";
  return "bg-destructive/80";
}

function refreshAll() {
  monitorsQuery.refresh();
  nodesQuery.refresh();
  resultsQuery.refresh();
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
  const ok = window.confirm(t("fleet.monitoring.confirm.delete", { name: selectedMonitor.value.name || selectedMonitor.value.id }));
  if (!ok) return;
  deletePending.value = true;
  try {
    await api.monitors.delete(selectedMonitor.value.id);
    toast.success(t("fleet.monitoring.toast.deleted"));
    selectedMonitorId.value = "";
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
      <template #actions>
        <Button
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
          <DataState
            :loading="monitorsQuery.loading.value"
            :error="monitorsQuery.error.value"
            :is-empty="monitors.length === 0"
            :empty-title="$t('fleet.monitoring.definitions.emptyTitle')"
            :empty-description="$t('fleet.monitoring.definitions.emptyDescription')"
            @retry="monitorsQuery.refresh"
          >
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
                      <span class="truncate font-medium">{{ monitor.name || monitor.id }}</span>
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
                <select
                  id="monitor-type"
                  v-model="monitorType"
                  class="h-9 rounded-md border border-input bg-background px-3 text-sm"
                >
                  <option value="tcp">TCP</option>
                  <option value="http">HTTP</option>
                </select>
              </div>
              <div class="grid gap-2">
                <Label>{{ $t('fleet.monitoring.create.assignment') }}</Label>
                <div class="grid grid-cols-2 rounded-md border border-input p-1">
                  <button
                    type="button"
                    :class="cn('rounded px-2 py-1.5 text-sm transition-colors', assignAll && 'bg-primary text-primary-foreground')"
                    @click="assignAll = true"
                  >
                    {{ $t('fleet.monitoring.create.all') }}
                  </button>
                  <button
                    type="button"
                    :class="cn('rounded px-2 py-1.5 text-sm transition-colors', !assignAll && 'bg-primary text-primary-foreground')"
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

            <DataState
              v-if="!assignAll"
              :loading="nodesQuery.loading.value"
              :error="nodesQuery.error.value"
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
                  <input v-model="selectedNodeIds" type="checkbox" :value="node.id" class="size-4 accent-primary" />
                  <span class="min-w-0 flex-1 truncate">{{ node.name || node.id }}</span>
                  <Badge :variant="node.online ? 'success' : 'secondary'">{{ node.online ? $t('fleet.monitoring.result.on') : $t('fleet.monitoring.result.off') }}</Badge>
                </label>
              </div>
            </DataState>

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
            @click="deleteMonitor"
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
          :is-empty="!selectedMonitor || selectedResults.length === 0"
          :empty-title="$t('fleet.monitoring.history.emptyTitle')"
          :empty-description="$t('fleet.monitoring.history.emptyDescription')"
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

            <div class="grid gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
              <div class="rounded-lg border border-border bg-muted/20 p-4">
                <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p class="text-sm font-medium">{{ $t('fleet.monitoring.history.latencyTrend') }}</p>
                    <p class="text-xs text-muted-foreground">{{ $t('fleet.monitoring.history.recentResults', { count: recentResults.length }) }}</p>
                  </div>
                  <Badge :variant="resultVariant(latestResult)">{{ resultLabel(latestResult) }}</Badge>
                </div>
                <svg viewBox="0 0 100 24" class="h-24 w-full overflow-visible">
                  <line x1="0" y1="22" x2="100" y2="22" class="stroke-border" stroke-width="0.4" />
                  <polyline
                    v-if="sparklinePoints"
                    :points="sparklinePoints"
                    class="fill-none stroke-primary"
                    stroke-width="1.4"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                  <text v-else x="50" y="13" text-anchor="middle" class="fill-muted-foreground text-[4px]">
                    {{ $t('fleet.monitoring.history.waitingSamples') }}
                  </text>
                </svg>
                <div class="mt-2 grid grid-cols-2 gap-2 text-xs text-muted-foreground">
                  <span>{{ $t('fleet.monitoring.history.successSuffix', { rate: selectedSuccessRate }) }}</span>
                  <span class="text-right">{{ $t('fleet.monitoring.history.averageSuffix', { latency: averageLatency }) }}</span>
                </div>
              </div>

              <div class="rounded-lg border border-border p-4">
                <p class="text-sm font-medium">{{ $t('fleet.monitoring.history.recentChecks') }}</p>
                <div class="mt-3 grid grid-cols-[repeat(24,minmax(0,1fr))] gap-1">
                  <span
                    v-for="result in recentResults.slice(-48)"
                    :key="`${result.monitor_id}:${result.node_id}:${result.at}`"
                    :class="cn('h-8 rounded-sm', resultBarClass(result))"
                    :title="`${nodeName(result.node_id)} ${result.success ? $t('fleet.monitoring.result.ok') : $t('common.status.failed')} ${formatLatency(result.latency_ms)}`"
                  />
                </div>
                <p class="mt-3 text-xs text-muted-foreground">
                  {{ $t('fleet.monitoring.history.failuresInHistory', { count: failureCount }) }}
                </p>
              </div>
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
                  v-for="result in sortedResultsDesc.slice(0, 40)"
                  :key="`${result.monitor_id}:${result.node_id}:${result.at}`"
                  class="grid grid-cols-[1fr_96px_96px_132px] gap-3 border-b border-border px-3 py-3 text-sm last:border-b-0"
                >
                  <div class="min-w-0">
                    <p class="truncate font-medium">{{ nodeName(result.node_id) }}</p>
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
              </div>
            </div>
          </div>
        </DataState>
      </CardContent>
    </Card>
  </div>
</template>
