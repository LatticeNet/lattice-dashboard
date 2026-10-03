<script setup lang="ts">
/**
 * One pair's series as a column per bucket (latencyModel.seriesBars).
 *
 * A measured bucket is a column of its p50 (or p95) in its latency band with
 * a tick at its p95; a bucket where every probe failed is a full red column;
 * a bucket the control plane heard nothing from is a hatched column, so a
 * gap reads as a gap and never as a fast or a dead path. Pointer and touch
 * scrub the series: the readout above follows the finger one bucket at a
 * time and stays on the last bucket touched.
 */
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import type { LatencySeries } from "@/lib/api/types";
import { formatDateTime } from "@/lib/format";

import { formatLoss, formatMs, seriesBars, type LatencyReading, type SeriesBar } from "./latencyModel";

const props = defineProps<{
  series?: LatencySeries;
  reading: LatencyReading;
}>();

const { t } = useI18n();

const chart = computed(() => seriesBars(props.series, props.reading));
const bars = computed(() => chart.value.bars);
const W = 10;
const H = 100;

/** Fill per band, as CSS variables so the column re-themes with the page. */
const BAND_VAR: Record<string, string> = {
  success: "var(--success)",
  "chart-2": "var(--chart-2)",
  warning: "var(--warning)",
  destructive: "var(--destructive)",
};

const hovered = ref<number | null>(null);
watch(
  () => props.series?.monitor_id + ":" + props.series?.window,
  () => {
    hovered.value = null;
  },
);

/** The bucket the readout speaks for: the one under the pointer, else the newest heard. */
const focusBar = computed<SeriesBar | undefined>(() => {
  if (hovered.value !== null) return bars.value[hovered.value];
  for (let i = bars.value.length - 1; i >= 0; i--) if (bars.value[i]!.kind !== "unknown") return bars.value[i];
  return bars.value[bars.value.length - 1];
});

function readout(bar: SeriesBar | undefined): string {
  if (!bar) return "";
  const when = formatDateTime(bar.at);
  if (bar.kind === "unknown") return t("fleet.monitoring.latency.chart.unknown", { when });
  if (bar.kind === "failing") return t("fleet.monitoring.latency.chart.failing", { when, heard: bar.samples }, bar.samples);
  return t("fleet.monitoring.latency.chart.measured", {
    when,
    value: formatMs(bar.valueMs),
    p95: formatMs(bar.p95Ms),
    loss: formatLoss(bar.loss),
    heard: bar.samples,
    expected: bar.expected,
  });
}

function scrub(event: PointerEvent): void {
  const el = event.currentTarget as HTMLElement | null;
  if (!el || bars.value.length === 0) return;
  const box = el.getBoundingClientRect();
  const x = Math.min(Math.max(event.clientX - box.left, 0), box.width - 1);
  hovered.value = Math.min(bars.value.length - 1, Math.floor((x / box.width) * bars.value.length));
}

const summary = computed(() => {
  const heard = bars.value.filter((b) => b.kind !== "unknown").length;
  return t("fleet.monitoring.latency.chart.summary", { heard, total: bars.value.length, ceiling: formatMs(chart.value.ceilingMs) });
});
const firstAt = computed(() => (bars.value[0] ? formatDateTime(bars.value[0].at) : ""));
const lastAt = computed(() => (bars.value.length ? formatDateTime(bars.value[bars.value.length - 1]!.at) : ""));
</script>

<template>
  <figure class="space-y-1.5">
    <p class="min-h-8 font-mono text-xs tabular text-muted-foreground" aria-live="polite" data-testid="latency-readout">{{ readout(focusBar) }}</p>
    <div class="relative">
      <span class="pointer-events-none absolute start-0 top-0 font-mono text-[10px] text-muted-foreground tabular">{{ formatMs(chart.ceilingMs) }}</span>
      <div
        class="touch-pan-y pt-4"
        data-testid="latency-chart"
        @pointermove="scrub"
        @pointerdown="scrub"
      >
        <svg
          :viewBox="`0 0 ${Math.max(bars.length, 1) * W} ${H}`"
          preserveAspectRatio="none"
          class="block h-32 w-full"
          role="img"
          :aria-label="summary"
        >
          <defs>
            <pattern id="latency-gap" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <rect width="6" height="6" fill="var(--muted)" />
              <line x1="0" y1="0" x2="0" y2="6" stroke="var(--border)" stroke-width="2.5" />
            </pattern>
          </defs>
          <line x1="0" :x2="Math.max(bars.length, 1) * W" :y1="H - 0.5" :y2="H - 0.5" stroke="var(--border)" stroke-width="1" vector-effect="non-scaling-stroke" />
          <g v-for="(bar, index) in bars" :key="bar.at">
            <rect
              v-if="bar.kind === 'unknown'"
              :x="index * W + 1"
              :y="0"
              :width="W - 2"
              :height="H"
              fill="url(#latency-gap)"
              opacity="0.55"
            />
            <rect
              v-else-if="bar.kind === 'failing'"
              :x="index * W + 1"
              :y="0"
              :width="W - 2"
              :height="H"
              fill="var(--destructive)"
              opacity="0.35"
            />
            <template v-else>
              <rect
                :x="index * W + 1"
                :y="H - bar.height * H"
                :width="W - 2"
                :height="bar.height * H"
                :fill="BAND_VAR[bar.band ?? ''] ?? 'var(--muted-foreground)'"
                :opacity="(bar.loss ?? 0) > 0 ? 0.65 : 0.9"
              />
              <line
                v-if="bar.p95 !== undefined"
                :x1="index * W + 1"
                :x2="index * W + W - 1"
                :y1="H - bar.p95 * H"
                :y2="H - bar.p95 * H"
                stroke="var(--foreground)"
                stroke-width="1.5"
                vector-effect="non-scaling-stroke"
                opacity="0.6"
              />
            </template>
            <rect
              v-if="hovered === index"
              :x="index * W"
              y="0"
              :width="W"
              :height="H"
              fill="none"
              stroke="var(--ring)"
              stroke-width="1.5"
              vector-effect="non-scaling-stroke"
            />
          </g>
        </svg>
      </div>
    </div>
    <figcaption class="flex justify-between gap-2 font-mono text-[10px] text-muted-foreground tabular">
      <span>{{ firstAt }}</span>
      <span>{{ lastAt }}</span>
    </figcaption>
  </figure>
</template>
