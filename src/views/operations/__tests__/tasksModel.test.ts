import assert from "node:assert/strict";
import { test } from "node:test";

import { parseTokens } from "../../../lib/queryTokens.ts";
import type { TaskResult, TaskView } from "../../../lib/api/types.ts";
import {
  TASK_GRAMMAR,
  failureReason,
  findTask,
  legacyOpenQuery,
  normalizeTaskPage,
  readResultPages,
  resultsRequest,
  runSummary,
  taskCancellable,
  taskListRequest,
  taskLive,
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

const result = (taskId: string, nodeId: string): TaskResult => ({ task_id: taskId, node_id: nodeId, exit_code: 0 }) as TaskResult;

test("the results read says when it stopped before the server ran out of rows", async () => {
  const pages: number[] = [];
  const read = async (offset: number) => {
    pages.push(offset);
    return { results: Array.from({ length: 500 }, (_, i) => result(i % 2 ? "task_a" : "task_x", `n${offset + i}`)), total: 2600 };
  };
  const capped = await readResultPages(["task_a"], read);
  assert.deepEqual(pages, [0, 500, 1000, 1500]);
  assert.equal(capped.truncated, true);
  assert.equal(capped.rowsRead, 2000);
  assert.equal(capped.results.length, 1000);
  assert.ok(capped.results.every((row) => row.task_id === "task_a"));
});

test("the results read is complete when the last page ends at the total, or the server sends a bare array", async () => {
  const exact = await readResultPages(["task_a"], async (offset) => ({ results: offset < 1000 ? Array.from({ length: 500 }, (_, i) => result("task_a", `n${offset + i}`)) : [], total: 1000 }));
  assert.equal(exact.truncated, false);
  assert.equal(exact.results.length, 1000);
  const bare = await readResultPages(["task_a"], async () => [result("task_a", "n1"), result("task_b", "n1")]);
  assert.deepEqual(bare, { results: [result("task_a", "n1")], truncated: false, rowsRead: 2 });
  assert.deepEqual(await readResultPages([], async () => { throw new Error("not called"); }), { results: [], truncated: false, rowsRead: 0 });
});

test("a run found before is read again on a narrow question that still holds it", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const open = task({ id: "task_open", targets: ["n7", "n8"], created_at: "2026-09-30T08:00:00.123Z", status: "leased" });
  const read = async (params: Record<string, unknown>) => {
    calls.push(params);
    return { tasks: [{ ...open, status: "cancelled" as const }], total: 1, limit: 500, offset: 0 };
  };
  const found = await findTask(read, "task_open", open);
  assert.equal(found?.status, "cancelled");
  assert.deepEqual(calls, [{ node_id: "n7", since: "2026-09-30T08:00:00.123Z", limit: 500, offset: 0 }]);
});

test("without a hint, or when the narrow question misses, the lookup walks the whole list", async () => {
  const rows = Array.from({ length: 1200 }, (_, i) => task({ id: `task_${i}` }));
  const calls: Array<Record<string, unknown>> = [];
  const read = async (params: { node_id?: string; limit?: number; offset?: number }) => {
    calls.push(params);
    if (params.node_id) return { tasks: [], total: 0, limit: 500, offset: 0 };
    const offset = params.offset ?? 0;
    return { tasks: rows.slice(offset, offset + (params.limit ?? 500)), total: rows.length, limit: 500, offset };
  };
  assert.equal((await findTask(read, "task_1100"))?.id, "task_1100");
  assert.deepEqual(calls.map((c) => c.offset), [0, 500, 1000]);
  calls.length = 0;
  const hint = task({ id: "task_1100", targets: ["n1"], created_at: "2026-09-30T00:00:00Z" });
  assert.equal((await findTask(read, "task_1100", hint))?.id, "task_1100");
  assert.equal(calls[0]?.node_id, "n1");
  assert.equal(calls.length, 4);
  assert.equal(await findTask(read, "task_missing"), null);
});

test("a run is live while it waits, runs or stalls", () => {
  assert.deepEqual(
    (["pending", "queued", "leased", "stalled", "finished", "failed", "cancelled", "expired"] as const).filter(taskLive),
    ["pending", "queued", "leased", "stalled"],
  );
});
