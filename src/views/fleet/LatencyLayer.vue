<script setup lang="ts">
/**
 * Monitoring's Latency layer: handshake time and loss from the probe sources
 * to their targets, as a matrix with targets down the side (they are many)
 * and sources across the top (they are few), so it reads on a phone with one
 * source and scrolls sideways inside its own frame with three.
 *
 * The plan and the rollups come from the server (GET /api/monitors/latency
 * and .../rollups); latencyModel arranges them and holds the one rule the
 * colours obey: a pair nothing was heard from is hatched, never green. A cell
 * opens the pair's series in a sheet (?pair=source~target), and the probe
 * settings open in a sheet of their own.
 *
 * No alerting is built here. The attention list shows lossy pairs in the
 * window on screen; a degradation alert belongs to the incident path, which
 * reads the same rollups on the server.
 */
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useNow } from "@vueuse/core";
import { Gauge, RefreshCw, Settings2 } from "lucide-vue-next";

import { api, type LatencyProbePlan, type LatencyWindow } from "@/lib/api";
import { formatAge, formatRelativeTime } from "@/lib/format";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { useAsyncData } from "@/composables/useAsyncData";
import { useProof } from "@/composables/useProof";
import { bindQueryParam } from "@/composables/useQueryParam";
import { bindRouteOpen } from "@/composables/useRouteOpen";
import type { OwnedRoute } from "@/composables/useOwnedRoute";
import { useAuthStore } from "@/stores/auth";

import AttentionList, { type AttentionItem } from "@/components/common/AttentionList.vue";
import DataState from "@/components/common/DataState.vue";
import EmptyState from "@/components/common/EmptyState.vue";
import ObjectSheet from "@/components/common/ObjectSheet.vue";
import ProofLine, { type ProofSegment } from "@/components/common/ProofLine.vue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

import LatencyConfigSheet from "./LatencyConfigSheet.vue";
import LatencySeriesChart from "./LatencySeriesChart.vue";
import {
  BAND_STYLE,
  LATENCY_READINGS,
  LATENCY_WINDOWS,
  buildLatencyMatrix,
  cellQuietFor,
  coveragePercent,
  draftFromConfig,
  draftToConfig,
  formatLoss,
  formatMs,
  groupLatencyRows,
  latencyProblems,
  pairKey,
  parsePairKey,
  setPairEnabled,
  type LatencyCell,
  type LatencyReading,
} from "./latencyModel";

const props = defineProps<{ owned: OwnedRoute }>();

const { t, locale } = useI18n();
const auth = useAuthStore();
const now = useNow({ interval: 30000 });
const canRead = computed(() => auth.can("monitor:read"));
const canAdmin = computed(() => auth.can("monitor:admin"));

const planQuery = useAsyncData(
  (signal) => (canRead.value ? api.monitors.latency.plan({ signal }) : Promise.resolve(undefined as unknown as LatencyProbePlan)),
  { pollInterval: 30000, immediate: canRead.value },
);
const rollupsQuery = useAsyncData(
  (signal) => (canRead.value ? api.monitors.latency.rollups({ signal }) : Promise.resolve(undefined)),
  { pollInterval: 30000, immediate: canRead.value },
);
const plan = computed(() => planQuery.data.value);

const windowParam = bindQueryParam<LatencyWindow>(props.owned, "window", {
  parse: (raw) => (LATENCY_WINDOWS.includes(raw as LatencyWindow) ? (raw as LatencyWindow) : "1h"),
  format: (value) => (value === "1h" ? undefined : value),
});
const readingParam = bindQueryParam<LatencyReading>(props.owned, "read", {
  parse: (raw) => (raw === "p95" ? "p95" : "p50"),
  format: (value) => (value === "p50" ? undefined : value),
});

const matrix = computed(() => (plan.value ? buildLatencyMatrix(plan.value, rollupsQuery.data.value, windowParam.value, readingParam.value) : undefined));
/** Targets by region, near mainland China first, so the times climb down the column. */
const groups = computed(() => (matrix.value ? groupLatencyRows(matrix.value.rows) : []));
const intervalSec = computed(() => plan.value?.config.interval_sec ?? 60);

function refreshAll(): void {
  void planQuery.refresh();
  void rollupsQuery.refresh();
}

