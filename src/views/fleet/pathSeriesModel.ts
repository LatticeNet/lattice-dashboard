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
 *     missing bucket can never be drawn as a line between its neighbours;
 *   - loss counts probes (design 29 M2a): lost over sent where a bucket has
 *     them, so a five-echo ICMP run that lost one is 20 percent, not a
 *     failed run; failed runs over runs in buckets written before M2a;
 *   - the degraded rule's guides and the previous period come from the server
 *     (design 29 D13): the console never re-derives a trigger, and a previous
 *     step with no successful run is null, never joined to its neighbours.
 *
 * Kept free of Vue and of uPlot so `node --test` covers it directly.
 */
import type { LatencySeries, MonitorDegradedRule, MonitorWindow, PathBaseline, PathSeriesResponse } from "@/lib/api/types";

import { chartCeiling } from "@/views/fleet/latencyModel";
import { degradedDraftFrom, degradedSummary, type DegradedField } from "@/views/fleet/degradedRuleModel";
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
  /** Share of the probes lost, 0 to 1: lost over sent, or failed runs over runs before M2a. */
  loss?: number;
  /** Probes sent and lost; zero in a bucket written before M2a. */
  sent: number;
  lost: number;
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
  /**
   * The 7-day baseline the path is judged on (design 29 D13): undefined from a
   * server before M3, null for a path that is never judged (a tls check).
   */
  baseline?: SeriesBaseline | null;
  /** The previous period's p50, one entry per point (null where that step had no successful run); undefined when not asked for. */
  previous?: (number | null)[];
  /** How far back the previous period sits, seconds. */
  previousOffsetSec?: number;
}

/** lattice-sdk PathBaselineMinHours: a path is judged once its baseline holds this many hourly buckets with runs. */
export const BASELINE_MIN_HOURS = 24;

export interface SeriesBaseline {
  from: number;
  to: number;
  hours: number;
  ready: boolean;
  p50Ms?: number;
  loss?: number;
  triggerP50Ms?: number;
  /** The hour's loss the loss arm must exceed, a share below 1; absent when the arm cannot fire (lossNotJudged). */
  triggerLoss?: number;
  /**
   * The loss arm cannot fire on this path. The server's trigger is the
   * larger of the rule's floor and its factor times the 7-day loss
   * (lattice-sdk DegradedLossTrigger), unbounded: a path that lost half its
   * runs or more over the week gets a trigger of 100% or more with the
   * default factor of 2, and no hour's loss is above that. Such a path reads
   * down, not degraded, so the sheet says the loss is not judged rather than
   * print an impossible "loss 200%".
   */
  lossNotJudged?: boolean;
  /** The thresholds in force, defaults filled in (degradedRuleModel's rule, one place for the defaults). */
  rule: Record<DegradedField, number>;
}

/** A rule as sent, defaults filled in where a field is absent or zero. */
export function ruleView(rule: MonitorDegradedRule | null | undefined): Record<DegradedField, number> {
  return degradedSummary(degradedDraftFrom(rule));
}

/** The server's baseline, read. A trigger is kept only once the baseline is ready, as the server sends it. */
export function readBaseline(raw: PathBaseline | null | undefined): SeriesBaseline | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  const hours = Math.max(0, Math.floor(raw.hours ?? 0));
  const ready = !!raw.ready && hours >= BASELINE_MIN_HOURS;
  const out: SeriesBaseline = { from: toSeconds(raw.from), to: toSeconds(raw.to), hours, ready, rule: ruleView(raw.rule) };
  const p50 = num(raw.p50_ms);
  const loss = num(raw.loss);
  if (p50 !== undefined) out.p50Ms = p50;
  if (loss !== undefined) out.loss = loss;
  if (ready) {
    const trigger = num(raw.trigger_p50_ms);
    const triggerLoss = num(raw.trigger_loss);
    if (trigger !== undefined && p50 !== undefined) out.triggerP50Ms = trigger;
    if (triggerLoss !== undefined && triggerLoss >= 1) out.lossNotJudged = true;
    else if (triggerLoss !== undefined) out.triggerLoss = triggerLoss;
  }
  return out;
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
  sent?: number;
  lost?: number;
  method?: string;
}

