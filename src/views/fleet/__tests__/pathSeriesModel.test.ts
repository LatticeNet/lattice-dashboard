import assert from "node:assert/strict";
import { test } from "node:test";

import type { PathSeriesResponse } from "@/lib/api/types";

import {
  BASELINE_MIN_HOURS,
  baselineGuides,
  baselinePending,
  aboveScale,
  chartCeilingMs,
  readBaseline,
  ruleView,
  LATENCY_LANE_START,
  LOSS_LANE,
  bucketIndexAt,
  chartColumns,
  emptyStepNote,
  expectedStepSeconds,
  fillSteps,
  gapRuns,
  inferStep,
  laneLayout,
  methodAt,
  earlierMethods,
  linePieces,
  methodMarkers,
  piecesCrossing,
  placeGuideLabels,
  placePreviousLabel,
  seriesCeilingMs,
  seriesFromLatency,
  seriesFromResponse,
  seriesStats,
  stepInProgress,
  stepIndex,
  toSeconds,
  visibleRange,
  seriesFromResponse as fromResponse,
  seriesStats as statsOf,
} from "../pathSeriesModel.ts";

test("steps: the server's rule at a 60 s interval and 7 days of fine history", () => {
  assert.equal(expectedStepSeconds("1h"), 60);
  assert.equal(expectedStepSeconds("6h"), 300);
  assert.equal(expectedStepSeconds("24h"), 300);
  assert.equal(expectedStepSeconds("3d"), 600);
  assert.equal(expectedStepSeconds("7d"), 900);
  // 14 days is past 7 days of fine history: coarse hours.
  assert.equal(expectedStepSeconds("14d"), 3600);
  assert.equal(expectedStepSeconds("14d", 60, 14), 1800);
});

test("steps: raw rows fold at a minute, and a step is never shorter than the interval", () => {
  assert.equal(expectedStepSeconds("1h", 5), 60, "raw rows are folded at one minute");
  assert.equal(expectedStepSeconds("1h", 300), 300, "a five-minute check expects a run in every step");
  assert.equal(expectedStepSeconds("6h", 30), 300);
  assert.equal(expectedStepSeconds("6h", 600), 600);
  assert.equal(expectedStepSeconds("24h", 3600), 3600, "an hourly certificate check");
  for (const w of ["1h", "6h", "24h", "3d", "7d", "14d"] as const) {
    const step = expectedStepSeconds(w, 60, 14);
    const span = { "1h": 3600, "6h": 21600, "24h": 86400, "3d": 259200, "7d": 604800, "14d": 1209600 }[w];
    assert.ok(span / step <= 720, `${w} stays within 720 points`);
  }
});

test("time: seconds, milliseconds, numeric strings and ISO all read as unix seconds", () => {
  assert.equal(toSeconds(1_700_000_000), 1_700_000_000);
  assert.equal(toSeconds(1_700_000_000_123), 1_700_000_000);
  assert.equal(toSeconds("1700000000"), 1_700_000_000);
  assert.equal(toSeconds("2026-10-16T08:00:00Z"), Date.parse("2026-10-16T08:00:00Z") / 1000);
  assert.ok(Number.isNaN(toSeconds("not a time")));
  assert.ok(Number.isNaN(toSeconds(undefined)));
});

function response(over: Partial<PathSeriesResponse> = {}): PathSeriesResponse {
  const t0 = 1_760_000_000;
  return {
    window: "24h",
    step_seconds: 300,
    from: t0,
    to: t0 + 6 * 300,
    method_changes: [],
    buckets: [
      { t: t0, n: 5, expected: 5, fail: 0, min_ms: 30, p50_ms: 34, p95_ms: 41, max_ms: 52, jitter_ms: 2 },
      { t: t0 + 300, n: 0, expected: 5, fail: 0 },
      { t: t0 + 600, n: 5, expected: 5, fail: 5 },
      // t0 + 900 is skipped by the server
      { t: t0 + 1200, n: 4, expected: 5, fail: 1, p50_ms: 60, p95_ms: 90, jitter_ms: 8 },
      { t: t0 + 1500, n: 0, expected: 0, fail: 0 },
    ],
    ...over,
  };
}

