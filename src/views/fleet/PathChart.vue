<script setup lang="ts">
/**
 * The path chart (design 29 D8): one time axis, two lanes on one canvas.
 *
 * The upper lane is latency: the band from min to p95 (p50 when the server
 * keeps no min) as a light fill in the path's state tone, and the p50 as a
 * 2 px line in the foreground ink so it reads in every state. The lower, short
 * lane is loss per bucket as bars; zero draws nothing. A bucket where runs
 * were expected and none was heard is hatched across both lanes and marked
 * "no data"; it is null in every column, so nothing interpolates across it.
 * A method change is a vertical rule with the new method's name.
 *
 * The crosshair snaps to buckets and carries the exact values. It follows the
 * pointer and the keyboard (Left and Right step a bucket, Home and End jump);
 * a drag selects a range and zooms into it; a double-click or Escape resets.
 * Beside the collection the values float by the cursor; on a phone (compact)
 * they sit in a fixed row above the chart, where a finger does not cover them.
 *
 * Built on uPlot (canvas). Colours are the console's tokens, read when the
 * chart mounts and again whenever the theme or palette changes. pathSeriesModel
 * holds every rule about the data; this file only draws it.
 */
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { useI18n } from "vue-i18n";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";

import { resolveColor, resolveFontFamily, rgba, watchTheme, type Rgba } from "@/lib/cssColor";
import { formatLoss, formatMs } from "./latencyModel";
import {
  bucketIndexAt,
  chartColumns,
  gapRuns,
  laneLayout,
  methodAt,
  methodMarkers,
  seriesCeilingMs,
  stepIndex,
  visibleRange,
  LATENCY_LANE_START,
  LOSS_LANE,
  type PathSeries,
  type SeriesPoint,
} from "./pathSeriesModel";

const props = withDefaults(
  defineProps<{
    series: PathSeries;
    /** The path's state tone for the band. */
    tone: "success" | "destructive" | "muted";
    /** The path's current method, for buckets that do not name theirs. */
    method: string;
    /** Phone layout: the readout is a fixed row above the chart. */
    compact?: boolean;
    height?: number;
    /** Accessible name, such as "cd-hs-sh to xuezhang-jp-nat, last 7 days". */
    label: string;
    /** Set when the path reads unknown with a reason: what the readout says of a bucket with no answer, which is then not drawn as an outage. */
    unmeasuredNote?: string;
  }>(),
  { compact: false, height: 240 },
);

const emit = defineEmits<{ zoom: [range: { from: number; to: number } | null] }>();

const { t, locale } = useI18n();

const wrapper = ref<HTMLDivElement | null>(null);
const host = ref<HTMLDivElement | null>(null);
const plot = shallowRef<uPlot | null>(null);
const activeIdx = ref(-1);
const cursorLeft = ref(0);
const zoomed = ref(false);
const announce = ref("");
const helpId = `path-chart-help-${Math.random().toString(36).slice(2, 8)}`;

/* ---- Colours ---- */

interface Palette {
  ink: Rgba;
  muted: Rgba;
  border: Rgba;
  card: Rgba;
  tone: Rgba;
  loss: Rgba;
  dark: boolean;
  /** Canvas fonts cannot read var(); the families are resolved with the colours. */
  mono: string;
  sans: string;
}
let palette: Palette | null = null;

function readPalette(): Palette {
  const toneToken = props.tone === "success" ? "--success" : props.tone === "destructive" ? "--destructive" : "--muted-foreground";
  return {
    ink: resolveColor("--foreground"),
    muted: resolveColor("--muted-foreground"),
    border: resolveColor("--border"),
    card: resolveColor("--card"),
    tone: resolveColor(toneToken),
    loss: resolveColor(props.unmeasuredNote ? "--muted-foreground" : "--destructive"),
    dark: document.documentElement.classList.contains("dark"),
    mono: resolveFontFamily("--font-mono"),
    sans: getComputedStyle(document.body).fontFamily || "system-ui, sans-serif",
  };
}

const colors = () => (palette ??= readPalette());

/* ---- Data ---- */

const step = computed(() => props.series.stepSec || 60);
const points = computed<SeriesPoint[]>(() => props.series.points);
const gaps = computed(() => gapRuns(props.series));
const markers = computed(() => methodMarkers(props.series));
const fullRange = computed<[number, number]>(() => {
  const first = points.value[0];
  const last = points.value[points.value.length - 1];
  if (!first || !last) return [props.series.from, props.series.to || props.series.from + 3600];
  return [first.t, last.t + step.value];
});
const lanes = computed(() => laneLayout(seriesCeilingMs(points.value)));

