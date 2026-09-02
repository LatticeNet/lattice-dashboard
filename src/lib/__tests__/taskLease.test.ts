import assert from "node:assert/strict";
import { test } from "node:test";

import { formatLeaseAge, leaseAttemptLabel, taskLeaseProgress } from "../taskLease.ts";

// The English strings, spelled out here so the test reads like the row does.
const text = {
  leasedFor: (age: string) => `leased ${age}`,
  attemptOf: (attempt: number, max: number) => `attempt ${attempt} of ${max}`,
};

function task(over: Record<string, unknown>) {
  return { id: "t", targets: ["hk-edge-01"], interpreter: "sh", status: "leased", ...over } as never;
}

test("a single-target leased task reads its lease from the task itself", () => {
  const progress = taskLeaseProgress(task({ attempts: 2, max_attempts: 3, lease_age_seconds: 41 * 60 }), "hk-edge-01");
  assert.equal(leaseAttemptLabel(progress, text), "leased 41 min, attempt 2 of 3");
});

test("a fan-out row reads its own target, not the task-level summary", () => {
  const fanout = task({
    targets: ["hk-edge-01", "sg-edge-02"],
    target_states: {
      "hk-edge-01": { status: "leased", attempts: 1, max_attempts: 3, lease_age_seconds: 90 },
      "sg-edge-02": { status: "stalled", attempts: 3, max_attempts: 3, lease_age_seconds: 6 * 86400, stalled_reason: "agent lost during run three times" },
    },
  });
  assert.equal(leaseAttemptLabel(taskLeaseProgress(fanout, "hk-edge-01"), text), "leased 1 min, attempt 1 of 3");
  assert.equal(leaseAttemptLabel(taskLeaseProgress(fanout, "sg-edge-02"), text), "agent lost during run three times, attempt 3 of 3");
  assert.equal(taskLeaseProgress(fanout, "sg-edge-02")?.status, "stalled");
  // No task-level scalars on a fan-out, and no row for a node that is not a target.
  assert.equal(taskLeaseProgress(fanout, "jp-edge-03"), undefined);
});

test("a superseded update task shows the winning version as its reason", () => {
  const progress = taskLeaseProgress(task({ attempts: 1, max_attempts: 3, lease_age_seconds: 900, stalled_reason: "superseded by v0.3.9-alpha.5" }));
  assert.equal(leaseAttemptLabel(progress, text), "superseded by v0.3.9-alpha.5, attempt 1 of 3");
});

test("an older server that sends no lease fields produces no label at all", () => {
  assert.equal(taskLeaseProgress(task({}), "hk-edge-01"), undefined);
  assert.equal(taskLeaseProgress(task({ status: "queued" })), undefined);
  assert.equal(leaseAttemptLabel(undefined, text), "");
});

test("lease age uses at most two units and never goes negative", () => {
  const cases: Array<[number, string]> = [
    [0, "0 s"],
    [30, "30 s"],
    [59.9, "59 s"],
    [60, "1 min"],
    [41 * 60, "41 min"],
    [3600, "1 h"],
    [2 * 3600 + 5 * 60 + 9, "2 h 5 min"],
    [86400, "1 d"],
    [6 * 86400 + 2 * 3600 + 30 * 60, "6 d 2 h"],
    [-5, "0 s"],
  ];
  for (const [seconds, want] of cases) {
    assert.equal(formatLeaseAge(seconds), want, `${seconds}s`);
  }
});
