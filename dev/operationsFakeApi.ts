/**
 * An in-memory stand-in for `@/lib/api` for the Operations pages (Approvals,
 * Tasks, Audit), wired in by vite.harness.config.ts:
 *
 *   LATTICE_HARNESS=operations pnpm exec vite --config vite.harness.config.ts --port 5480
 *   open http://127.0.0.1:5480/dev/operations.html#/tasks
 *
 * Fixtures, with `?fixture=` before the hash (see operationsFixture.ts):
 *
 *   prod     (default) production on 2026-09-30: 1,351 approvals with 0
 *            waiting, 1,771 tasks with 243 failed and 1 stalled, an audit
 *            log past the 200,000-record scan cap.
 *   pending  prod plus the hand-written stuck approvals and a 14-node wave
 *            waiting on the operator.
 *   empty    a fresh control plane: nothing anywhere.
 *   failing  every read answers 502.
 *
 * Switches: `&scope=read` drops the decide and run scopes; `&exec-off`
 * answers the version read with task execution switched off; `&no-stderr-head`
 * answers results without stderr_head (the server at c08ffaf);
 * `&no-approval-filter` ignores approval_id on the task list (same).
 * `&no-audit-exclude` ignores exclude_action and exclude_decision on the
 * audit query (a server from before a101). `&results-page=<n>` caps a page
 * of task results at n rows, so a page of fan-outs runs past the pages the
 * Tasks poll reads. `&no-timeout` drops timeout_sec from every task, the
 * shape of a view whose timeout was not read.
 *
 * The fake honours the queries the server honours, and refuses what it
 * refuses: task statuses outside the eight, more than 100 task ids.
 */
import { ApiError } from "@/lib/api/client";
import { sha256Hex } from "@/lib/crypto";
import type { ApprovalView, Principal, TaskResult, TaskView } from "@/lib/api/types";

import { fakeApprovalsApi } from "./approvalsFixture";
import { AUDIT_VERIFY, HAND_WRITTEN_NODES, NODES, buildApprovals, buildTasks, countTasks, linkAudit, queryAudit, type AuditQuery } from "./operationsFixture";

export * from "@/lib/api/index";

const flags = new URLSearchParams(window.location.search);
const FIXTURE = flags.get("fixture") ?? "prod";
const FAILING = FIXTURE === "failing";
const READ_ONLY = flags.get("scope") === "read";

const approvals: ApprovalView[] = buildApprovals(FIXTURE === "failing" ? "prod" : FIXTURE);
const { tasks, results } = buildTasks(FIXTURE === "failing" ? "prod" : FIXTURE, approvals);
if (flags.has("no-timeout")) for (const task of tasks) delete task.timeout_sec;
const listing = fakeApprovalsApi(approvals);

/**
 * The approvals fixture answers plan_sha256 with a stable stand-in, which is
 * enough for a decision to bind but not for the sheet, which hashes the plan
 * on screen and compares it with the server's value. This harness answers
 * the real SHA-256 of each plan, as the server does.
 */
const digests = new Map<string, string>();
const digestsReady = Promise.all(approvals.map(async (row) => digests.set(row.id, await sha256Hex(row.plan ?? ""))));

function realDigest<T>(value: T): T {
  const fix = (row: ApprovalView) => (digests.has(row.id) ? { ...row, plan_sha256: digests.get(row.id) } : row);
  if (Array.isArray(value)) return value.map(fix) as T;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.approvals)) return { ...record, approvals: (record.approvals as ApprovalView[]).map(fix) } as T;
    if (record.approval) return { ...record, approval: fix(record.approval as ApprovalView) } as T;
    if (typeof record.id === "string" && typeof record.plugin === "string") return fix(record as unknown as ApprovalView) as T;
  }
  return value;
}
linkAudit(
  approvals.filter((row) => row.status === "applied").slice(0, 200).map((row) => row.id),
  [...new Set(results.slice(0, 400).map((result) => result.task_id))],
);

function delay<T>(value: T, ms = 140): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

function fail(message = "upstream answered 502 Bad Gateway"): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(new ApiError(502, "bad_gateway", message)), 180));
}

function badRequest(message: string): Promise<never> {
  return new Promise((_, reject) => setTimeout(() => reject(new ApiError(400, "bad_request", message)), 60));
}

const READ_SCOPES = ["node:read", "approval:read", "task:read", "audit:read"];
const principal: Principal = {
  actor_id: "cdcd",
  username: "cdcd",
  scopes: READ_ONLY
    ? READ_SCOPES
    : [...READ_SCOPES, "task:run", "network:apply", "network:plan", "node:admin", "netpolicy:admin", "proxy:admin", "sshguard:admin", "terminal:open"],
  server_allowlist: [],
  csrf_token: "harness",
  totp_enabled: true,
};

const TASK_STATUSES = new Set(["queued", "leased", "stalled", "expired", "finished", "failed", "cancelled", "pending"]);
const ORIGINS = new Set(["approval", "rerun", "direct"]);

