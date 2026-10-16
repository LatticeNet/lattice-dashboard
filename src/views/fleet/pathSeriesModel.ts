/**
 * One path's series for the path chart (design 29 D5, D8).
 *
 * The server answers buckets on one step, with missing buckets explicit
 * (`n` 0 while `expected` is above 0). This model reads them into points the
 * chart draws, and holds the rules that make the chart honest:
 *
 *   - a missing bucket is null in every lane, so nothing interpolates across
 *     it, and it is listed as a gap run for the hatch;
 *   - a bucket where every run failed has no latency and a full loss bar;
 *   - a bucket that expected nothing (a paused path) is blank, not a gap;
 *   - a hole the server left in the steps is filled with gap points, so a
 *     missing bucket can never be drawn as a line between its neighbours.
 *
 * Kept free of Vue and of uPlot so `node --test` covers it directly.
 */
import type { LatencySeries, MonitorWindow, PathSeriesResponse } from "@/lib/api/types";

import { chartCeiling } from "@/views/fleet/latencyModel";
import { WINDOW_SECONDS } from "@/views/fleet/pathsModel";

/* ------------------------------------------------------------------ */
/* Steps                                                                */
/* ------------------------------------------------------------------ */

/** The most points a series may hold (design 29 D5). */
export const MAX_POINTS = 720;
/** Fine rollups (design 29 D4). */
export const FINE_STEP_SEC = 300;
/** Coarse rollups. */
export const COARSE_STEP_SEC = 3600;
export const COARSE_RETENTION_DAYS = 35;
/** Raw rows are folded at one minute. */
export const RAW_STEP_SEC = 60;
/** The longest window raw rows answer; longer windows read rollups. */
export const RAW_MAX_WINDOW_SEC = 3600;

/**
 * The step the server answers for a window (design 29 D5, as lattice-server
 * pathSeriesStep has it): the finest tier that covers the window (raw rows
 * folded at a minute up to an hour, five-minute rollups up to the fine
 * retention, hourly rollups beyond), then the smallest multiple of its
 * resolution that keeps the series within MAX_POINTS (the window starts on a
 * step boundary, so it holds one partial step more) and is no shorter than
 * the check's interval, so every whole step expects a run.
 *
 *   1h 1 min (60), 6h 5 min (72), 24h 5 min (288), 3d 10 min (432),
 *   7d 15 min (672), 14d 30 min with 14 days of fine history, else 1 h
 */
export function expectedStepSeconds(window: MonitorWindow, intervalSec = 60, fineRetentionDays = 7): number {
  const span = WINDOW_SECONDS[window];
  const base = span <= RAW_MAX_WINDOW_SEC ? RAW_STEP_SEC : span <= Math.max(0, fineRetentionDays) * 86400 ? FINE_STEP_SEC : COARSE_STEP_SEC;
  const perStep = base * (MAX_POINTS - 1);
  let k = span > perStep ? Math.ceil(span / perStep) : 1;
  if (intervalSec > base) k = Math.max(k, Math.ceil(intervalSec / base));
  return k * base;
}

/* ------------------------------------------------------------------ */
/* Points                                                               */
/* ------------------------------------------------------------------ */

export interface SeriesPoint {
  /** Bucket start, unix seconds. */
  t: number;
  n: number;
  expected: number;
  fail: number;
  minMs?: number;
  p50Ms?: number;
  p95Ms?: number;
  maxMs?: number;
  jitterMs?: number;
  /** Failure share of the runs heard, 0 to 1. */
  loss?: number;
  method?: string;
  /** Runs were expected and none was heard. */
  missing: boolean;
}

export interface MethodChange {
  t: number;
  method: string;
}

export interface PathSeries {
  stepSec: number;
  from: number;
  to: number;
  points: SeriesPoint[];
  methodChanges: MethodChange[];
}

/** Unix seconds from unix seconds, unix milliseconds or an ISO time; NaN when unreadable. */
export function toSeconds(value: number | string | undefined): number {
  if (typeof value === "number") return value > 1e12 ? Math.floor(value / 1000) : value;
  if (typeof value === "string" && value) {
    if (/^\d+(\.\d+)?$/.test(value)) return toSeconds(Number(value));
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? NaN : Math.floor(ms / 1000);
  }
  return NaN;
}

function num(value: number | undefined | null): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

interface RawPoint {
  t: number;
  n: number;
  expected: number;
  fail: number;
  minMs?: number;
  p50Ms?: number;
  p95Ms?: number;
  maxMs?: number;
  jitterMs?: number;
  loss?: number;
  method?: string;
}