/* ---- Head ---- */

const proof = useProof([planQuery, rollupsQuery], { hasData: () => planQuery.data.value !== undefined });
const proofSegments = computed<ProofSegment[]>(() => {
  const m = matrix.value;
  const p = plan.value;
  if (!m || !p) return [];
  const out: ProofSegment[] = [
    { key: "sources", tone: "strong", text: t("fleet.monitoring.latency.proof.sources", { n: m.sources.length }, m.sources.length) },
    { key: "targets", text: t("fleet.monitoring.latency.proof.targets", { n: m.counts.targets }, m.counts.targets) },
  ];
  if (m.counts.failing) out.push({ key: "failing", tone: "destructive", text: t("fleet.monitoring.latency.proof.failing", { n: m.counts.failing }) });
  if (m.counts.unknown) out.push({ key: "unknown", tone: "warning", text: t("fleet.monitoring.latency.proof.unknown", { n: m.counts.unknown }) });
  if (m.counts.notProbeable) out.push({ key: "notProbeable", text: t("fleet.monitoring.latency.proof.notProbeable", { n: m.counts.notProbeable }) });
  if (!p.config.enabled) out.push({ key: "off", tone: "warning", text: t("fleet.monitoring.latency.proof.off") });
  else out.push({ key: "every", tone: "muted", text: t("fleet.monitoring.latency.proof.every", { n: intervalSec.value }) });
  if (!p.stored) out.push({ key: "defaults", tone: "muted", text: t("fleet.monitoring.latency.proof.defaults") });
  return out;
});

/* ---- Attention: lossy pairs in the window on screen ---- */

const attention = computed<AttentionItem[]>(() => {
  const m = matrix.value;
  if (!m) return [];
  const windowLabel = t(`fleet.monitoring.latency.window.${windowParam.value}`);
  return latencyProblems(m).map((problem) => {
    const names = problem.pairs.map((p) => p.source.name);
    const sources = names.length <= 2 ? names.join(", ") : t("fleet.monitoring.latency.attention.sources", { n: names.length });
    const target = problem.target.name || problem.target.node_id;
    return {
      key: `latency:${problem.target.node_id}`,
      tone: problem.unreachable ? "danger" : "warning",
      claim: problem.unreachable
        ? t("fleet.monitoring.latency.attention.failing", { target, source: sources })
        : t("fleet.monitoring.latency.attention.lossy", { target, source: sources, loss: formatLoss(problem.worstLoss) }),
      proof: `${windowLabel}: ${problem.pairs.map((p) => t("fleet.monitoring.latency.attention.pairLoss", { source: p.source.name, loss: formatLoss(p.cell.kind === "failing" ? 1 : p.cell.loss) })).join(" · ")}`,
      action: { label: t("fleet.monitoring.attention.open"), run: () => pairSheet.open(pairKey(problem.pairs[0]!.cell.source, problem.target.node_id)) },
    };
  });
});

/* ---- Cells ---- */

const UNKNOWN_HATCH = "bg-[repeating-linear-gradient(135deg,var(--border)_0_1.5px,transparent_1.5px_7px)]";
/** Every probe failed: the only cell with a red tint (over 250 ms is a red bar on a plain cell). */
const FAILING_TINT = "bg-destructive/6";

function cellOpenable(cell: LatencyCell): boolean {
  return cell.kind === "measured" || cell.kind === "failing" || cell.kind === "unknown" || (cell.kind === "paused" && cell.hasHistory);
}

/** Numbers whose last probe is old: drawn without a band, like a stopped pair's history. */
function isQuiet(cell: LatencyCell): boolean {
  return cellQuietFor(cell, intervalSec.value, now.value.getTime()) !== undefined;
}

function cellClass(cell: LatencyCell): string {
  if (isQuiet(cell)) return "";
  switch (cell.kind) {
    case "measured":
      return BAND_STYLE[cell.band ?? "destructive"].tint;
    case "failing":
      // Light enough that its red word keeps 4.5:1 in the light theme (10% left it at 4.46).
      return FAILING_TINT;
    case "unknown":
      return UNKNOWN_HATCH;
    default:
      return "";
  }
}

