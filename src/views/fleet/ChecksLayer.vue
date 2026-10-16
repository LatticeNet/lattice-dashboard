<script setup lang="ts">
/**
 * Monitoring's Checks layer (design 29 D7, D9): every check in one list,
 * your checks first and the path set's generated checks grouped under it,
 * read-only (their paths are paused through the path set). A row opens the
 * check sheet on ?open=: its paths, one per source, and the path chart of the
 * one chosen. Create and edit open the editor the page hosts, so Overview and
 * Paths can open it too. Below the list, how long history is kept.
 *
 * A link that names a monitor (?open=, the old /monitoring/:id) or a node
 * (?node=, the node page's link) lands here.
 */
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useMediaQuery } from "@vueuse/core";
import { Activity, Globe, History, LockKeyhole, Pencil, RadioTower, Settings2, Trash2, X } from "lucide-vue-next";

import { api, type MonitorSettings, type MonitorView, type MonitorWindow, type Node } from "@/lib/api";
import { formatBytes, formatRelativeTime, shortId } from "@/lib/format";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import type { AsyncData } from "@/composables/useAsyncData";
import { bindQueryParam } from "@/composables/useQueryParam";
import { bindRouteOpen } from "@/composables/useRouteOpen";
import { useListQuery, useQueryText } from "@/composables/useListQuery";
import type { OwnedRoute } from "@/composables/useOwnedRoute";
import { withoutSorts } from "@/lib/query/syntax";

import AttentionList, { type AttentionItem } from "@/components/common/AttentionList.vue";
import ConfirmDialog from "@/components/common/ConfirmDialog.vue";
import DataTable, { type DataTableColumn } from "@/components/common/DataTable.vue";
import EmptyState from "@/components/common/EmptyState.vue";
import ListQueryBar from "@/components/common/ListQueryBar.vue";
import ObjectSheet from "@/components/common/ObjectSheet.vue";
import RowMenu, { type RowMenuItem } from "@/components/common/RowMenu.vue";
import StatusDot from "@/components/common/StatusDot.vue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

import PathDetail from "./PathDetail.vue";
import { CHECK_GROUP_ORDER, canEditCheck, checkGroup, latestCertExpiry } from "./checksModel";
import { createConfirmReturn } from "./confirmFocus";
import { formatLoss, formatMs } from "./latencyModel";
import { failingMonitors, healthRank, monitorHealth, type MonitorHealth } from "./monitorHealthModel";
import { MONITORING_QUERY_EXAMPLES, monitoringQuerySchema } from "./monitoringQuery";
import { isServerEvaluated } from "./monitorTypeModel";
import { stateRank, type PathAddress, type PathItem } from "./pathsModel";
import { usePathsCopy } from "./pathsCopy";
import type { PathsData } from "./usePathsData";

const props = defineProps<{
  owned: OwnedRoute;
  data: PathsData;
  monitorsQuery: AsyncData<MonitorView[]>;
  nodes: Node[];
  canAdmin: boolean;
  window: MonitorWindow;
  /** The windows the page offers, for the sheet's own window control. */
  offered: MonitorWindow[];
}>();

const emit = defineEmits<{
  create: [type?: "http" | "tls" | "tcp"];
  edit: [monitor: MonitorView];
  pathSet: [];
  retention: [];
  changed: [];
  window: [window: MonitorWindow];
}>();

const { t } = useI18n();
const { stateLabel, displayLabel, whyText } = usePathsCopy();
/** The server has the edit route: it answered the design 29 paths read. */
const serverEdits = computed(() => props.data.source.value === "paths");
const wide = useMediaQuery("(min-width: 768px)");

const all = computed(() => props.monitorsQuery.data.value ?? []);
const operator = computed(() => all.value.filter((m) => !m.managed_by));
const generated = computed(() => all.value.filter((m) => !!m.managed_by));

function nodeName(id: string): string {
  if (!id) return t("fleet.monitoring.result.controlPlane");
  return props.nodes.find((n) => n.id === id)?.name || shortId(id, 14);
}

function healthOf(monitor: MonitorView): MonitorHealth {
  return monitorHealth(monitor, monitor.latest, props.monitorsQuery.lastUpdated.value ?? Date.now());
}

/* ---- The node filter (?node=, from the node page) ---- */