function finish(raw: RawPoint): SeriesPoint {
  const n = Math.max(0, raw.n || 0);
  const fail = Math.min(n, Math.max(0, raw.fail || 0));
  const expected = Math.max(0, raw.expected || 0);
  const point: SeriesPoint = { t: raw.t, n, expected, fail, missing: n === 0 && expected > 0, method: raw.method };
  if (n > 0) {
    point.loss = raw.loss !== undefined ? Math.max(0, Math.min(1, raw.loss)) : fail / n;
    // Every run failed: there is no latency to draw, only the loss bar.
    if (fail < n) {
      point.p50Ms = raw.p50Ms;
      point.p95Ms = raw.p95Ms ?? raw.p50Ms;
      point.minMs = raw.minMs;
      point.maxMs = raw.maxMs;
      point.jitterMs = raw.jitterMs;
    }
  }
  return point;
}

/**
 * Points on one step, oldest first. A step the server skipped becomes a gap
 * point that expected what its neighbours expected, so it is hatched rather
 * than bridged.
 */
export function fillSteps(raw: readonly RawPoint[], stepSec: number): SeriesPoint[] {
  const sorted = raw.filter((p) => Number.isFinite(p.t)).sort((a, b) => a.t - b.t);
  const out: SeriesPoint[] = [];
  const step = stepSec > 0 ? stepSec : 0;
  for (const point of sorted) {
    const prev = out[out.length - 1];
    if (prev && point.t === prev.t) continue;
    if (prev && step > 0) {
      const holes = Math.round((point.t - prev.t) / step) - 1;
      // A server that skips a few thousand steps sent a broken series; cap the fill.
      for (let i = 1; i <= Math.min(holes, MAX_POINTS * 4); i++) {
        const expected = Math.max(prev.expected, point.expected, 1);
        out.push(finish({ t: prev.t + i * step, n: 0, fail: 0, expected }));
      }
    }
    out.push(finish(point));
  }
  return out;
}

export function seriesFromResponse(response: PathSeriesResponse): PathSeries {
  const raw: RawPoint[] = (response.buckets ?? []).map((b) => ({
    t: toSeconds(b.t),
    n: b.n,
    expected: b.expected,
    fail: b.fail,
    minMs: num(b.min_ms),
    p50Ms: num(b.p50_ms),
    p95Ms: num(b.p95_ms),
    maxMs: num(b.max_ms),
    jitterMs: num(b.jitter_ms),
    loss: num(b.loss),
    method: b.method || undefined,
  }));
  const stepSec = response.step_seconds > 0 ? response.step_seconds : inferStep(raw);
  const points = fillSteps(raw, stepSec);
  const from = toSeconds(response.from);
  const to = toSeconds(response.to);
  return {
    stepSec,
    from: Number.isFinite(from) ? from : (points[0]?.t ?? 0),
    to: Number.isFinite(to) ? to : (points[points.length - 1]?.t ?? 0) + stepSec,
    points,
    methodChanges: (response.method_changes ?? [])
      .map((c) => ({ t: toSeconds(c.t), method: c.method }))
      .filter((c) => Number.isFinite(c.t) && !!c.method)
      .sort((a, b) => a.t - b.t),
  };
}

/** A latency series from a server before design 29: no min, max or jitter, one method. */
export function seriesFromLatency(series: LatencySeries): PathSeries {
  const raw: RawPoint[] = (series.buckets ?? []).map((b) => ({
    t: toSeconds(b.at),
    n: b.samples,
    expected: b.expected,
    fail: b.failures,
    p50Ms: num(b.p50_ms),
    p95Ms: num(b.p95_ms),
    loss: num(b.loss),
  }));
  const stepSec = series.bucket_sec > 0 ? series.bucket_sec : inferStep(raw);
  const points = fillSteps(raw, stepSec);
  return {
    stepSec,
    from: toSeconds(series.from),
    to: toSeconds(series.to),
    points,
    methodChanges: [],
  };
}