function cellBar(cell: LatencyCell): string {
  if (isQuiet(cell)) return "bg-muted-foreground/40";
  if (cell.kind === "measured") return BAND_STYLE[cell.band ?? "destructive"].bar;
  if (cell.kind === "failing") return "bg-destructive";
  return "bg-transparent";
}

function cellMain(cell: LatencyCell): string {
  switch (cell.kind) {
    case "measured":
      return formatMs(cell.valueMs);
    case "failing":
      return t("fleet.monitoring.latency.cell.failing");
    case "unknown":
      return t("fleet.monitoring.latency.cell.unknown");
    case "paused":
      return cell.hasHistory && cell.p50Ms !== undefined ? formatMs(readingParam.value === "p95" ? (cell.p95Ms ?? cell.p50Ms) : cell.p50Ms) : t("fleet.monitoring.latency.cell.paused");
    case "notProbeable":
      return t("fleet.monitoring.latency.cell.notProbeable");
    case "self":
      return "";
  }
}

function cellSub(cell: LatencyCell): string {
  if (cell.kind === "measured" || cell.kind === "failing") {
    const parts: string[] = [];
    if (cell.loss !== undefined && (cell.kind === "failing" || cell.loss > 0)) parts.push(t("fleet.monitoring.latency.cell.loss", { loss: formatLoss(cell.loss) }));
    if (cell.partial && cell.coverage !== undefined) parts.push(t("fleet.monitoring.latency.cell.partial", { pct: coveragePercent(cell.coverage) }));
    // A window full of numbers whose last probe is days old is history, and says so.
    const quiet = cellQuietFor(cell, intervalSec.value, now.value.getTime());
    if (quiet !== undefined) parts.push(t("fleet.monitoring.latency.cell.quiet", { age: formatAge(quiet, locale.value) }));
    return parts.join(" · ");
  }
  if (cell.kind === "paused") return t(`fleet.monitoring.latency.paused.${cell.pausedReason ?? "target"}`);
  return "";
}

function cellLabel(cell: LatencyCell, targetName: string, sourceName: string): string {
  const main = cellMain(cell);
  const sub = cellSub(cell);
  return t("fleet.monitoring.latency.cell.label", { source: sourceName, target: targetName, state: sub ? `${main}, ${sub}` : main });
}

function targetDetail(nodeId: string): string {
  const node = plan.value?.nodes.find((n) => n.node_id === nodeId);
  if (!node) return "";
  if (node.target === "not_probeable") return t(`fleet.monitoring.latency.endpointNote.${node.endpoint_note || "no_tcp_line"}`);
  const parts = [node.endpoint ?? ""];
  if (node.endpoint_note === "last_known") parts.push(t("fleet.monitoring.latency.endpointNote.last_known"));
  if (node.target === "paused") parts.push(t(`fleet.monitoring.latency.reason.${node.target_reason || "pairs_off"}`));
  return parts.filter(Boolean).join(" · ");
}

/* ---- Pair sheet ---- */

const pairSheet = bindRouteOpen(props.owned, "pair");
const openPair = computed(() => parsePairKey(pairSheet.openId.value));
const nameOf = (id: string) => plan.value?.nodes.find((n) => n.node_id === id)?.name || id;
const openNode = computed(() => (openPair.value ? plan.value?.nodes.find((n) => n.node_id === openPair.value!.target) : undefined));
const openPairState = computed(() => (openPair.value ? plan.value?.pairs.find((p) => p.source === openPair.value!.source && p.target === openPair.value!.target) : undefined));
const openCell = computed<LatencyCell | undefined>(() => {
  const pair = openPair.value;
  const m = matrix.value;
  if (!pair || !m) return undefined;
  const col = m.sources.findIndex((s) => s.nodeId === pair.source);
  const row = m.rows.find((r) => r.node.node_id === pair.target);
  return col >= 0 && row ? row.cells[col] : undefined;
});
const openRollup = computed(() =>
  openPair.value ? rollupsQuery.data.value?.pairs.find((r) => r.source === openPair.value!.source && r.target === openPair.value!.target) : undefined,
);

