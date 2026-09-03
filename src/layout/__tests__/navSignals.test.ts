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

test("a task stuck for six days shows in the sidebar even though nothing failed", () => {
  // The badge counted failed and queued only, so a target the store had given
  // up re-leasing produced no signal at all: the sidebar was quiet for exactly
  // the state that most needed a person (KI-20).
  const stalledOnly = buildNavSignals({ tasksFailed: 0, tasksStalled: 1, tasksQueued: 0 });
  assert.deepEqual(stalledOnly.tasks, { count: 1, tone: "attention", label: "1 stalled" });

  // Stalled and failed are the same kind of stuck and share one badge.
  const both = buildNavSignals({ tasksFailed: 2, tasksStalled: 3, tasksQueued: 9 });
  assert.deepEqual(both.tasks, { count: 5, tone: "attention", label: "2 failed, 3 stalled" });

  // Nothing stuck: queued work still shows, at the lower tone.
  const queued = buildNavSignals({ tasksFailed: 0, tasksStalled: 0, tasksQueued: 4 });
  assert.equal(queued.tasks?.tone, "warning");

  // Zero is not a signal, and an unloaded source stays silent.
  assert.deepEqual(buildNavSignals({ tasksFailed: 0, tasksStalled: 0 }), {});
  assert.deepEqual(buildNavSignals({}), {});
});
