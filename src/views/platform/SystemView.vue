<script setup lang="ts">
/**
 * Platform > System: the control plane's own health and history, from its
 * metrics store (metrics.db).
 *
 * Two subjects on top, each one fact line and one chart: the host as the
 * container sees it and the lattice-server process. Under them the data
 * files and their growth over the range, then one layer at a time: plugin
 * methods (the default, because "which plugin is slow" is the question this
 * page was asked for), HTTP route groups, and state writes by caller. Every
 * row has its p50, p95, failures and a p95 sparkline over the range.
 *
 * The proof line says what the metrics store last wrote, when, and how full
 * it is against its series cap. A full administrator only: anyone else gets
 * the reason, not an empty page.
 */
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useNow } from "@vueuse/core";
import { Cpu, HardDrive, RefreshCw, Search, Server } from "lucide-vue-next";

import { api, ApiError, type MetricsQuery, type MetricsRange, type SystemHealth } from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { useProof } from "@/composables/useProof";
import { useOwnedRoute } from "@/composables/useOwnedRoute";
import { bindLayer } from "@/composables/useLayer";
import { bindQueryParam } from "@/composables/useQueryParam";
import { NO_VALUE, formatDateTime, formatDuration } from "@/lib/format";
import { cn } from "@/lib/utils";

import PageHeader from "@/components/common/PageHeader.vue";
import ProofLine, { type ProofSegment } from "@/components/common/ProofLine.vue";
import AttentionList, { type AttentionItem } from "@/components/common/AttentionList.vue";
import LayerTabs, { type LayerTab } from "@/components/common/LayerTabs.vue";
import DataState from "@/components/common/DataState.vue";
import HistoryChart from "@/components/common/HistoryChart.vue";
import RangeSparkline from "@/components/common/RangeSparkline.vue";
import SystemEventRow from "./SystemEventRow.vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

import {
  DEFAULT_SYSTEM_RANGE,
  SYSTEM_LAYERS,
  SYSTEM_RANGES,
  filterRows,
  formatByteChange,
  formatBytesShort,
  formatSeconds,
  formatUnit,
  freeSpaceTone,
  groupPluginRows,
  memoryTone,
  parseRange,
  sortedTiers,
  spanParts,
  sparkChange,
  storeFreshness,
  type SystemLayer,
  type Tone,
} from "./systemModel";

const { t } = useI18n();
const owned = useOwnedRoute();
const now = useNow({ interval: 1000 });

const range = bindQueryParam<MetricsRange>(owned, "range", {
  parse: (raw) => parseRange(raw),
  format: (value) => (value === DEFAULT_SYSTEM_RANGE ? undefined : value),
});
const layer = bindLayer<SystemLayer>(owned, () => SYSTEM_LAYERS, () => "plugins");

const CP_SERIES = ["host.mem_used", "host.mem_total", "host.load1", "proc.rss", "proc.heap", "proc.cpu", "host.disk_used", "host.disk_total"];

const healthQuery = useAsyncData<SystemHealth>((signal) => api.system.health(range.value, { signal }), { pollInterval: 30_000 });
const seriesQuery = useAsyncData<MetricsQuery>((signal) => api.system.series("cp", CP_SERIES, range.value, 400, { signal }), {
  pollInterval: 60_000,
});
watch(range, () => {
  void healthQuery.refresh();
  void seriesQuery.refresh();
});

const health = computed(() => healthQuery.data.value);
const proof = useProof([healthQuery, seriesQuery]);

/** 403 and 503 are answers, not failures: say what they mean instead of a retry. */
const blocked = computed<"forbidden" | "disabled" | null>(() => {
  const err = healthQuery.error.value;
  if (!(err instanceof ApiError)) return null;
  if (err.isForbidden) return "forbidden";
  if (err.status === 503) return "disabled";
  return null;
});

const store = computed(() => health.value?.metrics_store);
const freshness = computed(() => (store.value ? storeFreshness(store.value, now.value.getTime()) : undefined));