test("gaps: no data is null in every lane, a skipped step is filled as a gap, a paused bucket is blank", () => {
  const s = seriesFromResponse(response());
  assert.equal(s.points.length, 6);
  assert.deepEqual(s.points.map((p) => p.missing), [false, true, false, true, false, false]);
  const [xs, floor, p50, p95, loss] = chartColumns(s.points);
  assert.equal(xs.length, 6);
  assert.deepEqual(p50, [34, null, null, null, 60, null]);
  assert.deepEqual(floor, [30, null, null, null, 60, null], "min, else p50");
  assert.deepEqual(p95, [41, null, null, null, 90, null]);
  // Every run failed: a full loss bar and no latency. A paused bucket draws nothing.
  assert.deepEqual(loss, [null, null, 1, null, 0.25, null]);
  assert.deepEqual(gapRuns(s), [
    { from: 1_760_000_300, to: 1_760_000_600, buckets: 1 },
    { from: 1_760_000_900, to: 1_760_001_200, buckets: 1 },
  ]);
});

test("gaps: neighbouring missing buckets make one run", () => {
  const t0 = 1000;
  const points = fillSteps(
    [
      { t: t0, n: 1, expected: 1, fail: 0, p50Ms: 10 },
      { t: t0 + 60, n: 0, expected: 1, fail: 0 },
      { t: t0 + 120, n: 0, expected: 1, fail: 0 },
      { t: t0 + 300, n: 1, expected: 1, fail: 0, p50Ms: 12 },
    ],
    60,
  );
  assert.equal(points.length, 6);
  assert.deepEqual(gapRuns({ points, stepSec: 60 }), [{ from: t0 + 60, to: t0 + 300, buckets: 4 }]);
});

test("series without a stated step infer it from the buckets", () => {
  assert.equal(inferStep([{ t: 0 }, { t: 60 }, { t: 120 }, { t: 300 }]), 60);
  assert.equal(inferStep([]), 60);
  const s = seriesFromResponse(response({ step_seconds: 0 }));
  assert.equal(s.stepSec, 300);
});

test("legacy series: samples and failures become runs, no min or jitter", () => {
  const s = seriesFromLatency({
    source: "sh",
    target: "jp",
    monitor_id: "mon_lat_jp",
    window: "24h",
    bucket_sec: 300,
    from: "2026-10-16T00:00:00Z",
    to: "2026-10-16T00:15:00Z",
    buckets: [
      { at: "2026-10-16T00:00:00Z", samples: 5, failures: 1, expected: 5, p50_ms: 40, p95_ms: 50, loss: 0.2 },
      { at: "2026-10-16T00:05:00Z", samples: 0, failures: 0, expected: 5 },
      { at: "2026-10-16T00:10:00Z", samples: 5, failures: 0, expected: 5, p50_ms: 42, p95_ms: 48, loss: 0 },
    ],
  });
  assert.equal(s.stepSec, 300);
  assert.deepEqual(s.points.map((p) => [p.n, p.fail, p.p50Ms ?? null, p.minMs ?? null, p.missing]), [
    [5, 1, 40, null, false],
    [0, 0, null, null, true],
    [5, 0, 42, null, false],
  ]);
});

test("method changes: the server's list starts with the method in force, and only later entries are switches", () => {
  const t0 = 1_760_000_000;
  const plain = seriesFromResponse(response({ method_changes: [{ t: t0, method: "tcp" }] }));
  assert.deepEqual(methodMarkers(plain), [], "the first entry is the starting method, not a switch");
  assert.equal(methodAt(plain, t0 + 600, "icmp"), "tcp");
  const listed = seriesFromResponse(response({ method_changes: [{ t: t0, method: "tcp" }, { t: t0 + 600, method: "beacon" }] }));
  assert.deepEqual(methodMarkers(listed), [{ t: t0 + 600, from: "tcp", to: "beacon" }]);
  assert.equal(methodAt(listed, t0 + 1200, "beacon"), "beacon");
  assert.equal(methodAt(listed, t0 + 300, "beacon"), "tcp");
  assert.equal(methodAt(listed, t0 - 300, "beacon"), "tcp", "before any data the first method ran");
  const fromBuckets = seriesFromResponse(
    response({
      method_changes: [],
      buckets: [
        { t: t0, n: 1, expected: 1, fail: 0, p50_ms: 10, method: "tcp" },
        { t: t0 + 300, n: 1, expected: 1, fail: 0, p50_ms: 10, method: "tcp" },
        { t: t0 + 600, n: 1, expected: 1, fail: 0, p50_ms: 9, method: "icmp" },
      ],
    }),
  );
  assert.deepEqual(methodMarkers(fromBuckets), [{ t: t0 + 600, from: "tcp", to: "icmp" }]);
  assert.equal(methodAt(fromBuckets, t0, "icmp"), "tcp");
  const none = seriesFromResponse(response({ method_changes: [] }));
  assert.equal(methodAt(none, t0, "tcp"), "tcp", "a series that names no method reads the path's");
});