function list(raw: unknown): string[] {
  return String(raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function lastChange(task: TaskView): number {
  return Math.max(...[task.created_at, task.started_at, task.finished_at].map((at) => (at ? Date.parse(at) : 0)));
}

function queryTasks(params: Record<string, unknown>) {
  const statuses = list(params.status);
  const bad = statuses.find((s) => !TASK_STATUSES.has(s));
  if (bad) return badRequest(`status ${bad} is not one of queued, leased, stalled, expired, finished, failed, cancelled, pending`);
  const origins = list(params.origin);
  const badOrigin = origins.find((s) => !ORIGINS.has(s));
  if (badOrigin) return badRequest(`origin ${badOrigin} is not one of approval, rerun, direct`);
  const since = params.since ? Date.parse(String(params.since)) : Number.NaN;
  if (params.since && Number.isNaN(since)) return badRequest("since must be RFC 3339");
  const nodeId = String(params.node_id ?? "").trim();
  const approvalId = flags.has("no-approval-filter") ? "" : String(params.approval_id ?? "").trim();
  const limit = Math.min(500, Math.max(1, Number(params.limit ?? 100)));
  const offset = Math.max(0, Number(params.offset ?? 0));
  const rows = tasks.filter((task) => {
    if (statuses.length && !statuses.includes(task.status)) return false;
    if (origins.length && !origins.includes(task.origin ?? "direct")) return false;
    if (!Number.isNaN(since) && lastChange(task) < since) return false;
    if (nodeId && !task.targets.includes(nodeId)) return false;
    if (approvalId && task.approval_id !== approvalId) return false;
    return true;
  });
  return delay({ tasks: rows.slice(offset, offset + limit).map((task) => ({ ...task })), total: rows.length, limit, offset }, 220);
}

function queryResults(params: Record<string, unknown> | undefined) {
  if (!params || Object.keys(params).length === 0) return delay(results.map((r) => ({ ...r })), 400);
  const ids = new Set(list(params.task_id));
  if (ids.size > 100) return badRequest("task_id takes at most 100 ids");
  const nodeId = String(params.node_id ?? "").trim();
  const omit = params.omit_output === 1 || params.omit_output === "1";
  const rows = results.filter((r) => (!ids.size || ids.has(r.task_id)) && (!nodeId || r.node_id === nodeId));
  const cap = Number(flags.get("results-page")) || 500;
  const limit = params.limit !== undefined ? Math.min(cap, Math.max(1, Number(params.limit))) : omit ? rows.length : Math.min(cap, 100);
  const offset = Math.max(0, Number(params.offset ?? 0));
  const page: TaskResult[] = rows.slice(offset, offset + limit).map((r) => {
    if (!omit) return { ...r };
    const { stdout, stderr, ...rest } = r;
    const view: TaskResult = { ...rest, stdout_bytes: stdout?.length ?? 0, stderr_bytes: stderr?.length ?? 0 };
    const head = (stderr ?? "").split("\n").map((line) => line.trim()).find(Boolean);
    if (head && !flags.has("no-stderr-head")) view.stderr_head = head.slice(0, 200);
    return view;
  });
  return delay({ results: page, total: rows.length, limit, offset }, 160);
}

function findTask(id: string): TaskView | undefined {
  return tasks.find((task) => task.id === id);
}

function newTask(from: TaskView, targets: string[], origin: TaskView["origin"]): TaskView {
  const task: TaskView = {
    ...from,
    id: `task_new${Date.now().toString(36)}`,
    targets,
    status: "queued",
    origin,
    created_at: new Date().toISOString(),
    started_at: undefined,
    finished_at: undefined,
    rerun_of_task_id: origin === "rerun" ? from.id : undefined,
    approval_id: origin === "approval" ? from.approval_id : undefined,
    actor_id: "cdcd",
  };
  tasks.unshift(task);
  return task;
}

const unimplemented = new Proxy(
  {},
  {
    get(_target, prop) {
      return () => Promise.reject(new Error(`fake api: ${String(prop)} is not implemented in the operations harness`));
    },
  },
);

// The api object is cast to the real type below, so reads are loosely typed here.
function guard(read: () => Promise<unknown>): Promise<unknown> {
  return FAILING ? fail() : read();
}

export const api = {
  auth: { me: () => delay(principal, 40) },
  version: () => delay({ version: "alpha-0.2.2a102", task_execution_disabled: flags.has("exec-off") }, 40),
  nodes: { list: () => guard(() => delay({ nodes: [...NODES, ...(FIXTURE === "pending" ? HAND_WRITTEN_NODES : [])].map((n) => ({ ...n })) })) },
  approvals: {
    list: (params?: Record<string, unknown>) => guard(() => digestsReady.then((): Promise<unknown> => listing.list(params)).then(realDigest)),
    counts: (params?: Record<string, unknown>) => guard(() => listing.counts(params)),
    get: (id: string) => guard(() => digestsReady.then((): Promise<unknown> => listing.get(id)).then(realDigest)),
    approve: (approvalId: string, queueApply: boolean, planSha256?: string) => {
      const approval = approvals.find((row) => row.id === approvalId);
      if (!approval) return Promise.reject(new ApiError(404, "not_found", "approval not found"));
      if (!planSha256) return Promise.reject(new ApiError(400, "bad_request", "plan_sha256 is required"));
      approval.status = "approved";
      approval.approved_by = "cdcd";
      approval.updated_at = new Date().toISOString();
      approval.waiting = queueApply
        ? { code: "task_queued", reason: "Queued; the node picks it up on its next poll.", blocked: false, node_id: approval.node_id, node_status: "online", dismissible: false }
        : { code: "not_queued", reason: "Approved without queueing an apply, and nothing has queued one since.", blocked: true, node_id: approval.node_id, node_status: "online", dismissible: false };
      return delay(undefined);
    },
    reject: (approvalId: string) => {
      const approval = approvals.find((row) => row.id === approvalId);
      if (approval && approval.status === "pending") {
        approval.status = "rejected";
        approval.rejected_by = "cdcd";
        approval.rejected_at = new Date().toISOString();
        approval.updated_at = approval.rejected_at;
      }
      return delay(approval);
    },
    dismiss: (approvalId: string) => {
      const approval = approvals.find((row) => row.id === approvalId);
      // The server's rule (handleDismissApproval): an agent update whose
      // reason is the stale error, whatever its status, or a waiting plan the
      // server reports as dismissible.
      const staleAgentUpdate = approval?.plugin === "agentupdate" && (approval.reason ?? "").startsWith("agent update approval is stale");
      if (!approval || (!staleAgentUpdate && !approval.waiting?.dismissible)) {
        return Promise.reject(new ApiError(409, "conflict", "approval is not stale; reject or approve it explicitly"));
      }
      approval.status = "dismissed";
      approval.updated_at = new Date().toISOString();
      approval.waiting = undefined;
      return delay(approval);
    },
  },
  agentUpdates: {
    plan: () => Promise.reject(new Error("fake api: re-planning is not implemented in the operations harness")),
  },
  tasks: {
    list: () => guard(() => delay(tasks.map((task) => ({ ...task })), 600)),
    query: (params: Record<string, unknown>) => guard(() => queryTasks(params)),
    counts: () => guard(() => delay(countTasks(tasks), 80)),
    listForNode: (nodeId: string, limit = 50) => guard(() => queryTasks({ node_id: nodeId, limit })),
    results: (params?: Record<string, unknown>) => guard(() => queryResults(params)),
    revealScript: () => Promise.reject(new ApiError(403, "step_up_required", "revealing a script needs a fresh second factor")),
    create: (input: { targets: string[]; interpreter: string }) => {
      const task = newTask({ ...(tasks[0] as TaskView), interpreter: input.interpreter }, input.targets, "direct");
      return delay(task);
    },
    rerun: (id: string) => {
      const task = findTask(id);
      if (!task) return Promise.reject(new ApiError(404, "not_found", "task not found"));
      return delay(newTask(task, task.targets, "rerun"));
    },
    rerunNode: (id: string, nodeId: string) => {
      const task = findTask(id);
      if (!task) return Promise.reject(new ApiError(404, "not_found", "task not found"));
      return delay(newTask(task, [nodeId], "rerun"));
    },
    cancel: (id: string) => {
      const task = findTask(id);
      if (!task) return Promise.reject(new ApiError(404, "not_found", "task not found"));
      if (!["queued", "pending", "leased", "stalled"].includes(task.status)) return Promise.reject(new ApiError(409, "conflict", `a ${task.status} task cannot be cancelled`));
      task.status = "cancelled";
      task.finished_at = new Date().toISOString();
      return delay({ ...task });
    },
    delete: (id: string) => {
      const index = tasks.findIndex((task) => task.id === id);
      if (index < 0) return Promise.reject(new ApiError(404, "not_found", "task not found"));
      tasks.splice(index, 1);
      return delay({ ok: true });
    },
  },
  audit: {
    query: (params?: AuditQuery) =>
      guard(() =>
        FIXTURE === "empty"
          ? delay({ events: [], total: 0, limit: Number(params?.limit ?? 100), offset: Number(params?.offset ?? 0), scanned: 0, complete: true }, 120)
          : delay(
              queryAudit(flags.has("no-audit-exclude") ? { ...params, exclude_action: undefined, exclude_decision: undefined } : (params ?? {})),
              260,
            ),
      ),
    verify: () => guard(() => delay(FIXTURE === "empty" ? { enabled: true, ok: true, count: 0, anchored: false } : AUDIT_VERIFY, 900)),
  },
  capabilities: { list: () => delay({ capabilities: [] }) },
  plugins: { contributions: () => delay([]) },
  terminal: { list: () => delay({ sessions: [] }) },
} as unknown as typeof import("@/lib/api/index").api;
