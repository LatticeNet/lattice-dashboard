/**
 * The System page (Platform > System) and the node page's History card: the
 * control plane's own health and long-term history, read from its metrics
 * store (lattice-server internal/metricsdb, metrics.db).
 *
 * The store keeps every bucket's min, max and count beside its average, so a
 * chart over a month can still show the two-minute spike a plain average
 * would flatten. This model turns the server's columnar series into chart
 * geometry that keeps that spread and keeps gaps as gaps: a bucket the
 * control plane heard nothing in is never drawn as a value.
 *
 * Kept free of Vue so `node --test` covers it directly.
 */
import type {
  MetricsRange,
  MetricsSeries,
  MetricsUnit,
  SystemEventRow,
  SystemMetricsStore,
  SystemSpark,
  SystemTier,
} from "@/lib/api/systemTypes";

/** The ranges the System page and the node's History card offer. */
export const SYSTEM_RANGES: readonly MetricsRange[] = ["24h", "7d", "30d", "90d", "1y"];
export const DEFAULT_SYSTEM_RANGE: MetricsRange = "24h";

export type SystemLayer = "plugins" | "http" | "store";
export const SYSTEM_LAYERS: readonly SystemLayer[] = ["plugins", "http", "store"];

export function parseRange(raw: unknown, allowed: readonly MetricsRange[] = SYSTEM_RANGES): MetricsRange {
  return typeof raw === "string" && (allowed as readonly string[]).includes(raw) ? (raw as MetricsRange) : DEFAULT_SYSTEM_RANGE;
}

import { NO_VALUE } from "@/lib/format";

/** Seconds as the shortest honest duration: 0.4 ms, 82 ms, 1.2 s, 3.5 min. */
export function formatSeconds(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds)) return NO_VALUE;
  if (seconds <= 0) return "0 ms";
  if (seconds < 0.001) return `${(seconds * 1000).toFixed(2)} ms`;
  if (seconds < 0.01) return `${(seconds * 1000).toFixed(1)} ms`;
  if (seconds < 1) return `${Math.round(seconds * 1000)} ms`;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 2 : 1)} s`;
  if (seconds < 3600) return `${(seconds / 60).toFixed(1)} min`;
  return `${(seconds / 3600).toFixed(1)} h`;
}

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"];

/** Bytes with 1024 steps, as the rest of the console prints them. */
export function formatBytesShort(bytes: number | undefined, digits = 1): string {
  if (bytes === undefined || !Number.isFinite(bytes)) return NO_VALUE;
  const negative = bytes < 0;
  let v = Math.abs(bytes);
  if (v < 1) return "0 B";
  let i = 0;
  while (v >= 1024 && i < BYTE_UNITS.length - 1) {
    v /= 1024;
    i++;
  }
  return `${negative ? "-" : ""}${v.toFixed(i === 0 ? 0 : digits)} ${BYTE_UNITS[i]}`;
}

/** A signed byte change: "+120.0 MB", "-3.0 KB", "±0 B". */
export function formatByteChange(delta: number | undefined): string | undefined {
  if (delta === undefined || !Number.isFinite(delta)) return undefined;
  if (Math.abs(delta) < 1) return "±0 B";
  return delta > 0 ? `+${formatBytesShort(delta)}` : formatBytesShort(delta);
}

/** One value in its series' unit. */
export function formatUnit(unit: MetricsUnit | undefined, value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return NO_VALUE;
  switch (unit) {
    case "percent":
      return `${value.toFixed(value < 10 ? 1 : 0)}%`;
    case "bytes":
      return formatBytesShort(value);
    case "bytes_per_second":
      return `${formatBytesShort(value)}/s`;
    case "seconds":
      return formatSeconds(value);
    case "load":
      return value.toFixed(2);
    case "count":
      return Math.round(value).toLocaleString("en-US");
    default:
      return Number.isInteger(value) ? String(value) : value.toFixed(2);
  }
}

/** A rate per minute, two significant figures under ten. */
export function formatRate(perMinute: number): string {
  if (!Number.isFinite(perMinute) || perMinute <= 0) return "0";
  if (perMinute < 0.1) return perMinute.toFixed(3);
  if (perMinute < 10) return perMinute.toFixed(1);
  return Math.round(perMinute).toLocaleString("en-US");
}

export function errorRate(row: Pick<SystemEventRow, "calls" | "errors">): number {
  return row.calls > 0 ? row.errors / row.calls : 0;
}

export function formatErrorRate(row: Pick<SystemEventRow, "calls" | "errors">): string {
  if (row.errors === 0) return "0";
  const rate = errorRate(row) * 100;
  return `${rate < 1 ? rate.toFixed(2) : rate.toFixed(1)}%`;
}

export type Tone = "default" | "warning" | "destructive";

/**
 * How a row reads. Failures decide first: one in twenty is destructive, one
 * in a hundred a warning. Then latency: a p95 at or over one second is the
 * server's own slow-request line (LATTICE_SLOW_REQUEST_MS defaults to 1000).
 */
export function eventRowTone(row: Pick<SystemEventRow, "calls" | "errors" | "p95_seconds">): Tone {
  const failures = errorTone(row);
  if (failures !== "default") return failures;
  return row.p95_seconds >= 1 ? "warning" : "default";
}

/** The failure count's own tone: a slow method with no failures prints its zero plainly. */
export function errorTone(row: Pick<SystemEventRow, "calls" | "errors">): Tone {
  const rate = errorRate(row);
  if (rate >= 0.05) return "destructive";
  if (rate >= 0.01) return "warning";
  return "default";
}

/** Free space on the data volume: under ten percent destructive, under fifteen a warning. */
export function freeSpaceTone(free: number | undefined, total: number | undefined): Tone {
  if (!free || !total) return "default";
  const share = free / total;
  if (share < 0.1) return "destructive";
  if (share < 0.15) return "warning";
  return "default";
}

/** Host memory: under ten percent available destructive, under twenty a warning. */
export function memoryTone(available: number | undefined, total: number | undefined): Tone {
  if (available === undefined || !total) return "default";
  const share = available / total;
  if (share < 0.1) return "destructive";
  if (share < 0.2) return "warning";
  return "default";
}

/** The first and last average of a gauge sparkline, and their difference. */
export function sparkChange(spark: SystemSpark | undefined): number | undefined {
  const avg = spark?.avg;
  if (!avg || avg.length < 2) return undefined;
  return avg[avg.length - 1]! - avg[0]!;
}

/** Rows whose name (or plugin) contains every word of the query. */
export function filterRows<T extends Pick<SystemEventRow, "name" | "plugin">>(rows: readonly T[], query: string): T[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...rows];
  return rows.filter((row) => {
    const hay = `${row.plugin ?? ""} ${row.name}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