function finish(raw: RawPoint): SeriesPoint {
  const n = Math.max(0, raw.n || 0);
  const fail = Math.min(n, Math.max(0, raw.fail || 0));
  const expected = Math.max(0, raw.expected || 0);
  const sent = Math.max(0, Math.floor(raw.sent || 0));
  const lost = Math.min(sent, Math.max(0, Math.floor(raw.lost || 0)));
  const point: SeriesPoint = { t: raw.t, n, expected, fail, sent, lost, missing: n === 0 && expected > 0, method: raw.method };
  if (n > 0) {
    const share = sent > 0 ? lost / sent : raw.loss !== undefined ? raw.loss : fail / n;
    point.loss = Math.max(0, Math.min(1, share));
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
    sent: num(b.sent),
    lost: num(b.lost),
    method: b.method || undefined,
  }));
  const stepSec = response.step_seconds > 0 ? response.step_seconds : inferStep(raw);
  const points = fillSteps(raw, stepSec);
  const from = toSeconds(response.from);
  const to = toSeconds(response.to);
  const series: PathSeries = {
    stepSec,
    from: Number.isFinite(from) ? from : (points[0]?.t ?? 0),
    to: Number.isFinite(to) ? to : (points[points.length - 1]?.t ?? 0) + stepSec,
    points,
    methodChanges: (response.method_changes ?? [])
      .map((c) => ({ t: toSeconds(c.t), method: c.method }))
      .filter((c) => Number.isFinite(c.t) && !!c.method)
      .sort((a, b) => a.t - b.t),
  };
  if (response.baseline !== undefined) series.baseline = readBaseline(response.baseline);
  if (response.previous) {
    // Entry i belongs to the server's bucket i; a step the console filled in has no earlier value.
    const byT = new Map<number, number | null>();
    raw.forEach((point, i) => byT.set(point.t, num(response.previous!.p50_ms?.[i]) ?? null));
    series.previous = points.map((p) => byT.get(p.t) ?? null);
    series.previousOffsetSec = response.previous.offset_seconds > 0 ? response.previous.offset_seconds : undefined;
  }
  return series;
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

/**
 * Whether a point is the step in progress: the last step of a series, which
 * ends after the series' `to`. The server counts its runs as they arrive and
 * expects the runs certainly due so far, never fewer than it has heard, so a
 * step in progress that has heard nothing yet expects nothing yet.
 */
export function stepInProgress(series: Pick<PathSeries, "to" | "stepSec">, point: Pick<SeriesPoint, "t">): boolean {
  return series.stepSec > 0 && Number.isFinite(series.to) && point.t + series.stepSec > series.to;
}

/**
 * What the readout says of a step that heard no run: a gap ("noData") when
 * runs were due, "notYet" for the step in progress before its first run is
 * due, and "notExpected" for a step that expected none (a paused path).
 * Undefined for a step that heard a run.
 */