const nodeFilter = bindQueryParam(props.owned, "node", {
  parse: (raw) => (typeof raw === "string" ? raw : ""),
  format: (value: string) => value || undefined,
});

const sorted = computed(() =>
  [...all.value].sort((a, b) => {
    const group = CHECK_GROUP_ORDER.indexOf(checkGroup(a)) - CHECK_GROUP_ORDER.indexOf(checkGroup(b));
    if (group !== 0) return group;
    const rank = healthRank(healthOf(a)) - healthRank(healthOf(b));
    if (rank !== 0) return rank;
    return (a.name || a.id).localeCompare(b.name || b.id);
  }),
);

const listed = computed(() => {
  const id = nodeFilter.value;
  if (!id) return sorted.value;
  return sorted.value.filter((m) => !isServerEvaluated(m.type) && (m.assign_all || (m.node_ids ?? []).includes(id)));
});

/* ---- The query field (?monitors.q=, as before) ---- */

const querySchema = monitoringQuerySchema({
  health: (m) => healthOf(m),
  allNodeNames: () => props.nodes.map((n) => n.name || n.id),
  nodeName,
  serverEvaluated: (m) => isServerEvaluated(m.type),
});
const storedQuery = bindQueryParam<string>(props.owned, "monitors.q", {
  parse: (raw) => (typeof raw === "string" ? raw : ""),
  format: (value) => (value.trim() ? value : undefined),
});
const queryText = useQueryText(storedQuery);
const query = useListQuery(listed, querySchema, queryText);
const queryExamples = computed(() => MONITORING_QUERY_EXAMPLES.map((e) => ({ query: e.query, note: t(`fleet.monitoring.query.examples.${e.key}`) })));

/* ---- Attention: operator checks that fail or went quiet ---- */

const attention = computed<AttentionItem[]>(() => {
  const items: AttentionItem[] = failingMonitors(operator.value, healthOf).map(({ monitor, failing, total }) => ({
    key: `failing:${monitor.id}`,
    tone: "danger",
    claim: t("fleet.monitoring.attention.failing", { name: monitor.name || monitor.id }),
    proof: total > 1 ? t("fleet.monitoring.status.failingOn", { n: failing, total }) : t("fleet.monitoring.status.failing"),
    action: { label: t("fleet.monitoring.attention.open"), run: () => sheet.open(monitor.id) },
  }));
  for (const monitor of operator.value) {
    const state = healthOf(monitor);
    if (state.kind !== "stale") continue;
    items.push({
      key: `stale:${monitor.id}`,
      tone: "warning",
      claim: t("fleet.monitoring.attention.stale", { name: monitor.name || monitor.id }),
      proof: t("fleet.monitoring.status.lastResult", { age: formatRelativeTime(state.lastAt) }),
      action: { label: t("fleet.monitoring.attention.open"), run: () => sheet.open(monitor.id) },
    });
  }
  return items;
});

/* ---- The table ---- */

function statusView(monitor: MonitorView): { text: string; detail?: string; tone?: "success" | "warning" | "destructive"; textClass: string } {
  const state = healthOf(monitor);
  switch (state.kind) {
    case "disabled":
      return { text: t("fleet.monitoring.checks.paused"), textClass: "text-muted-foreground" };
    case "unread":
      return { text: t("overview.read.failed"), textClass: "text-muted-foreground" };
    case "none":
      return { text: t("fleet.monitoring.status.none"), textClass: "text-muted-foreground" };
    case "failing":
      // "down", as Paths and Overview say it.
      return {
        text: state.total > 1 ? t("fleet.monitoring.checks.downOn", { n: state.failing, total: state.total }) : t("fleet.monitoring.paths.state.down"),
        tone: "destructive",
        textClass: "text-destructive font-medium",
      };
    case "stale":
      return { text: t("fleet.monitoring.status.lastResult", { age: formatRelativeTime(state.lastAt) }), tone: "warning", textClass: "text-warning-text" };
    case "up": {
      // A certificate check leads with the days left, the reason it exists; others with the newest latency.
      const days = certDaysLeft(monitor);
      const detail = days !== undefined ? (days < 0 ? t("fleet.monitoring.checks.certExpired") : t("fleet.monitoring.checks.certLeft", { n: days })) : state.latencyMs !== undefined ? formatMs(state.latencyMs) : undefined;
      return { text: t("fleet.monitoring.status.up"), detail, tone: "success", textClass: "text-foreground" };
    }
  }
}