/** Buckets plot at their middle, so bars, gaps and the crosshair line up with the bucket they read. */
function columns(): uPlot.AlignedData {
  const [xs, floor, p50, p95, loss] = chartColumns(points.value);
  const half = step.value / 2;
  return [xs.map((x) => x + half), floor, p50, p95, loss] as unknown as uPlot.AlignedData;
}

/** The x values uPlot autoscales to: the first and last bucket middles. */
function dataExtent(): [number, number] | undefined {
  const first = points.value[0];
  const last = points.value[points.value.length - 1];
  if (!first || !last) return undefined;
  return [first.t + step.value / 2, last.t + step.value / 2];
}

/* ---- Formatting ---- */

const dateTime = computed(() => new Intl.DateTimeFormat(locale.value, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }));
const timeOnly = computed(() => new Intl.DateTimeFormat(locale.value, { hour: "2-digit", minute: "2-digit", hour12: false }));
const dayOnly = computed(() => new Intl.DateTimeFormat(locale.value, { month: "short", day: "numeric" }));

function axisTime(splits: number[], incr: number): string[] {
  return splits.map((s) => {
    const d = new Date(s * 1000);
    if (incr >= 86400) return dayOnly.value.format(d);
    // A tick on midnight names the day, so a multi-day hour axis stays readable.
    if (d.getHours() === 0 && d.getMinutes() === 0) return dayOnly.value.format(d);
    return timeOnly.value.format(d);
  });
}

function msTick(value: number): string {
  if (value === 0) return "0";
  return formatMs(value).replace(" ", " ");
}

/* ---- Drawing ---- */

let hatch: CanvasPattern | null = null;
function hatchPattern(ctx: CanvasRenderingContext2D, pxRatio: number): CanvasPattern | null {
  if (hatch) return hatch;
  const size = Math.round(7 * pxRatio);
  const tile = document.createElement("canvas");
  tile.width = size;
  tile.height = size;
  const g = tile.getContext("2d");
  if (!g) return null;
  g.strokeStyle = rgba(colors().muted, colors().dark ? 0.45 : 0.4);
  g.lineWidth = Math.max(1, pxRatio);
  // 135 degrees: down to the right, the console's unknown hatch.
  g.beginPath();
  g.moveTo(0, 0);
  g.lineTo(size, size);
  g.moveTo(-size, 0);
  g.lineTo(0, size);
  g.moveTo(size, 0);
  g.lineTo(2 * size, size);
  g.stroke();
  hatch = ctx.createPattern(tile, "repeat");
  return hatch;
}

function drawGaps(u: uPlot): void {
  const ctx = u.ctx;
  const { left, top, width, height } = u.bbox;
  const pattern = hatchPattern(ctx, uPlot.pxRatio);
  ctx.save();
  ctx.beginPath();
  ctx.rect(left, top, width, height);
  ctx.clip();
  for (const run of gaps.value) {
    const x0 = u.valToPos(run.from, "x", true);
    const x1 = u.valToPos(run.to, "x", true);
    if (x1 < left || x0 > left + width) continue;
    if (pattern) {
      ctx.fillStyle = pattern;
      ctx.fillRect(x0, top, Math.max(1, x1 - x0), height);
    }
    const w = x1 - x0;
    if (w >= 56 * uPlot.pxRatio) {
      ctx.fillStyle = rgba(colors().card, 0.92);
      const label = t("fleet.monitoring.chart.noData");
      ctx.font = `${11 * uPlot.pxRatio}px ${colors().sans}`;
      const tw = ctx.measureText(label).width;
      const cx = x0 + w / 2;
      const cy = top + height * (1 - (1 + LATENCY_LANE_START) / 2);
      ctx.fillRect(cx - tw / 2 - 4 * uPlot.pxRatio, cy - 8 * uPlot.pxRatio, tw + 8 * uPlot.pxRatio, 16 * uPlot.pxRatio);
      ctx.fillStyle = rgba(colors().muted);
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label, cx, cy);
    }
  }
  ctx.restore();
}