test("Auto's switch back is a switch too: ICMP filtered falls back to TCP, and ICMP is tried again after 24 hours", () => {
  const t0 = 1_760_000_000;
  const day = 86_400;
  const series = seriesFromResponse(
    response({
      method_changes: [
        { t: t0, method: "icmp" },
        { t: t0 + 3600, method: "tcp" },
        { t: t0 + 3600 + day, method: "icmp" },
        { t: t0 + 3600 + day + 1800, method: "tcp" },
      ],
    }),
  );
  assert.deepEqual(methodMarkers(series), [
    { t: t0 + 3600, from: "icmp", to: "tcp" },
    { t: t0 + 3600 + day, from: "tcp", to: "icmp" },
    { t: t0 + 3600 + day + 1800, from: "icmp", to: "tcp" },
  ]);
  assert.equal(methodAt(series, t0 + 3600 + day + 600, "tcp"), "icmp", "the retry window reads ICMP");
});

test("lanes: 0 ms sits above the loss lane and 100% loss reaches the lane's top", () => {
  const lanes = laneLayout(168);
  assert.equal(lanes.msMax, 200);
  const span = lanes.msMax - lanes.msMin;
  assert.ok(Math.abs((0 - lanes.msMin) / span - LATENCY_LANE_START) < 1e-9);
  assert.ok(Math.abs((lanes.lossTicks[1]!.ms - lanes.msMin) / span - LOSS_LANE) < 1e-9);
  assert.equal(1 / lanes.lossMax, LOSS_LANE);
  assert.deepEqual(lanes.msTicks, [0, 100, 200]);
  assert.ok(lanes.divider < 0 && lanes.divider > lanes.lossTicks[1]!.ms);
  assert.equal(laneLayout(0).msMax, 50);
  assert.equal(laneLayout(1430).msMax, 2000);
  assert.equal(seriesCeilingMs(seriesFromResponse(response()).points), 90);
  assert.equal(seriesCeilingMs(seriesFromResponse(response()).points, true), 90);
});

test("crosshair: the bucket under a time, and keys that step within the visible range", () => {
  const s = seriesFromResponse(response());
  const t0 = 1_760_000_000;
  assert.equal(bucketIndexAt(s.points, t0 + 10, 300), 0);
  assert.equal(bucketIndexAt(s.points, t0 + 610, 300), 2);
  assert.equal(bucketIndexAt(s.points, t0 - 100, 300), 0);
  assert.equal(bucketIndexAt(s.points, t0 + 99_999, 300), 5);
  assert.equal(bucketIndexAt([], t0, 300), -1);
  const range = visibleRange(s.points, t0 + 300, t0 + 1200);
  assert.deepEqual(range, { first: 1, last: 4 });
  assert.equal(stepIndex(2, "ArrowLeft", range), 1);
  assert.equal(stepIndex(1, "ArrowLeft", range), 1);
  assert.equal(stepIndex(4, "ArrowRight", range), 4);
  assert.equal(stepIndex(2, "Home", range), 1);
  assert.equal(stepIndex(2, "End", range), 4);
  assert.equal(stepIndex(-1, "ArrowRight", range), 1, "no cursor yet: the first key lands at the start");
  assert.equal(stepIndex(-1, "ArrowLeft", range), 4, "or at the end, going back");
  assert.equal(stepIndex(2, "Enter", range), 2);
  assert.equal(stepIndex(0, "ArrowLeft", { first: -1, last: -1 }), -1);
});

