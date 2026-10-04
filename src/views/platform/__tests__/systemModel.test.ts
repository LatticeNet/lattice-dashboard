import assert from "node:assert/strict";
import { test } from "node:test";

import type { MetricsSeries, SystemEventRow, SystemRefusedSeries } from "@/lib/api/systemTypes";

import {
  chartCeiling,
  chartGeometry,
  errorRate,
  errorTone,
  eventRowTone,
  filterRows,
  formatByteChange,
  formatBytesShort,
  formatErrorRate,
  formatRate,
  formatSeconds,
  formatUnit,
  freeSpaceTone,
  groupPluginRows,
  memoryTone,
  metricsBlock,
  niceCeil,
  parseRange,
  pointAt,
  refusedGroups,
  segments,
  seriesPoints,
  spanParts,
  sparkChange,
  sparkPath,
  storeFreshness,
} from "../systemModel.ts";

function row(over: Partial<SystemEventRow> = {}): SystemEventRow {
  return {
    name: "svc/m",
    calls: 100,
    errors: 0,
    per_minute: 1,
    p50_seconds: 0.02,
    p95_seconds: 0.08,
    max_seconds: 0.2,
    avg_seconds: 0.03,
    spark: { step_seconds: 1800, t: [], n: [] },
    ...over,
  };
}

test("durations read in the unit an operator thinks in", () => {
  assert.equal(formatSeconds(0.0004), "0.40 ms");
  assert.equal(formatSeconds(0.0042), "4.2 ms");
  assert.equal(formatSeconds(0.082), "82 ms");
  assert.equal(formatSeconds(1.234), "1.23 s");
  assert.equal(formatSeconds(42), "42.0 s");
  assert.equal(formatSeconds(210), "3.5 min");
  assert.equal(formatSeconds(0), "0 ms");
  assert.equal(formatSeconds(undefined), "-");
  assert.equal(formatSeconds(Number.NaN), "-");
});

test("bytes and byte changes", () => {
  assert.equal(formatBytesShort(0), "0 B");
  assert.equal(formatBytesShort(930 * 1024 * 1024), "930.0 MB");
  assert.equal(formatBytesShort(1.5 * 1024 ** 3), "1.5 GB");
  assert.equal(formatByteChange(120 * 1024 * 1024), "+120.0 MB");
  assert.equal(formatByteChange(-3 * 1024), "-3.0 KB");
  assert.equal(formatByteChange(0.2), "±0 B");
  assert.equal(formatByteChange(undefined), undefined);
});

test("a value prints in its series' unit", () => {
  assert.equal(formatUnit("percent", 7.25), "7.3%");
  assert.equal(formatUnit("percent", 62.4), "62%");
  assert.equal(formatUnit("bytes_per_second", 2048), "2.0 KB/s");
  assert.equal(formatUnit("load", 0.5), "0.50");
  assert.equal(formatUnit("count", 1204.4), "1,204");
  assert.equal(formatUnit("seconds", 0.25), "250 ms");
  assert.equal(formatUnit(undefined, 3), "3");
  assert.equal(formatRate(0), "0");
  assert.equal(formatRate(0.05), "0.050");
  assert.equal(formatRate(4.26), "4.3");
  assert.equal(formatRate(1520.2), "1,520");
});

test("a row's tone: failures first, then the slow-request line", () => {
  assert.equal(eventRowTone(row()), "default");
  assert.equal(eventRowTone(row({ errors: 1 })), "warning");
  assert.equal(eventRowTone(row({ errors: 5 })), "destructive");
  assert.equal(eventRowTone(row({ p95_seconds: 1 })), "warning");
  assert.equal(eventRowTone(row({ calls: 0, errors: 0 })), "default");
  // A slow method with no failures: its row reads slow, its zero failures stay plain.
  assert.equal(errorTone(row({ p95_seconds: 4.8 })), "default");
  assert.equal(errorTone(row({ errors: 1 })), "warning");
  assert.equal(errorRate(row({ errors: 3 })), 0.03);
  assert.equal(formatErrorRate(row({ errors: 0 })), "0");
  assert.equal(formatErrorRate(row({ errors: 1, calls: 400 })), "0.25%");
  assert.equal(formatErrorRate(row({ errors: 12 })), "12.0%");
});

