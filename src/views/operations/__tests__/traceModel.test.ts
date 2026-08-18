import assert from "node:assert/strict";
import { test } from "node:test";

import type { AuditEvent } from "../../../lib/api/types.ts";
import {
  orderTimeline,
  referencedApprovalIds,
  referencedTaskIds,
  summarize,
} from "../traceModel.ts";

function ev(partial: Partial<AuditEvent>): AuditEvent {
  return {
    id: "audit_x",
    at: "2026-06-12T12:00:00Z",
    action: "test",
    decision: "allow",
    ...partial,
  } as AuditEvent;
}

test("referencedApprovalIds/taskIds pull distinct refs in first-seen order", () => {
  const events = [
    ev({ id: "a1", metadata: { approval_id: "appr-1" } }),
    ev({ id: "a2", metadata: { task_id: "task-9", approval_id: "appr-1" } }),
    ev({ id: "a3", metadata: { approval_id: "appr-2" } }),
    ev({ id: "a4", metadata: {} }),
  ];
  assert.deepEqual(referencedApprovalIds(events), ["appr-1", "appr-2"]);
  assert.deepEqual(referencedTaskIds(events), ["task-9"]);
});

test("numeric metadata refs are coerced to strings", () => {
  const events = [ev({ metadata: { task_id: 42 as unknown as string } })];
  assert.deepEqual(referencedTaskIds(events), ["42"]);
});

test("orderTimeline sorts oldest-first with id tiebreak", () => {
  const events = [
    ev({ id: "b", at: "2026-06-12T12:00:05Z" }),
    ev({ id: "a", at: "2026-06-12T12:00:05Z" }),
    ev({ id: "c", at: "2026-06-12T12:00:01Z" }),
  ];
  assert.deepEqual(
    orderTimeline(events).map((e) => e.id),
    ["c", "a", "b"],
  );
});

test("summarize counts denies, nodes, and time span", () => {
  const events = [
    ev({ id: "a", at: "2026-06-12T12:00:05Z", node_id: "node-b", decision: "deny" }),
    ev({ id: "b", at: "2026-06-12T12:00:01Z", node_id: "node-a" }),
    ev({ id: "c", at: "2026-06-12T12:00:09Z", node_id: "node-a", decision: "allow" }),
  ];
  const s = summarize(events);
  assert.equal(s.total, 3);
  assert.equal(s.denied, 1);
  assert.equal(s.firstAt, "2026-06-12T12:00:01Z");
  assert.equal(s.lastAt, "2026-06-12T12:00:09Z");
  assert.deepEqual(s.nodes, ["node-a", "node-b"]);
});

test("empty group summarizes cleanly", () => {
  const s = summarize([]);
  assert.equal(s.total, 0);
  assert.equal(s.firstAt, undefined);
  assert.deepEqual(s.nodes, []);
});
