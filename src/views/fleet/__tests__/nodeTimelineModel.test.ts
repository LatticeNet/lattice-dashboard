import assert from "node:assert/strict";
import { test } from "node:test";

import {
  approvalEntries,
  auditEntries,
  buildNodeTimeline,
  groupByDay,
  sortTimeline,
  taskEntries,
} from "../nodeTimelineModel.ts";

const NODE = "hk-edge-01";

test("audit rows keep their decision and correlation", () => {
  const entries = auditEntries([
    { id: "a1", at: "2026-08-18T10:00:00Z", action: "node.disable", decision: "deny", actor_id: "op", reason: "scope", correlation_id: "c1" },
  ] as never);
  assert.equal(entries.length, 1);
  assert.deepEqual(
    { ...entries[0] },
    { id: "audit:a1", kind: "audit", at: "2026-08-18T10:00:00Z", action: "node.disable", outcome: "deny", actor: "op", detail: "scope", correlationId: "c1" },
  );
});

test("a task contributes both its queueing and this node's own result", () => {
  const tasks = [
    { id: "t1", targets: [NODE, "other"], interpreter: "bash", status: "finished", created_at: "2026-08-18T09:00:00Z" },
    { id: "t2", targets: ["other"], interpreter: "bash", status: "finished", created_at: "2026-08-18T09:30:00Z" },
  ];
  const results = [
    { task_id: "t1", node_id: NODE, exit_code: 1, finished_at: "2026-08-18T09:01:00Z", error: "" },
    { task_id: "t1", node_id: "other", exit_code: 0, finished_at: "2026-08-18T09:02:00Z" },
    { task_id: "t2", node_id: "other", exit_code: 0, finished_at: "2026-08-18T09:31:00Z" },
  ];
  const entries = taskEntries(NODE, tasks as never, results as never);
  assert.deepEqual(entries.map((e) => e.id), ["task:t1", "result:t1:hk-edge-01"]);
  assert.equal(entries[1].outcome, "failed");
  assert.equal(entries[1].detail, "exit 1");
});

test("a result whose task is not ours is ignored even when the node matches", () => {
  const entries = taskEntries(NODE, [] as never, [
    { task_id: "gone", node_id: NODE, exit_code: 0, finished_at: "2026-08-18T09:00:00Z" },
  ] as never);
  assert.deepEqual(entries, []);
});

test("approvals report the decision time and who decided", () => {
  const entries = approvalEntries(NODE, [
    { id: "ap1", node_id: NODE, plugin: "netguard", action: "apply_policy", status: "approved", actor_id: "sys", approved_by: "op", created_at: "2026-08-18T08:00:00Z", updated_at: "2026-08-18T08:05:00Z" },
    { id: "ap2", node_id: "elsewhere", plugin: "netguard", action: "apply_policy", status: "pending", created_at: "2026-08-18T08:00:00Z" },
  ] as never);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].at, "2026-08-18T08:05:00Z");
  assert.equal(entries[0].actor, "op");
  assert.equal(entries[0].action, "netguard.apply_policy");
});

test("the stream is newest first and stable when timestamps tie", () => {
  const sorted = sortTimeline([
    { id: "b", kind: "audit", at: "2026-08-18T10:00:00Z", action: "x", outcome: "allow" },
    { id: "a", kind: "audit", at: "2026-08-18T10:00:00Z", action: "x", outcome: "allow" },
    { id: "c", kind: "audit", at: "2026-08-18T11:00:00Z", action: "x", outcome: "allow" },
  ]);
  assert.deepEqual(sorted.map((e) => e.id), ["c", "a", "b"]);
});

test("the limit applies to the merged stream, not to each source", () => {
  // Chatty audit must not push out a recent task: that entry is exactly what
  // the operator came to find.
  const audit = Array.from({ length: 30 }, (_, i) => ({
    id: `a${i}`,
    at: `2026-08-18T07:${String(i).padStart(2, "0")}:00Z`,
    action: "poll",
    decision: "allow",
  }));
  const timeline = buildNodeTimeline({
    nodeId: NODE,
    audit: audit as never,
    tasks: [{ id: "t9", targets: [NODE], interpreter: "bash", status: "failed", created_at: "2026-08-18T09:00:00Z" }] as never,
    limit: 5,
  });
  assert.equal(timeline.length, 5);
  assert.equal(timeline[0].id, "task:t9");
});

test("days come out in stream order with their entries intact", () => {
  const days = groupByDay([
    { id: "1", kind: "audit", at: "2026-08-18T10:00:00Z", action: "x", outcome: "allow" },
    { id: "2", kind: "audit", at: "2026-08-18T09:00:00Z", action: "x", outcome: "allow" },
    { id: "3", kind: "audit", at: "2026-08-17T23:00:00Z", action: "x", outcome: "allow" },
  ]);
  assert.deepEqual(days.map((d) => [d.day, d.entries.length]), [["2026-08-18", 2], ["2026-08-17", 1]]);
});