const proofSegments = computed<ProofSegment[]>(() => {
  const s = store.value;
  if (!s) return [];
  const segs: ProofSegment[] = [];
  if (s.last_write_at) {
    segs.push({
      key: "wrote",
      text: t("platform.system.proof.wrote", { time: formatDateTime(s.last_write_at) }),
      tone: freshness.value === "late" ? "warning" : "strong",
    });
  } else {
    segs.push({ key: "wrote", text: t("platform.system.proof.waiting"), tone: "muted" });
  }
  segs.push({
    key: "series",
    text: t("platform.system.proof.series", { series: s.series.toLocaleString("en-US"), max: s.max_series.toLocaleString("en-US") }),
    tone: s.series >= s.max_series * 0.9 ? "warning" : "default",
  });
  segs.push({ key: "size", text: t("platform.system.proof.size", { size: formatBytesShort(s.size_bytes) }) });
  if (health.value) {
    segs.push({ key: "step", text: t("platform.system.proof.uptime", { uptime: formatDuration(health.value.process.uptime_seconds) }), tone: "muted" });
  }
  return segs;
});

const attention = computed<AttentionItem[]>(() => {
  const h = health.value;
  const s = store.value;
  if (!h || !s) return [];
  const items: AttentionItem[] = [];
  if (s.last_write_error) {
    items.push({ key: "write-error", tone: "danger", claim: t("platform.system.attention.writeFailing"), proof: s.last_write_error });
  } else if (freshness.value === "late" && s.last_write_at) {
    items.push({ key: "late", tone: "warning", claim: t("platform.system.attention.late"), proof: formatDateTime(s.last_write_at) });
  }
  if (s.dropped_series > 0) {
    items.push({
      key: "dropped",
      tone: "warning",
      claim: t("platform.system.attention.dropped", { n: s.dropped_series }, s.dropped_series),
      proof: t("platform.system.attention.droppedProof", { max: s.max_series }),
    });
  }
  const free = h.host.disk_free_bytes;
  const total = h.host.disk_total_bytes;
  const diskTone = freeSpaceTone(free, total);
  if (diskTone !== "default") {
    items.push({
      key: "disk",
      tone: diskTone === "destructive" ? "danger" : "warning",
      claim: t("platform.system.attention.disk", { free: formatBytesShort(free), dir: h.host.data_dir ?? "" }),
      proof: t("platform.system.attention.diskProof", { total: formatBytesShort(total) }),
    });
  }
  const memTone = memoryTone(h.host.mem_available_bytes, h.host.mem_total_bytes);
  if (memTone !== "default") {
    items.push({
      key: "memory",
      tone: memTone === "destructive" ? "danger" : "warning",
      claim: t("platform.system.attention.memory", { avail: formatBytesShort(h.host.mem_available_bytes) }),
      proof: t("platform.system.attention.memoryProof", { total: formatBytesShort(h.host.mem_total_bytes) }),
    });
  }
  return items;
});

/* Charts ------------------------------------------------------------- */

const seriesByName = computed(() => new Map((seriesQuery.data.value?.series ?? []).map((s) => [s.name, s])));
const chartFrom = computed(() => Math.floor(Date.parse(seriesQuery.data.value?.from ?? health.value?.from ?? "") / 1000) || 0);
const chartTo = computed(() => Math.floor(Date.parse(seriesQuery.data.value?.to ?? health.value?.to ?? "") / 1000) || 0);
const chartStep = computed(() => seriesQuery.data.value?.step_seconds ?? 60);
const stepLabel = computed(() => {
  const step = seriesQuery.data.value?.step_seconds;
  if (!step) return "";
  const parts = spanParts(step);
  return t("platform.system.stepEvery", { span: t(`platform.system.span.${parts.unit}`, { n: parts.n }, parts.n) });
});

/* Facts -------------------------------------------------------------- */

interface Fact {
  key: string;
  label: string;
  value: string;
  detail?: string;
  tone?: Tone;
}

const hostFacts = computed<Fact[]>(() => {
  const host = health.value?.host;
  if (!host) return [];
  const facts: Fact[] = [];
  if (host.load1 !== undefined) {
    facts.push({
      key: "load",
      label: t("platform.system.host.load"),
      value: host.load1.toFixed(2),
      detail: t("platform.system.host.loadDetail", { l5: host.load5?.toFixed(2), l15: host.load15?.toFixed(2), cpus: health.value?.process.cpus }),
    });
  }
  if (host.mem_total_bytes !== undefined) {
    const used = host.mem_total_bytes - (host.mem_available_bytes ?? 0);
    facts.push({
      key: "mem",
      label: t("platform.system.host.memory"),
      value: `${formatBytesShort(used)} / ${formatBytesShort(host.mem_total_bytes)}`,
      detail: t("platform.system.host.memoryDetail", { avail: formatBytesShort(host.mem_available_bytes) }),
      tone: memoryTone(host.mem_available_bytes, host.mem_total_bytes),
    });
  }
  if (host.disk_total_bytes !== undefined) {
    facts.push({
      key: "disk",
      label: t("platform.system.host.disk"),
      value: `${formatBytesShort(host.disk_used_bytes)} / ${formatBytesShort(host.disk_total_bytes)}`,
      detail: t("platform.system.host.diskDetail", { free: formatBytesShort(host.disk_free_bytes) }),
      tone: freeSpaceTone(host.disk_free_bytes, host.disk_total_bytes),
    });
  }
  return facts;
});