const DAY_MS = 86_400_000;
/** Whole days until the certificate a tls check last read expires; undefined for other checks. */
function certDaysLeft(monitor: MonitorView): number | undefined {
  if (monitor.type !== "tls") return undefined;
  const expires = latestCertExpiry(monitor.latest);
  return expires === undefined ? undefined : Math.floor((expires - Date.now()) / DAY_MS);
}

/** A check's newest failure on one source, from the list's newest results. */
function failureOn(monitor: MonitorView | undefined, source: string): string | undefined {
  const latest = monitor?.latest?.find((l) => (l.node_id ?? "") === source);
  return latest && !latest.success ? latest.error || undefined : undefined;
}

/**
 * A generated check's name without the "Latency to " every one of them
 * starts with: under the Path set group it says nothing, and on a phone it
 * pushed the part that differs out of the cell.
 */
function shownName(monitor: MonitorView): string {
  const name = monitor.name || monitor.id;
  return monitor.managed_by && name.startsWith("Latency to ") ? name.slice("Latency to ".length) : name;
}

function cadence(seconds: number): string {
  if (seconds >= 3600 && seconds % 3600 === 0) return t("fleet.monitoring.definitions.unit.h", { n: seconds / 3600 });
  if (seconds >= 60 && seconds % 60 === 0) return t("fleet.monitoring.definitions.unit.m", { n: seconds / 60 });
  return t("fleet.monitoring.definitions.unit.s", { n: seconds });
}

function assignmentLabel(monitor: MonitorView): string {
  if (isServerEvaluated(monitor.type)) return t("fleet.monitoring.assignment.controlPlane");
  if (monitor.assign_all) return t("fleet.monitoring.assignment.allNodes");
  const count = monitor.node_ids?.length ?? 0;
  // A generated check whose every path is paused runs on no source.
  if (count === 0) return t("fleet.monitoring.checks.noneRunning");
  const paused = (monitor.paused_node_ids ?? []).length;
  const base = count === 1 ? nodeName(monitor.node_ids![0]!) : t("fleet.monitoring.assignment.nodeCount", { count }, count);
  return paused ? t("fleet.monitoring.checks.withPaused", { base, n: paused }) : base;
}

const columns = computed<DataTableColumn<MonitorView>[]>(() => [
  // Wraps on a phone: thirty generated names share "Latency to", and a cut name hides the part that differs.
  { key: "name", label: t("fleet.monitoring.checks.table.name"), sortable: true, searchable: true, wrap: true, value: (m) => m.name || m.id },
  { key: "status", label: t("fleet.monitoring.table.status"), sortable: true, value: (m) => healthRank(healthOf(m)) },
  { key: "type", label: t("fleet.monitoring.checks.table.method"), sortable: true, searchable: true },
  { key: "target", label: t("fleet.monitoring.table.target"), searchable: true },
  { key: "assignment", label: t("fleet.monitoring.checks.table.from"), value: (m) => assignmentLabel(m) },
  { key: "interval", label: t("fleet.monitoring.table.every"), sortable: true, value: (m) => m.interval_sec },
  { key: "actions", label: "", class: "w-12 max-md:w-11 max-md:px-0", pin: "end" },
]);

const confirmReturn = createConfirmReturn();
const deleteTarget = ref<MonitorView | undefined>();
const deleteOpen = ref(false);
const deletePending = ref(false);

function requestDelete(monitor: MonitorView): void {
  confirmReturn.remember(monitor.id);
  deleteTarget.value = monitor;
  deleteOpen.value = true;
}

async function deleteMonitor(): Promise<void> {
  const target = deleteTarget.value;
  if (!target) return;
  deletePending.value = true;
  try {
    await api.monitors.delete(target.id);
    toast.success(t("fleet.monitoring.toast.deleted"));
    deleteOpen.value = false;
    if (sheet.openId.value === target.id) sheet.close();
    emit("changed");
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("fleet.monitoring.toast.deleteFailed"));
  } finally {
    deletePending.value = false;
  }
}

const deleteImpact = computed(() => {
  const m = deleteTarget.value;
  if (!m) return [];
  const lines = [t("fleet.monitoring.confirm.impactHistory")];
  if (m.type === "tls") lines.push(t("fleet.monitoring.confirm.impactUpcoming"));
  return lines;
});