function drawOverlay(u: uPlot): void {
  const ctx = u.ctx;
  const { left, top, width, height } = u.bbox;
  const px = uPlot.pxRatio;
  ctx.save();
  ctx.beginPath();
  ctx.rect(left, top, width, height);
  ctx.clip();
  // The hairline between the lanes.
  const divider = u.valToPos(lanes.value.divider, "ms", true);
  ctx.strokeStyle = rgba(colors().border);
  ctx.lineWidth = px;
  ctx.beginPath();
  ctx.moveTo(left, Math.round(divider) + 0.5);
  ctx.lineTo(left + width, Math.round(divider) + 0.5);
  ctx.stroke();
  // Lane captions, quiet, at the lane's top left.
  ctx.fillStyle = rgba(colors().muted);
  ctx.font = `${10 * px}px ${colors().mono}`;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText(t("fleet.monitoring.chart.lossLane"), left + 4 * px, top + height * (1 - LOSS_LANE) + 3 * px);
  // Min and max ticks once a bucket is wide enough to hold them (raw and 5-minute buckets).
  const bucketPx = u.valToPos(fullRange.value[0] + step.value, "x", true) - u.valToPos(fullRange.value[0], "x", true);
  // Only once buckets are far enough apart that the ticks read as marks, not as a dashed line.
  if (step.value <= 300 && bucketPx >= 16 * px) {
    ctx.strokeStyle = rgba(colors().ink, 0.35);
    ctx.lineWidth = px;
    const half = step.value / 2;
    const tick = Math.min(bucketPx * 0.2, 4 * px);
    ctx.beginPath();
    for (const p of points.value) {
      const x = u.valToPos(p.t + half, "x", true);
      if (x < left || x > left + width) continue;
      for (const v of [p.minMs, p.maxMs]) {
        if (v === undefined) continue;
        const y = Math.round(u.valToPos(v, "ms", true)) + 0.5;
        ctx.moveTo(x - tick, y);
        ctx.lineTo(x + tick, y);
      }
    }
    ctx.stroke();
  }
  // Method changes: a rule labelled with the switch it marks ("TCP → ICMP") on a card-coloured pad.
  ctx.font = `${10 * px}px ${colors().mono}`;
  ctx.textBaseline = "top";
  markers.value.forEach((m) => {
    const x = Math.round(u.valToPos(m.t, "x", true)) + 0.5;
    if (x < left || x > left + width) return;
    ctx.strokeStyle = rgba(colors().ink, 0.55);
    ctx.setLineDash([3 * px, 3 * px]);
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x, top + height);
    ctx.stroke();
    ctx.setLineDash([]);
    const label = `${m.from.toUpperCase()} \u2192 ${m.to.toUpperCase()}`;
    const w = ctx.measureText(label).width + 8 * px;
    // Right of the rule, or left of it when the rule sits near the end.
    const lx = x + w + 4 * px > left + width ? x - w - 4 * px : x + 4 * px;
    ctx.fillStyle = rgba(colors().card, 0.92);
    ctx.fillRect(lx, top + 2 * px, w, 14 * px);
    ctx.fillStyle = rgba(colors().ink);
    ctx.textAlign = "left";
    ctx.fillText(label, lx + 4 * px, top + 4 * px);
  });
  ctx.restore();
}

/* ---- The plot ---- */