/** The most common distance between neighbouring buckets, for a series that did not state its step. */
export function inferStep(raw: readonly { t: number }[]): number {
  const ts = raw.map((p) => p.t).filter(Number.isFinite).sort((a, b) => a - b);
  const counts = new Map<number, number>();
  for (let i = 1; i < ts.length; i++) {
    const d = ts[i]! - ts[i - 1]!;
    if (d > 0) counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  let best = 0;
  let bestCount = 0;
  for (const [d, c] of counts) if (c > bestCount || (c === bestCount && d < best)) [best, bestCount] = [d, c];
  return best || 60;
}

/* ------------------------------------------------------------------ */
/* Gaps and markers                                                     */
/* ------------------------------------------------------------------ */

export interface GapRun {
  /** Start of the first missing bucket, unix seconds. */
  from: number;
  /** End of the last missing bucket. */
  to: number;
  buckets: number;
}

/** Runs of missing buckets, for the hatch across both lanes. */
export function gapRuns(series: Pick<PathSeries, "points" | "stepSec">): GapRun[] {
  const runs: GapRun[] = [];
  for (const point of series.points) {
    if (!point.missing) continue;
    const last = runs[runs.length - 1];
    if (last && Math.abs(last.to - point.t) < 1e-6) {
      last.to = point.t + series.stepSec;
      last.buckets += 1;
    } else {
      runs.push({ from: point.t, to: point.t + series.stepSec, buckets: 1 });
    }
  }
  return runs;
}

export interface MethodSwitch {
  t: number;
  /** The method before the switch. */
  from: string;
  to: string;
}

/**
 * Where the method begins: the server's list (the method in force from the
 * first bucket with data, then every bucket where it changed, as lattice-sdk
 * PathSeries.MethodChanges says), else the same read from the buckets' own
 * method field.
 */
export function methodStarts(series: PathSeries): MethodChange[] {
  if (series.methodChanges.length) return series.methodChanges;
  const out: MethodChange[] = [];
  for (const point of series.points) {
    if (!point.method) continue;
    if (out[out.length - 1]?.method !== point.method) out.push({ t: point.t, method: point.method });
  }
  return out;
}

/** The switches the chart marks: every start after the first whose method differs from the one before. */
export function methodMarkers(series: PathSeries): MethodSwitch[] {
  const starts = methodStarts(series);
  const out: MethodSwitch[] = [];
  for (let i = 1; i < starts.length; i++) {
    if (starts[i]!.method !== starts[i - 1]!.method) out.push({ t: starts[i]!.t, from: starts[i - 1]!.method, to: starts[i]!.method });
  }
  return out;
}

/**
 * The method in force at a time: the bucket's own, else the last start at or
 * before it, else the first start (before any data, the first method is
 * the one that ran), else the path's current method.
 */
export function methodAt(series: PathSeries, t: number, current: string): string {
  const point = series.points.find((p) => p.t === t);
  if (point?.method) return point.method;
  const starts = methodStarts(series);
  const before = starts.filter((m) => m.t <= t);
  return before[before.length - 1]?.method ?? starts[0]?.method ?? current;
}

/* ------------------------------------------------------------------ */
/* Lanes                                                                */
/* ------------------------------------------------------------------ */

/** Share of the plot height the loss lane takes, from the bottom. */
export const LOSS_LANE = 0.24;
/** Where the latency lane starts, from the bottom; the space between is the lane gap. */
export const LATENCY_LANE_START = 0.3;

export interface LaneLayout {
  /** The latency scale: 0 ms sits at LATENCY_LANE_START of the height. */
  msMin: number;
  msMax: number;
  /** The loss scale: a loss of 1 reaches the top of the loss lane. */
  lossMax: number;
  /** Latency ticks, in ms. */
  msTicks: number[];
  /** Loss ticks, as a share and as the ms value at the same height (the one left axis carries both). */
  lossTicks: { share: number; ms: number }[];
  /** The ms value at the hairline between the lanes. */
  divider: number;
}

/**
 * Two lanes on one canvas and one left axis. The latency scale is stretched
 * below zero so 0 ms sits above the loss lane; the loss scale is stretched
 * so 100% reaches the top of its lane. Ticks for both are expressed on the
 * latency scale, which is the axis the canvas draws.
 */
export function laneLayout(maxMs: number): LaneLayout {
  const ceiling = chartCeiling(Math.max(1, Number.isFinite(maxMs) ? maxMs : 1));
  const msMax = ceiling;
  const msMin = -msMax * (LATENCY_LANE_START / (1 - LATENCY_LANE_START));
  const span = msMax - msMin;
  const atHeight = (fraction: number) => msMin + span * fraction;
  return {
    msMin,
    msMax,
    lossMax: 1 / LOSS_LANE,
    msTicks: [0, ceiling / 2, ceiling],
    lossTicks: [
      { share: 0, ms: atHeight(0) },
      { share: 1, ms: atHeight(LOSS_LANE) },
    ],
    divider: atHeight((LOSS_LANE + LATENCY_LANE_START) / 2),
  };
}

/** The highest latency the chart must hold: p95, else p50, else max when it is shown. */
export function seriesCeilingMs(points: readonly SeriesPoint[], withMax = false): number {
  let max = 0;
  for (const p of points) {
    const v = withMax ? (p.maxMs ?? p.p95Ms ?? p.p50Ms) : (p.p95Ms ?? p.p50Ms);
    if (v !== undefined && v > max) max = v;
  }
  return max;
}

/**
 * The columns uPlot draws: x, band floor (min, else p50), p50, band ceiling
 * (p95), loss. A missing or all-failed bucket is null in every latency
 * column; loss is null where nothing was heard and where nothing was lost.
 */
export function chartColumns(points: readonly SeriesPoint[]): [number[], (number | null)[], (number | null)[], (number | null)[], (number | null)[]] {
  const xs: number[] = [];
  const floor: (number | null)[] = [];
  const p50: (number | null)[] = [];
  const p95: (number | null)[] = [];
  const loss: (number | null)[] = [];
  for (const p of points) {
    xs.push(p.t);
    const median = p.p50Ms ?? null;
    p50.push(median);
    floor.push(median === null ? null : (p.minMs ?? median));
    p95.push(median === null ? null : (p.p95Ms ?? median));
    loss.push(p.n > 0 && (p.loss ?? 0) > 0 ? (p.loss ?? 0) : null);
  }
  return [xs, floor, p50, p95, loss];
}

/* ------------------------------------------------------------------ */
/* The crosshair                                                        */
/* ------------------------------------------------------------------ */

/** The bucket holding a time, or the nearest one; -1 for an empty series. */
export function bucketIndexAt(points: readonly SeriesPoint[], t: number, stepSec: number): number {
  if (!points.length) return -1;
  let lo = 0;
  let hi = points.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (points[mid]!.t <= t) lo = mid;
    else hi = mid - 1;
  }
  const at = points[lo]!;
  if (t < at.t && lo === 0) return 0;
  if (t >= at.t + stepSec && lo + 1 < points.length) return lo + 1;
  return lo;
}