const seriesQuery = useAsyncData(
  (signal) => {
    const pair = openPair.value;
    if (!canRead.value || !pair) return Promise.resolve(undefined);
    return api.monitors.latency.series(pair.source, pair.target, windowParam.value, { signal });
  },
  { pollInterval: 30000, immediate: false },
);
watch(
  () => [pairSheet.openId.value, windowParam.value] as const,
  ([id]) => {
    seriesQuery.data.value = undefined;
    seriesQuery.error.value = undefined;
    if (id) void seriesQuery.refresh();
  },
  { immediate: true },
);

const sheetState = computed(() => {
  if (!openPair.value) return "loading" as const;
  if (!plan.value) return planQuery.error.value && !planQuery.loading.value ? ("failed" as const) : ("loading" as const);
  if (!openCell.value) return "gone" as const;
  return planQuery.error.value ? ("stale" as const) : ("ready" as const);
});

const openBadge = computed<{ variant: "success" | "destructive" | "secondary" | "outline"; label: string }>(() => {
  const cell = openCell.value;
  if (!cell) return { variant: "secondary", label: "" };
  switch (cell.kind) {
    case "measured":
      return { variant: cell.band === "success" || cell.band === "chart-2" ? "success" : cell.band === "destructive" ? "destructive" : "outline", label: t("fleet.monitoring.latency.sheet.measured", { value: formatMs(cell.valueMs), reading: readingParam.value }) };
    case "failing":
      return { variant: "destructive", label: t("fleet.monitoring.latency.cell.failing") };
    case "unknown":
      return { variant: "secondary", label: t("fleet.monitoring.latency.cell.unknown") };
    default:
      return { variant: "secondary", label: cellSub(cell) || cellMain(cell) };
  }
});

const windowStats = computed(() => LATENCY_WINDOWS.map((w) => ({ window: w, stats: openRollup.value?.windows[w] })));

/* ---- Pair switch and settings ---- */

const configOpen = ref(false);
const pairPending = ref(false);

async function setOpenPairEnabled(enabled: boolean): Promise<void> {
  const p = plan.value;
  const pair = openPair.value;
  if (!p || !pair) return;
  pairPending.value = true;
  try {
    const draft = setPairEnabled(draftFromConfig(p.config), pair.source, pair.target, enabled);
    planQuery.data.value = await api.monitors.latency.save(draftToConfig(draft));
    void rollupsQuery.refresh();
    toast.success(enabled ? t("fleet.monitoring.latency.toast.pairResumed") : t("fleet.monitoring.latency.toast.pairStopped"));
  } catch (error) {
    const status = (error as { status?: number }).status;
    toast.error(status === 409 ? t("fleet.monitoring.latency.toast.conflict") : error instanceof Error ? error.message : t("fleet.monitoring.latency.toast.saveFailed"));
    void planQuery.refresh();
  } finally {
    pairPending.value = false;
  }
}

function onSaved(next: LatencyProbePlan): void {
  planQuery.data.value = next;
  void rollupsQuery.refresh();
}

const sourceNoteText = (note?: string) => (note ? t(`fleet.monitoring.latency.sourceNote.${note}`) : "");
const LEGEND = computed(() => [
  { key: "success", swatch: BAND_STYLE.success.swatch, label: t("fleet.monitoring.latency.legend.under", { ms: 50 }) },
  { key: "chart-2", swatch: BAND_STYLE["chart-2"].swatch, label: t("fleet.monitoring.latency.legend.under", { ms: 100 }) },
  { key: "warning", swatch: BAND_STYLE.warning.swatch, label: t("fleet.monitoring.latency.legend.under", { ms: 250 }) },
  { key: "destructive", swatch: BAND_STYLE.destructive.swatch, label: t("fleet.monitoring.latency.legend.over", { ms: 250 }) },
]);
</script>

