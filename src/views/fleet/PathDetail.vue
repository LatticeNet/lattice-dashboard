<script setup lang="ts">
/**
 * One path, read (design 29 D8): its state and why, the window's figures,
 * the path chart, the buckets as a table, and its latest raw runs.
 *
 * Shared by the path sheet on Paths and the check sheet on Checks, which own
 * the actions. The series comes from GET /api/monitors/series; a server from
 * before design 29 answers a generated path from the latency series route and
 * has no series for an operator check, which then shows its runs only.
 */
import { computed, defineAsyncComponent, defineComponent, h, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import { RouterLink } from "vue-router";

import { api, unwrap, type MonitorResult, type MonitorWindow } from "@/lib/api";
import { useAuthStore } from "@/stores/auth";
import { formatDateTime, formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useAsyncData } from "@/composables/useAsyncData";
import { Badge } from "@/components/ui/badge";

import { latestCertExpiry } from "./checksModel";
import { formatLoss, formatMs } from "./latencyModel";
import { methodAt, methodMarkers, seriesFromLatency, seriesFromResponse, seriesStats, type PathSeries } from "./pathSeriesModel";
import { isChosenUnknown, runEchoes, runRows } from "./pathsModel";
import {
  availability,
  formatDeltaLoss,
  formatDeltaMs,
  legacyWindow,
  pathDelta,
  type PathAddress,
  type PathItem,
  type PathsSource,
} from "./pathsModel";
import { usePathsCopy } from "./pathsCopy";
import WindowControl from "./WindowControl.vue";

// The chart and uPlot load with the first sheet that draws one, not with the page. A chunk
// that fails to load (a tab left open across a deploy) says so instead of leaving a blank.
const ChartLoadFailed = defineComponent({
  name: "PathChartLoadFailed",
  setup() {
    const { t } = useI18n();
    return () => h("p", { class: "rounded-md border border-border p-3 text-xs text-destructive", role: "alert" }, t("fleet.monitoring.paths.sheet.chartFailed"));
  },
});
const PathChart = defineAsyncComponent({ loader: () => import("./PathChart.vue"), errorComponent: ChartLoadFailed });

const props = defineProps<{
  address: PathAddress;
  path?: PathItem;
  window: MonitorWindow;
  source: PathsSource;
  compact: boolean;
  /** "cd-hs-sh to xuezhang-jp-nat", for the chart's accessible name. */
  title: string;
  /** The windows the page offers; given, the sheet carries its own control (the page's is under the sheet). */
  offered?: MonitorWindow[];
  /** The agent's newest error, for a down path the server sends without a reason. */
  failure?: string;
  /** The source's agent version, said when the path reads agent_too_old. */
  agentVersion?: string;
  /** The paths read failed before it said which server this is, so no series can be asked for yet. */
  pathsFailed?: boolean;
}>();

const emit = defineEmits<{ window: [window: MonitorWindow] }>();

const { t } = useI18n();
const { whyText, stateLabel, windowLong, reasonText, reasonShort } = usePathsCopy();
/** Agent updates needs node:admin; without it the sheet names the version and links nowhere. */
const canUpdateAgents = computed(() => useAuthStore().can("node:admin"));

/** The reason a path reads unknown when it measured nothing (not a pause or a choice): its figures and runs are then not an outage. */
const unmeasured = computed(() => {
  const p = props.path;
  return p?.state === "unknown" && p.reason && !isChosenUnknown(p.reason) ? p.reason : undefined;
});

/** Beacon reasons the target's Beacon card explains and fixes: no beacon, not admitted, refused, not listening, filtered. */
const BEACON_ON_TARGET = new Set(["beacon_not_enabled", "firewall_pending", "beacon_source_pending", "refused_by_node", "beacon_not_listening", "beacon_filtered"]);
const beaconFixOnTarget = computed(() => !!unmeasured.value && BEACON_ON_TARGET.has(unmeasured.value));

const monitorId = computed(() => props.path?.monitorId || props.address.monitorId || "");
/** The range the chart is zoomed to, whose figures replace the window's. */
const zoom = ref<{ from: number; to: number } | null>(null);

const seriesQuery = useAsyncData<PathSeries | null>(
  async (signal) => {
    const a = props.address;
    if (props.source === "legacy") {
      if (!a.targetNode) return null;
      return seriesFromLatency(await api.monitors.latency.series(a.source, a.targetNode, legacyWindow(props.window), { signal }));
    }
    const query = a.targetNode && !a.monitorId ? { source: a.source, target_node: a.targetNode, window: props.window } : { source: a.source, monitor: a.monitorId, window: props.window };
    return seriesFromResponse(await api.monitors.series(query, { signal }));
  },
  { pollInterval: 60000, immediate: false },
);

const resultsQuery = useAsyncData<MonitorResult[]>(
  (signal) => (monitorId.value ? api.monitors.results(monitorId.value, { signal }).then((r) => unwrap(r, "results")) : Promise.resolve([])),
  { pollInterval: 30000, immediate: false },
);

watch(
  () => [props.address.source, props.address.targetNode, props.address.monitorId, props.window, props.source] as const,
  () => {
    seriesQuery.data.value = undefined;
    seriesQuery.error.value = undefined;
    zoom.value = null;
    // The paths read decides which server this is first; reading the series before that would ask the wrong route.
    if (props.source !== "unknown") void seriesQuery.refresh();
  },
  { immediate: true },
);
watch(
  monitorId,
  () => {
    resultsQuery.data.value = undefined;
    void resultsQuery.refresh();
  },
  { immediate: true },
);

/* ---- Figures ---- */

const series = computed(() => seriesQuery.data.value ?? undefined);

interface Figure {
  key: string;
  label: string;
  value: string;
  sub?: string;
  tone?: "destructive";
}

const figures = computed<Figure[]>(() => {
  const s = series.value;
  const zoomed = zoom.value && s ? s.points.filter((p) => p.t + s.stepSec > zoom.value!.from && p.t < zoom.value!.to) : undefined;
  const fromBuckets = zoomed ?? (props.path ? undefined : s?.points);
  const stats = fromBuckets
    ? seriesStats(fromBuckets)
    : props.path
      ? { p50Ms: props.path.p50Ms, p95Ms: props.path.p95Ms, jitterMs: props.path.jitterMs, loss: props.path.loss, availability: availability(props.path), samples: props.path.samples, expected: props.path.expected }
      : undefined;
  if (!stats) return [];
  const delta = !zoomed && props.path ? pathDelta(props.path) : {};
  const none = t("common.misc.none");
  // Nothing measured: no run counted, or the path reads unknown with a reason. Availability is then none, never 0%.
  const measured = stats.samples > 0 && !unmeasured.value;
  return [
    { key: "p50", label: "p50", value: stats.p50Ms !== undefined ? formatMs(stats.p50Ms) : none, sub: delta.p50Ms !== undefined ? formatDeltaMs(delta.p50Ms) : undefined },
    { key: "p95", label: "p95", value: stats.p95Ms !== undefined ? formatMs(stats.p95Ms) : none },
    { key: "jitter", label: t("fleet.monitoring.paths.stats.jitter"), value: stats.jitterMs !== undefined ? formatMs(stats.jitterMs) : none },
    {
      key: "loss",
      label: t("fleet.monitoring.paths.stats.loss"),
      value: stats.samples > 0 && stats.loss !== undefined ? formatLoss(stats.loss) : none,
      // A stray lost run in a week is not an alarm; a loss of one percent or more is, on a path that measures.
      tone: measured && (stats.loss ?? 0) >= 0.01 ? "destructive" : undefined,
      sub: delta.loss !== undefined ? formatDeltaLoss(delta.loss) : undefined,
    },
    { key: "availability", label: t("fleet.monitoring.paths.stats.availability"), value: measured && stats.availability !== undefined ? formatAvailability(stats.availability) : none },
    { key: "samples", label: t("fleet.monitoring.paths.stats.samples"), value: t("fleet.monitoring.paths.stats.samplesValue", { n: stats.samples, expected: stats.expected }) },
  ];
});

function formatAvailability(share: number): string {
  if (share >= 1) return "100%";
  if (share >= 0.999) return ">99.9%";
  return `${(Math.floor(share * 1000) / 10).toFixed(1)}%`;
}

const figuresCaption = computed(() => {
  if (zoom.value) return t("fleet.monitoring.paths.stats.zoomed", { from: formatDateTime(zoom.value.from * 1000), to: formatDateTime(zoom.value.to * 1000) });
  const hasDelta = props.path?.prev && (props.path.prev.p50Ms !== undefined || props.path.prev.loss !== undefined);
  return hasDelta ? t("fleet.monitoring.paths.stats.windowDelta", { window: windowLong(props.window) }) : t("fleet.monitoring.paths.stats.window", { window: windowLong(props.window) });
});

const tone = computed<"success" | "destructive" | "muted">(() => (props.path?.state === "up" ? "success" : props.path?.state === "down" ? "destructive" : "muted"));

/* ---- Runs ---- */

const RUNS_SHOWN = 20;
const runs = computed(() =>
  (resultsQuery.data.value ?? [])
    .filter((r) => (r.node_id ?? "") === props.address.source)
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
    .slice(0, RUNS_SHOWN),
);
const rows = computed(() => runRows(runs.value, unmeasured.value));

/** The newest run, from the path or else from the runs: a run that measured nothing is still a run. */
const lastRun = computed(() => {
  if (props.path?.lastAt) return { at: props.path.lastAt, nothing: false };
  const newest = runs.value[0];
  return newest ? { at: newest.at, nothing: !!newest.reason || !!unmeasured.value } : undefined;
});

/** What the readout says of a bucket with no answer on a path that measured nothing. */
const unmeasuredNote = computed(() => (unmeasured.value ? t("fleet.monitoring.chart.nothingMeasured", { reason: reasonShort(unmeasured.value) }) : undefined));

/** The cause the agent named for the reason, such as "refused to dial 10.0.0.8: private address": said first, before the general sentence. */
const reasonDetail = computed(() => {
  const reason = unmeasured.value;
  if (!reason) return "";
  return runs.value.find((r) => r.reason === reason && r.error)?.error ?? "";
});

/** Why the path is not up: the newest failed run's error for a down path (the server sends no reason with it), else the reason. */
const reasonLine = computed(() => {
  const p = props.path;
  if (!p) return "";
  if (p.state === "down" && !p.reason) {
    // A run with a reason measured nothing; the failure is the newest run that did.
    const failed = runs.value.find((r) => !r.success && !r.reason && r.error);
    if (failed?.error) return failed.error;
    if (props.failure) return props.failure;
  }
  return whyText(p);
});

/* ---- A certificate check: when the certificate expires ---- */

const DAY_MS = 86_400_000;
/** The expiry the newest run that completed a handshake read, for a tls check. */
const cert = computed(() => {
  const expires = latestCertExpiry(runs.value);
  if (expires === undefined) return undefined;
  return { date: formatDateTime(expires), days: Math.floor((expires - Date.now()) / DAY_MS) };
});

/* ---- Table view ---- */

const tableRows = computed(() => [...(series.value?.points ?? [])].reverse());
/** A series that switched method (tcp to icmp) names each bucket's method in the table too. */
const tableMethods = computed(() => !!series.value && methodMarkers(series.value).length > 0);
const tableMethod = (t: number) => (series.value ? methodAt(series.value, t, props.path?.method ?? "tcp").toUpperCase() : "");
</script>

<template>
  <div class="space-y-5 text-sm">
    <!-- State and why: the first thing the sheet says. -->
    <div class="space-y-1">
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Badge v-if="path" :variant="path.state === 'up' ? 'success' : path.state === 'down' ? 'destructive' : 'secondary'" data-testid="path-state">
          {{ stateLabel(path.state) }}
        </Badge>
        <span v-if="lastRun" class="text-xs text-muted-foreground">
          {{ lastRun.nothing ? $t('fleet.monitoring.paths.sheet.lastRunNothing', { age: formatRelativeTime(lastRun.at) }) : $t('fleet.monitoring.paths.sheet.lastRun', { age: formatRelativeTime(lastRun.at) }) }}
        </span>
        <span v-else-if="path" class="text-xs text-muted-foreground">{{ $t('fleet.monitoring.paths.sheet.noRun') }}</span>
      </div>
      <p v-if="reasonDetail" class="font-mono text-xs break-words text-foreground" data-testid="path-reason-detail">{{ reasonDetail }}</p>
      <p v-if="path && path.state !== 'up'" :class="cn('text-sm break-words', path.state === 'down' ? 'text-destructive' : 'text-muted-foreground')" data-testid="path-reason">
        {{ reasonLine }}
      </p>
      <!-- What the operator can do about it, for the reasons that have a next step. -->
      <p v-if="unmeasured === 'agent_too_old' && (agentVersion || canUpdateAgents)" class="text-xs text-muted-foreground" data-testid="path-next">
        {{ agentVersion ? $t('fleet.monitoring.paths.sheet.agentNow', { version: agentVersion }) : '' }}
        <RouterLink v-if="canUpdateAgents" :to="{ name: 'platform-agent-updates' }" class="font-medium text-foreground underline underline-offset-2">{{ $t('fleet.monitoring.paths.sheet.agentUpdate') }}</RouterLink>
      </p>
      <p v-else-if="unmeasured === 'icmp_filtered'" class="text-xs text-muted-foreground" data-testid="path-next">{{ $t('fleet.monitoring.paths.sheet.filteredNext') }}</p>
      <!-- A beacon reason whose fix is on the target: its Beacon card on the node page (design 29 D12). -->
      <p v-else-if="beaconFixOnTarget && path?.targetNode" class="text-xs text-muted-foreground" data-testid="path-next">
        <RouterLink
          :to="{ name: 'node-detail', params: { id: path.targetNode }, hash: '#node-beacon' }"
          class="font-medium text-foreground underline underline-offset-2 pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:items-center"
        >{{ $t('fleet.monitoring.paths.sheet.beaconNext', { name: path.targetNodeName || path.targetNode }) }}</RouterLink>
      </p>
    </div>

    <p
      v-if="cert"
      :class="cn('rounded-md border border-border p-3 text-sm', cert.days < 0 && 'text-destructive')"
      data-testid="path-cert"
    >
      {{ cert.days < 0 ? $t('fleet.monitoring.paths.sheet.certExpired', { date: cert.date }) : $t('fleet.monitoring.paths.sheet.cert', { date: cert.date, n: cert.days }, cert.days) }}
    </p>

    <section v-if="figures.length" class="space-y-1.5" :aria-label="figuresCaption">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <p class="text-xs text-muted-foreground">{{ figuresCaption }}</p>
        <WindowControl
          v-if="offered && offered.length"
          :model-value="window"
          :offered="offered"
          :label="$t('fleet.monitoring.window.label')"
          @update:model-value="(w) => emit('window', w)"
        />
      </div>
      <dl class="grid grid-cols-3 gap-x-3 gap-y-2.5 rounded-md border border-border p-3" data-testid="path-stats">
        <div v-for="f in figures" :key="f.key" class="min-w-0">
          <dt class="text-xs text-muted-foreground">{{ f.label }}</dt>
          <dd :class="cn('font-mono font-medium tabular', f.tone === 'destructive' && 'text-destructive')">{{ f.value }}</dd>
          <dd v-if="f.sub" class="font-mono text-[11px] text-muted-foreground tabular">{{ f.sub }}</dd>
        </div>
      </dl>
    </section>

    <section class="space-y-2" :aria-label="$t('fleet.monitoring.paths.sheet.chart')">
      <p v-if="seriesQuery.error.value" class="rounded-md border border-border p-3 text-xs text-destructive" role="alert">
        {{ $t('fleet.monitoring.paths.sheet.seriesFailed', { reason: seriesQuery.error.value.message }) }}
        <button type="button" class="ms-1 font-medium text-foreground underline underline-offset-2" @click="seriesQuery.refresh()">{{ $t('common.actions.retry') }}</button>
      </p>
      <p v-else-if="source === 'unknown' && pathsFailed" class="rounded-md border border-border p-3 text-xs text-muted-foreground" role="status" data-testid="path-no-series">
        {{ $t('fleet.monitoring.paths.sheet.seriesNeedsPaths') }}
      </p>
      <p v-else-if="seriesQuery.data.value === null" class="rounded-md bg-muted/40 p-3 text-xs text-muted-foreground" data-testid="path-no-series">
        {{ $t('fleet.monitoring.paths.sheet.noSeries') }}
      </p>
      <div v-else-if="!series" :class="cn('rounded-md bg-muted/30', compact ? 'h-[19rem]' : 'h-[17.5rem]')" aria-busy="true">
        <span class="sr-only">{{ $t('common.proof.reading') }}</span>
      </div>
      <p v-else-if="series.points.length === 0" class="rounded-md bg-muted/40 p-3 text-xs text-muted-foreground">{{ $t('fleet.monitoring.paths.sheet.seriesEmpty') }}</p>
      <PathChart
        v-else
        :series="series"
        :tone="tone"
        :method="path?.method ?? 'tcp'"
        :compact="compact"
        :height="compact ? 200 : 228"
        :label="$t('fleet.monitoring.paths.sheet.chartLabel', { path: title, window: windowLong(window) })"
        :unmeasured-note="unmeasuredNote"
        :class="seriesQuery.refreshing.value && 'opacity-70'"
        @zoom="(range) => (zoom = range)"
      />
      <details v-if="series && series.points.length" class="group rounded-md border border-border" data-testid="path-table">
        <summary class="cursor-pointer list-none px-3 py-2 text-xs font-medium text-muted-foreground hover:text-foreground pointer-coarse:min-h-11 pointer-coarse:py-3">
          {{ $t('fleet.monitoring.paths.sheet.table', { n: series.points.length }) }}
        </summary>
        <div class="max-h-80 overflow-auto border-t border-border">
          <table class="w-full text-xs">
            <caption class="sr-only">{{ $t('fleet.monitoring.paths.sheet.tableCaption', { path: title }) }}</caption>
            <thead class="sticky top-0 bg-card text-muted-foreground">
              <tr>
                <th scope="col" class="px-3 py-1.5 text-start font-medium">{{ $t('fleet.monitoring.paths.sheet.col.time') }}</th>
                <th scope="col" class="px-2 py-1.5 text-end font-medium">p50</th>
                <th scope="col" class="px-2 py-1.5 text-end font-medium">p95</th>
                <th scope="col" class="px-2 py-1.5 text-end font-medium">{{ $t('fleet.monitoring.paths.stats.jitter') }}</th>
                <th scope="col" class="px-2 py-1.5 text-end font-medium">{{ $t('fleet.monitoring.paths.stats.loss') }}</th>
                <th scope="col" class="px-3 py-1.5 text-end font-medium">{{ $t('fleet.monitoring.paths.stats.samples') }}</th>
                <th v-if="tableMethods" scope="col" class="px-3 py-1.5 text-start font-medium">{{ $t('fleet.monitoring.chart.method') }}</th>
              </tr>
            </thead>
            <tbody class="font-mono tabular">
              <tr v-for="p in tableRows" :key="p.t" class="border-t border-border/60">
                <td class="whitespace-nowrap px-3 py-1">{{ formatDateTime(p.t * 1000) }}</td>
                <template v-if="p.missing">
                  <td colspan="4" class="px-2 py-1 text-end font-sans text-muted-foreground">{{ $t('fleet.monitoring.chart.noData') }}</td>
                </template>
                <template v-else>
                  <td class="px-2 py-1 text-end">{{ formatMs(p.p50Ms) || '' }}</td>
                  <td class="px-2 py-1 text-end">{{ formatMs(p.p95Ms) || '' }}</td>
                  <td class="px-2 py-1 text-end">{{ formatMs(p.jitterMs) || '' }}</td>
                  <td :class="cn('px-2 py-1 text-end', (p.loss ?? 0) > 0 && 'text-destructive')">{{ p.n > 0 ? formatLoss(p.loss ?? 0) : '' }}</td>
                </template>
                <td class="px-3 py-1 text-end">{{ p.n }}/{{ p.expected }}</td>
                <td v-if="tableMethods" class="px-3 py-1">{{ tableMethod(p.t) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </details>
    </section>

    <section class="space-y-2" :aria-label="$t('fleet.monitoring.paths.sheet.runs')">
      <h3 class="text-xs font-medium text-muted-foreground">{{ $t('fleet.monitoring.paths.sheet.runs') }}</h3>
      <p v-if="resultsQuery.error.value" class="text-xs text-destructive">{{ resultsQuery.error.value.message }}</p>
      <ul v-else-if="runs.length" class="divide-y divide-border rounded-md border border-border" data-testid="path-runs">
        <template v-for="row in rows" :key="row.kind === 'run' ? row.run.at : `${row.reason}-${row.newest.at}`">
          <!-- A stretch of runs that measured nothing for one reason: one row, not one per interval. -->
          <li v-if="row.kind === 'unmeasured'" class="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-3 px-3 py-1.5 text-xs" data-run="unmeasured">
            <span class="min-w-0 text-muted-foreground">
              {{ row.count > 1 ? $t('fleet.monitoring.paths.sheet.runSpan', { from: formatDateTime(row.oldest.at), to: formatDateTime(row.newest.at) }) : formatDateTime(row.newest.at) }}
            </span>
            <span class="text-end text-muted-foreground">{{ $t('fleet.monitoring.paths.sheet.runsUnmeasured', { n: row.count }, row.count) }}</span>
            <span class="col-span-2 break-words text-muted-foreground">{{ reasonText(row.reason) }}</span>
            <span v-if="row.newest.error" class="col-span-2 break-words font-mono text-muted-foreground">{{ row.newest.error }}</span>
          </li>
          <li v-else class="grid grid-cols-[minmax(0,1fr)_auto_auto] items-baseline gap-x-3 px-3 py-1.5 text-xs" :data-run="row.run.success ? 'ok' : 'fail'">
            <span class="min-w-0 text-muted-foreground">{{ formatDateTime(row.run.at) }}</span>
            <span class="font-mono tabular">{{ row.run.latency_ms !== undefined ? formatMs(row.run.latency_ms) : '' }}</span>
            <span :class="cn('text-end font-medium', row.run.success ? 'text-foreground' : 'text-destructive')">{{ row.run.success ? $t('fleet.monitoring.result.ok') : $t('fleet.monitoring.result.fail') }}</span>
            <span v-if="runEchoes(row.run)" class="col-span-3 break-words font-mono text-muted-foreground tabular" data-testid="run-echoes">
              <span :class="runEchoes(row.run)!.lost > 0 ? 'text-destructive' : ''">{{ $t('fleet.monitoring.paths.sheet.echoes', { sent: runEchoes(row.run)!.sent, lost: runEchoes(row.run)!.lost }) }}</span>
              <template v-if="runEchoes(row.run)!.rtts.length">: {{ runEchoes(row.run)!.rtts.join(' ') }} ms</template>
            </span>
            <span v-if="row.run.error" class="col-span-3 break-words text-destructive">{{ row.run.error }}</span>
          </li>
        </template>
      </ul>
      <p v-else-if="resultsQuery.data.value !== undefined" class="text-xs text-muted-foreground">{{ $t('fleet.monitoring.paths.sheet.runsEmpty') }}</p>
    </section>

    <p v-if="path" class="text-xs text-muted-foreground" data-testid="path-endpoint">
      {{ $t('fleet.monitoring.paths.sheet.endpoint', { method: path.method.toUpperCase(), target: path.target || $t('common.misc.none') }) }}
    </p>
  </div>
</template>