function options(width: number): uPlot.Options {
  const font = `11px ${colors().mono}`;
  return {
    width,
    height: props.height,
    legend: { show: false },
    // Room on the right for the last time tick's label, which centres on its tick.
    padding: [8, 22, 0, 0],
    cursor: {
      x: true,
      y: false,
      drag: { x: true, y: false, setScale: true },
      points: {
        size: (_u, seriesIdx) => (seriesIdx === 2 ? 8 : 0),
        width: 2,
        fill: () => rgba(colors().ink),
        stroke: () => rgba(colors().card),
      },
      // The line snaps to the bucket the pointer is over.
      move: (u, left, top) => {
        const xs = u.data[0];
        if (!xs.length || left < 0) return [left, top];
        const t = u.posToVal(left, "x") - step.value / 2;
        const idx = bucketIndexAt(points.value, t, step.value);
        return idx < 0 ? [left, top] : [u.valToPos(xs[idx]!, "x"), top];
      },
    },
    select: { show: true, left: 0, top: 0, width: 0, height: 0 },
    scales: {
      // A range uPlot derives from the data (first and last bucket middles) is
      // the full window; anything else is a zoom and is kept as asked.
      x: {
        time: true,
        range: (_u, min, max) => {
          const [a, b] = fullRange.value;
          const xs = dataExtent();
          if (min == null || max == null || !Number.isFinite(min) || !Number.isFinite(max)) return [a, b];
          if (xs && Math.abs(min - xs[0]) < 1e-6 && Math.abs(max - xs[1]) < 1e-6) return [a, b];
          return [min, max];
        },
      },
      ms: { range: () => [lanes.value.msMin, lanes.value.msMax] },
      loss: { range: () => [0, lanes.value.lossMax] },
    },
    axes: [
      {
        stroke: () => rgba(colors().muted),
        grid: { stroke: () => rgba(colors().border), width: 1 },
        ticks: { show: false },
        font,
        size: 28,
        space: props.compact ? 72 : 88,
        values: (_u, splits, _axisIdx, _space, incr) => axisTime(splits, incr),
      },
      {
        scale: "ms",
        side: 3,
        size: 58,
        stroke: () => rgba(colors().muted),
        grid: { stroke: () => rgba(colors().border), width: 1 },
        ticks: { show: false },
        font,
        splits: () => [lanes.value.lossTicks[0]!.ms, lanes.value.lossTicks[1]!.ms, ...lanes.value.msTicks],
        // The loss lane's top reads 100%; the latency lane's 0 sits a hair above it and is left
        // unlabelled (its gridline stays), so the two labels never print over each other.
        values: (_u, splits) =>
          splits.map((v, i) => {
            if (i === 0) return "";
            if (i === 1) return "100%";
            return v === 0 ? "" : msTick(v);
          }),
      },
    ],
    series: [
      {},
      { scale: "ms", stroke: "transparent", width: 0, points: { show: false }, spanGaps: false },
      { scale: "ms", stroke: () => rgba(colors().ink), width: 2, points: { show: false }, spanGaps: false },
      { scale: "ms", stroke: "transparent", width: 0, points: { show: false }, spanGaps: false },
      {
        scale: "loss",
        stroke: "transparent",
        width: 0,
        fill: () => rgba(colors().loss, colors().dark ? 0.6 : 0.5),
        points: { show: false },
        paths: uPlot.paths.bars!({ size: [0.7, 24, 1], gap: 2, radius: 0.2 }),
      },
    ],
    bands: [{ series: [3, 1], fill: () => rgba(colors().tone, colors().dark ? 0.22 : 0.16) }],
    hooks: {
      drawClear: [(u) => drawGaps(u)],
      draw: [(u) => drawOverlay(u)],
      setCursor: [
        (u) => {
          const idx = u.cursor.idx;
          activeIdx.value = idx === null || idx === undefined || (u.cursor.left ?? -1) < 0 ? -1 : idx;
          cursorLeft.value = u.cursor.left ?? 0;
        },
      ],
      setScale: [
        (u, key) => {
          if (key !== "x") return;
          const min = u.scales.x?.min ?? fullRange.value[0];
          const max = u.scales.x?.max ?? fullRange.value[1];
          const isZoomed = min > fullRange.value[0] + 1 || max < fullRange.value[1] - 1;
          zoomed.value = isZoomed;
          emit("zoom", isZoomed ? { from: min, to: max } : null);
        },
      ],
    },
  };
}

function build(): void {
  const el = host.value;
  if (!el) return;
  plot.value?.destroy();
  palette = readPalette();
  hatch = null;
  const width = Math.max(240, wrapper.value?.clientWidth ?? 480);
  plot.value = new uPlot(options(width), columns(), el);
}

function resetZoom(): void {
  const u = plot.value;
  if (!u) return;
  u.setScale("x", { min: fullRange.value[0], max: fullRange.value[1] });
}

watch(
  () => props.series,
  () => {
    const u = plot.value;
    if (!u) return;
    activeIdx.value = -1;
    // A poll brings the same window a minute later: a zoom that still fits stays where the
    // operator put it. Otherwise resetting the scales lands on the full window (the x range
    // maps the data extent to it).
    const min = u.scales.x?.min;
    const max = u.scales.x?.max;
    const [from, to] = fullRange.value;
    if (zoomed.value && min !== undefined && max !== undefined && min >= from && max <= to) {
      u.setData(columns(), false);
      u.setScale("x", { min, max });
    } else {
      u.setData(columns());
    }
  },
);

watch(
  () => [props.tone, props.unmeasuredNote],
  () => {
    palette = readPalette();
    hatch = null;
    plot.value?.redraw(false, false);
  },
);

watch(
  () => props.height,
  (height) => plot.value?.setSize({ width: plot.value.width, height }),
);

let stopTheme: (() => void) | null = null;
let resizer: ResizeObserver | null = null;