test("aggregates: runs, loss and availability exact; percentiles weighted by successful runs", () => {
  const s = seriesFromResponse(response());
  const stats = seriesStats(s.points);
  assert.equal(stats.samples, 14);
  assert.equal(stats.expected, 25);
  assert.equal(stats.loss, 6 / 14);
  assert.equal(stats.availability, 8 / 25);
  assert.equal(stats.p50Ms, 34);
  assert.equal(stats.p95Ms, 90);
  assert.equal(stats.jitterMs, (2 * 5 + 8 * 3) / 8);
  assert.deepEqual(seriesStats([]), { samples: 0, expected: 0, p50Ms: undefined, p95Ms: undefined });
});

test("loss counts probes: lost over sent where a bucket has them, failed runs over runs before M2a", () => {
  const response: PathSeriesResponse = {
    window: "1h",
    step_seconds: 300,
    from: 0,
    to: 900,
    buckets: [
      // Before M2a: one run failed of five.
      { t: 0, n: 5, expected: 5, fail: 1, p50_ms: 70 },
      // An ICMP bucket: five runs of five echoes, three echoes lost, no run failed.
      { t: 300, n: 5, expected: 5, fail: 0, sent: 25, lost: 3, p50_ms: 71 },
      // A tcp bucket written by M2a: sent counts one per run.
      { t: 600, n: 5, expected: 5, fail: 0, sent: 5, lost: 0, p50_ms: 69 },
    ],
  };
  const s = fromResponse(response);
  assert.deepEqual(s.points.map((p) => p.loss), [0.2, 3 / 25, 0]);
  assert.deepEqual(s.points.map((p) => [p.sent, p.lost]), [[0, 0], [25, 3], [5, 0]]);
  const stats = statsOf(s.points);
  // Probes: 5 runs, 25 echoes, 5 runs; lost: 1 run, 3 echoes, 0.
  assert.equal(stats.loss, 4 / 35);
  assert.equal(stats.availability, 14 / 15, "availability stays successful runs over expected runs");
});

test("a window that switched methods says what else measured it, so its figures are not read as the current method's", () => {
  const t0 = 1_760_000_000;
  const day = 86_400;
  const base = (changes: { t: number; method: string }[]) => ({ ...seriesFromResponse(response({ method_changes: changes })), from: t0, to: t0 + 7 * day });
  const switched = base([
    { t: t0 - day, method: "tcp" },
    { t: t0 + 5 * day, method: "beacon" },
  ]);
  assert.deepEqual(earlierMethods(switched, "beacon"), { since: t0 + 5 * day, seconds: 5 * day, methods: ["tcp"] });
  assert.equal(earlierMethods(switched, "tcp"), undefined, "the series does not end on that method");
  assert.equal(earlierMethods(base([{ t: t0 - day, method: "beacon" }]), "beacon"), undefined, "one method measured the whole window");
  // Auto's 24 hour retry: ICMP, then TCP, then ICMP again; the window reads ICMP now and TCP measured part of it.
  const retried = base([
    { t: t0, method: "icmp" },
    { t: t0 + day, method: "tcp" },
    { t: t0 + 2 * day, method: "icmp" },
  ]);
  assert.deepEqual(earlierMethods(retried, "ICMP"), { since: t0 + 2 * day, seconds: 2 * day, methods: ["tcp"] });
});

/* ---- Design 29 M3 (contract D13): the baseline and the previous period ---- */

function m3Series(over: Partial<PathSeriesResponse> = {}): PathSeriesResponse {
  const t0 = 1_760_600_000 - (1_760_600_000 % 300);
  return {
    window: "24h",
    step_seconds: 300,
    from: t0,
    to: t0 + 4 * 300,
    buckets: [0, 1, 3].map((i) => ({ t: t0 + i * 300, n: 5, expected: 5, fail: 0, p50_ms: 60 + i, p95_ms: 70 + i })),
    baseline: {
      from: "2026-10-09T08:00:00Z",
      to: "2026-10-16T08:00:00Z",
      hours: 168,
      ready: true,
      p50_ms: 64,
      loss: 0.004,
      trigger_p50_ms: 128,
      trigger_loss: 0.02,
      rule: { loss_percent: 2, loss_factor: 2, latency_factor: 2, latency_margin_ms: 30 },
    },
    previous: { from: t0 - 86400, to: t0 - 86400 + 1200, offset_seconds: 86400, step_seconds: 300, p50_ms: [58, null, 61] },
    ...over,
  };
}