function menuFor(monitor: MonitorView): RowMenuItem[] {
  if (monitor.managed_by) {
    return [{ key: "pathset", label: t("fleet.monitoring.paths.sheet.editPathSet"), icon: Settings2, hidden: !props.canAdmin, run: () => emit("pathSet") }];
  }
  return [
    {
      key: "edit",
      label: t("fleet.monitoring.checks.actions.edit"),
      icon: Pencil,
      // Until the paths read says which server this is, Edit is neither offered nor refused.
      hidden: !props.canAdmin || props.data.source.value === "unknown",
      disabled: !canEditCheck(monitor, serverEdits.value),
      reason: canEditCheck(monitor, serverEdits.value) ? undefined : t("fleet.monitoring.checks.editUnavailable"),
      run: () => emit("edit", monitor),
    },
    { key: "delete", label: t("common.actions.delete"), icon: Trash2, danger: true, hidden: !props.canAdmin, run: () => requestDelete(monitor) },
  ];
}

/* ---- The check sheet ---- */

const sheet = bindRouteOpen(props.owned);
const selected = computed(() => (sheet.openId.value ? all.value.find((m) => m.id === sheet.openId.value) : undefined));
const sheetState = computed(() => {
  if (!sheet.openId.value) return "loading" as const;
  if (props.monitorsQuery.data.value === undefined) {
    return props.monitorsQuery.error.value && !props.monitorsQuery.loading.value ? ("failed" as const) : ("loading" as const);
  }
  if (!selected.value) return "gone" as const;
  return props.monitorsQuery.error.value ? ("stale" as const) : ("ready" as const);
});

interface SourceRow {
  source: string;
  name: string;
  path?: PathItem;
  /** From the check's newest results, when the server has no paths read. */
  latest?: { success: boolean; latencyMs?: number; at: string; error?: string };
  paused: boolean;
}

/** One row per source of the open check: its path when the matrix has it, else its newest result. */
const sourceRows = computed<SourceRow[]>(() => {
  const m = selected.value;
  if (!m) return [];
  const paths = (props.data.matrix.value?.paths ?? []).filter((p) => p.monitorId === m.id);
  const paused = new Set(m.paused_node_ids ?? []);
  if (paths.length) {
    return paths
      .map((p) => ({ source: p.source, name: p.sourceName, path: p, paused: paused.has(p.source) }))
      .sort((a, b) => stateRank(a.path.state) - stateRank(b.path.state) || a.name.localeCompare(b.name));
  }
  return (m.latest ?? [])
    .map((l) => ({ source: l.node_id ?? "", name: nodeName(l.node_id ?? ""), latest: { success: l.success, latencyMs: l.latency_ms, at: l.at, error: l.error }, paused: paused.has(l.node_id ?? "") }))
    .sort((a, b) => Number(a.latest.success) - Number(b.latest.success) || a.name.localeCompare(b.name));
});

/**
 * The source a check sheet opens on: the worst one that is measured (down
 * before up, the higher loss first), never a paused one while a measured
 * source exists, so the chart shows something to read.
 */
function defaultSource(rows: SourceRow[]): string | undefined {
  const measured = rows.filter((r) => !r.paused && (r.path ? r.path.state !== "unknown" : !!r.latest));
  const pool = measured.length ? measured : rows.filter((r) => !r.paused).length ? rows.filter((r) => !r.paused) : rows;
  const rank = (r: SourceRow) => (r.path ? stateRank(r.path.state) : r.latest && !r.latest.success ? 0 : 2);
  return [...pool].sort((a, b) => rank(a) - rank(b) || (b.path?.loss ?? 0) - (a.path?.loss ?? 0) || a.name.localeCompare(b.name))[0]?.source;
}

const chosenSource = ref<string | undefined>();
watch(
  () => [sheet.openId.value, sourceRows.value.map((r) => r.source).join(",")] as const,
  () => {
    if (!sourceRows.value.some((r) => r.source === chosenSource.value)) chosenSource.value = defaultSource(sourceRows.value);
  },
  { immediate: true },
);
const chosenRow = computed(() => sourceRows.value.find((r) => r.source === chosenSource.value));
const chosenAddress = computed<PathAddress | undefined>(() => {
  const m = selected.value;
  const row = chosenRow.value;
  if (!m || !row) return undefined;
  if (m.managed_by && row.path?.targetNode) return { source: row.source, targetNode: row.path.targetNode };
  return { source: row.source, monitorId: m.id };
});

