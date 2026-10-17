<script setup lang="ts">
/**
 * One path, read (design 29 D8): its state and why, the window's figures,
 * the path chart, the buckets as a table, and its latest raw runs.
 *
 * Shared by the path sheet on Paths and the check sheet on Checks, which own
 * the actions. The series comes from GET /api/monitors/series; a server from
 * before design 29 answers a generated path from the latency series route and
 * has no series for an operator check, which then shows its runs only.
 *
 * From a server that judges degraded (design 29 D13) the sheet says a
 * degraded path's evidence, since when and while clearing until when; a down
 * or degraded path's verdict; the degraded rule's guides on the chart and the
 * loss trigger in the stats; and "Compare with the previous period", kept in
 * ?compare=1, overlays the previous window's p50.
 */
import { computed, defineAsyncComponent, defineComponent, h, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import { RouterLink } from "vue-router";

import { api, unwrap, type MonitorResult, type MonitorWindow } from "@/lib/api";
import { useAuthStore } from "@/stores/auth";
import { bindQueryParam } from "@/composables/useQueryParam";
import type { OwnedRoute } from "@/composables/useOwnedRoute";
import { formatDateTime, formatDateTimeRange, formatDuration, formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useAsyncData } from "@/composables/useAsyncData";
import { Badge } from "@/components/ui/badge";

import { latestCertExpiry } from "./checksModel";
import { formatLoss, formatMs } from "./latencyModel";
import { baselinePending, earlierMethods, methodAt, methodMarkers, seriesFromLatency, seriesFromResponse, seriesStats, stepInProgress, type PathSeries } from "./pathSeriesModel";
import { displayState, formatShare, isChosenUnknown, LOSS_TEXT, lossTone, reasonCode, runEchoes, runRows } from "./pathsModel";
import type { Verdict } from "./triangulationModel";
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
import BeaconReplanNote from "./BeaconReplanNote.vue";
import { replanNames } from "./beaconModel";
import { useBeaconReplan } from "./useBeaconReplan";

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
  /** The page's route, which keeps "Compare with the previous period" in ?compare=1. */
  owned: OwnedRoute;
  /** The server judges degraded (its matrix carries degraded_at): the comparison and the rule's guides exist. */
  judgesDegraded?: boolean;
  /** Where a down or degraded path's cause most likely sits (triangulationModel). */
  verdict?: Verdict;
}>();

const emit = defineEmits<{ window: [window: MonitorWindow] }>();

const { t } = useI18n();
const { whyText, stateLabel, windowLong, reasonText, reasonShort, methodName, evidenceSentences, degradedTimes, verdictLabel, verdictEvidence } = usePathsCopy();
/** Agent updates needs node:admin; without it the sheet names the version and links nowhere. */
const canUpdateAgents = computed(() => useAuthStore().can("node:admin"));

/** The reason a path reads unknown when it measured nothing (not a pause or a choice): its figures and runs are then not an outage. */
const unmeasured = computed(() => {
  const p = props.path;
  return p?.state === "unknown" && p.reason && !isChosenUnknown(p.reason) ? p.reason : undefined;
});

/** Beacon reasons the target's Beacon card explains and fixes: no beacon, not admitted, refused, not listening, filtered. */
const BEACON_ON_TARGET = new Set(["beacon_not_enabled", "firewall_pending", "beacon_source_pending", "refused_by_node", "beacon_not_listening", "beacon_filtered"]);
const beaconFixOnTarget = computed(() => BEACON_ON_TARGET.has(reasonCode(unmeasured.value) ?? ""));

/**
 * A source the target's beacon does not admit yet (firewall_pending,
 * beacon_source_pending) waits on a change plan the server names: the sheet
 * offers it, pre-filled as the server words it, or the plan that already
 * waits, where the Beacon card link stood.
 */
const replans = useBeaconReplan();
const replan = computed(() => {
  const code = reasonCode(unmeasured.value);
  if (!replans || (code !== "firewall_pending" && code !== "beacon_source_pending")) return undefined;
  const item = replans.replanFor(props.path?.targetNode);
  return item ? { item, names: replanNames(item, undefined, replans.nameOf), canPlan: replans.missing(item).length === 0 } : undefined;
});