test("free space and memory tones", () => {
  assert.equal(freeSpaceTone(9.7e9, 99e9), "destructive"); // hkg on 2026-10-04: 9.8 percent free
  assert.equal(freeSpaceTone(12e9, 99e9), "warning");
  assert.equal(freeSpaceTone(20e9, 99e9), "default");
  assert.equal(freeSpaceTone(undefined, 99e9), "default");
  assert.equal(memoryTone(0.9e9, 3.9e9), "default");
  assert.equal(memoryTone(0.5e9, 3.9e9), "warning");
  assert.equal(memoryTone(0.3e9, 3.9e9), "destructive");
});

test("rows filter by every word across plugin and name", () => {
  const rows = [row({ name: "subscription/fetch", plugin: "latticenet.vpn-core" }), row({ name: "zones/list", plugin: "latticenet.netguard" })];
  assert.deepEqual(filterRows(rows, "vpn fetch").map((r) => r.name), ["subscription/fetch"]);
  assert.deepEqual(filterRows(rows, "  ").length, 2);
  assert.deepEqual(filterRows(rows, "nothing").length, 0);
});

test("plugin groups put the plugin with the slowest method first", () => {
  const groups = groupPluginRows([
    row({ plugin: "a", name: "fast", p95_seconds: 0.01, calls: 10 }),
    row({ plugin: "b", name: "slow", p95_seconds: 2, calls: 1, errors: 1 }),
    row({ plugin: "a", name: "medium", p95_seconds: 0.3, calls: 5 }),
  ]);
  assert.deepEqual(groups.map((g) => g.plugin), ["b", "a"]);
  assert.deepEqual(groups[1]!.rows.map((r) => r.name), ["medium", "fast"]);
  assert.equal(groups[1]!.calls, 15);
  assert.equal(groups[0]!.errors, 1);
});

test("store freshness", () => {
  const now = Date.parse("2026-10-04T12:05:30Z");
  assert.equal(storeFreshness({ last_write_at: "2026-10-04T12:05:00Z" }, now), "fresh");
  assert.equal(storeFreshness({ last_write_at: "2026-10-04T12:01:00Z" }, now), "late");
  assert.equal(storeFreshness({}, now), "waiting");
  assert.equal(storeFreshness({ last_write_at: "2026-10-04T12:05:00Z", last_write_error: "disk full" }, now), "failing");
});

test("spans name the tiers the way the server keeps them", () => {
  assert.deepEqual(spanParts(60), { n: 1, unit: "min" });
  assert.deepEqual(spanParts(240), { n: 4, unit: "min" });
  assert.deepEqual(spanParts(3600), { n: 1, unit: "h" });
  assert.deepEqual(spanParts(48 * 3600), { n: 2, unit: "d" });
  assert.deepEqual(spanParts(14 * 86400), { n: 14, unit: "d" });
  assert.deepEqual(spanParts(1830 * 86400), { n: 5, unit: "y" });
  assert.equal(parseRange("7d"), "7d");
  assert.equal(parseRange("2w"), "24h");
  assert.equal(parseRange(undefined), "24h");
});

const SERIES: MetricsSeries = {
  name: "proc.rss",
  kind: "gauge",
  unit: "bytes",
  t: [0, 60, 120, 300, 480, 540],
  avg: [10, 20, 15, 30, 40, Number.NaN],
  min: [5, 15, 10, 25, 35, 1],
  max: [12, 25, 20, 35, 45, 2],
  n: [6, 6, 6, 6, 6, 6],
};

test("series points drop non-finite buckets and segments break at gaps", () => {
  const pts = seriesPoints(SERIES);
  assert.equal(pts.length, 5);
  const segs = segments(pts, 60);
  assert.deepEqual(segs.map((s) => s.map((p) => p.t)), [[0, 60, 120], [300], [480]]);
});

test("chart geometry keeps the band, the line and lone buckets apart", () => {
  const g = chartGeometry(seriesPoints(SERIES), { from: 0, to: 600, step: 60, w: 600, h: 100, ceiling: 50 });
  assert.match(g.line, /^M30\.00,80\.00L90\.00,60\.00L150\.00,70\.00$/);
  assert.match(g.band, /^M30\.00,76\.00L90\.00,50\.00L150\.00,60\.00L150\.00,80\.00L90\.00,70\.00L30\.00,90\.00Z$/);
  assert.deepEqual(g.dots, [
    { x: 330, y: 40 },
    { x: 510, y: 20 },
  ]);
  // Values past the ceiling are clamped to the top, never drawn off the plot.
  const clamped = chartGeometry(seriesPoints(SERIES), { from: 0, to: 600, step: 60, w: 600, h: 100, ceiling: 10 });
  assert.ok(!clamped.line.includes("-"));
});