/* ---- Retention ---- */

const settings = computed<MonitorSettings | undefined>(() => props.data.settings.value);
</script>

<template>
  <div class="space-y-4">
    <AttentionList :items="attention" />

    <!-- Nothing at all yet: one sentence and the watches worth starting with. -->
    <section
      v-if="monitorsQuery.data.value !== undefined && all.length === 0"
      class="rounded-lg border border-dashed border-border px-5 py-8 text-center"
      aria-labelledby="checks-empty"
    >
      <RadioTower class="mx-auto size-6 text-muted-foreground" aria-hidden="true" />
      <h2 id="checks-empty" class="mt-3 text-sm font-medium">{{ $t('fleet.monitoring.checks.empty.title') }}</h2>
      <p class="mx-auto mt-1 max-w-lg text-sm text-muted-foreground">
        {{ canAdmin ? $t('fleet.monitoring.checks.empty.description') : $t('fleet.monitoring.definitions.emptyReadOnly') }}
      </p>
      <div v-if="canAdmin" class="mt-4 flex flex-wrap justify-center gap-2">
        <Button size="sm" type="button" @click="emit('create', 'http')">
          <Globe class="size-4" aria-hidden="true" />
          {{ $t('fleet.monitoring.empty.http') }}
        </Button>
        <Button variant="outline" size="sm" type="button" @click="emit('create', 'tls')">
          <LockKeyhole class="size-4" aria-hidden="true" />
          {{ $t('fleet.monitoring.empty.tls') }}
        </Button>
        <Button variant="outline" size="sm" type="button" @click="emit('pathSet')">
          <Settings2 class="size-4" aria-hidden="true" />
          {{ $t('fleet.monitoring.paths.empty.pathSet') }}
        </Button>
      </div>
    </section>

    <div v-if="nodeFilter && all.length" class="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
      <button
        type="button"
        class="inline-flex max-w-full items-center gap-1 rounded-sm border border-primary/40 bg-primary/10 px-2 py-0.5 font-medium text-foreground hover:bg-primary/20 pointer-coarse:min-h-11"
        :aria-label="$t('fleet.monitoring.nodeFilter.remove', { node: nodeName(nodeFilter) })"
        @click="nodeFilter = ''"
      >
        <span class="truncate">{{ $t('fleet.monitoring.nodeFilter.chip', { node: nodeName(nodeFilter) }) }}</span>
        <X class="size-3 shrink-0" aria-hidden="true" />
      </button>
      <span class="tabular">{{ $t('fleet.monitoring.nodeFilter.showing', { shown: listed.length, total: all.length }) }}</span>
    </div>

    <ListQueryBar
      v-if="all.length"
      v-model="queryText"
      class="max-w-3xl"
      storage-key="monitors"
      testid="monitors-query"
      :query="query"
      :count="query.filtering.value ? { shown: query.rows.value.length, total: listed.length } : undefined"
      :label="$t('fleet.monitoring.query.label')"
      :placeholder="$t('fleet.monitoring.query.placeholder')"
      :examples="queryExamples"
    />

    <DataTable
      v-if="!(monitorsQuery.data.value !== undefined && all.length === 0)"
      state-key="monitors"
      :columns="columns"
      :rows="query.rows.value"
      :row-key="(m) => m.id"
      :group-key="(m) => checkGroup(m)"
      :group-order="CHECK_GROUP_ORDER"
      :loading="monitorsQuery.loading.value"
      :error="monitorsQuery.error.value ?? null"
      :has-data="monitorsQuery.data.value !== undefined"
      :expression-filter="false"
      :external-sort="query.sorted.value"
      :class="query.staleRows.value && 'opacity-50'"
      :inert="query.staleRows.value || undefined"
      :row-click="(m, el) => sheet.open(m.id, el)"
      :active-row-id="sheet.openId.value"
      data-testid="checks-table"
      @retry="monitorsQuery.refresh"
      @sort="queryText = withoutSorts(queryText)"
    >
      <template #group="{ group }">
        <span class="font-medium text-foreground">{{ $t(`fleet.monitoring.checks.group.${group.key}`) }}</span>
        <span class="font-mono tabular text-muted-foreground">{{ group.rows.length }}</span>
        <span v-if="group.key === 'pathset'" class="truncate text-xs text-muted-foreground">{{ $t('fleet.monitoring.checks.group.pathsetNote') }}</span>
      </template>
      <template #cell-name="{ row }">
        <span class="flex min-w-0 items-center gap-2">
          <Activity class="size-4 shrink-0 text-muted-foreground max-md:hidden" aria-hidden="true" />
          <span class="font-medium md:truncate max-md:break-words" :title="row.name || row.id">{{ shownName(row) }}</span>
        </span>
      </template>
      <template #cell-status="{ row }">
        <span class="flex min-w-0 items-center gap-1.5 whitespace-nowrap text-xs" data-testid="monitor-status">
          <StatusDot v-if="statusView(row).tone" :tone="statusView(row).tone" :pulse="false" />
          <span :class="statusView(row).textClass">{{ statusView(row).text }}</span>
          <span v-if="statusView(row).detail" class="font-mono tabular text-muted-foreground">{{ statusView(row).detail }}</span>
        </span>
      </template>
      <template #cell-type="{ row }">
        <span class="font-mono text-xs uppercase">{{ row.type }}</span>
        <span v-if="row.type === 'tls'" class="ms-1.5 whitespace-nowrap text-xs text-muted-foreground">{{ $t('fleet.monitoring.definitions.threshold', { days: row.threshold_days ?? 14 }) }}</span>
      </template>
      <template #cell-target="{ row }">
        <span class="font-mono text-xs">{{ row.target }}</span>
      </template>
      <template #cell-assignment="{ row }">
        <span class="text-xs text-muted-foreground">{{ assignmentLabel(row) }}</span>
      </template>
      <template #cell-interval="{ row }">
        <span class="whitespace-nowrap text-xs text-muted-foreground">{{ $t('fleet.monitoring.definitions.interval', { interval: cadence(row.interval_sec), timeout: cadence(row.timeout_sec) }) }}</span>
      </template>
      <template #cell-actions="{ row }">
        <RowMenu :name="row.name || row.id" :items="menuFor(row)" />
      </template>
      <template v-if="nodeFilter" #empty>
        <EmptyState :icon="RadioTower" :title="$t('fleet.monitoring.nodeFilter.emptyTitle', { node: nodeName(nodeFilter) })" :description="$t('fleet.monitoring.nodeFilter.emptyDescription')">
          <Button variant="outline" size="sm" type="button" @click="nodeFilter = ''">{{ $t('fleet.monitoring.nodeFilter.showAll') }}</Button>
        </EmptyState>
      </template>
    </DataTable>

    <!-- How long history is kept; only a server with the retention setting shows it. -->
    <section
      v-if="settings"
      class="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-border bg-card px-3.5 py-2.5 text-sm"
      data-testid="checks-retention"
      :aria-label="$t('fleet.monitoring.retention.title')"
    >
      <History class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <p class="me-auto min-w-0">
        <span class="font-medium">{{ $t('fleet.monitoring.retention.summary', { n: settings.fine_retention_days }, settings.fine_retention_days) }}</span>
        <span class="ms-2 font-mono text-xs text-muted-foreground tabular">{{ $t('fleet.monitoring.retention.sizes', { measured: formatBytes(settings.measured_bytes), projected: formatBytes(settings.projected_bytes) }) }}</span>
      </p>
      <Button variant="outline" size="sm" type="button" data-testid="retention-open" @click="emit('retention')">
        {{ canAdmin ? $t('fleet.monitoring.retention.change') : $t('fleet.monitoring.retention.view') }}
      </Button>
    </section>

    <!-- One check: its paths, and the chart of the source chosen. -->
    <ObjectSheet
      :open="!!sheet.openId.value"
      :title="selected?.name || selected?.id || sheet.openId.value || ''"
      :subtitle="selected ? `${selected.type.toUpperCase()} · ${selected.target}` : undefined"
      :state="sheetState"
      :error="monitorsQuery.error.value?.message ?? null"
      :return-focus="sheet.returnFocus"
      :gone-title="$t('fleet.monitoring.sheet.goneTitle')"
      :gone-description="$t('fleet.monitoring.sheet.goneDescription')"
      @close="sheet.close"
      @retry="monitorsQuery.refresh"
    >
      <div v-if="selected" class="space-y-5 text-sm">
        <p v-if="selected.managed_by" class="rounded-md bg-muted/40 p-2.5 text-xs text-muted-foreground">{{ $t('fleet.monitoring.checks.sheet.generatedNote') }}</p>
        <p v-else-if="!selected.enabled" class="rounded-md bg-muted/40 p-2.5 text-xs text-muted-foreground">{{ $t('fleet.monitoring.checks.sheet.pausedNote') }}</p>

        <section v-if="sourceRows.length" class="space-y-1.5" :aria-label="$t('fleet.monitoring.checks.sheet.sources')">
          <h3 class="text-xs font-medium text-muted-foreground">{{ $t('fleet.monitoring.checks.sheet.sources') }}</h3>
          <ul class="divide-y divide-border rounded-md border border-border" data-testid="check-sources">
            <li v-for="row in sourceRows" :key="row.source">
              <button
                type="button"
                :aria-pressed="row.source === chosenSource"
                :class="cn('grid min-h-11 w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 px-3 py-1.5 text-start outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring', row.source === chosenSource && 'bg-muted')"
                @click="chosenSource = row.source"
              >
                <span class="min-w-0">
                  <span class="block truncate font-medium">{{ row.name }}</span>
                  <span v-if="row.paused" class="block text-xs text-muted-foreground">{{ $t('fleet.monitoring.checks.editor.paused') }}</span>
                  <span v-else-if="row.path && row.path.state !== 'up'" :class="cn('block truncate text-xs', row.path.state === 'down' ? 'text-destructive' : 'text-muted-foreground')">
                    {{ displayLabel(row.path) }}: {{ whyText(row.path, failureOn(selected, row.source)) }}
                  </span>
                  <span v-else-if="row.latest && !row.latest.success" class="block truncate text-xs text-destructive">{{ row.latest.error || $t('fleet.monitoring.result.failing') }}</span>
                </span>
                <span class="text-end font-mono text-xs tabular">
                  <template v-if="row.path">
                    <span class="block">{{ row.path.p50Ms !== undefined && row.path.state !== 'unknown' ? formatMs(row.path.p50Ms) : displayLabel(row.path) }}</span>
                    <span v-if="(row.path.loss ?? 0) > 0" class="block text-muted-foreground">{{ $t('fleet.monitoring.paths.cell.loss', { loss: formatLoss(row.path.loss) }) }}</span>
                  </template>
                  <template v-else-if="row.latest">
                    <span :class="row.latest.success ? '' : 'text-destructive'">{{ row.latest.success ? formatMs(row.latest.latencyMs) || $t('fleet.monitoring.result.ok') : $t('fleet.monitoring.result.fail') }}</span>
                  </template>
                </span>
              </button>
            </li>
          </ul>
        </section>
        <p v-else class="text-muted-foreground">{{ $t('fleet.monitoring.history.emptyDescription') }}</p>

        <PathDetail
          v-if="chosenAddress && chosenRow"
          :address="chosenAddress"
          :path="chosenRow.path"
          :window="window"
          :source="data.source.value"
          :compact="!wide"
          :title="$t('fleet.monitoring.paths.sheet.title', { source: chosenRow.name, target: selected.name || selected.target })"
          :offered="offered"
          :failure="failureOn(selected, chosenRow.source)"
          @window="(w) => emit('window', w)"
        />
      </div>
      <template v-if="canAdmin && selected" #actions>
        <template v-if="selected.managed_by">
          <Button variant="outline" size="sm" type="button" @click="emit('pathSet')">
            <Settings2 class="size-4" aria-hidden="true" />
            {{ $t('fleet.monitoring.paths.sheet.editPathSet') }}
          </Button>
        </template>
        <template v-else>
          <Badge v-if="data.source.value === 'legacy'" variant="outline" class="me-auto">{{ $t('fleet.monitoring.checks.editUnavailable') }}</Badge>
          <Button variant="outline" size="sm" type="button" class="text-destructive" :disabled="deletePending" @click="requestDelete(selected)">
            <Trash2 class="size-4" aria-hidden="true" />
            {{ $t('common.actions.delete') }}
          </Button>
          <Button v-if="canEditCheck(selected, serverEdits)" size="sm" type="button" data-testid="check-edit" @click="emit('edit', selected)">
            <Pencil class="size-4" aria-hidden="true" />
            {{ $t('fleet.monitoring.checks.actions.edit') }}
          </Button>
        </template>
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
      :return-focus="confirmReturn.target"
      @confirm="deleteMonitor"
    />
  </div>
</template>