test("baseline: read with its triggers and the rule in force; the guides are the 7-day p50 and the latency trigger", () => {
  const s = seriesFromResponse(m3Series());
  assert.equal(s.baseline!.ready, true);
  assert.equal(s.baseline!.hours, 168);
  assert.equal(s.baseline!.p50Ms, 64);
  assert.equal(s.baseline!.triggerP50Ms, 128);
  assert.equal(s.baseline!.triggerLoss, 0.02);
  assert.deepEqual(s.baseline!.rule, { lossPercent: 2, lossFactor: 2, latencyFactor: 2, latencyMarginMs: 30 });
  assert.deepEqual(baselineGuides(s.baseline), [
    { kind: "median", ms: 64 },
    { kind: "trigger", ms: 128 },
  ]);
  assert.equal(baselinePending(s.baseline), undefined);
});

test("baseline: the ceiling covers the trigger, so the guide is always on the chart", () => {
  const s = seriesFromResponse(m3Series());
  assert.equal(seriesCeilingMs(s.points), 73, "the series alone tops out at its p95");
  assert.equal(chartCeilingMs(s), 128);
  const tall = seriesFromResponse(m3Series({ buckets: [{ t: 1_760_599_800, n: 5, expected: 5, fail: 0, p50_ms: 300, p95_ms: 400 }] }));
  assert.equal(chartCeilingMs(tall), 400, "a series above its trigger keeps its own ceiling");
});

test("ceiling: one stalled bucket does not flatten the rest; the scale stops at the typical range and never below the trigger", () => {
  const t0 = 1_760_600_000 - (1_760_600_000 % 60);
  // An hour of one-minute buckets near 39 ms, one of which stalled for a second.
  const buckets = Array.from({ length: 60 }, (_, i) => ({ t: t0 + i * 60, n: 1, expected: 1, fail: 0, p50_ms: 39 + (i % 3), p95_ms: 40 + (i % 3) }));
  buckets[40] = { ...buckets[40]!, p50_ms: 1012, p95_ms: 1046 };
  const plain = { window: "1h" as const, step_seconds: 60, from: t0, to: t0 + 3600, buckets };
  const spiky = seriesFromResponse(plain);
  assert.equal(chartCeilingMs(spiky), 42, "the 95th percentile bucket sets the scale, not the stall");
  assert.deepEqual(aboveScale(spiky.points, laneLayout(chartCeilingMs(spiky)).msMax), [40], "and the stalled bucket is the one marked");

  const judged = seriesFromResponse({ ...m3Series(), ...plain });
  assert.equal(chartCeilingMs(judged), 128, "never below the degraded trigger");
  assert.deepEqual(aboveScale(judged.points, laneLayout(chartCeilingMs(judged)).msMax), [40]);

  // A high bucket within twice the typical range is data, not a stall: nothing is clipped.
  buckets[40] = { ...buckets[40]!, p50_ms: 70, p95_ms: 80 };
  const busy = seriesFromResponse(plain);
  assert.equal(chartCeilingMs(busy), 80);
  assert.deepEqual(aboveScale(busy.points, laneLayout(chartCeilingMs(busy)).msMax), []);

  // A stall in the drawn previous period is clipped and marked like one in the series.
  const compared = seriesFromResponse(plain);
  const previous = compared.points.map((_, i) => (i === 12 ? 980 : 38));
  const withPrevious = chartCeilingMs({ ...compared, previous }, true);
  assert.equal(withPrevious, 80, "the busy bucket is data and stays on the scale; the previous stall does not");
  assert.deepEqual(aboveScale(compared.points, laneLayout(withPrevious).msMax, previous), [12]);

  // Under twenty buckets the 95th percentile is the highest one, so a short series is never clipped.
  const short = seriesFromResponse({ ...plain, buckets: [buckets[0]!, { ...buckets[1]!, p95_ms: 1046 }] });
  assert.equal(chartCeilingMs(short), 1046);
});