const processFacts = computed<Fact[]>(() => {
  const p = health.value?.process;
  if (!p) return [];
  const facts: Fact[] = [];
  facts.push({
    key: "cpu",
    label: t("platform.system.process.cpu"),
    value: p.cpu_percent === undefined ? NO_VALUE : formatUnit("percent", p.cpu_percent),
    detail: t("platform.system.process.cpuDetail", { cpus: p.cpus }),
  });
  facts.push({
    key: "rss",
    label: t("platform.system.process.rss"),
    value: p.rss_bytes === undefined ? NO_VALUE : formatBytesShort(p.rss_bytes),
    detail: t("platform.system.process.heapDetail", { heap: formatBytesShort(p.heap_bytes), total: formatBytesShort(p.go_total_bytes) }),
  });
  facts.push({
    key: "goroutines",
    label: t("platform.system.process.goroutines"),
    value: p.goroutines.toLocaleString("en-US"),
    detail: t("platform.system.process.gcDetail", { pause: formatSeconds(p.gc_pause_max_seconds) }),
  });
  if (p.open_fds !== undefined) {
    facts.push({ key: "fds", label: t("platform.system.process.fds"), value: p.open_fds.toLocaleString("en-US") });
  }
  return facts;
});

const TONE_TEXT: Record<Tone, string> = { default: "text-foreground", warning: "text-warning-text", destructive: "text-destructive" };

/* Rows --------------------------------------------------------------- */

const files = computed(() => health.value?.files ?? []);
const pluginGroups = computed(() => groupPluginRows(health.value?.plugins ?? []));
const processes = computed(() => new Map((health.value?.plugin_processes ?? []).map((p) => [p.plugin, p])));
const search = ref("");
const httpRows = computed(() => filterRows(health.value?.http ?? [], search.value));
const storeRows = computed(() => filterRows(health.value?.store ?? [], search.value));
const healthFrom = computed(() => Math.floor(Date.parse(health.value?.from ?? "") / 1000) || 0);
const healthTo = computed(() => Math.floor(Date.parse(health.value?.to ?? "") / 1000) || 0);

const layerTabs = computed<LayerTab<SystemLayer>[]>(() => [
  { value: "plugins", label: t("platform.system.layers.plugins"), count: health.value ? pluginGroups.value.length : undefined },
  { value: "http", label: t("platform.system.layers.http"), count: health.value?.http.length },
  { value: "store", label: t("platform.system.layers.store"), count: health.value?.store.length },
]);

const tiers = computed(() => sortedTiers(store.value?.tiers ?? []));
function tierPhrase(seconds: number): string {
  const parts = spanParts(seconds);
  return t(`platform.system.span.${parts.unit}`, { n: parts.n }, parts.n);
}

const refreshing = computed(() => healthQuery.refreshing.value || seriesQuery.refreshing.value);
function refreshAll(): void {
  void healthQuery.refresh();
  void seriesQuery.refresh();
}
</script>

