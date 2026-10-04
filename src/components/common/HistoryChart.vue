<script setup lang="ts">
/**
 * A metrics-store series over a range: the average as a line and, for the
 * first series, the min to max spread of every bucket as a band behind it.
 * The band is the point of keeping min and max: a month at one-hour
 * resolution still shows the two-minute spike an average would flatten.
 *
 * A bucket the control plane heard nothing in is a gap, never a value, and a
 * lone bucket between gaps is a dot. Pointer, touch and the arrow keys scrub
 * the buckets; the readout above follows and names the bucket's time, its
 * average and its spread. Inline SVG themed by CSS variables, so it is
 * CSP-safe and re-themes with the page.
 */
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";

import type { MetricsSeries, MetricsUnit } from "@/lib/api/systemTypes";
import {
  chartCeiling,
  chartGeometry,
  formatAxisTime,
  formatBucketTime,
  formatUnit,
  pointAt,
  seriesPoints,
  type ChartPoint,
} from "@/views/platform/systemModel";

/** One accent for the series the chart is about; muted ink for the one beside it. */
type Tone = "primary" | "muted";

export interface HistoryChartSeries {
  series?: MetricsSeries;
  label: string;
  tone?: Tone;
}

const props = withDefaults(
  defineProps<{
    lines: HistoryChartSeries[];
    /** Range in unix seconds, and the width of one bucket. */
    from: number;
    to: number;
    step: number;
    unit?: MetricsUnit;
    /** A known top (the host's memory, the volume's size). */
    ceiling?: number;
    /** Accessible name of the chart. */
    label: string;
    height?: number;
  }>(),
  { unit: undefined, ceiling: undefined, height: 112 },
);

const { t, locale } = useI18n();

const W = 600;
const H = 100;
const STROKE: Record<Tone, string> = {
  primary: "var(--primary)",
  muted: "var(--muted-foreground)",
};

const pointsBySeries = computed(() => props.lines.map((line) => seriesPoints(line.series)));
const dataMax = computed(() => {
  let top = 0;
  pointsBySeries.value.forEach((points, i) => {
    for (const p of points) top = Math.max(top, i === 0 ? p.max : p.avg);
  });
  return top;
});
const ceiling = computed(() => chartCeiling(props.unit, dataMax.value, props.ceiling));
const geometry = computed(() =>
  pointsBySeries.value.map((points) =>
    chartGeometry(points, { from: props.from, to: props.to, step: props.step, w: W, h: H, ceiling: ceiling.value }),
  ),
);
const hasData = computed(() => pointsBySeries.value.some((points) => points.length > 0));

/** The bucket time under the pointer or the keys, or null for "the newest". */
const focusT = ref<number | null>(null);
watch(
  () => [props.from, props.to, props.step],
  () => {
    focusT.value = null;
  },
);

const primary = computed(() => pointsBySeries.value[0] ?? []);
const focusPoint = computed<ChartPoint | undefined>(() => {
  const pts = primary.value;
  if (focusT.value === null) return pts[pts.length - 1];
  return pts.find((p) => p.t === focusT.value);
});

function readoutFor(p: ChartPoint | undefined): string {
  // An empty chart says so once, in the plot; the readout stays blank.
  if (!p) return "";
  const when = formatBucketTime(p.t, props.step, locale.value);
  const parts = props.lines.map((line, i) => {
    const point = i === 0 ? p : pointsBySeries.value[i]?.find((q) => q.t === p.t);
    if (!point) return `${line.label} ${t("platform.system.chart.notHeard")}`;
    if (i === 0 && point.max !== point.min) {
      return t("platform.system.chart.valueSpread", {
        label: line.label,
        avg: formatUnit(props.unit, point.avg),
        min: formatUnit(props.unit, point.min),
        max: formatUnit(props.unit, point.max),
      });
    }
    return `${line.label} ${formatUnit(props.unit, point.avg)}`;
  });
  return `${when} · ${parts.join(" · ")}`;
}
const readout = computed(() => readoutFor(focusPoint.value));

function scrub(event: PointerEvent): void {
  const el = event.currentTarget as HTMLElement | null;
  if (!el) return;
  const box = el.getBoundingClientRect();
  if (box.width <= 0) return;
  const fraction = Math.min(Math.max((event.clientX - box.left) / box.width, 0), 1);
  const p = pointAt(primary.value, fraction, props.from, props.to, props.step);
  if (p) focusT.value = p.t;
}

function leave(event: PointerEvent): void {
  // A finger that lifts keeps its bucket; a mouse that leaves lets go.
  if (event.pointerType === "mouse") focusT.value = null;
}

function onKey(event: KeyboardEvent): void {
  const pts = primary.value;
  if (pts.length === 0) return;
  const idx = focusPoint.value ? pts.indexOf(focusPoint.value) : pts.length - 1;
  let next = idx;
  switch (event.key) {
    case "ArrowLeft":
      next = Math.max(0, idx - 1);
      break;
    case "ArrowRight":
      next = Math.min(pts.length - 1, idx + 1);
      break;
    case "Home":
      next = 0;
      break;
    case "End":
      next = pts.length - 1;
      break;
    case "Escape":
      focusT.value = null;
      return;
    default:
      return;
  }
  event.preventDefault();
  focusT.value = pts[next]!.t;
}