onMounted(() => {
  build();
  stopTheme = watchTheme(() => {
    palette = readPalette();
    hatch = null;
    plot.value?.redraw(false, true);
  });
  resizer = new ResizeObserver(() => {
    const u = plot.value;
    const width = wrapper.value?.clientWidth;
    if (u && width && Math.abs(width - u.width) > 1) u.setSize({ width: Math.max(240, width), height: props.height });
  });
  if (wrapper.value) resizer.observe(wrapper.value);
});

onBeforeUnmount(() => {
  stopTheme?.();
  resizer?.disconnect();
  plot.value?.destroy();
  plot.value = null;
});

/* ---- Keyboard ---- */

function onKeydown(event: KeyboardEvent): void {
  const u = plot.value;
  if (!u) return;
  // Escape resets a zoom; otherwise it is the sheet's, which closes.
  if (event.key === "Escape") {
    if (zoomed.value) {
      event.preventDefault();
      event.stopPropagation();
      resetZoom();
    }
    return;
  }
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const min = u.scales.x?.min ?? fullRange.value[0];
  const max = u.scales.x?.max ?? fullRange.value[1];
  const range = visibleRange(points.value, min - step.value / 2, max - step.value / 2);
  const next = stepIndex(activeIdx.value, event.key, range);
  if (next < 0) return;
  const x = u.data[0][next]!;
  u.setCursor({ left: u.valToPos(x, "x"), top: u.bbox.height / uPlot.pxRatio / 4 });
  announce.value = readoutText.value;
}

/** A tap on a touch screen places the crosshair (uPlot follows the mouse only). */
function onPointerDown(event: PointerEvent): void {
  if (event.pointerType !== "touch") return;
  const u = plot.value;
  if (!u) return;
  const rect = u.over.getBoundingClientRect();
  u.setCursor({ left: event.clientX - rect.left, top: event.clientY - rect.top });
}

/* ---- Readout ---- */

const active = computed(() => (activeIdx.value >= 0 ? points.value[activeIdx.value] : undefined));

interface ReadoutEntry {
  key: string;
  label: string;
  value: string;
  tone?: "destructive" | "muted";
}

const readout = computed<{ time: string; entries: ReadoutEntry[]; note?: string } | undefined>(() => {
  const p = active.value;
  if (!p) return undefined;
  const start = new Date(p.t * 1000);
  const end = new Date((p.t + step.value) * 1000);
  const time = `${dateTime.value.format(start)} → ${timeOnly.value.format(end)}`;
  const runs = t("fleet.monitoring.chart.runs", { n: p.n, expected: p.expected });
  const method = methodAt(props.series, p.t, props.method);
  const methodEntry: ReadoutEntry[] = [{ key: "method", label: t("fleet.monitoring.chart.method"), value: method.toUpperCase() }];
  if (p.missing) {
    return { time, note: t("fleet.monitoring.chart.noDataLong"), entries: [{ key: "runs", label: t("fleet.monitoring.chart.samples"), value: runs }, ...methodEntry] };
  }
  if (p.n === 0) {
    return { time, note: t("fleet.monitoring.chart.notExpected"), entries: methodEntry };
  }
  const entries: ReadoutEntry[] = [];
  if (p.p50Ms !== undefined) {
    if (p.minMs !== undefined) entries.push({ key: "min", label: t("fleet.monitoring.chart.min"), value: formatMs(p.minMs) });
    entries.push({ key: "p50", label: "p50", value: formatMs(p.p50Ms) });
    if (p.p95Ms !== undefined) entries.push({ key: "p95", label: "p95", value: formatMs(p.p95Ms) });
    if (p.maxMs !== undefined) entries.push({ key: "max", label: t("fleet.monitoring.chart.max"), value: formatMs(p.maxMs) });
    if (p.jitterMs !== undefined) entries.push({ key: "jitter", label: t("fleet.monitoring.chart.jitter"), value: formatMs(p.jitterMs) });
  }
  const alarm = props.unmeasuredNote ? undefined : ("destructive" as const);
  entries.push({ key: "loss", label: t("fleet.monitoring.chart.loss"), value: formatLoss(p.loss ?? 0), tone: (p.loss ?? 0) > 0 ? alarm : undefined });
  // A multi-packet bucket counts its loss in packets, echoes for icmp and signed requests for a beacon; say how many.
  if (p.sent > p.n) entries.push({ key: "echoes", label: t(method === "beacon" ? "fleet.monitoring.chart.requests" : "fleet.monitoring.chart.echoes"), value: t("fleet.monitoring.chart.echoesValue", { lost: p.lost, sent: p.sent }), tone: p.lost > 0 ? alarm : undefined });
  entries.push({ key: "runs", label: t("fleet.monitoring.chart.samples"), value: runs });
  entries.push(...methodEntry);
  return { time, entries, note: p.p50Ms === undefined ? (props.unmeasuredNote ?? t("fleet.monitoring.chart.allFailed")) : undefined };
});

