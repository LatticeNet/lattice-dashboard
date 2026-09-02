import assert from "node:assert/strict";
import { test } from "node:test";

import { buildNodeQueue } from "../nodeTaskQueueModel.ts";

const NODE = "hk-edge-01";

function task(over: Record<string, unknown>) {
  return {
    id: "t", targets: [NODE], interpreter: "bash", status: "queued",
    created_at: "2026-08-28T10:00:00Z", ...over,
  } as never;
}

test("only unfinished tasks aimed at this node are queued work", () => {
  const q = buildNodeQueue(
    [
      task({ id: "waiting", status: "queued" }),
      task({ id: "running", status: "leased" }),
      task({ id: "done", status: "finished" }),
      task({ id: "failed", status: "failed" }),
      task({ id: "cancelled", status: "cancelled" }),
      task({ id: "other-node", status: "queued", targets: ["somewhere-else"] }),
    ],
    NODE,
  );
  assert.deepEqual(q.entries.map((e) => e.id), ["running", "waiting"]);
  assert.equal(q.queued, 1);
  assert.equal(q.running, 1);
});

test("a task the agent already holds sorts above older queued ones", () => {
  const q = buildNodeQueue(
    [
      task({ id: "old", status: "queued", created_at: "2026-08-28T09:00:00Z" }),
      task({ id: "leased-later", status: "leased", created_at: "2026-08-28T11:00:00Z" }),
    ],
    NODE,
  );
  assert.deepEqual(q.entries.map((e) => e.id), ["leased-later", "old"]);
  assert.equal(q.entries[0].running, true);
});

test("queued tasks run oldest first, which is the reverse of every other list here", () => {
  const q = buildNodeQueue(
    [
      task({ id: "third", created_at: "2026-08-28T12:00:00Z" }),
      task({ id: "first", created_at: "2026-08-28T10:00:00Z" }),
      task({ id: "second", created_at: "2026-08-28T11:00:00Z" }),
    ],
    NODE,
  );
  assert.deepEqual(q.entries.map((e) => e.id), ["first", "second", "third"]);
});

test("an entry with no timestamp sorts last rather than posing as the oldest", () => {
  const q = buildNodeQueue(
    [
      task({ id: "undated", created_at: undefined }),
      task({ id: "dated", created_at: "2026-08-28T10:00:00Z" }),
    ],
    NODE,
  );
  assert.deepEqual(q.entries.map((e) => e.id), ["dated", "undated"]);
});

test("a fan-out task reports how many nodes it targets", () => {
  const q = buildNodeQueue([task({ id: "fanout", targets: [NODE, "b", "c"] })], NODE);
  assert.equal(q.entries[0].targetCount, 3);
});

test("no node means no queue, rather than every node's queue", () => {
  assert.deepEqual(buildNodeQueue([task({})], "").entries, []);
  assert.deepEqual(buildNodeQueue([task({})], "   ").entries, []);
});

test("a task with no targets array does not crash the panel", () => {
  const q = buildNodeQueue([{ id: "x", status: "queued", interpreter: "sh" } as never], NODE);
  assert.deepEqual(q.entries, []);
});

test("a stalled task stays visible on the node page, marked and counted apart", () => {
  const q = buildNodeQueue(
    [
      task({ id: "given-up", status: "stalled", attempts: 3, max_attempts: 3, lease_age_seconds: 6 * 86400, stalled_reason: "agent lost during run three times" }),
      task({ id: "waiting", status: "queued" }),
    ],
    NODE,
  );
  assert.deepEqual(q.entries.map((e) => e.id), ["given-up", "waiting"]);
  const stalled = q.entries[0];
  assert.equal(stalled.stalled, true);
  assert.equal(stalled.running, false);
  assert.equal(stalled.lease?.stalledReason, "agent lost during run three times");
  assert.equal(q.stalled, 1);
  assert.equal(q.queued, 1);
  assert.equal(q.running, 0);
});

test("a fan-out that is running elsewhere but stalled here reads as stalled for this node", () => {
  const q = buildNodeQueue(
    [
      task({
        id: "fanout", status: "leased", targets: [NODE, "somewhere-else"],
        target_states: {
          [NODE]: { status: "stalled", attempts: 3, max_attempts: 3, stalled_reason: "agent lost during run three times" },
          "somewhere-else": { status: "leased", attempts: 1, max_attempts: 3, lease_age_seconds: 60 },
        },
      }),
    ],
    NODE,
  );
  assert.equal(q.entries[0].status, "stalled");
  assert.equal(q.entries[0].lease?.attempts, 3);
  assert.equal(q.stalled, 1);
});

test("a fan-out target that already answered here is not this node's queue, whatever the task says", () => {
  const q = buildNodeQueue(
    [
      task({
        id: "fanout", status: "leased", targets: [NODE, "somewhere-else"],
        target_states: {
          [NODE]: { status: "finished", attempts: 1, max_attempts: 3, lease_age_seconds: 300 },
          "somewhere-else": { status: "leased", attempts: 1, max_attempts: 3, lease_age_seconds: 60 },
        },
      }),
      task({
        id: "not-yet-here", status: "leased", targets: [NODE, "somewhere-else"],
        target_states: {
          [NODE]: { status: "queued" },
          "somewhere-else": { status: "leased", attempts: 1, max_attempts: 3, lease_age_seconds: 60 },
        },
      }),
    ],
    NODE,
  );
  assert.deepEqual(q.entries.map((e) => e.id), ["not-yet-here"]);
  assert.equal(q.entries[0].running, false);
  assert.equal(q.queued, 1);
  assert.equal(q.running, 0);
});