export interface PluginGroup {
  plugin: string;
  rows: SystemEventRow[];
  calls: number;
  errors: number;
  /** The slowest method's p95, the figure a slow plugin is found by. */
  worstP95: number;
}

/** Plugin rows grouped by plugin, the plugin with the slowest method first. */
export function groupPluginRows(rows: readonly SystemEventRow[]): PluginGroup[] {
  const groups = new Map<string, PluginGroup>();
  for (const row of rows) {
    const id = row.plugin ?? "";
    let g = groups.get(id);
    if (!g) {
      g = { plugin: id, rows: [], calls: 0, errors: 0, worstP95: 0 };
      groups.set(id, g);
    }
    g.rows.push(row);
    g.calls += row.calls;
    g.errors += row.errors;
    g.worstP95 = Math.max(g.worstP95, row.p95_seconds);
  }
  const out = [...groups.values()];
  for (const g of out) g.rows.sort((a, b) => b.p95_seconds - a.p95_seconds || b.calls - a.calls || a.name.localeCompare(b.name));
  out.sort((a, b) => b.worstP95 - a.worstP95 || a.plugin.localeCompare(b.plugin));
  return out;
}

export type StoreFreshness = "fresh" | "waiting" | "late" | "failing";

/**
 * Whether the metrics store is keeping up. It writes once a minute, just
 * after the minute closes; more than three minutes without a write is late.
 * A store that has not written since this process started is waiting for its
 * first minute.
 */
export function storeFreshness(store: Pick<SystemMetricsStore, "last_write_at" | "last_write_error">, now: number): StoreFreshness {
  if (store.last_write_error) return "failing";
  if (!store.last_write_at) return "waiting";
  const age = now - Date.parse(store.last_write_at);
  return age > 3 * 60_000 ? "late" : "fresh";
}

/** When the next one-minute point is due: the end of the current minute plus the flush delay. */
export function nextPointAt(now: number): number {
  return Math.floor(now / 60_000) * 60_000 + 60_000 + 500;
}