test("baseline: not ready under 24 hours, with no trigger and a note of how far it is", () => {
  const raw = m3Series().baseline!;
  const s = seriesFromResponse(m3Series({ baseline: { ...raw, hours: 14, ready: false, trigger_p50_ms: null, trigger_loss: null } }));
  assert.equal(s.baseline!.ready, false);
  assert.equal(s.baseline!.triggerP50Ms, undefined);
  assert.deepEqual(baselineGuides(s.baseline), [], "no guide before the path is judged");
  assert.deepEqual(baselinePending(s.baseline), { hours: 14, needed: BASELINE_MIN_HOURS });
  assert.equal(readBaseline({ ...raw, hours: 23, ready: true })!.ready, false, "23 hourly buckets are not a baseline whatever the flag says");
  assert.equal(readBaseline({ ...raw, hours: 24, ready: true })!.ready, true);
  // Triggers sent with a baseline that is not ready are not kept: a path not judged has nothing to be above.
  const early = readBaseline({ ...raw, hours: 30, ready: false, trigger_p50_ms: 128, trigger_loss: 0.02 })!;
  assert.deepEqual([early.triggerP50Ms, early.triggerLoss], [undefined, undefined], "the server's flag says not ready");
  const short = readBaseline({ ...raw, hours: 23, ready: true, trigger_p50_ms: 128, trigger_loss: 0.02 })!;
  assert.deepEqual([short.triggerP50Ms, short.triggerLoss], [undefined, undefined], "23 hours is not ready");
  assert.deepEqual(baselineGuides(early), []);
});

test("baseline: a loss trigger of 100% or more means the loss arm cannot fire, never a threshold of 200%", () => {
  const raw = m3Series().baseline!;
  // An always-down path: 7-day loss 100%, the server's trigger 2 x 100% = 200%.
  const down = readBaseline({ ...raw, loss: 1, trigger_loss: 2 })!;
  assert.equal(down.triggerLoss, undefined);
  assert.equal(down.lossNotJudged, true);
  assert.equal(down.loss, 1, "the 7-day loss is still read");
  // Half the runs lost: the trigger is exactly 100%, and no hour's loss is above it either.
  assert.equal(readBaseline({ ...raw, loss: 0.5, trigger_loss: 1 })!.lossNotJudged, true);
  // Below 100% the trigger stands.
  const lossy = readBaseline({ ...raw, loss: 0.49, trigger_loss: 0.98 })!;
  assert.equal(lossy.triggerLoss, 0.98);
  assert.equal(lossy.lossNotJudged, undefined);
  // Not ready: nothing to judge, so nothing said either way.
  assert.equal(readBaseline({ ...raw, hours: 10, ready: false, loss: 1, trigger_loss: 2 })!.lossNotJudged, undefined);
});

test("baseline: null for a path that is never judged, undefined from a server before M3", () => {
  assert.equal(seriesFromResponse(m3Series({ baseline: null })).baseline, null);
  const older = m3Series();
  delete older.baseline;
  assert.equal(seriesFromResponse(older).baseline, undefined);
  assert.equal(baselinePending(null), undefined);
  assert.deepEqual(baselineGuides(null), []);
});

test("baseline: a latency trigger needs a 7-day p50; a rule fills its defaults", () => {
  const raw = m3Series().baseline!;
  const s = readBaseline({ ...raw, p50_ms: null, trigger_p50_ms: 128 })!;
  assert.equal(s.triggerP50Ms, undefined);
  assert.deepEqual(baselineGuides(s), []);
  assert.deepEqual(ruleView({ loss_percent: 5, latency_margin_ms: 0 }), { lossPercent: 5, lossFactor: 2, latencyFactor: 2, latencyMarginMs: 30 });
  assert.deepEqual(ruleView(null), { lossPercent: 2, lossFactor: 2, latencyFactor: 2, latencyMarginMs: 30 });
});

test("previous: one entry per point, aligned by bucket; a step the console filled and a step with no run are null", () => {
  const s = seriesFromResponse(m3Series());
  assert.equal(s.points.length, 4, "the hole at bucket 2 is filled");
  assert.deepEqual(s.previous, [58, null, null, 61]);
  assert.equal(s.previousOffsetSec, 86400);
  assert.equal(chartCeilingMs({ ...s, previous: [58, null, null, 200] }, true), 200, "a drawn overlay is covered too");
  assert.equal(chartCeilingMs({ ...s, previous: [58, null, null, 200] }, false), 128);
  const plain = m3Series();
  delete plain.previous;
  assert.equal(seriesFromResponse(plain).previous, undefined, "not asked, not there");
});