export function emptyStepNote(point: Pick<SeriesPoint, "n" | "missing">, inProgress: boolean): "noData" | "notYet" | "notExpected" | undefined {
  if (point.missing) return "noData";
  if (point.n > 0) return undefined;
  return inProgress ? "notYet" : "notExpected";
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
 * What else measured the window when the method switched inside it, so the
 * window's figures are not read as the current method's alone: the last
 * switch to the current method, the span before it, and the methods that
 * ran then. Undefined when one method measured the whole window, or the
 * series ends on another method.
 */
export function earlierMethods(series: PathSeries, current: string): { since: number; seconds: number; methods: string[] } | undefined {
  const inside = methodMarkers(series).filter((m) => m.t > series.from && m.t <= series.to);
  const last = inside[inside.length - 1];
  if (!last || last.to.toLowerCase() !== current.toLowerCase()) return undefined;
  const methods = [...new Set([inside[0]!.from, ...inside.slice(0, -1).map((m) => m.to)])].filter((m) => m !== last.to);
  return methods.length ? { since: last.t, seconds: last.t - series.from, methods } : undefined;
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
 * The dashed guides of the degraded rule (design 29 D13): the 7-day p50 and
 * the latency trigger, once the baseline is ready. None before it, and no
 * loss guide: the loss lane is per bucket and the trigger is over an hour.
 */
export function baselineGuides(baseline: SeriesBaseline | null | undefined): { kind: "median" | "trigger"; ms: number }[] {
  if (!baseline?.ready || baseline.p50Ms === undefined) return [];
  const out: { kind: "median" | "trigger"; ms: number }[] = [{ kind: "median", ms: baseline.p50Ms }];
  if (baseline.triggerP50Ms !== undefined) out.push({ kind: "trigger", ms: baseline.triggerP50Ms });
  return out;
}

export type GuideKind = "median" | "trigger";

/** A drawn line's pieces in pixels: x0, y0, x1, y1. A point with no drawn neighbour is a piece of no length. */
export type LinePiece = [number, number, number, number];

/** The pieces of a line drawn without spanning gaps: a null or undefined value breaks it, as the chart's line breaks. */
export function linePieces(values: readonly { x: number; y: number | null | undefined }[]): LinePiece[] {
  const out: LinePiece[] = [];
  let prev: { x: number; y: number } | undefined;
  for (const v of values) {
    if (v.y === null || v.y === undefined || !Number.isFinite(v.y)) {
      prev = undefined;
      continue;
    }
    out.push(prev ? [prev.x, prev.y, v.x, v.y] : [v.x, v.y, v.x, v.y]);
    prev = { x: v.x, y: v.y };
  }
  return out;
}

/**
 * Where the previous period's label goes. The guides are labelled on the
 * canvas, and so is the dotted previous line: once, at the start of the part
 * in view, so it names the line where the line begins. It sits above the
 * line, or below it when that crosses fewer of the drawn lines (`covered`)
 * or above would leave the latency lane; it never runs past the plot's
 * right edge. Undefined when no previous step is in view.
 */
export function placePreviousLabel(
  line: readonly { x: number; y: number | null | undefined }[],
  opts: { w: number; h: number; gap: number; left: number; right: number; laneTop: number; laneBottom: number; covered: (box: { x0: number; x1: number; y0: number; y1: number }) => number },
): { x: number; top: number } | undefined {
  const start = line.find((p) => p.y !== null && p.y !== undefined && Number.isFinite(p.y) && p.x >= opts.left && p.x <= opts.right);
  if (!start) return undefined;
  const y = start.y as number;
  const x = Math.max(opts.left + opts.gap, Math.min(start.x + opts.gap, opts.right - opts.w - opts.gap));
  const box = (top: number) => ({ x0: x, x1: x + opts.w, y0: top, y1: top + opts.h });
  const above = y - opts.gap - opts.h;
  const below = y + opts.gap;
  const fits = (top: number) => top >= opts.laneTop && top + opts.h <= opts.laneBottom;
  if (fits(above) && (!fits(below) || opts.covered(box(above)) <= opts.covered(box(below)))) return { x, top: above };
  if (fits(below)) return { x, top: below };
  return { x, top: Math.max(opts.laneTop, Math.min(above, opts.laneBottom - opts.h)) };
}

/** How many pieces cross a box: a steep drop through a label counts, not only the points that land in it. */
export function piecesCrossing(pieces: readonly LinePiece[], box: { x0: number; x1: number; y0: number; y1: number }): number {
  let n = 0;
  for (const [ax, ay, bx, by] of pieces) {
    if (Math.max(ax, bx) < box.x0 || Math.min(ax, bx) > box.x1) continue;
    if (Math.max(ay, by) < box.y0 || Math.min(ay, by) > box.y1) continue;
    n += 1;
  }
  return n;
}

export interface GuideLabelSlot {
  kind: GuideKind;
  /** The label box's top, in the same pixels as the lines. */
  top: number;
  /** Set when the label could not stack clear of the other one and sits beside it, to its left, on its own line's side. */
  beside: boolean;
}

/**
 * Where each guide's label sits (design 29 D13: labelled once at the right
 * edge). A label hugs its line, above or below, unless the data drawn there
 * (`covered`, which the chart counts from the lines it plots under the
 * label) would cross it; it then steps away from the line, at most
 * `maxOffset` pixels, to the nearest clear place. It stays nearer its own
 * line than the other one and never straddles the other line, never leaves
 * the latency lane ([laneTop, laneBottom]) and never overlaps the other
 * label. Scoring is the data it covers first, then its distance from the
 * line, then above before below. When no placement keeps the two labels
 * apart (lines a few pixels apart in a short lane), the median label moves
 * beside the trigger's, to its left.
 *
 * The chart also draws the labels beneath the series, so whatever data a
 * label cannot avoid still paints over it: a label never hides a bucket.
 */
export function placeGuideLabels(
  lines: readonly { kind: GuideKind; y: number }[],
  opts: { h: number; gap: number; laneTop: number; laneBottom: number; maxOffset?: number; covered: (kind: GuideKind, top: number, bottom: number) => number },
): GuideLabelSlot[] {
  const { h, gap, laneTop, laneBottom, covered } = opts;
  const maxOffset = Math.max(0, Math.floor(opts.maxOffset ?? 2 * h));
  type Option = { top: number; score: number };
  const options = (line: { kind: GuideKind; y: number }, other: { y: number } | undefined): Option[] => {
    const out: Option[] = [];
    for (let d = 0; d <= maxOffset; d++) {
      for (const below of [false, true]) {
        const top = below ? line.y + gap + d : line.y - gap - h - d;
        if (top < laneTop || top + h > laneBottom) continue;
        if (other) {
          const centre = top + h / 2;
          if (other.y >= top && other.y <= top + h) continue;
          if (Math.abs(centre - other.y) <= Math.abs(centre - line.y)) continue;
        }
        out.push({ top, score: covered(line.kind, top, top + h) * 10_000 + d * 2 + (below ? 1 : 0) });
      }
    }
    return out;
  };
  const clamp = (top: number) => Math.min(Math.max(top, laneTop), Math.max(laneTop, laneBottom - h));
  const best = (line: { kind: GuideKind; y: number }, other?: { y: number }) => {
    const opts = options(line, other);
    if (!opts.length) return clamp(line.y - gap - h);
    return opts.reduce((a, b) => (b.score < a.score ? b : a)).top;
  };
  if (lines.length < 2) return lines.map((line) => ({ kind: line.kind, top: best(line), beside: false }));
  const [a, b] = lines as [{ kind: GuideKind; y: number }, { kind: GuideKind; y: number }];
  let pick: { a: number; b: number; s: number } | undefined;
  const optsB = options(b, a);
  for (const oa of options(a, b)) {
    for (const ob of optsB) {
      if (Math.abs(oa.top - ob.top) < h) continue;
      const s = oa.score + ob.score;
      if (!pick || s < pick.s) pick = { a: oa.top, b: ob.top, s };
    }
  }
  if (pick) return [
    { kind: a.kind, top: pick.a, beside: false },
    { kind: b.kind, top: pick.b, beside: false },
  ];
  // No placement keeps them apart: each takes its own best place and the median steps aside.
  return [a, b].map((line) => ({ kind: line.kind, top: best(line), beside: line.kind === "median" }));
}

/**
 * The latency the chart's scale must cover: the series, its guides (so the
 * trigger is always on the chart) and the previous period when it is drawn.
 */
export function chartCeilingMs(series: Pick<PathSeries, "points" | "baseline" | "previous">, withPrevious = false): number {
  let max = seriesCeilingMs(series.points);
  for (const guide of baselineGuides(series.baseline)) max = Math.max(max, guide.ms);
  if (withPrevious) for (const v of series.previous ?? []) if (v !== null && v > max) max = v;
  return max;
}

/** Hours of history a not-yet-judged path has, for "Degraded is judged once this path has 24 hours of history (14 h so far)"; undefined when it is judged or never will be. */
export function baselinePending(baseline: SeriesBaseline | null | undefined): { hours: number; needed: number } | undefined {
  if (!baseline || baseline.ready) return undefined;
  return { hours: baseline.hours, needed: BASELINE_MIN_HOURS };
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
 * no window figures. Runs, failures, loss (over probes) and availability are exact; p50,
 * p95 and jitter are weighted by successful runs, which is close to but not
 * the server's histogram percentile.
 */
export function seriesStats(points: readonly SeriesPoint[]): SeriesStats {
  let samples = 0;
  let expected = 0;
  let fail = 0;
  // Probes, as the server counts loss: echoes where a bucket has them, else runs.
  let probes = 0;
  let lostProbes = 0;
  const p50: { value: number; weight: number }[] = [];
  const p95: { value: number; weight: number }[] = [];
  let jitterSum = 0;
  let jitterWeight = 0;
  for (const p of points) {
    samples += p.n;
    expected += p.expected;
    fail += p.fail;
    if (p.sent > 0) {
      probes += p.sent;
      lostProbes += p.lost;
    } else {
      probes += p.n;
      lostProbes += p.fail;
    }
    const ok = p.n - p.fail;
    if (p.p50Ms !== undefined && ok > 0) p50.push({ value: p.p50Ms, weight: ok });
    if (p.p95Ms !== undefined && ok > 0) p95.push({ value: p.p95Ms, weight: ok });
    if (p.jitterMs !== undefined && ok > 0) {
      jitterSum += p.jitterMs * ok;
      jitterWeight += ok;
    }
  }
  const stats: SeriesStats = { samples, expected };
  if (probes > 0) stats.loss = lostProbes / probes;
  if (expected > 0) stats.availability = Math.max(0, Math.min(1, (samples - fail) / expected));
  stats.p50Ms = weightedQuantile(p50, 0.5);
  stats.p95Ms = weightedQuantile(p95, 0.95);
  if (jitterWeight > 0) stats.jitterMs = jitterSum / jitterWeight;
  return stats;
}
