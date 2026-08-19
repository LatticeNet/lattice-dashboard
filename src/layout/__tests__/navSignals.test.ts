import assert from "node:assert/strict";
import { test } from "node:test";

import { buildNavSignals, formatBadge, sectionSignal } from "../navSignals.ts";

test("nothing is claimed before the data has loaded", () => {
  // A nav that reads "0 pending" before the first response is lying with a
  // number, and an operator who learns to trust it will be misled once.
  assert.deepEqual(buildNavSignals({}), {});
  assert.deepEqual(buildNavSignals({ approvalsPending: undefined, nodesOffline: undefined }), {});
});

test("zero is not a signal", () => {
  assert.deepEqual(buildNavSignals({ approvalsPending: 0, nodesOffline: 0, tasksFailed: 0 }), {});
});

test("pending work and unreachable machines read differently", () => {
  const signals = buildNavSignals({ approvalsPending: 45, nodesOffline: 3, nodesTotal: 35 });
  assert.equal(signals.approvals?.count, 45);
  assert.equal(signals.approvals?.tone, "warning");
  assert.equal(signals.nodes?.tone, "attention");
  assert.match(signals.nodes?.label ?? "", /not reporting/);
});

test("a failure replaces queued work rather than stacking beside it", () => {
  const both = buildNavSignals({ tasksFailed: 2, tasksQueued: 9 });
  assert.equal(both.tasks?.count, 2);
  assert.equal(both.tasks?.tone, "attention");

  const queuedOnly = buildNavSignals({ tasksFailed: 0, tasksQueued: 9 });
  assert.equal(queuedOnly.tasks?.count, 9);
  assert.equal(queuedOnly.tasks?.tone, "warning");
});

test("a collapsed section shows the worst of what it hides", () => {
  const signals = buildNavSignals({ approvalsPending: 45, tasksFailed: 2 });
  const section = sectionSignal(signals, ["approvals", "tasks", "audit"]);
  // Total so the number means something, tone from the worst child so a
  // failure inside a shut section cannot look like ordinary queued work.
  assert.equal(section?.count, 47);
  assert.equal(section?.tone, "attention");
  assert.equal(sectionSignal(signals, ["audit"]), undefined);
});

test("large counts stop pretending to be exact", () => {
  assert.equal(formatBadge(7), "7");
  assert.equal(formatBadge(99), "99");
  assert.equal(formatBadge(100), "99+");
});