const monitorId = computed(() => props.path?.monitorId || props.address.monitorId || "");
/** The range the chart is zoomed to, whose figures replace the window's. */
const zoom = ref<{ from: number; to: number } | null>(null);

/** "Compare with the previous period" (D13): off by default, kept in ?compare=1. */
const compareParam = bindQueryParam<boolean>(props.owned, "compare", {
  parse: (raw) => raw === "1",
  format: (value) => (value ? "1" : undefined),
});
/** Only a server that judges degraded answers compare=previous; an older one is never asked. */
const comparing = computed(() => !!props.judgesDegraded && props.source === "paths" && compareParam.value);

const seriesQuery = useAsyncData<PathSeries | null>(
  async (signal) => {
    const a = props.address;
    if (props.source === "legacy") {
      if (!a.targetNode) return null;
      return seriesFromLatency(await api.monitors.latency.series(a.source, a.targetNode, legacyWindow(props.window), { signal }));
    }
    const base = a.targetNode && !a.monitorId ? { source: a.source, target_node: a.targetNode, window: props.window } : { source: a.source, monitor: a.monitorId, window: props.window };
    const query = comparing.value ? { ...base, compare: "previous" as const } : base;
    return seriesFromResponse(await api.monitors.series(query, { signal }));
  },
  { pollInterval: 60000, immediate: false },
);

const resultsQuery = useAsyncData<MonitorResult[]>(
  (signal) => (monitorId.value ? api.monitors.results(monitorId.value, { signal }).then((r) => unwrap(r, "results")) : Promise.resolve([])),
  { pollInterval: 30000, immediate: false },
);

// Turning the comparison on or off rereads the series; the chart keeps drawing the one it has meanwhile.
watch(comparing, () => {
  if (props.source !== "unknown") void seriesQuery.refresh();
});
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
  /** Zoomed: the window had a change line here, so its height stays and the chart below does not move under the pointer. */
  holdSub?: boolean;
  tone?: "destructive" | "warning";
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
  // The change against the period before is the window's; a selected range has none, but keeps the line's height.
  const windowDelta = props.path ? pathDelta(props.path) : {};
  const delta = zoomed ? {} : windowDelta;
  const none = t("common.misc.none");
  // Nothing measured: no run counted, or the path reads unknown with a reason. Availability is then none, never 0%.
  const measured = stats.samples > 0 && !unmeasured.value;
  return [
    { key: "p50", label: "p50", value: stats.p50Ms !== undefined ? formatMs(stats.p50Ms) : none, sub: delta.p50Ms !== undefined ? formatDeltaMs(delta.p50Ms) : undefined, holdSub: windowDelta.p50Ms !== undefined },
    { key: "p95", label: "p95", value: stats.p95Ms !== undefined ? formatMs(stats.p95Ms) : none },
    { key: "jitter", label: t("fleet.monitoring.paths.stats.jitter"), value: stats.jitterMs !== undefined ? formatMs(stats.jitterMs) : none },
    {
      key: "loss",
      label: t("fleet.monitoring.paths.stats.loss"),
      value: stats.samples > 0 && stats.loss !== undefined ? formatLoss(stats.loss) : none,
      // A stray lost run in a week is not an alarm; a loss of one percent or more is, on a path that measures. From a
      // server that judges degraded, the loss takes the path's state tone (D13: amber means degraded), never a red of its own.
      tone: measured && (stats.loss ?? 0) >= 0.01 ? lossFigureTone.value : undefined,
      sub: delta.loss !== undefined ? formatDeltaLoss(delta.loss) : undefined,
      holdSub: windowDelta.loss !== undefined,
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
  if (zoom.value) return t("fleet.monitoring.paths.stats.zoomed", formatDateTimeRange(zoom.value.from * 1000, zoom.value.to * 1000));
  const hasDelta = props.path?.prev && (props.path.prev.p50Ms !== undefined || props.path.prev.loss !== undefined);
  return hasDelta ? t("fleet.monitoring.paths.stats.windowDelta", { window: windowLong(props.window) }) : t("fleet.monitoring.paths.stats.window", { window: windowLong(props.window) });
});