test("ceilings: percent keeps 100, a known top wins, otherwise a nice step above the data", () => {
  assert.equal(chartCeiling("percent", 12), 100);
  assert.equal(chartCeiling("percent", 180), 200);
  assert.equal(chartCeiling("bytes", 2e9, 3.9e9), 3.9e9);
  assert.equal(chartCeiling("bytes", 4.2e9, 3.9e9), 4.2e9);
  assert.equal(chartCeiling("seconds", 0.8), 1);
  assert.equal(chartCeiling("load", 0), 1);
  assert.equal(niceCeil(0.0042), 0.005);
  assert.equal(niceCeil(230), 250);
  assert.equal(niceCeil(1000), 1000);
});

test("scrubbing finds the bucket under the pointer, and nothing in a gap", () => {
  const pts = seriesPoints(SERIES);
  assert.equal(pointAt(pts, 0.05, 0, 600, 60)?.t, 0);
  assert.equal(pointAt(pts, 0.5, 0, 600, 60)?.t, 300);
  assert.equal(pointAt(pts, 0.7, 0, 600, 60), undefined);
  assert.equal(pointAt([], 0.5, 0, 600, 60), undefined);
});

test("sparklines break where nothing was heard and keep the slot widths", () => {
  const spark = { step_seconds: 60, t: [0, 60, 240, 300], n: [1, 1, 1, 1], p95: [1, 2, 3, 4] };
  const d = sparkPath(spark, spark.p95, { from: 0, to: 360, w: 96, h: 24 });
  assert.equal((d.match(/M/g) ?? []).length, 2);
  assert.equal((d.match(/L/g) ?? []).length, 2);
  assert.equal(sparkPath(undefined, [], { from: 0, to: 1, w: 96, h: 24 }), "");
  assert.equal(sparkChange({ step_seconds: 60, t: [0, 60], n: [1, 1], avg: [100, 350] }), 250);
  assert.equal(sparkChange({ step_seconds: 60, t: [0], n: [1], avg: [100] }), undefined);
});

test("a 403 and the two metrics 503 codes block the page; any other failure is retried", () => {
  assert.equal(metricsBlock(undefined), null);
  assert.equal(metricsBlock({ status: 403, code: "capability_denied" }), "forbidden");
  assert.equal(metricsBlock({ status: 400, code: "x", forbidden: true }), "forbidden");
  assert.equal(metricsBlock({ status: 503, code: "metrics_disabled" }), "disabled");
  assert.equal(metricsBlock({ status: 503, code: "metrics_unavailable" }), "unavailable");
  // A proxy's 503 during a restart, or a 502, is a failure to retry, not an answer.
  assert.equal(metricsBlock({ status: 503, code: "internal_error" }), null);
  assert.equal(metricsBlock({ status: 502, code: "bad_gateway" }), null);
});

function refused(owner: string, name: string, reason: string): SystemRefusedSeries {
  return { owner, name, reason, first: "2026-10-04T10:00:00Z", last: "2026-10-04T11:00:00Z", samples: 60 };
}

test("refused series group by the cap that refused them, the total cap first, a few named each", () => {
  const groups = refusedGroups([
    refused("cp", "b", "kind_mismatch"),
    refused("plugin/p", "m1", "max_series_per_owner"),
    refused("node/a", "cpu", "max_series"),
    refused("node/a", "mem", "max_series"),
    refused("node/b", "cpu", "max_series"),
    refused("node/b", "mem", "max_series"),
    refused("plugin/q", "m9", "max_series_per_owner"),
    refused("plugin/p", "m2", "max_series_per_owner"),
    refused("cp", "bad�name", "invalid"),
  ]);
  assert.deepEqual(
    groups.map((g) => [g.reason, g.owner, g.names, g.total]),
    [
      ["max_series", undefined, ["node/a cpu", "node/a mem", "node/b cpu"], 4],
      // Each owner's own cap is its own group, naming the series without the owner.
      ["max_series_per_owner", "plugin/p", ["m1", "m2"], 2],
      ["max_series_per_owner", "plugin/q", ["m9"], 1],
      ["kind_mismatch", undefined, ["cp b"], 1],
      ["invalid", undefined, ["cp bad�name"], 1],
    ],
  );
  assert.deepEqual(refusedGroups([]), []);
});
