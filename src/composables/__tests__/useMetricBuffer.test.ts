import assert from "node:assert/strict";
import test from "node:test";

import type { Metrics } from "@/lib/api/types";

import { useMetricBuffer } from "../useMetricBuffer.ts";

const ZERO = "0001-01-01T00:00:00Z";

/**
 * A node that never reported still carries a metrics object, all zeros. A
 * current server leaves its collected_at off; an older one sent the Go zero
 * time. Recording either stamped each poll with the current time, so two
 * polls drew a flat 0% sparkline for a machine that has never sent a number.
 */
test("a never-reported node's empty metrics leave no samples", () => {
  const buffer = useMetricBuffer();
  buffer.clear();
  const empty = { cpu_percent: 0, memory_used: 0, memory_total: 0 } as Metrics;
  for (const [id, metrics] of [
    ["absent", empty],
    ["zero", { ...empty, collected_at: ZERO }],
    ["blank", { ...empty, collected_at: "" }],
  ] as const) {
    buffer.record(id, metrics);
    buffer.record(id, metrics);
    assert.deepEqual(buffer.series(id, "cpu"), [], id);
    assert.equal(buffer.latest(id), undefined, id);
  }
  buffer.record("missing", undefined);
  assert.deepEqual(buffer.series("missing", "cpu"), []);
});

test("real samples accrue, and a repeated snapshot replaces rather than repeats", () => {
  const buffer = useMetricBuffer();
  buffer.clear();
  buffer.record("n1", { cpu_percent: 10, collected_at: "2026-10-17T09:30:00Z" } as Metrics);
  buffer.record("n1", { cpu_percent: 10, collected_at: "2026-10-17T09:30:00Z" } as Metrics);
  buffer.record("n1", { cpu_percent: 30, collected_at: "2026-10-17T09:30:05Z" } as Metrics);
  assert.deepEqual(buffer.series("n1", "cpu"), [10, 30]);
  assert.equal(buffer.latest("n1")?.at, Date.parse("2026-10-17T09:30:05Z"));
});