/** The next bucket a key moves to: arrows by one, Home and End to the ends, within the visible range. */
export function stepIndex(current: number, key: string, range: { first: number; last: number }): number {
  if (range.last < range.first) return -1;
  const clamp = (i: number) => Math.max(range.first, Math.min(range.last, i));
  if (current < range.first || current > range.last) return key === "ArrowLeft" || key === "End" ? range.last : range.first;
  switch (key) {
    case "ArrowLeft":
      return clamp(current - 1);
    case "ArrowRight":
      return clamp(current + 1);
    case "Home":
      return range.first;
    case "End":
      return range.last;
    default:
      return current;
  }
}

/** The indexes of the buckets inside an x range. */
export function visibleRange(points: readonly SeriesPoint[], min: number, max: number): { first: number; last: number } {
  let first = -1;
  let last = -1;
  points.forEach((p, i) => {
    if (p.t >= min && p.t <= max) {
      if (first < 0) first = i;
      last = i;
    }
  });
  return { first, last };
}

/* ------------------------------------------------------------------ */
/* Aggregates                                                           */
/* ------------------------------------------------------------------ */

export interface SeriesStats {
  p50Ms?: number;
  p95Ms?: number;
  jitterMs?: number;
  loss?: number;
  availability?: number;
  samples: number;
  expected: number;
}

function weightedQuantile(pairs: { value: number; weight: number }[], q: number): number | undefined {
  const sorted = pairs.filter((p) => p.weight > 0).sort((a, b) => a.value - b.value);
  const total = sorted.reduce((sum, p) => sum + p.weight, 0);
  if (!total) return undefined;
  let acc = 0;
  for (const p of sorted) {
    acc += p.weight;
    if (acc >= total * q) return p.value;
  }
  return sorted[sorted.length - 1]!.value;
}

/**
 * A range's figures from its buckets, for a zoomed range or a server that sent
 * no window figures. Runs, failures, loss and availability are exact; p50,
 * p95 and jitter are weighted by successful runs, which is close to but not
 * the server's histogram percentile.
 */
export function seriesStats(points: readonly SeriesPoint[]): SeriesStats {
  let samples = 0;
  let expected = 0;
  let fail = 0;
  const p50: { value: number; weight: number }[] = [];
  const p95: { value: number; weight: number }[] = [];
  let jitterSum = 0;
  let jitterWeight = 0;
  for (const p of points) {
    samples += p.n;
    expected += p.expected;
    fail += p.fail;
    const ok = p.n - p.fail;
    if (p.p50Ms !== undefined && ok > 0) p50.push({ value: p.p50Ms, weight: ok });
    if (p.p95Ms !== undefined && ok > 0) p95.push({ value: p.p95Ms, weight: ok });
    if (p.jitterMs !== undefined && ok > 0) {
      jitterSum += p.jitterMs * ok;
      jitterWeight += ok;
    }
  }
  const stats: SeriesStats = { samples, expected };
  if (samples > 0) stats.loss = fail / samples;
  if (expected > 0) stats.availability = Math.max(0, Math.min(1, (samples - fail) / expected));
  stats.p50Ms = weightedQuantile(p50, 0.5);
  stats.p95Ms = weightedQuantile(p95, 0.95);
  if (jitterWeight > 0) stats.jitterMs = jitterSum / jitterWeight;
  return stats;
}