/**
 * The window's figures span every method that measured it. After a switch
 * (Auto moving a NAT node from TCP to Beacon, or back to ICMP after its
 * 24 hour retry) the sheet says how much of the window the earlier method
 * measured, so a loss from before the switch is not read as the current
 * method's.
 */
const mixedNote = computed(() => {
  const s = series.value;
  const current = props.path?.method;
  if (!s || !current) return "";
  const mix = earlierMethods(s, current);
  if (!mix) return "";
  return t("fleet.monitoring.paths.stats.mixed", {
    span: formatDuration(mix.seconds),
    methods: mix.methods.map(methodName).join(", "),
    method: methodName(current),
    age: formatRelativeTime(mix.since * 1000),
  });
});

const tone = computed<"success" | "warning" | "destructive" | "muted">(() => {
  const state = props.path?.state;
  return state === "up" ? "success" : state === "degraded" ? "warning" : state === "down" ? "destructive" : "muted";
});

/** The loss bars' and the table's tone: the path's state tone, the ink on an up path, muted when it measured nothing (pathsModel lossTone). */
const barTone = computed(() => (unmeasured.value ? "muted" : lossTone(props.path ? displayState(props.path) : undefined)));
/** A lossy window's figure: the M1 red on a server that does not judge degraded, else the bars' tone when it is a state's (down, degraded). */
const lossFigureTone = computed<"destructive" | "warning" | undefined>(() => {
  if (!props.judgesDegraded) return "destructive";
  return barTone.value === "destructive" || barTone.value === "warning" ? barTone.value : undefined;
});

/* ---- Degraded (design 29 D13) ---- */

const degradedLines = computed(() => (props.path?.state === "degraded" ? [...evidenceSentences(props.path.degraded), ...degradedTimes(props.path.degraded)] : []));
/**
 * The rule's triggers for the stats: the loss trigger has no guide (the loss lane is per bucket), so it is said here.
 * The rule does not depend on the selected range, and the guides stay on a zoomed chart, so neither do these.
 */
const triggers = computed(() => {
  const b = series.value?.baseline;
  if (!b?.ready) return undefined;
  const parts: string[] = [];
  if (b.triggerLoss !== undefined) parts.push(t("fleet.monitoring.paths.stats.triggerLoss", { trigger: formatShare(b.triggerLoss), baseline: formatShare(b.loss ?? 0) }));
  if (b.triggerP50Ms !== undefined) parts.push(t("fleet.monitoring.paths.stats.triggerLatency", { trigger: formatMs(b.triggerP50Ms), baseline: formatMs(b.p50Ms) }));
  return parts.length ? parts.join(" · ") : undefined;
});
/** A path not judged yet says how far it is: "Degraded is judged once this path has 24 hours of history (14 h so far)." */
const pendingNote = computed(() => {
  const pending = props.judgesDegraded ? baselinePending(series.value?.baseline) : undefined;
  return pending ? t("fleet.monitoring.paths.sheet.baselinePending", { needed: pending.needed, hours: pending.hours }) : "";
});

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
/** The newest row is the step in progress: its runs are counted so far, so the row says so. */
const tableLive = (t: number) => !!series.value && stepInProgress(series.value, { t });
</script>