<template>
  <div class="space-y-4">
    <EmptyState
      v-if="!canRead"
      :icon="Gauge"
      :title="$t('fleet.monitoring.noAccessTitle')"
      :description="$t('fleet.monitoring.noAccessDescription')"
    />
    <template v-else>
      <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
        <ProofLine v-bind="proof" :segments="proofSegments" class="me-auto" @retry="refreshAll" />
        <Button variant="outline" size="sm" type="button" :disabled="planQuery.refreshing.value || rollupsQuery.refreshing.value" @click="refreshAll">
          <RefreshCw :class="cn('size-4', (planQuery.refreshing.value || rollupsQuery.refreshing.value) && 'animate-spin')" aria-hidden="true" />
          {{ $t('common.actions.refresh') }}
        </Button>
        <Button v-if="canAdmin && plan" size="sm" type="button" data-testid="latency-configure" @click="configOpen = true">
          <Settings2 class="size-4" aria-hidden="true" />
          {{ $t('fleet.monitoring.latency.configure') }}
        </Button>
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <div class="flex rounded-md border border-border p-0.5 text-xs" role="group" :aria-label="$t('fleet.monitoring.latency.windowLabel')">
          <button
            v-for="w in LATENCY_WINDOWS"
            :key="w"
            type="button"
            :class="cn('rounded px-2.5 py-1 font-mono outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11 pointer-coarse:min-w-11', windowParam === w ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:text-foreground')"
            :aria-pressed="windowParam === w"
            @click="windowParam = w"
          >
            {{ $t(`fleet.monitoring.latency.window.${w}`) }}
          </button>
        </div>
        <div class="flex rounded-md border border-border p-0.5 text-xs" role="group" :aria-label="$t('fleet.monitoring.latency.readingLabel')">
          <button
            v-for="r in LATENCY_READINGS"
            :key="r"
            type="button"
            :class="cn('rounded px-2.5 py-1 font-mono outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11 pointer-coarse:min-w-11', readingParam === r ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:text-foreground')"
            :aria-pressed="readingParam === r"
            @click="readingParam = r"
          >
            {{ r }}
          </button>
        </div>
      </div>

      <AttentionList :items="attention" />

      <DataState
        :loading="planQuery.loading.value"
        :error="planQuery.error.value ?? null"
        :has-data="!!plan"
        :skeleton-rows="6"
        @retry="refreshAll"
      >
        <template v-if="plan && matrix">
          <!-- No source can probe: say which node the defaults looked for. -->
          <EmptyState
            v-if="matrix.sources.length === 0"
            :icon="Gauge"
            :title="plan.stored ? $t('fleet.monitoring.latency.empty.noSourcesTitle') : $t('fleet.monitoring.latency.empty.noDefaultSourceTitle', { name: plan.default_source_name })"
            :description="$t('fleet.monitoring.latency.empty.noSourcesDescription')"
          >
            <Button v-if="canAdmin" size="sm" type="button" @click="configOpen = true">{{ $t('fleet.monitoring.latency.configure') }}</Button>
          </EmptyState>
          <EmptyState
            v-else-if="matrix.rows.length === 0"
            :icon="Gauge"
            :title="$t('fleet.monitoring.latency.empty.noTargetsTitle')"
            :description="$t('fleet.monitoring.latency.empty.noTargetsDescription')"
          >
            <Button v-if="canAdmin" size="sm" type="button" @click="configOpen = true">{{ $t('fleet.monitoring.latency.configure') }}</Button>
          </EmptyState>
          <template v-else>
            <div class="space-y-3">
            <!-- The key in one row above the matrix, as on Topology, so the matrix keeps the page's width. -->
            <aside class="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground" data-testid="latency-legend" :aria-label="$t('fleet.monitoring.latency.legend.label')">
              <span v-for="item in LEGEND" :key="item.key" class="inline-flex items-center gap-1.5">
                <span :class="cn('size-2.5 rounded-[2px]', item.swatch)" aria-hidden="true" />
                {{ item.label }}
              </span>
              <span class="inline-flex items-center gap-1.5">
                <span :class="cn('size-2.5 rounded-[2px] border border-destructive/50', FAILING_TINT)" aria-hidden="true" />
                {{ $t('fleet.monitoring.latency.legend.failing') }}
              </span>
              <span class="inline-flex items-center gap-1.5">
                <span :class="cn('size-2.5 rounded-[2px] border border-muted-foreground/50', UNKNOWN_HATCH)" aria-hidden="true" />
                {{ $t('fleet.monitoring.latency.legend.unknown') }}
              </span>
              <span>{{ $t('fleet.monitoring.latency.legend.partial', { pct: 50 }) }}</span>
              <span>{{ $t('fleet.monitoring.latency.legend.quiet') }}</span>
              <span class="hidden basis-full lg:block">{{ $t('fleet.monitoring.latency.legend.method') }}</span>
            </aside>
            <!-- Shrink-wrapped: a column per source stays a cell wide, so one source does not stretch into a bar. -->
            <div
              class="w-fit max-w-full overflow-x-auto rounded-lg border border-border bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              role="region"
              tabindex="0"
              :aria-label="$t('fleet.monitoring.latency.matrixLabel')"
              data-testid="latency-matrix"
            >
              <table class="border-collapse text-sm">
                <caption class="sr-only">{{ $t('fleet.monitoring.latency.matrixCaption', { window: $t(`fleet.monitoring.latency.window.${windowParam}`), reading: readingParam }) }}</caption>
                <thead>
                  <tr class="border-b border-border bg-muted/40 text-xs text-muted-foreground">
                    <!-- On a phone each target's name has its own line above its cells, so the target column goes. -->
                    <th scope="col" class="sticky start-0 z-10 w-80 min-w-40 bg-muted px-3 py-2 text-start font-medium max-sm:hidden">
                      {{ $t('fleet.monitoring.latency.targetColumn') }}
                    </th>
                    <th
                      v-for="source in matrix.sources"
                      :key="source.nodeId"
                      scope="col"
                      class="w-36 min-w-28 px-2 py-2 text-start align-bottom font-medium max-sm:w-auto max-sm:min-w-20"
                    >
                      <span class="block text-[10px] uppercase tracking-wide">{{ $t('fleet.monitoring.latency.fromLabel') }}</span>
                      <!-- A phone has no tooltip, so the whole source name shows there, wrapped. -->
                      <span class="block truncate text-foreground max-sm:whitespace-normal max-sm:break-words" :title="source.name">{{ source.name }}</span>
                      <span v-if="source.note" class="block text-[11px] font-normal text-warning-text">{{ sourceNoteText(source.note) }}</span>
                    </th>
                  </tr>
                </thead>
                <!-- One body per target: on a phone its name and line take a full-width
                     row above its cells (whole, not broken at a hyphen into a narrow
                     column), and every source fits beside the others. -->
                <template v-for="group in groups" :key="group.region">
                <tbody class="border-b border-border">
                  <tr>
                    <th
                      :colspan="matrix.sources.length + 1"
                      scope="rowgroup"
                      class="bg-muted/30 px-3 pb-1 pt-2.5 text-start text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
                      :data-region="group.region"
                    >
                      {{ $t(`fleet.monitoring.topology.region.${group.region}`) }} · <span class="font-mono tabular">{{ group.rows.length }}</span>
                    </th>
                  </tr>
                </tbody>
                <tbody v-for="row in group.rows" :key="row.node.node_id" class="border-b border-border last:border-b-0" :data-target="row.node.node_id">
                  <tr class="sm:hidden">
                    <th :colspan="matrix.sources.length" scope="rowgroup" class="px-2 pt-1.5 text-start font-normal">
                      <RouterLink
                        :to="{ name: 'node-detail', params: { id: row.node.node_id } }"
                        class="inline-flex max-w-full items-center font-medium hover:underline pointer-coarse:min-h-11"
                      ><span class="truncate">{{ row.node.name || row.node.node_id }}</span></RouterLink>
                      <span class="block truncate text-xs text-muted-foreground">
                        <span v-if="row.node.country" class="font-mono">{{ row.node.country }}</span>
                        <template v-if="row.node.country && targetDetail(row.node.node_id)"> · </template>
                        <span :class="row.node.target === 'not_probeable' ? '' : 'font-mono'">{{ targetDetail(row.node.node_id) }}</span>
                      </span>
                    </th>
                  </tr>
                  <tr>
                    <th scope="row" class="sticky start-0 z-10 bg-card px-3 py-1.5 text-start align-middle font-normal max-sm:hidden">
                      <RouterLink
                        :to="{ name: 'node-detail', params: { id: row.node.node_id } }"
                        class="flex max-w-72 items-center font-medium hover:underline pointer-coarse:min-h-11"
                        :title="row.node.name"
                      ><span class="truncate">{{ row.node.name || row.node.node_id }}</span></RouterLink>
                      <span class="line-clamp-2 max-w-72 text-xs text-muted-foreground" :title="targetDetail(row.node.node_id)">
                        <span v-if="row.node.country" class="font-mono">{{ row.node.country }}</span>
                        <template v-if="row.node.country && targetDetail(row.node.node_id)"> · </template>
                        <span :class="row.node.target === 'not_probeable' ? '' : 'font-mono'">{{ targetDetail(row.node.node_id) }}</span>
                      </span>
                    </th>
                    <td v-for="(cell, index) in row.cells" :key="cell.source" class="p-1 align-middle">
                      <button
                        v-if="cellOpenable(cell)"
                        type="button"
                        :class="cn('group relative flex h-11 w-full min-w-24 max-sm:min-w-20 items-center overflow-hidden rounded-md border border-transparent ps-3 pe-2 text-start outline-none transition-colors hover:border-border focus-visible:ring-2 focus-visible:ring-ring', cellClass(cell), pairSheet.openId.value === pairKey(cell.source, cell.target) && 'border-ring')"
                        :aria-label="cellLabel(cell, row.node.name, matrix.sources[index]!.name)"
                        :data-cell="cell.kind"
                        @click="(e) => pairSheet.open(pairKey(cell.source, cell.target), e.currentTarget as HTMLElement)"
                      >
                        <span :class="cn('absolute inset-y-1 start-1 w-1 rounded-full', cellBar(cell))" aria-hidden="true" />
                        <span class="min-w-0">
                          <span
                            :class="cn(
                              'block truncate leading-tight',
                              cell.kind === 'measured' && 'font-mono font-medium tabular',
                              cell.kind === 'measured' && (isQuiet(cell) ? 'text-muted-foreground' : BAND_STYLE[cell.band ?? 'destructive'].text),
                              cell.kind === 'failing' && 'text-xs font-medium text-destructive',
                              cell.kind === 'unknown' && 'text-xs font-medium text-muted-foreground',
                              cell.kind === 'paused' && 'font-mono text-muted-foreground tabular',
                            )"
                          >{{ cellMain(cell) }}</span>
                          <span v-if="cellSub(cell)" class="block truncate text-[11px] leading-tight text-muted-foreground">{{ cellSub(cell) }}</span>
                        </span>
                      </button>
                      <span
                        v-else
                        class="flex h-11 min-w-24 items-center rounded-md px-3 text-xs text-muted-foreground max-sm:min-w-20"
                        :data-cell="cell.kind"
                        :aria-label="cell.kind === 'self' ? undefined : cellLabel(cell, row.node.name, matrix.sources[index]!.name)"
                      >
                        <template v-if="cell.kind !== 'self'">
                          <span class="min-w-0">
                            <span class="block truncate">{{ cellMain(cell) }}</span>
                            <span v-if="cellSub(cell)" class="block truncate text-[11px]">{{ cellSub(cell) }}</span>
                          </span>
                        </template>
                      </span>
                    </td>
                  </tr>
                </tbody>
                </template>
              </table>
            </div>

            </div>
          </template>
        </template>
      </DataState>
    </template>

    <!-- One pair: its windows, series and endpoint. -->
    <ObjectSheet
      :open="!!pairSheet.openId.value"
      :title="openPair ? $t('fleet.monitoring.latency.sheet.title', { source: nameOf(openPair.source), target: nameOf(openPair.target) }) : ''"
      :subtitle="openNode?.endpoint ? [openNode.protocol, openNode.endpoint].filter(Boolean).join(' · ') : undefined"
      :state="sheetState"
      :error="planQuery.error.value?.message ?? null"
      :return-focus="pairSheet.returnFocus"
      :gone-title="$t('fleet.monitoring.latency.sheet.goneTitle')"
      :gone-description="$t('fleet.monitoring.latency.sheet.goneDescription')"
      @close="pairSheet.close"
      @retry="refreshAll"
    >
      <div v-if="openPair && openCell" class="space-y-5 text-sm">
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
          <Badge :variant="openBadge.variant">{{ openBadge.label }}</Badge>
          <span v-if="openRollup?.latest" class="text-xs text-muted-foreground">
            {{ $t('fleet.monitoring.latency.sheet.lastProbe', { age: formatRelativeTime(openRollup.latest.at) }) }}
            <template v-if="openRollup.latest.success"> · {{ formatMs(openRollup.latest.latency_ms) }}</template>
            <span v-else class="text-destructive"> · {{ openRollup.latest.error || $t('fleet.monitoring.latency.cell.failing') }}</span>
          </span>
        </div>

        <dl class="grid grid-cols-3 gap-2" data-testid="latency-windows">
          <div
            v-for="entry in windowStats"
            :key="entry.window"
            :class="cn('rounded-md border p-2', entry.window === windowParam ? 'border-ring' : 'border-border')"
          >
            <dt class="font-mono text-xs text-muted-foreground">{{ $t(`fleet.monitoring.latency.window.${entry.window}`) }}</dt>
            <dd v-if="entry.stats && entry.stats.samples > 0" class="space-y-0.5">
              <span class="block font-mono font-medium tabular">{{ entry.stats.p50_ms !== undefined ? formatMs(entry.stats.p50_ms) : $t('fleet.monitoring.latency.cell.failing') }}</span>
              <span class="block font-mono text-[11px] text-muted-foreground tabular">p95 {{ formatMs(entry.stats.p95_ms) || $t('common.misc.none') }}</span>
              <span :class="cn('block text-[11px] tabular', (entry.stats.loss ?? 0) > 0 ? 'text-destructive' : 'text-muted-foreground')">{{ $t('fleet.monitoring.latency.cell.loss', { loss: formatLoss(entry.stats.loss) }) }}</span>
              <span class="block text-[11px] text-muted-foreground tabular">{{ $t('fleet.monitoring.latency.sheet.heard', { heard: entry.stats.samples, expected: entry.stats.expected }) }}</span>
            </dd>
            <dd v-else class="text-xs text-muted-foreground">{{ $t('fleet.monitoring.latency.cell.unknown') }}</dd>
          </div>
        </dl>

        <section class="space-y-2" :aria-label="$t('fleet.monitoring.latency.sheet.series')">
          <div class="flex flex-wrap items-center gap-2">
            <p class="me-auto text-xs text-muted-foreground">{{ $t('fleet.monitoring.latency.sheet.series') }}</p>
            <div class="flex rounded-md border border-border p-0.5 text-xs" role="group" :aria-label="$t('fleet.monitoring.latency.windowLabel')">
              <button
                v-for="w in LATENCY_WINDOWS"
                :key="w"
                type="button"
                :class="cn('rounded px-2 py-1 font-mono outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11 pointer-coarse:min-w-11', windowParam === w ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:text-foreground')"
                :aria-pressed="windowParam === w"
                @click="windowParam = w"
              >
                {{ $t(`fleet.monitoring.latency.window.${w}`) }}
              </button>
            </div>
          </div>
          <p v-if="seriesQuery.error.value" class="text-xs text-destructive">{{ seriesQuery.error.value.message }}</p>
          <p v-else-if="!seriesQuery.data.value" class="h-44 text-xs text-muted-foreground">{{ $t('common.proof.reading') }}</p>
          <LatencySeriesChart v-else :series="seriesQuery.data.value" :reading="readingParam" />
        </section>

        <section class="space-y-1 text-xs text-muted-foreground">
          <p v-if="openNode?.line_name">{{ $t('fleet.monitoring.latency.sheet.line', { line: openNode.line_name }) }}</p>
          <p v-if="openNode?.endpoint_note === 'last_known'">{{ $t('fleet.monitoring.latency.endpointNote.last_knownLong') }}</p>
          <p>{{ $t('fleet.monitoring.latency.sheet.method') }}</p>
        </section>
      </div>
      <template v-if="canAdmin && openPair && openPairState" #actions>
        <Button
          v-if="openPairState.enabled"
          variant="outline"
          size="sm"
          type="button"
          :disabled="pairPending"
          data-testid="latency-pair-stop"
          @click="setOpenPairEnabled(false)"
        >
          {{ $t('fleet.monitoring.latency.sheet.stopPair') }}
        </Button>
        <Button v-else size="sm" type="button" :disabled="pairPending" data-testid="latency-pair-resume" @click="setOpenPairEnabled(true)">
          {{ $t('fleet.monitoring.latency.sheet.resumePair') }}
        </Button>
      </template>
    </ObjectSheet>

    <LatencyConfigSheet v-if="plan && canAdmin" :open="configOpen" :plan="plan" @close="configOpen = false" @saved="onSaved" @reload="planQuery.refresh" />
  </div>
</template>