/** A duration in seconds as a retention or resolution phrase input: 60 → {n:1, unit:"min"}. */
export function spanParts(seconds: number): { n: number; unit: "min" | "h" | "d" | "y" } {
  if (seconds >= 365 * 86400 && seconds % 86400 === 0 && seconds / 86400 >= 365) {
    const years = seconds / (365 * 86400);
    if (Math.abs(years - Math.round(years)) < 0.02) return { n: Math.round(years), unit: "y" };
  }
  if (seconds >= 86400 && seconds % 86400 === 0) return { n: seconds / 86400, unit: "d" };
  if (seconds >= 3600 && seconds % 3600 === 0) return { n: seconds / 3600, unit: "h" };
  return { n: Math.max(1, Math.round(seconds / 60)), unit: "min" };
}

/** Tiers finest first, for the retention disclosure. */
export function sortedTiers(tiers: readonly SystemTier[]): SystemTier[] {
  return [...tiers].sort((a, b) => a.resolution_seconds - b.resolution_seconds);
}

/**
 * A chart's edge label: the time of day within two days, the day within
 * about a year, the month beyond.
 */
export function formatAxisTime(unixSeconds: number, spanSeconds: number, locale?: string): string {
  if (!unixSeconds) return "";
  const opts: Intl.DateTimeFormatOptions =
    spanSeconds <= 2 * 86400
      ? { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }
      : spanSeconds <= 400 * 86400
        ? { month: "short", day: "numeric" }
        : { year: "numeric", month: "short" };
  return new Intl.DateTimeFormat(locale, opts).format(new Date(unixSeconds * 1000));
}

/** A bucket's time in the readout: to the minute for buckets under a day, the date for day buckets. */
export function formatBucketTime(unixSeconds: number, stepSeconds: number, locale?: string): string {
  const opts: Intl.DateTimeFormatOptions =
    stepSeconds < 86400
      ? { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }
      : { year: "numeric", month: "short", day: "numeric" };
  return new Intl.DateTimeFormat(locale, opts).format(new Date(unixSeconds * 1000));
}

/* ------------------------------------------------------------------ */
/* Chart geometry                                                      */
/* ------------------------------------------------------------------ */

export interface ChartPoint {
  t: number;
  avg: number;
  min: number;
  max: number;
  n: number;
  e?: number;
  p50?: number;
  p95?: number;
}

/** Zip a columnar series into points, dropping any bucket with a missing or non-finite value. */
export function seriesPoints(series: MetricsSeries | undefined): ChartPoint[] {
  if (!series) return [];
  const out: ChartPoint[] = [];
  for (let i = 0; i < series.t.length; i++) {
    const avg = series.avg[i];
    const min = series.min[i];
    const max = series.max[i];
    if (avg === undefined || min === undefined || max === undefined || ![avg, min, max].every(Number.isFinite)) continue;
    out.push({
      t: series.t[i]!,
      avg,
      min,
      max,
      n: series.n[i] ?? 0,
      e: series.e?.[i],
      p50: series.p50?.[i],
      p95: series.p95?.[i],
    });
  }
  return out;
}

/**
 * Split points where consecutive buckets are further apart than one and a
 * half steps, so the chart draws a gap where nothing was heard.
 */
export function segments(points: readonly ChartPoint[], stepSeconds: number): ChartPoint[][] {
  const out: ChartPoint[][] = [];
  let cur: ChartPoint[] = [];
  for (const p of points) {
    const prev = cur[cur.length - 1];
    if (prev && p.t - prev.t > stepSeconds * 1.5) {
      out.push(cur);
      cur = [];
    }
    cur.push(p);
  }
  if (cur.length) out.push(cur);
  return out;
}

/**
 * The top of a chart's scale. Percent charts keep 100 in view so a quiet
 * machine reads as quiet; byte charts reach a known ceiling (the host's
 * memory, the volume's size) when one is given; otherwise the data's max
 * with ten percent headroom, rounded to a readable step.
 */
export function chartCeiling(unit: MetricsUnit | undefined, dataMax: number, ceiling?: number): number {
  if (ceiling !== undefined && ceiling > 0) return Math.max(ceiling, dataMax);
  if (unit === "percent") return Math.max(100, niceCeil(dataMax));
  if (dataMax <= 0) return 1;
  return niceCeil(dataMax * 1.1);
}

