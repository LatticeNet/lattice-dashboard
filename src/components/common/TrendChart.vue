<script setup lang="ts">
/**
 * TrendChart — a zero-dependency inline-SVG line + area trend chart.
 *
 * A "sparkline that scales up": responsive SVG, themed entirely with Tailwind
 * token classes (text-primary, text-success, …) so it tracks light/dark mode.
 * CSP-safe — no canvas, no runtime style injection, no inline scripts.
 */
import { computed } from "vue";

type Tone = "primary" | "success" | "warning" | "info" | "destructive";

const props = withDefaults(
  defineProps<{
    /** The data series (required). */
    values: number[];
    /** Optional x-axis labels / timestamps, surfaced to assistive tech. */
    labels?: string[];
    /** Rendered pixel height of the SVG. */
    height?: number;
    /** Semantic colour token used for line, area, and the "last" label. */
    tone?: Tone;
    /** Render the soft area fill under the line. */
    area?: boolean;
    /** Unit suffix shown next to min/max/last labels (e.g. "ms"). */
    unit?: string;
    /** Value formatter for the min/max/last labels. */
    formatValue?: (n: number) => string;
  }>(),
  {
    labels: undefined,
    height: 140,
    tone: "primary",
    area: true,
    unit: "",
    formatValue: undefined,
  },
);

// Fixed internal coordinate space; the SVG scales to its container width while
// preserveAspectRatio="none" stretches the plot horizontally. Text is rendered
// in a separate, non-stretched overlay so it stays crisp.
const VIEW_W = 600;
const VIEW_H = 100;
const PAD_Y = 10; // vertical breathing room so the line never clips the edges.

// Map tone -> static classes. Full literals (not concatenation) so Tailwind's
// content scanner keeps every variant in the build.
const toneTextClass: Record<Tone, string> = {
  primary: "text-primary",
  success: "text-success",
  warning: "text-warning",
  info: "text-info",
  destructive: "text-destructive",
};

const lineClass = computed(() => toneTextClass[props.tone]);

const fmt = (n: number): string => (props.formatValue ? props.formatValue(n) : String(n));

const cleanValues = computed(() =>
  (props.values ?? []).filter((v): v is number => typeof v === "number" && Number.isFinite(v)),
);

const count = computed(() => cleanValues.value.length);
const hasData = computed(() => count.value > 0);

const stats = computed(() => {
  const vs = cleanValues.value;
  if (vs.length === 0) return { min: 0, max: 0, last: 0, first: 0 };
  let min = vs[0]!;
  let max = vs[0]!;
  for (const v of vs) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { min, max, last: vs[vs.length - 1]!, first: vs[0]! };
});

/** Project a value into the [PAD_Y, VIEW_H - PAD_Y] band (inverted Y axis). */
function projectY(value: number): number {
  const { min, max } = stats.value;
  const span = max - min;
  const usable = VIEW_H - PAD_Y * 2;
  if (span <= 0) return VIEW_H / 2; // flat series → centre line.
  return PAD_Y + (1 - (value - min) / span) * usable;
}

/** X position for index i across the fixed coordinate width. */
function projectX(index: number): number {
  const n = count.value;
  if (n <= 1) return VIEW_W / 2;
  return (index / (n - 1)) * VIEW_W;
}

const points = computed(() =>
  cleanValues.value.map((v, i) => ({ x: projectX(i), y: projectY(v) })),
);

/** Polyline points for the line stroke. Single point → a short flat segment. */
const linePoints = computed(() => {
  if (count.value === 0) return "";
  if (count.value === 1) {
    const y = projectY(cleanValues.value[0]!);
    return `0,${y.toFixed(2)} ${VIEW_W},${y.toFixed(2)}`;
  }
  return points.value.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" ");
});

/** Closed polygon points for the area fill (line + down to the baseline). */
const areaPoints = computed(() => {
  if (!props.area || count.value === 0) return "";
  const base = VIEW_H;
  if (count.value === 1) {
    const y = projectY(cleanValues.value[0]!);
    return `0,${base} 0,${y.toFixed(2)} ${VIEW_W},${y.toFixed(2)} ${VIEW_W},${base}`;
  }
  const top = points.value.map((p) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join(" ");
  return `0,${base} ${top} ${VIEW_W},${base}`;
});

// Guide lines for the min and max levels (and the latest value).
const maxLineY = computed(() => projectY(stats.value.max));
const minLineY = computed(() => projectY(stats.value.min));

const minLabel = computed(() => `${fmt(stats.value.min)}${props.unit}`);
const maxLabel = computed(() => `${fmt(stats.value.max)}${props.unit}`);
const lastLabel = computed(() => `${fmt(stats.value.last)}${props.unit}`);

const ariaLabel = computed(() => {
  if (!hasData.value) return "Trend chart, no data";
  if (count.value === 1) return `Trend, 1 point, value ${lastLabel.value}`;
  return `Trend, ${count.value} points, min ${minLabel.value}, max ${maxLabel.value}, last ${lastLabel.value}`;
});
</script>

<template>
  <figure class="w-full" :aria-label="ariaLabel">
    <!-- Empty state -->
    <div
      v-if="!hasData"
      class="flex items-center justify-center rounded-md border border-dashed border-border text-xs text-muted-foreground"
      :style="{ height: height + 'px' }"
      role="img"
      aria-label="No data"
    >
      No data
    </div>

    <template v-else>
      <!-- Plot area: horizontally stretched, line uses non-scaling stroke so it
           stays a clean 2px regardless of container width. -->
      <svg
        :viewBox="`0 0 ${VIEW_W} ${VIEW_H}`"
        :style="{ height: height + 'px' }"
        class="block w-full"
        preserveAspectRatio="none"
        role="img"
        :aria-label="ariaLabel"
      >
        <!-- max / min guide lines -->
        <line
          :x1="0"
          :x2="VIEW_W"
          :y1="maxLineY"
          :y2="maxLineY"
          class="stroke-current text-border"
          stroke-width="1"
          stroke-dasharray="4 4"
          vector-effect="non-scaling-stroke"
        />
        <line
          :x1="0"
          :x2="VIEW_W"
          :y1="minLineY"
          :y2="minLineY"
          class="stroke-current text-border"
          stroke-width="1"
          stroke-dasharray="4 4"
          vector-effect="non-scaling-stroke"
        />

        <!-- area fill -->
        <polygon
          v-if="area && areaPoints"
          :points="areaPoints"
          :class="['fill-current opacity-10', lineClass]"
          stroke="none"
        />

        <!-- line -->
        <polyline
          :points="linePoints"
          fill="none"
          :class="['stroke-current', lineClass]"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          vector-effect="non-scaling-stroke"
        />
      </svg>

      <!-- Crisp, non-stretched labels overlaid as normal HTML text. -->
      <figcaption class="mt-2 flex items-center justify-between gap-2 text-xs">
        <span class="text-muted-foreground">
          min <span class="font-mono tabular">{{ minLabel }}</span>
        </span>
        <span class="text-muted-foreground">
          max <span class="font-mono tabular">{{ maxLabel }}</span>
        </span>
        <span :class="['font-medium', lineClass]">
          last <span class="font-mono tabular">{{ lastLabel }}</span>
        </span>
      </figcaption>
    </template>
  </figure>
</template>