test("guide labels: above their line by default, below when the data runs there, never over each other", () => {
  const lane = { h: 13, gap: 1, laneTop: 0, laneBottom: 200 };
  const none = () => 0;
  // Far apart, nothing under them: both above their lines.
  assert.deepEqual(placeGuideLabels([{ kind: "median", y: 150 }, { kind: "trigger", y: 60 }], { ...lane, covered: none }), [
    { kind: "median", top: 136, beside: false },
    { kind: "trigger", top: 46, beside: false },
  ]);
  // The newest p50 runs just above the trigger (a degraded path): its label goes below the line, clear of the data.
  const overTrigger = (kind: string, top: number, bottom: number) => (kind === "trigger" && top < 60 && bottom > 40 ? 5 : 0);
  assert.deepEqual(placeGuideLabels([{ kind: "median", y: 150 }, { kind: "trigger", y: 60 }], { ...lane, covered: overTrigger })[1], { kind: "trigger", top: 61, beside: false });
  // A line along the top of the lane: its label cannot go above, so it goes below.
  assert.deepEqual(placeGuideLabels([{ kind: "trigger", y: 5 }], { ...lane, covered: none }), [{ kind: "trigger", top: 6, beside: false }]);
  // Lines 8 px apart: stacked so the boxes do not overlap (trigger above its line, median below its own).
  const close = placeGuideLabels([{ kind: "median", y: 108 }, { kind: "trigger", y: 100 }], { ...lane, covered: none });
  assert.ok(Math.abs(close[0]!.top - close[1]!.top) >= 13, "the boxes do not overlap");
  assert.deepEqual(close, [
    { kind: "median", top: 109, beside: false },
    { kind: "trigger", top: 86, beside: false },
  ]);
  // A lane too short to stack them: the median steps beside the trigger's label.
  const short = placeGuideLabels([{ kind: "median", y: 20 }, { kind: "trigger", y: 14 }], { h: 13, gap: 1, laneTop: 0, laneBottom: 30, covered: none });
  assert.deepEqual(short.map((s) => [s.kind, s.beside]), [["median", true], ["trigger", false]]);
  for (const s of short) assert.ok(s.top >= 0 && s.top + 13 <= 30, "inside the lane");
  assert.deepEqual(placeGuideLabels([], { ...lane, covered: none }), []);
});

test("guide labels: data on both sides of a line moves its label to the nearest clear place, still nearer its own line", () => {
  const lane = { h: 13, gap: 1, laneTop: 0, laneBottom: 200 };
  // A week of p50 and the previous period run in a band from 136 to 165 px around the median line at 150.
  const band = (kind: string, top: number, bottom: number) => (kind === "median" && top <= 165 && bottom >= 136 ? 5 : 0);
  const [median, trigger] = placeGuideLabels([{ kind: "median", y: 150 }, { kind: "trigger", y: 60 }], { ...lane, covered: band });
  assert.deepEqual(median, { kind: "median", top: 122, beside: false }, "14 px above the line clears the band; below would need 15");
  assert.deepEqual(trigger, { kind: "trigger", top: 46, beside: false });
  // Never as far as the other line: with the trigger 30 px above, the label cannot climb out of the band, so it stays on its line.
  const near = placeGuideLabels([{ kind: "median", y: 150 }, { kind: "trigger", y: 120 }], { ...lane, laneBottom: 170, covered: band });
  const m = near.find((s) => s.kind === "median")!;
  assert.ok(Math.abs(m.top + 6.5 - 150) < Math.abs(m.top + 6.5 - 120), "nearer its own line than the trigger's");
  assert.ok(!(120 >= m.top && 120 <= m.top + 13), "never across the trigger line");
  // Within maxOffset only: a band wider than the reach leaves the label beside its line, under the data.
  const wide = (kind: string, top: number, bottom: number) => (kind === "median" && top <= 199 && bottom >= 90 ? 5 : 0);
  assert.deepEqual(placeGuideLabels([{ kind: "median", y: 150 }], { ...lane, covered: wide }), [{ kind: "median", top: 136, beside: false }]);
});

