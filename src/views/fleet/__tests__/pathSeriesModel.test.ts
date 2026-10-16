import assert from "node:assert/strict";
import { test } from "node:test";

import type { PathSeriesResponse } from "@/lib/api/types";

import {
  LATENCY_LANE_START,
  LOSS_LANE,
  bucketIndexAt,
  chartColumns,
  expectedStepSeconds,
  fillSteps,
  gapRuns,
  inferStep,
  laneLayout,
  methodAt,
  methodMarkers,
  seriesCeilingMs,
  seriesFromLatency,
  seriesFromResponse,
  seriesStats,
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