<template>
  <div class="space-y-5 text-sm">
    <!-- State and why: the first thing the sheet says. -->
    <div class="space-y-1">
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Badge v-if="path" :variant="path.state === 'up' ? 'success' : path.state === 'degraded' ? 'warning' : path.state === 'down' ? 'destructive' : 'secondary'" data-testid="path-state">
          {{ stateLabel(path.state) }}
        </Badge>
        <span v-if="path?.state === 'degraded' && path.degraded?.clearingSince" class="text-xs text-warning-text" data-testid="path-clearing">{{ $t('fleet.monitoring.paths.sheet.clearing') }}</span>
        <span v-if="lastRun" class="text-xs text-muted-foreground">
          {{ lastRun.nothing ? $t('fleet.monitoring.paths.sheet.lastRunNothing', { age: formatRelativeTime(lastRun.at) }) : $t('fleet.monitoring.paths.sheet.lastRun', { age: formatRelativeTime(lastRun.at) }) }}
        </span>
        <span v-else-if="path" class="text-xs text-muted-foreground">{{ $t('fleet.monitoring.paths.sheet.noRun') }}</span>
      </div>
      <p v-if="reasonDetail" class="font-mono text-xs break-words text-foreground" data-testid="path-reason-detail">{{ reasonDetail }}</p>
      <template v-if="path?.state === 'degraded'">
        <p class="text-sm break-words text-warning-text" data-testid="path-reason">{{ reasonText(path.reason) }}</p>
        <p v-for="line in degradedLines" :key="line" class="text-xs break-words text-foreground" data-testid="path-evidence">{{ line }}</p>
      </template>
      <p v-else-if="path && path.state !== 'up'" :class="cn('text-sm break-words', path.state === 'down' ? 'text-destructive' : 'text-muted-foreground')" data-testid="path-reason">
        {{ reasonLine }}
      </p>
      <!-- Where the cause most likely sits (D13): a label with its evidence, never a state. -->
      <p v-if="verdict && (path?.state === 'down' || path?.state === 'degraded')" class="text-xs break-words text-muted-foreground" data-testid="path-verdict">
        <span class="font-medium text-foreground">{{ verdictLabel(verdict) }}</span><span aria-hidden="true"> · </span><span class="sr-only">. </span>{{ verdictEvidence(verdict) }}
      </p>
      <!-- What the operator can do about it, for the reasons that have a next step. -->
      <p v-if="unmeasured === 'agent_too_old' && (agentVersion || canUpdateAgents)" class="text-xs text-muted-foreground" data-testid="path-next">
        {{ agentVersion ? $t('fleet.monitoring.paths.sheet.agentNow', { version: agentVersion }) : '' }}
        <RouterLink v-if="canUpdateAgents" :to="{ name: 'platform-agent-updates' }" class="font-medium text-foreground underline underline-offset-2">{{ $t('fleet.monitoring.paths.sheet.agentUpdate') }}</RouterLink>
      </p>
      <p v-else-if="unmeasured === 'icmp_filtered'" class="text-xs text-muted-foreground" data-testid="path-next">{{ $t('fleet.monitoring.paths.sheet.filteredNext') }}</p>
      <!-- A source the target's beacon does not admit yet: the change plan the server names, in one action. -->
      <BeaconReplanNote
        v-else-if="replan && replans"
        class="mt-1.5"
        :item="replan.item"
        :target="path?.targetNodeName || replan.item.name"
        :names="replan.names"
        :sentences="false"
        :can-plan="replan.canPlan"
        :opening="replans.opening.value === replan.item.nodeId"
        beacon-link
        @plan="replans.open(replan.item)"
      />
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
      <!-- The caption wraps in its own column rather than pushing the window control under it, so a zoom's longer caption does not move the chart. -->
      <div class="flex flex-wrap items-center justify-between gap-2">
        <p class="min-w-0 flex-1 basis-64 text-xs text-muted-foreground" data-testid="path-stats-caption">{{ figuresCaption }}</p>
        <WindowControl
          v-if="offered && offered.length"
          :model-value="window"
          :offered="offered"
          :label="$t('fleet.monitoring.window.label')"
          @update:model-value="(w) => emit('window', w)"
        />
      </div>
      <!-- The note is about the window's figures, so a selected range hides it, keeping its height: the note invites that drag, and the chart must stay under the pointer. -->
      <p v-if="mixedNote" :class="cn('text-xs break-words text-muted-foreground', zoom && 'invisible')" :aria-hidden="zoom ? 'true' : undefined" data-testid="path-stats-mixed">{{ mixedNote }}</p>
      <dl class="grid grid-cols-3 gap-x-3 gap-y-2.5 rounded-md border border-border p-3" data-testid="path-stats">
        <div v-for="f in figures" :key="f.key" class="min-w-0">
          <dt class="text-xs text-muted-foreground">{{ f.label }}</dt>
          <dd :class="cn('font-mono font-medium tabular', f.tone === 'destructive' && 'text-destructive', f.tone === 'warning' && 'text-warning-text')">{{ f.value }}</dd>
          <dd v-if="f.sub" class="font-mono text-[11px] text-muted-foreground tabular">{{ f.sub }}</dd>
          <dd v-else-if="f.holdSub" class="invisible font-mono text-[11px] tabular" aria-hidden="true" data-testid="path-stats-held">&nbsp;</dd>
        </div>
        <!-- The degraded rule's triggers: the loss trigger has no guide on the chart, so the stats say both. -->
        <div v-if="triggers" class="col-span-3 min-w-0 border-t border-border pt-2" data-testid="path-triggers">
          <dt class="text-xs text-muted-foreground">{{ $t('fleet.monitoring.paths.stats.triggers') }}</dt>
          <dd class="font-mono text-xs break-words tabular">{{ triggers }}</dd>
        </div>
      </dl>
    </section>

    <section class="space-y-2" :aria-label="$t('fleet.monitoring.paths.sheet.chart')">
      <!-- The chart header: the comparison, off by default (D13). -->
      <div v-if="judgesDegraded && source === 'paths'" class="flex flex-wrap items-center justify-between gap-2">
        <p class="text-xs font-medium text-muted-foreground">{{ $t('fleet.monitoring.paths.sheet.chart') }}</p>
        <button
          type="button"
          role="switch"
          :aria-checked="compareParam"
          :class="cn('inline-flex items-center gap-2 rounded-md px-2 py-1 text-xs outline-none transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11', compareParam ? 'text-foreground' : 'text-muted-foreground')"
          data-testid="path-compare"
          @click="compareParam = !compareParam"
        >
          <span :class="cn('relative inline-flex h-4 w-7 shrink-0 rounded-full border border-border transition-colors', compareParam ? 'bg-foreground' : 'bg-muted')" aria-hidden="true">
            <span :class="cn('absolute top-0.5 size-2.5 rounded-full bg-card transition-[inset-inline-start]', compareParam ? 'start-3.5' : 'start-0.5')" />
          </span>
          {{ $t('fleet.monitoring.paths.sheet.compare') }}
        </button>
      </div>
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
        :loss-tone="barTone"
        :compare="comparing"
        :class="seriesQuery.refreshing.value && 'opacity-70'"
        @zoom="(range) => (zoom = range)"
      />
      <p v-if="pendingNote" class="text-xs text-muted-foreground" data-testid="path-baseline-pending">{{ pendingNote }}</p>
      <p v-if="path?.state === 'degraded'" class="text-xs text-muted-foreground" data-testid="path-baseline-drift">{{ $t('fleet.monitoring.paths.sheet.baselineDrift') }}</p>
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
                <td class="whitespace-nowrap px-3 py-1">
                  {{ formatDateTime(p.t * 1000) }}<span v-if="tableLive(p.t)" class="ms-1 font-sans text-muted-foreground" data-testid="path-table-live">{{ $t('fleet.monitoring.chart.inProgress') }}</span>
                </td>
                <template v-if="p.missing">
                  <td colspan="4" class="px-2 py-1 text-end font-sans text-muted-foreground">{{ $t('fleet.monitoring.chart.noData') }}</td>
                </template>
                <template v-else>
                  <td class="px-2 py-1 text-end">{{ formatMs(p.p50Ms) || '' }}</td>
                  <td class="px-2 py-1 text-end">{{ formatMs(p.p95Ms) || '' }}</td>
                  <td class="px-2 py-1 text-end">{{ formatMs(p.jitterMs) || '' }}</td>
                  <td :class="cn('px-2 py-1 text-end', (p.loss ?? 0) > 0 && LOSS_TEXT[barTone])">{{ p.n > 0 ? formatLoss(p.loss ?? 0) : '' }}</td>
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
