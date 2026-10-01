import assert from "node:assert/strict";
import { test } from "node:test";

import { parseTokens } from "../../../lib/queryTokens.ts";
import type { TaskResult, TaskView } from "../../../lib/api/types.ts";
import {
  TASK_GRAMMAR,
  failureReason,
  legacyOpenQuery,
  normalizeTaskPage,
  resultsRequest,
  runSummary,
  taskCancellable,
  taskListRequest,
} from "../tasksModel.ts";

const tokens = (text: string) =>
  parseTokens(text, TASK_GRAMMAR, { node: { toId: (v) => (v === "[cd]-DMIT-2" ? "node_dmit2" : undefined) } });

const task = (over: Partial<TaskView>): TaskView => ({ id: "task_a", targets: ["n1"], interpreter: "sh", status: "finished", ...over });

test("a question becomes one task list call with the server's own parameters", () => {
  const params = taskListRequest({
    tokens: tokens("status:failed,stalled node:[cd]-DMIT-2 origin:approval approval:approval_9zk"),
    window: { from: "2026-09-30T00:00:00.000Z" },
    offset: 50,
  });
  assert.deepEqual(params, {
    limit: 50,
    offset: 50,
    status: ["stalled", "failed"],
    origin: ["approval"],
    node_id: "node_dmit2",
    approval_id: "approval_9zk",
    since: "2026-09-30T00:00:00.000Z",
  });
});

test("the bare question still sends a limit, so the server pages instead of answering every task", () => {
  assert.deepEqual(taskListRequest({ tokens: tokens(""), window: {}, offset: 0 }), { limit: 50, offset: 0 });
});

test("pending is a status the field accepts, and unknown statuses are named, not sent", () => {
  const parsed = tokens("status:pending,bogus");
  assert.deepEqual(parsed.enums.status, ["pending"]);
  assert.equal(parsed.problems.length, 1);
});

test("an older server's bare array is filtered and paged by the console", () => {
  const rows = [
    task({ id: "t1", status: "failed" }),
    task({ id: "t2", status: "finished" }),
    task({ id: "t3", status: "failed" }),
    task({ id: "t4", status: "failed" }),
  ];
  const page = normalizeTaskPage(rows, { status: ["failed"], limit: 2, offset: 1 });
  assert.deepEqual(page.tasks.map((t) => t.id), ["t3", "t4"]);
  assert.equal(page.total, 3);
  assert.equal(page.serverFiltered, false);
});

test("a server without approval_id pages every task; rows are checked against the approval", () => {
  const response = { tasks: [task({ id: "t1", approval_id: "a1" }), task({ id: "t2", approval_id: "a2" })], total: 1771, limit: 50, offset: 0 };
  const page = normalizeTaskPage(response, { approval_id: "a1", limit: 50, offset: 0 });
  assert.deepEqual(page.tasks.map((t) => t.id), ["t1"]);
  assert.equal(page.total, 1);
});

test("a filtering server's envelope is taken as it is", () => {
  const response = { tasks: [task({ id: "t1" })], total: 243, limit: 50, offset: 0 };
  assert.deepEqual(normalizeTaskPage(response, { status: ["failed"], limit: 50, offset: 0 }), { tasks: response.tasks, total: 243, serverFiltered: true });
});

test("the results poll asks for the rows on screen and never more than the server takes", () => {
  const ids = Array.from({ length: 120 }, (_, i) => `t${i}`);
  const req = resultsRequest(ids);
  assert.equal(req.task_id.split(",").length, 100);
  assert.equal(req.omit_output, 1);
  assert.equal(req.limit, 500);
});

test("a run's summary counts the newest result per target and names the first failure", () => {
  const results: TaskResult[] = [
    { task_id: "t", node_id: "n1", exit_code: 0, finished_at: "2026-09-30T10:00:00Z" },
    { task_id: "t", node_id: "n2", exit_code: 127, stderr_head: "sh: 1: curl: not found", finished_at: "2026-09-30T10:00:00Z" },
    // A newer answer from n3 replaces its older failure.
    { task_id: "t", node_id: "n3", exit_code: 1, finished_at: "2026-09-30T09:00:00Z" },
    { task_id: "t", node_id: "n3", exit_code: 0, finished_at: "2026-09-30T11:00:00Z" },
  ];
  const summary = runSummary({ targets: ["n1", "n2", "n3", "n4", "n1"] }, results);
  assert.equal(summary.total, 4);
  assert.equal(summary.reported, 3);
  assert.equal(summary.passed, 2);
  assert.equal(summary.failed, 1);
  assert.equal(summary.firstFailure?.nodeId, "n2");
});

test("the failure reason is the exit code and the first thing that says why", () => {
  const exit = (code: number) => `exit ${code}`;
  assert.equal(failureReason({ exit_code: 127, stderr_head: "sh: 1: curl: not found" }, exit), "exit 127: sh: 1: curl: not found");
  assert.equal(failureReason({ exit_code: 124, error: "task timed out after 300s", stderr_head: "x" }, exit), "exit 124: task timed out after 300s");
  assert.equal(failureReason({ exit_code: 1, stderr: "\n  Killed\nmore" }, exit), "exit 1: Killed");
  // An older server sends no stderr head with omit_output: the code stands alone.
  assert.equal(failureReason({ exit_code: 2 }, exit), "exit 2");
});

test("cancel is offered while nothing ran or nothing answers, including rows stored as pending", () => {
  assert.deepEqual(
    (["pending", "queued", "leased", "stalled", "finished", "failed", "cancelled", "expired"] as const).filter(taskCancellable),
    ["pending", "queued", "leased", "stalled"],
  );
});

test("an old /tasks?id= link opens the task in the sheet", () => {
  assert.deepEqual(legacyOpenQuery({ id: "task_abc", status: "failed" }), { status: "failed", open: "task_abc" });
  assert.deepEqual(legacyOpenQuery({ id: "task_abc", open: "task_new" }), { open: "task_new" });
  assert.equal(legacyOpenQuery({ status: "failed" }), null);
});