/** The next "nice" number at or above v: 1, 2, 2.5 or 5 times a power of ten (or of 1024 above a KiB). */
export function niceCeil(v: number): number {
  if (!(v > 0)) return 1;
  const exp = Math.floor(Math.log10(v));
  const base = 10 ** exp;
  for (const m of [1, 2, 2.5, 5, 10]) {
    if (m * base >= v - 1e-12) return m * base;
  }
  return 10 * base;
}

export interface ChartGeometry {
  /** SVG path (several subpaths) of the min to max band. */
  band: string;
  /** SVG path (several subpaths) of the average line, broken at gaps. */
  line: string;
  /** Isolated buckets, drawn as dots because a one-point segment has no line. */
  dots: { x: number; y: number }[];
  ceiling: number;
}

/**
 * Project a series into a w by h box over [from, to] (unix seconds) and
 * [0, ceiling]. The band is drawn per segment so it breaks at gaps too.
 */
export function chartGeometry(
  points: readonly ChartPoint[],
  opts: { from: number; to: number; step: number; w: number; h: number; ceiling: number; value?: (p: ChartPoint) => number },
): ChartGeometry {
  const { from, to, step, w, h, ceiling } = opts;
  const value = opts.value ?? ((p: ChartPoint) => p.avg);
  const span = Math.max(to - from, 1);
  // A bucket is drawn at its middle, so the newest one does not sit past the edge.
  const x = (t: number) => (((t + step / 2 - from) / span) * w);
  const y = (v: number) => h - (Math.min(Math.max(v, 0), ceiling) / ceiling) * h;
  const fmt = (n: number) => n.toFixed(2);
  let band = "";
  let line = "";
  const dots: { x: number; y: number }[] = [];
  for (const seg of segments(points, step)) {
    if (seg.length === 1) {
      dots.push({ x: x(seg[0]!.t), y: y(value(seg[0]!)) });
      continue;
    }
    line += seg.map((p, i) => `${i === 0 ? "M" : "L"}${fmt(x(p.t))},${fmt(y(value(p)))}`).join("") + " ";
    const top = seg.map((p, i) => `${i === 0 ? "M" : "L"}${fmt(x(p.t))},${fmt(y(p.max))}`).join("");
    const bottom = [...seg].reverse().map((p) => `L${fmt(x(p.t))},${fmt(y(p.min))}`).join("");
    band += `${top}${bottom}Z `;
  }
  return { band: band.trim(), line: line.trim(), dots, ceiling };
}

/** The point nearest to a horizontal position (0 to 1 across the chart), or undefined when there is none within one step. */
export function pointAt(points: readonly ChartPoint[], fraction: number, from: number, to: number, step: number): ChartPoint | undefined {
  if (points.length === 0) return undefined;
  const t = from + fraction * (to - from) - step / 2;
  let best: ChartPoint | undefined;
  let bestDist = Infinity;
  for (const p of points) {
    const d = Math.abs(p.t - t);
    if (d < bestDist) {
      best = p;
      bestDist = d;
    }
  }
  return bestDist <= step ? best : undefined;
}

/**
 * A sparkline's polyline over a fixed box, one x slot per bucket of the
 * range so gaps keep their width; null values break the line. A latency
 * line stands on zero; a size line (relative) spans its own min to max, so
 * a file growing by one percent still shows which way it is going.
 */
export function sparkPath(
  spark: SystemSpark | undefined,
  values: readonly (number | undefined)[],
  opts: { from: number; to: number; w: number; h: number; relative?: boolean },
): string {
  if (!spark || spark.t.length === 0) return "";
  const step = Math.max(spark.step_seconds, 1);
  const span = Math.max(opts.to - opts.from, step);
  const finite = values.filter((v): v is number => v !== undefined && Number.isFinite(v));
  const top = finite.length ? Math.max(...finite) : 0;
  const floor = opts.relative && finite.length ? Math.min(...finite) : 0;
  const ceiling = top - floor > 0 ? top - floor : 1;
  let d = "";
  let prevT: number | undefined;
  spark.t.forEach((t, i) => {
    const v = values[i];
    if (v === undefined || !Number.isFinite(v)) {
      prevT = undefined;
      return;
    }
    const px = ((t + step / 2 - opts.from) / span) * opts.w;
    const py = opts.h - 1 - ((v - floor) / ceiling) * (opts.h - 2);
    const join = prevT !== undefined && t - prevT <= step * 1.5;
    d += `${join ? "L" : "M"}${px.toFixed(1)},${py.toFixed(1)}`;
    prevT = t;
  });
  return d;
}
