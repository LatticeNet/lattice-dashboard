<script setup lang="ts">
/**
 * A node's long-term history on its page: what its beats carried (CPU,
 * memory, disk, load, network) and the gap between beats as the control
 * plane heard them, from the metrics store. The live bars above show now;
 * this shows whether now is normal.
 *
 * Reads only while the page is open, once a minute (the store's own
 * cadence). A server that keeps no history says so in one line instead of
 * an empty card.
 */
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { History } from "lucide-vue-next";

import { api, ApiError, type MetricsQuery, type MetricsRange } from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { cn } from "@/lib/utils";

import DataState from "@/components/common/DataState.vue";
import HistoryChart, { type HistoryChartSeries } from "@/components/common/HistoryChart.vue";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

import { DEFAULT_SYSTEM_RANGE, SYSTEM_RANGES, spanParts } from "@/views/platform/systemModel";

const props = defineProps<{ nodeId: string }>();

const { t } = useI18n();
const range = ref<MetricsRange>(DEFAULT_SYSTEM_RANGE);

const query = useAsyncData<MetricsQuery>((signal) => api.nodes.history(props.nodeId, range.value, { signal }), { pollInterval: 60_000 });
watch([range, () => props.nodeId], () => void query.refresh());

const disabled = computed(() => query.error.value instanceof ApiError && query.error.value.status === 503);
const forbidden = computed(() => query.error.value instanceof ApiError && query.error.value.isForbidden);
const data = computed(() => query.data.value);
const byName = computed(() => new Map((data.value?.series ?? []).map((s) => [s.name, s])));
const from = computed(() => Math.floor(Date.parse(data.value?.from ?? "") / 1000) || 0);
const to = computed(() => Math.floor(Date.parse(data.value?.to ?? "") / 1000) || 0);
const step = computed(() => data.value?.step_seconds ?? 60);
const isEmpty = computed(() => !!data.value && data.value.series.every((s) => s.t.length === 0));

interface Panel {
  key: string;
  title: string;
  unit: "percent" | "load" | "bytes_per_second" | "seconds";
  lines: HistoryChartSeries[];
  hint?: string;
}

const panels = computed<Panel[]>(() => [
  { key: "cpu", title: t("platform.system.nodeHistory.cpu"), unit: "percent", lines: [{ series: byName.value.get("cpu"), label: t("platform.system.nodeHistory.cpu") }] },
  { key: "mem", title: t("platform.system.nodeHistory.mem"), unit: "percent", lines: [{ series: byName.value.get("mem"), label: t("platform.system.nodeHistory.mem") }] },
  { key: "disk", title: t("platform.system.nodeHistory.disk"), unit: "percent", lines: [{ series: byName.value.get("disk"), label: t("platform.system.nodeHistory.disk") }] },
  { key: "load", title: t("platform.system.nodeHistory.load"), unit: "load", lines: [{ series: byName.value.get("load1"), label: t("platform.system.nodeHistory.load") }] },
  {
    key: "net",
    title: t("platform.system.nodeHistory.network"),
    unit: "bytes_per_second",
    lines: [
      { series: byName.value.get("net_rx"), label: t("platform.system.nodeHistory.rx") },
      { series: byName.value.get("net_tx"), label: t("platform.system.nodeHistory.tx"), tone: "muted" },
    ],
  },
  {
    key: "gap",
    title: t("platform.system.nodeHistory.beatGap"),
    unit: "seconds",
    lines: [{ series: byName.value.get("beat_gap"), label: t("platform.system.nodeHistory.beatGap") }],
    hint: t("platform.system.nodeHistory.beatGapHint"),
  },
]);

const stepLabel = computed(() => {
  if (!data.value) return "";
  const parts = spanParts(data.value.step_seconds);
  return t("platform.system.stepEvery", { span: t(`platform.system.span.${parts.unit}`, { n: parts.n }, parts.n) });
});
</script>

<template>
  <Card v-if="!forbidden" data-testid="node-history">
    <CardHeader>
      <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
        <CardTitle class="flex grow items-center gap-2">
          <History class="size-4 text-muted-foreground" aria-hidden="true" />
          {{ $t('platform.system.nodeHistory.title') }}
        </CardTitle>
        <div v-if="!disabled" class="flex rounded-md border border-border p-0.5 text-xs" role="group" :aria-label="$t('platform.system.rangeLabel')">
          <button
            v-for="r in SYSTEM_RANGES"
            :key="r"
            type="button"
            :class="cn('rounded px-2 py-1 font-mono outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11 pointer-coarse:min-w-11', range === r ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:text-foreground')"
            :aria-pressed="range === r"
            @click="range = r"
          >
            {{ $t(`platform.system.range.${r}`) }}
          </button>
        </div>
      </div>
      <CardDescription>{{ $t('platform.system.nodeHistory.description') }}</CardDescription>
    </CardHeader>
    <CardContent>
      <p v-if="disabled" class="text-sm text-muted-foreground">{{ $t('platform.system.nodeHistory.disabled') }}</p>
      <DataState
        v-else
        :loading="query.loading.value"
        :error="query.error.value"
        :has-data="!!data"
        :is-empty="isEmpty"
        :empty-title="$t('platform.system.nodeHistory.title')"
        :empty-description="$t('platform.system.nodeHistory.empty')"
        :skeleton-rows="3"
        @retry="query.refresh"
      >
        <div :class="cn('grid min-w-0 grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2 transition-opacity', query.refreshing.value && 'opacity-80')">
          <section v-for="panel in panels" :key="panel.key" class="min-w-0" :aria-label="panel.title">
            <h3 class="text-xs font-medium text-muted-foreground" :title="panel.hint">{{ panel.title }}</h3>
            <HistoryChart
              :lines="panel.lines"
              :from="from"
              :to="to"
              :step="step"
              :unit="panel.unit"
              :height="64"
              :label="$t('platform.system.nodeHistory.chartLabel', { metric: panel.title })"
            />
          </section>
        </div>
        <p class="mt-3 text-xs text-muted-foreground">{{ stepLabel }}</p>
      </DataState>
    </CardContent>
  </Card>
</template>
