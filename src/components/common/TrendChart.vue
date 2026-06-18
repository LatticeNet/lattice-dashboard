<script setup lang="ts">
/**
 * TrendChart — a zero-dependency inline-SVG line + area trend chart.
 *
 * A "sparkline that scales up": responsive SVG, themed entirely with Tailwind
 * token classes (text-primary, text-success, …) so it tracks light/dark mode.
 * CSP-safe — no canvas, no runtime style injection, no inline scripts.
 */
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";

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
    /**
     * Enable the optional hover layer (crosshair + focus dot + value tooltip).
     * When false, the chart renders exactly as the static default. Pure SVG +
     * Vue-bound DOM, so it stays CSP-safe (no inline scripts, no v-html).
     */
    interactive?: boolean;
    /**
     * Plain-English fallback prefix for the tooltip's value line. Callers can
     * pass a translated string; defaults keep static usage self-contained.
     */
    tooltipValueLabel?: string;
  }>(),
  {
    labels: undefined,
    height: 140,
    tone: "primary",
    area: true,
    unit: "",
    formatValue: undefined,
    interactive: true,
    tooltipValueLabel: "value",
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
const { t } = useI18n();

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
  if (!hasData.value) return t("common.chart.trendNoData");
  if (count.value === 1) return t("common.chart.trendOnePoint", { value: lastLabel.value });
  return t("common.chart.trendSummary", {
    count: count.value,
    min: minLabel.value,
    max: maxLabel.value,
    last: lastLabel.value,
  });
});

// ---------------------------------------------------------------------------
// Optional hover layer (gated behind `interactive`). All geometry derives from
// the live SVG bounding box at event time — no scroll/resize listeners, no
// stale reactive trackers, no inline scripts. The tooltip is a plain Vue-bound
// <div> (never a title= attribute, never v-html), so it stays CSP-safe.
// ---------------------------------------------------------------------------

/** Root <figure> ref so we can position the absolute tooltip against it. */
const rootEl = ref<HTMLElement | null>(null);
/** Plot <svg> ref so we can map client pixels back into the data domain. */
const svgEl = ref<SVGSVGElement | null>(null);

/** Index of the currently focused data point, or null when not hovering. */
const focusIndex = ref<number | null>(null);
/** Pointer X relative to the plot, in CSS pixels (for tooltip placement). */
const focusClientX = ref(0);

/** Whether the interactive layer should render at all. */
const showInteractive = computed(() => props.interactive && hasData.value);

/**
 * Map a value-domain index to the visible CSS-pixel X within the plot. The SVG
 * stretches horizontally (preserveAspectRatio="none"), so X scales linearly
 * with the rendered width while Y keeps the fixed VIEW_H coordinate space.
 */
function indexToClientX(index: number, width: number): number {
  if (count.value <= 1) return width / 2;
  return (index / (count.value - 1)) * width;
}

/**
 * Nearest-index hit test via binary search over the evenly-spaced X domain.
 * Points are uniformly distributed, so we can compute the fractional index
 * directly and then snap to the closer neighbour — O(1), but kept as an
 * explicit two-neighbour comparison to stay correct for any spacing.
 */
function nearestIndex(fraction: number): number {
  const n = count.value;
  if (n <= 1) return 0;
  const target = fraction * (n - 1);
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (mid < target) lo = mid + 1;
    else hi = mid;
  }
  // `lo` is the first index >= target; compare it with its left neighbour.
  if (lo > 0 && target - (lo - 1) <= lo - target) lo -= 1;
  return lo;
}

function handlePointerMove(event: MouseEvent): void {
  if (!showInteractive.value) return;
  const svg = svgEl.value;
  if (!svg) return;
  const rect = svg.getBoundingClientRect();
  if (rect.width <= 0) return;
  const localX = event.clientX - rect.left;
  const fraction = Math.min(1, Math.max(0, localX / rect.width));
  const idx = nearestIndex(fraction);
  focusIndex.value = idx;
  // Anchor the tooltip on the snapped point, not the raw pointer, so it tracks
  // the focus dot exactly.
  focusClientX.value = indexToClientX(idx, rect.width);
}