test("line pieces: gaps break the line; a steep drop crosses a box its points miss", () => {
  const pieces = linePieces([
    { x: 0, y: 10 },
    { x: 10, y: 12 },
    { x: 20, y: null },
    { x: 30, y: 50 },
    { x: 40, y: 150 },
  ]);
  assert.deepEqual(pieces, [
    [0, 10, 0, 10],
    [0, 10, 10, 12],
    [30, 50, 30, 50],
    [30, 50, 40, 150],
  ], "the null at x 20 leaves x 10 and x 30 unjoined");
  // A label from y 90 to 103 between x 32 and 38: neither point lands in it, the drop from 50 to 150 crosses it.
  assert.equal(piecesCrossing(pieces, { x0: 32, x1: 38, y0: 90, y1: 103 }), 1);
  assert.equal(piecesCrossing(pieces, { x0: 12, x1: 28, y0: 0, y1: 200 }), 0, "nothing is drawn across the gap");
  assert.equal(piecesCrossing(pieces, { x0: 0, x1: 10, y0: 20, y1: 40 }), 0);
});

test("the step in progress: the last step, which ends after now, says its runs so far and is never read as a pause", () => {
  // An hour at a minute as the server lays it out: 60 steps, the last holding now (09:47:20), 20 s in, no run yet.
  const to = 1789375640;
  const from = Math.floor(to / 60) * 60 - 59 * 60;
  const buckets = Array.from({ length: 60 }, (_, i) => ({ t: from + i * 60, n: i === 59 ? 0 : 1, expected: i === 59 ? 0 : 1, fail: 0, p50_ms: 40 }));
  const s = seriesFromResponse({ window: "1h", step_seconds: 60, from, to, buckets });
  assert.equal(s.points.length, 60);
  assert.deepEqual(
    s.points.map((p) => stepInProgress(s, p)).flatMap((live, i) => (live ? [i] : [])),
    [59],
    "only the newest step is in progress",
  );
  const live = s.points[59]!;
  assert.equal(live.missing, false, "a step that has not reached its first run is not a gap");
  assert.equal(emptyStepNote(live, true), "notYet");
  // The same empty step anywhere else expected nothing: a pause.
  assert.equal(emptyStepNote({ n: 0, missing: false }, false), "notExpected");
  assert.equal(emptyStepNote({ n: 0, missing: true }, true), "noData", "a whole interval passed with no run: a gap, in progress or not");
  assert.equal(emptyStepNote({ n: 1, missing: false }, true), undefined);
  // A series that ends on a step boundary has no step in progress; a step of 0 never is.
  assert.equal(stepInProgress({ to: from + 60 * 60, stepSec: 60 }, { t: from + 59 * 60 }), false);
  assert.equal(stepInProgress({ to, stepSec: 0 }, { t: to }), false);
  assert.equal(stepInProgress({ to: NaN, stepSec: 60 }, { t: to }), false);
});

test("the previous period's label: once, where its line begins in view, on the side the p50 crosses less, inside the lane", () => {
  const opts = { w: 80, h: 13, gap: 3, left: 60, right: 460, laneTop: 10, laneBottom: 180, covered: () => 0 };
  // The line starts at its first step with a value inside the plot; the steps before it had no run.
  const line = [{ x: 40, y: 100 }, { x: 70, y: null }, { x: 100, y: 120 }, { x: 130, y: 118 }];
  assert.deepEqual(placePreviousLabel(line, opts), { x: 103, top: 104 }, "above the line by the gap, left aligned at its start");
  // Above crosses the drawn p50, below does not: below.
  const crossed = (box: { y0: number }) => (box.y0 < 120 ? 2 : 0);
  assert.deepEqual(placePreviousLabel(line, { ...opts, covered: crossed }), { x: 103, top: 123 });
  // Near the lane's top there is no room above; near the bottom none below.
  assert.deepEqual(placePreviousLabel([{ x: 100, y: 20 }], opts), { x: 103, top: 23 });
  assert.deepEqual(placePreviousLabel([{ x: 100, y: 178 }], opts), { x: 103, top: 162 });
  // A line that begins at the right edge keeps its label inside the plot.
  assert.deepEqual(placePreviousLabel([{ x: 450, y: 100 }], opts), { x: 377, top: 84 });
  // Nothing in view (no value, or every value outside the plot): no label.
  assert.equal(placePreviousLabel([{ x: 100, y: null }, { x: 120, y: undefined }], opts), undefined);
  assert.equal(placePreviousLabel([{ x: 20, y: 90 }, { x: 500, y: 90 }], opts), undefined);
});