<template>
  <div class="space-y-5 p-4 sm:p-6">
    <PageHeader :title="$t('platform.system.title')">
      <template #description>
        <p class="text-sm text-muted-foreground">{{ $t('platform.system.description') }}</p>
        <ProofLine v-if="!blocked" v-bind="proof" :segments="proofSegments" @retry="refreshAll" />
      </template>
      <template v-if="!blocked" #actions>
        <div class="flex rounded-md border border-border p-0.5 text-xs" role="group" :aria-label="$t('platform.system.rangeLabel')">
          <button
            v-for="r in SYSTEM_RANGES"
            :key="r"
            type="button"
            :class="cn('rounded px-2.5 py-1 font-mono outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11 pointer-coarse:min-w-11', range === r ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:text-foreground')"
            :aria-pressed="range === r"
            @click="range = r"
          >
            {{ $t(`platform.system.range.${r}`) }}
          </button>
        </div>
        <Button variant="outline" size="sm" class="pointer-coarse:min-h-11" :disabled="refreshing" @click="refreshAll">
          <RefreshCw aria-hidden="true" :class="cn('size-4', refreshing && 'animate-spin')" />
          {{ $t('common.actions.refresh') }}
        </Button>
      </template>
    </PageHeader>

    <!-- An answer, not a failure: who may read this, or why there is nothing to read. -->
    <section v-if="blocked" class="rounded-lg border border-border bg-card p-5" data-testid="system-blocked">
      <h2 class="font-medium">{{ $t(`platform.system.blocked.${blocked}.title`) }}</h2>
      <p class="mt-1 max-w-prose text-sm text-muted-foreground">{{ $t(`platform.system.blocked.${blocked}.body`) }}</p>
    </section>

    <template v-else>
      <AttentionList :items="attention" />

      <DataState
        :loading="healthQuery.loading.value"
        :error="healthQuery.error.value"
        :has-data="!!health"
        :skeleton-rows="4"
        @retry="refreshAll"
      >
        <div :class="cn('space-y-5 transition-opacity', refreshing && 'opacity-80')">
          <!-- The two subjects: the machine and the process on it. -->
          <div class="grid min-w-0 grid-cols-1 gap-4 xl:grid-cols-2">
            <section class="min-w-0 rounded-lg border border-border bg-card p-4" :aria-label="$t('platform.system.host.title')" data-testid="system-host">
              <h2 class="flex items-center gap-2 text-sm font-medium">
                <HardDrive class="size-4 text-muted-foreground" aria-hidden="true" />
                {{ $t('platform.system.host.title') }}
                <span class="truncate font-mono text-xs font-normal text-muted-foreground">{{ health?.host.data_dir }}</span>
              </h2>
              <dl v-if="hostFacts.length" class="mt-3 grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-3">
                <div v-for="f in hostFacts" :key="f.key" class="min-w-0">
                  <dt class="text-xs text-muted-foreground">{{ f.label }}</dt>
                  <dd :class="cn('font-mono text-sm tabular', TONE_TEXT[f.tone ?? 'default'])">{{ f.value }}</dd>
                  <dd v-if="f.detail" class="text-xs text-pretty text-muted-foreground">{{ f.detail }}</dd>
                </div>
              </dl>
              <p v-else class="mt-3 text-sm text-muted-foreground">{{ $t('platform.system.host.unreadable') }}</p>
              <div class="mt-4">
                <HistoryChart
                  :lines="[{ series: seriesByName.get('host.mem_used'), label: $t('platform.system.host.memoryUsed') }]"
                  :from="chartFrom"
                  :to="chartTo"
                  :step="chartStep"
                  unit="bytes"
                  :ceiling="health?.host.mem_total_bytes"
                  :label="$t('platform.system.host.memoryChart')"
                />
                <HistoryChart
                  class="mt-3"
                  :lines="[{ series: seriesByName.get('host.disk_used'), label: $t('platform.system.host.diskUsed') }]"
                  :from="chartFrom"
                  :to="chartTo"
                  :step="chartStep"
                  unit="bytes"
                  :ceiling="health?.host.disk_total_bytes"
                  :height="72"
                  :label="$t('platform.system.host.diskChart')"
                />
              </div>
            </section>

            <section class="min-w-0 rounded-lg border border-border bg-card p-4" :aria-label="$t('platform.system.process.title')" data-testid="system-process">
              <h2 class="flex items-center gap-2 text-sm font-medium">
                <Server class="size-4 text-muted-foreground" aria-hidden="true" />
                {{ $t('platform.system.process.title') }}
                <span class="truncate font-mono text-xs font-normal text-muted-foreground">{{ health?.process.version }} · {{ health?.process.go_version }}</span>
              </h2>
              <dl class="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
                <div v-for="f in processFacts" :key="f.key" class="min-w-0">
                  <dt class="text-xs text-muted-foreground">{{ f.label }}</dt>
                  <dd class="font-mono text-sm tabular">{{ f.value }}</dd>
                  <dd v-if="f.detail" class="text-xs text-pretty text-muted-foreground">{{ f.detail }}</dd>
                </div>
              </dl>
              <div class="mt-4">
                <HistoryChart
                  :lines="[
                    { series: seriesByName.get('proc.rss'), label: $t('platform.system.process.rss') },
                    { series: seriesByName.get('proc.heap'), label: $t('platform.system.process.heap'), tone: 'muted' },
                  ]"
                  :from="chartFrom"
                  :to="chartTo"
                  :step="chartStep"
                  unit="bytes"
                  :label="$t('platform.system.process.memoryChart')"
                />
                <HistoryChart
                  class="mt-3"
                  :lines="[{ series: seriesByName.get('proc.cpu'), label: $t('platform.system.process.cpu') }]"
                  :from="chartFrom"
                  :to="chartTo"
                  :step="chartStep"
                  unit="percent"
                  :height="72"
                  :label="$t('platform.system.process.cpuChart')"
                />
              </div>
            </section>
          </div>
          <p v-if="stepLabel" class="-mt-2 text-xs text-muted-foreground">{{ stepLabel }}</p>

          <!-- Data files: what is growing, by how much over the range. -->
          <section class="min-w-0 rounded-lg border border-border bg-card" :aria-label="$t('platform.system.files.title')" data-testid="system-files">
            <h2 class="border-b border-border px-4 py-2.5 text-sm font-medium">{{ $t('platform.system.files.title') }}</h2>
            <ul class="divide-y divide-border">
              <li v-for="f in files" :key="f.label" class="grid min-h-10 grid-cols-[1fr_auto] items-center gap-x-4 gap-y-0.5 px-4 py-1.5 sm:grid-cols-[1fr_5rem_7rem_6rem]">
                <span class="min-w-0 truncate font-mono text-sm" :title="f.path">{{ f.label }}</span>
                <span class="text-right font-mono text-sm tabular">{{ f.size_bytes === undefined ? NO_VALUE : formatBytesShort(f.size_bytes) }}</span>
                <span class="font-mono text-xs tabular text-muted-foreground sm:text-right">
                  {{ formatByteChange(sparkChange(f.spark)) ?? $t('platform.system.files.noChange') }}
                </span>
                <RangeSparkline class="justify-self-end" :spark="f.spark" field="avg" :from="healthFrom" :to="healthTo" />
              </li>
            </ul>
          </section>

          <section class="min-w-0 space-y-3">
            <LayerTabs v-model="layer" :tabs="layerTabs" :label="$t('platform.system.layers.label')" />

            <!-- Plugins: grouped by plugin, the slowest method first. -->
            <div v-if="layer === 'plugins'" class="min-w-0" data-testid="system-plugins">
              <p v-if="pluginGroups.length === 0" class="rounded-lg border border-dashed border-border p-5 text-sm text-muted-foreground">
                {{ $t('platform.system.plugins.empty') }}
              </p>
              <div v-else class="overflow-hidden rounded-lg border border-border bg-card">
                <div class="hidden min-h-8 items-center gap-3 border-b border-border px-4 text-xs text-muted-foreground md:flex">
                  <span class="grow">{{ $t('platform.system.cols.method') }}</span>
                  <span class="w-20 text-right">{{ $t('platform.system.cols.calls') }}</span>
                  <span class="w-16 text-right">{{ $t('platform.system.cols.perMinute') }}</span>
                  <span class="w-20 text-right">p50</span>
                  <span class="w-20 text-right">p95</span>
                  <span class="w-16 text-right">{{ $t('platform.system.cols.errors') }}</span>
                  <span class="w-24">{{ $t('platform.system.cols.p95Trend') }}</span>
                </div>
                <div v-for="g in pluginGroups" :key="g.plugin" class="border-b border-border last:border-b-0">
                  <div class="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-0.5 bg-muted/30 px-4 py-1.5">
                    <Cpu class="size-3.5 text-muted-foreground" aria-hidden="true" />
                    <span class="min-w-0 truncate font-mono text-sm font-medium">{{ g.plugin }}</span>
                    <span class="text-xs text-muted-foreground tabular">{{ $t('platform.system.plugins.summary', { calls: g.calls.toLocaleString('en-US'), errors: g.errors }) }}</span>
                    <span v-if="processes.get(g.plugin)" class="text-xs text-muted-foreground tabular sm:ms-auto">
                      {{ $t('platform.system.plugins.process', {
                        cpu: formatSeconds(processes.get(g.plugin)!.cpu_seconds),
                        n: processes.get(g.plugin)!.processes,
                        rss: formatBytesShort(processes.get(g.plugin)!.peak_rss_bytes),
                      }) }}
                    </span>
                  </div>
                  <ul>
                    <SystemEventRow v-for="row in g.rows" :key="row.name" :row="row" :from="healthFrom" :to="healthTo" indent />
                  </ul>
                </div>
              </div>
            </div>

            <!-- HTTP route groups and state writes share a shape: one row each, searchable. -->
            <div v-else class="min-w-0 space-y-3" :data-testid="layer === 'http' ? 'system-http' : 'system-store'">
              <div class="relative max-w-sm">
                <Search class="pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
                <Input
                  v-model="search"
                  class="ps-8 pointer-coarse:min-h-11"
                  :placeholder="layer === 'http' ? $t('platform.system.searchRoutes') : $t('platform.system.searchCallers')"
                  :aria-label="layer === 'http' ? $t('platform.system.searchRoutes') : $t('platform.system.searchCallers')"
                />
              </div>
              <p v-if="(layer === 'http' ? httpRows : storeRows).length === 0" class="rounded-lg border border-dashed border-border p-5 text-sm text-muted-foreground">
                {{ search ? $t('platform.system.noMatches') : layer === 'http' ? $t('platform.system.http.empty') : $t('platform.system.store.empty') }}
              </p>
              <div v-else class="overflow-hidden rounded-lg border border-border bg-card">
                <div class="hidden min-h-8 items-center gap-3 border-b border-border px-4 text-xs text-muted-foreground md:flex">
                  <span class="grow">{{ layer === 'http' ? $t('platform.system.cols.route') : $t('platform.system.cols.caller') }}</span>
                  <span class="w-20 text-right">{{ $t('platform.system.cols.calls') }}</span>
                  <span class="w-16 text-right">{{ $t('platform.system.cols.perMinute') }}</span>
                  <span class="w-20 text-right">p50</span>
                  <span class="w-20 text-right">p95</span>
                  <span class="w-16 text-right">{{ $t('platform.system.cols.errors') }}</span>
                  <span class="w-24">{{ $t('platform.system.cols.p95Trend') }}</span>
                </div>
                <ul>
                  <SystemEventRow v-for="row in layer === 'http' ? httpRows : storeRows" :key="row.name" :row="row" :from="healthFrom" :to="healthTo" />
                </ul>
              </div>
            </div>
          </section>

          <!-- How long each resolution is kept: the long-term record the operator asked for. -->
          <details class="group rounded-lg border border-border bg-card" data-testid="system-retention">
            <summary class="flex min-h-10 cursor-pointer list-none items-center gap-2 px-4 text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11">
              {{ $t('platform.system.retention.title') }}
              <span class="truncate text-xs font-normal text-muted-foreground">
                {{ tiers.map((tier) => $t('platform.system.retention.short', { res: tierPhrase(tier.resolution_seconds), keep: tierPhrase(tier.retention_seconds) })).join(' · ') }}
              </span>
            </summary>
            <div class="space-y-2 border-t border-border px-4 py-3 text-sm">
              <p class="max-w-prose text-muted-foreground">
                {{ $t('platform.system.retention.body', { slots: store?.slots_per_series.toLocaleString('en-US'), max: store?.max_series.toLocaleString('en-US'), perOwner: store?.max_series_per_owner }) }}
              </p>
              <ul class="divide-y divide-border rounded-md border border-border">
                <li v-for="tier in tiers" :key="tier.name" class="flex min-h-8 flex-wrap items-center gap-x-4 px-3 py-1 font-mono text-xs tabular">
                  <span class="w-10">{{ tier.name }}</span>
                  <span class="grow text-muted-foreground">{{ $t('platform.system.retention.row', { keep: tierPhrase(tier.retention_seconds), slots: tier.slots_per_series.toLocaleString('en-US') }) }}</span>
                  <span>{{ $t('platform.system.retention.rows', { n: tier.rows.toLocaleString('en-US') }) }}</span>
                </li>
              </ul>
              <p class="font-mono text-xs text-muted-foreground">{{ store?.path }}</p>
            </div>
          </details>
        </div>
      </DataState>
    </template>
  </div>
</template>