function handlePointerLeave(): void {
  focusIndex.value = null;
}

/** The focused point's coordinates in the fixed SVG view space. */
const focusPoint = computed(() => {
  const idx = focusIndex.value;
  if (idx == null) return null;
  const v = cleanValues.value[idx];
  if (typeof v !== "number") return null;
  return { x: projectX(idx), y: projectY(v), value: v };
});

/** Tooltip content — timestamp (from labels) + formatted value. */
const tooltip = computed(() => {
  const idx = focusIndex.value;
  if (idx == null) return null;
  const v = cleanValues.value[idx];
  if (typeof v !== "number") return null;
  const time = props.labels?.[idx] ?? "";
  return { time, value: `${fmt(v)}${props.unit}` };
});
</script>

<template>
  <figure ref="rootEl" class="w-full" :aria-label="ariaLabel">
    <!-- Empty state -->
    <div
      v-if="!hasData"
      class="flex items-center justify-center rounded-md border border-dashed border-border text-xs text-muted-foreground"
      :style="{ height: height + 'px' }"
      role="img"
      :aria-label="$t('common.state.noData')"
    >
      {{ $t('common.state.noData') }}
    </div>

    <template v-else>
      <!-- Plot area: horizontally stretched, line uses non-scaling stroke so it
           stays a clean 2px regardless of container width. The relative wrapper
           anchors the optional HTML tooltip overlay. -->
      <div class="relative w-full">
      <svg
        ref="svgEl"
        :viewBox="`0 0 ${VIEW_W} ${VIEW_H}`"
        :style="{ height: height + 'px' }"
        class="block w-full"
        preserveAspectRatio="none"
        role="img"
        :aria-label="ariaLabel"
        @mousemove="handlePointerMove"
        @mouseleave="handlePointerLeave"
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

        <!-- Optional hover crosshair + focus dot (pure SVG). -->
        <template v-if="showInteractive && focusPoint">
          <line
            :x1="focusPoint.x"
            :x2="focusPoint.x"
            :y1="0"
            :y2="VIEW_H"
            class="stroke-current text-muted-foreground"
            stroke-width="1"
            vector-effect="non-scaling-stroke"
          />
          <circle
            :cx="focusPoint.x"
            :cy="focusPoint.y"
            r="3.5"
            :class="['fill-current', lineClass]"
            vector-effect="non-scaling-stroke"
          />
        </template>
      </svg>

      <!-- Optional value tooltip: positioned HTML div (not title=, not v-html).
           pointer-events-none keeps it from stealing the SVG's mouse events. -->
      <div
        v-if="showInteractive && tooltip"
        class="pointer-events-none absolute top-0 z-10 -translate-x-1/2 -translate-y-full rounded-md border border-border bg-popover px-2 py-1 text-xs whitespace-nowrap text-popover-foreground shadow-md"
        :style="{ left: focusClientX + 'px' }"
        role="status"
        aria-live="off"
      >
        <span v-if="tooltip.time" class="block text-muted-foreground">{{ tooltip.time }}</span>
        <span class="block font-medium">
          {{ tooltipValueLabel }}
          <span class="font-mono tabular">{{ tooltip.value }}</span>
        </span>
      </div>
      </div>

      <!-- Crisp, non-stretched labels overlaid as normal HTML text. -->
      <figcaption class="mt-2 flex items-center justify-between gap-2 text-xs">
        <span class="text-muted-foreground">
          {{ $t('common.chart.min') }} <span class="font-mono tabular">{{ minLabel }}</span>
        </span>
        <span class="text-muted-foreground">
          {{ $t('common.chart.max') }} <span class="font-mono tabular">{{ maxLabel }}</span>
        </span>
        <span :class="['font-medium', lineClass]">
          {{ $t('common.chart.last') }} <span class="font-mono tabular">{{ lastLabel }}</span>
        </span>
      </figcaption>
    </template>
  </figure>
</template>