const crosshairX = computed(() => {
  const p = focusT.value === null ? undefined : focusPoint.value;
  if (!p) return null;
  return ((p.t + props.step / 2 - props.from) / Math.max(props.to - props.from, 1)) * W;
});

/** The scrubbed bucket's average, marked on the line in HTML so it stays round. */
const focusMarker = computed(() => {
  const x = crosshairX.value;
  const p = focusPoint.value;
  if (x === null || !p) return null;
  const y = (1 - Math.min(Math.max(p.avg, 0), ceiling.value) / ceiling.value) * props.height;
  return { left: (x / W) * 100 + "%", top: `calc(1rem + ${y}px)` };
});

const ceilingLabel = computed(() => formatUnit(props.unit, ceiling.value));
const fromLabel = computed(() => formatAxisTime(props.from, props.to - props.from, locale.value));
const toLabel = computed(() => formatAxisTime(props.to, props.to - props.from, locale.value));
</script>

<template>
  <figure class="min-w-0 space-y-1">
    <!-- Below 640 px the readout wraps rather than truncating (a title is out of
         reach on touch), and keeps two lines' room so scrubbing never moves
         the plot. -->
    <p class="min-h-8 font-mono text-xs break-words tabular text-muted-foreground sm:min-h-4 sm:truncate" aria-live="polite" :title="readout">{{ readout }}</p>
    <div class="relative">
      <span v-if="hasData" class="pointer-events-none absolute start-0 top-0 font-mono text-[10px] text-muted-foreground tabular">{{ ceilingLabel }}</span>
      <div
        class="touch-pan-y rounded-sm pt-4 outline-none focus-visible:ring-2 focus-visible:ring-ring"
        tabindex="0"
        role="group"
        :aria-label="label"
        :aria-roledescription="$t('platform.system.chart.roledescription')"
        data-testid="history-chart"
        @pointermove="scrub"
        @pointerdown="scrub"
        @pointerleave="leave"
        @keydown="onKey"
      >
        <svg :viewBox="`0 0 ${W} ${H}`" preserveAspectRatio="none" class="block w-full" :style="{ height: height + 'px' }" aria-hidden="true">
          <line x1="0" :x2="W" :y1="H - 0.5" :y2="H - 0.5" stroke="var(--border)" stroke-width="1" vector-effect="non-scaling-stroke" />
          <line x1="0" :x2="W" y1="0.5" y2="0.5" stroke="var(--border)" stroke-width="1" stroke-dasharray="3 4" vector-effect="non-scaling-stroke" />
          <template v-for="(g, i) in geometry" :key="i">
            <path v-if="i === 0 && g.band" :d="g.band" :fill="STROKE[lines[i]?.tone ?? 'primary']" opacity="0.16" />
            <path
              v-if="g.line"
              :d="g.line"
              fill="none"
              :stroke="STROKE[lines[i]?.tone ?? 'primary']"
              stroke-width="1.5"
              stroke-linejoin="round"
              vector-effect="non-scaling-stroke"
            />
          </template>
          <line
            v-if="crosshairX !== null"
            :x1="crosshairX"
            :x2="crosshairX"
            y1="0"
            :y2="H"
            stroke="var(--foreground)"
            stroke-width="1"
            opacity="0.45"
            vector-effect="non-scaling-stroke"
          />
        </svg>
        <!-- Dots in HTML so they stay round on a stretched plot. -->
        <template v-for="(g, i) in geometry" :key="`dots-${i}`">
          <span
            v-for="(d, j) in g.dots"
            :key="j"
            class="pointer-events-none absolute size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full"
            :style="{ left: (d.x / W) * 100 + '%', top: `calc(1rem + ${(d.y / H) * height}px)`, background: STROKE[lines[i]?.tone ?? 'primary'] }"
          />
        </template>
        <span
          v-if="focusMarker"
          class="pointer-events-none absolute size-2 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-background"
          :style="{ ...focusMarker, background: STROKE[lines[0]?.tone ?? 'primary'] }"
        />
        <p v-if="!hasData" class="pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 text-center text-xs text-muted-foreground">
          {{ $t('platform.system.chart.noPoints') }}
        </p>
      </div>
    </div>
    <figcaption class="flex justify-between gap-2 font-mono text-[10px] text-muted-foreground tabular">
      <span>{{ fromLabel }}</span>
      <span v-if="lines.length > 1" class="flex flex-wrap justify-center gap-x-3">
        <span v-for="line in lines" :key="line.label" class="inline-flex items-center gap-1">
          <span class="inline-block h-0.5 w-3" :style="{ background: STROKE[line.tone ?? 'primary'] }" aria-hidden="true" />{{ line.label }}
        </span>
      </span>
      <span>{{ toLabel }}</span>
    </figcaption>
  </figure>
</template>