const readoutText = computed(() => {
  const r = readout.value;
  if (!r) return "";
  return [r.time, r.note, ...r.entries.map((e) => `${e.label} ${e.value}`)].filter(Boolean).join(", ");
});

/** The floating readout's side: right of the cursor, or left of it past the middle. */
const floatStyle = computed(() => {
  const u = plot.value;
  if (!u) return {};
  const plotLeft = u.bbox.left / uPlot.pxRatio;
  const x = plotLeft + cursorLeft.value;
  const width = u.width;
  return x > width / 2 ? { right: `${width - x + 12}px`, top: "8px" } : { left: `${x + 12}px`, top: "8px" };
});
</script>

<template>
  <div class="space-y-1.5">
    <!-- Phone: the values in a fixed row above the chart, never under the finger. -->
    <div
      v-if="compact"
      class="min-h-11 rounded-md border border-border bg-muted/30 px-2.5 py-1.5 text-xs"
      data-testid="path-chart-readout-fixed"
      aria-hidden="true"
    >
      <template v-if="readout">
        <p class="font-mono tabular text-muted-foreground">{{ readout.time }}</p>
        <p class="flex flex-wrap gap-x-3 gap-y-0.5">
          <span v-if="readout.note" class="text-muted-foreground">{{ readout.note }}</span>
          <span v-for="entry in readout.entries" :key="entry.key" class="whitespace-nowrap">
            <span class="text-muted-foreground">{{ entry.label }}</span>
            <span :class="['ms-1 font-mono tabular', entry.tone === 'destructive' ? 'text-destructive' : 'text-foreground']">{{ entry.value }}</span>
          </span>
        </p>
      </template>
      <p v-else class="py-1 text-muted-foreground">{{ $t('fleet.monitoring.chart.hintTouch') }}</p>
    </div>
    <div
      ref="wrapper"
      class="relative w-full rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
      tabindex="0"
      role="group"
      :aria-label="label"
      :aria-describedby="helpId"
      data-testid="path-chart"
      :data-zoomed="zoomed ? '' : undefined"
      @keydown="onKeydown"
      @pointerdown="onPointerDown"
    >
      <div ref="host" class="path-chart" />
      <div
        v-if="!compact && readout"
        class="pointer-events-none absolute z-10 w-max max-w-64 rounded-md border border-border bg-popover px-2.5 py-2 text-xs text-popover-foreground shadow-md"
        :style="floatStyle"
        data-testid="path-chart-readout"
        aria-hidden="true"
      >
        <p class="mb-1 font-mono tabular text-muted-foreground">{{ readout.time }}</p>
        <p v-if="readout.note" class="mb-1 text-muted-foreground">{{ readout.note }}</p>
        <dl class="grid grid-cols-[auto_auto] gap-x-3 gap-y-0.5">
          <template v-for="entry in readout.entries" :key="entry.key">
            <dt class="text-muted-foreground">{{ entry.label }}</dt>
            <dd :class="['text-end font-mono font-medium tabular', entry.tone === 'destructive' ? 'text-destructive' : 'text-foreground']">{{ entry.value }}</dd>
          </template>
        </dl>
      </div>
    </div>
    <p :id="helpId" class="text-[11px] text-muted-foreground">
      {{ compact ? $t('fleet.monitoring.chart.helpTouch') : $t('fleet.monitoring.chart.help') }}
      <button
        v-if="zoomed"
        type="button"
        class="ms-1 font-medium text-foreground underline underline-offset-2 pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:items-center"
        data-testid="path-chart-reset"
        @click="resetZoom"
      >{{ $t('fleet.monitoring.chart.reset') }}</button>
    </p>
    <p class="sr-only" aria-live="polite">{{ announce }}</p>
  </div>
</template>

<style scoped>
/* uPlot's selection, in the console's ink rather than its default blue. */
.path-chart :deep(.u-select) {
  background: color-mix(in oklab, var(--foreground) 10%, transparent);
}
.path-chart :deep(.u-cursor-x) {
  border-right: 1px solid color-mix(in oklab, var(--foreground) 45%, transparent);
}
.path-chart :deep(.u-over) {
  cursor: crosshair;
}
</style>
