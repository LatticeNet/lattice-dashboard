import assert from "node:assert/strict";
import { test } from "node:test";

import { formatLeaseAge, leaseAttemptLabel, stalledText, taskLeaseProgress, taskStateStyle } from "../taskLease.ts";

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

test("a never-leased target of a fan-out keeps its own status and has no label", () => {
  const fanout = task({
    targets: ["hk-edge-01", "sg-edge-02"],
    target_states: {
      "hk-edge-01": { status: "queued" },
      "sg-edge-02": { status: "leased", attempts: 1, max_attempts: 3, lease_age_seconds: 60 },
    },
  });
  const progress = taskLeaseProgress(fanout, "hk-edge-01");
  assert.equal(progress?.status, "queued");
  assert.equal(leaseAttemptLabel(progress, text), "");
});

/* ------------------------------------------------------------------ */
/* The stall sentence: said once, and joined with punctuation that      */
/* survives a server reason that already ends in a full stop.           */
/* ------------------------------------------------------------------ */

const stallText = { ...text, stalledNoLease: "Nothing is running this and no result arrived; cancel it or rerun" };

const REAL_REASON =
  "The store stopped re-leasing after 3 attempts (last lease expired 2026-08-27T08:51:00Z).";

function stalled(over: Record<string, unknown> = {}) {
  return taskLeaseProgress(
    task({ status: "stalled", attempts: 3, max_attempts: 3, stalled_reason: REAL_REASON, ...over }),
    "hk-edge-01",
  );
}

test("a stalled reason ending in a full stop is joined with a comma, not with both", () => {
  const line = stalledText(stalled(), stallText);
  assert.equal(
    line,
    "The store stopped re-leasing after 3 attempts (last lease expired 2026-08-27T08:51:00Z), attempt 3 of 3",
  );
  assert.ok(!line.includes("."), `a full stop met a comma: ${line}`);
  assert.ok(!line.includes(" ,"), line);
});

test("the same reason written with Chinese punctuation loses its full stop too", () => {
  const line = stalledText(stalled({ stalled_reason: "重试 3 次后放弃续租。" }), stallText);
  assert.equal(line, "重试 3 次后放弃续租, attempt 3 of 3");
});

test("a stall says the finding once, not the reason plus a restatement of it", () => {
  const line = stalledText(stalled(), stallText);
  // The generic sentence is the fallback, never an addition: printing both is
  // what produced a cell that said "stalled" three times over.
  assert.ok(!line.includes(stallText.stalledNoLease), line);
});

test("a server that sends no reason falls back to the generic sentence", () => {
  const progress = taskLeaseProgress(task({ status: "stalled" }), "hk-edge-01");
  assert.equal(stalledText(progress, stallText), stallText.stalledNoLease);
});

test("lease age spells its units in the caller's language", () => {
  const zh = {
    days: (n: number) => `${n} 天`,
    hours: (n: number) => `${n} 小时`,
    minutes: (n: number) => `${n} 分钟`,
    seconds: (n: number) => `${n} 秒`,
  };
  assert.equal(formatLeaseAge(41 * 60, zh), "41 分钟");
  assert.equal(formatLeaseAge(6 * 86400 + 2 * 3600, zh), "6 天 2 小时");
  assert.equal(formatLeaseAge(30, zh), "30 秒");
  // A label built with those units carries them through.
  const progress = taskLeaseProgress(task({ attempts: 1, max_attempts: 3, lease_age_seconds: 41 * 60 }), "hk-edge-01");
  assert.equal(
    leaseAttemptLabel(progress, { ...text, duration: zh }),
    "leased 41 分钟, attempt 1 of 3",
  );
});

/* ------------------------------------------------------------------ */
/* One semantic token per task state, for every surface that prints one.*/
/* ------------------------------------------------------------------ */

test("every task state has exactly one colour, and both pages read it from here", () => {
  // The two surfaces that used to disagree: the Tasks table and the node
  // page's queue. Reading the same table is the whole point of it existing.
  assert.deepEqual(taskStateStyle("stalled"), { variant: "warning", textClass: "text-warning" });
  assert.deepEqual(taskStateStyle("leased"), { variant: "secondary", textClass: "text-muted-foreground" });
  assert.deepEqual(taskStateStyle("queued"), { variant: "outline", textClass: "text-muted-foreground" });
  assert.deepEqual(taskStateStyle("failed"), { variant: "destructive", textClass: "text-destructive" });
});

test("destructive is spent on failure alone, and the deliberate stops read alike", () => {
  const destructive = ["queued", "leased", "finished", "cancelled", "expired", "stalled", "failed"].filter(
    (state) => taskStateStyle(state).variant === "destructive",
  );
  assert.deepEqual(destructive, ["failed"]);
  assert.equal(taskStateStyle("cancelled").variant, taskStateStyle("expired").variant);
});

test("a state word from a newer server reads as not started rather than throwing", () => {
  assert.deepEqual(taskStateStyle("some-future-state"), taskStateStyle("queued"));
});

test("the style table cannot be mutated through the accessor", () => {
  const style = taskStateStyle("failed");
  style.variant = "outline";
  assert.equal(taskStateStyle("failed").variant, "destructive");
});
