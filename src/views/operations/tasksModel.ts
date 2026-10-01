/**
 * Pure model for the Tasks page (design 23, section 4.3).
 *
 * Two layers on `?view=`: Runs (the default) and New task. Runs lists one
 * server page of what the operator asked for: the query field speaks the
 * shared token grammar, and every key is the task list's own parameter
 * (status, node_id, origin, approval_id), with the range written as `since`.
 * Each row is one attempt: a rerun is its own row and names the run it
 * repeats, so the list counts attempts while the head's failed figure (from
 * the counts read) counts runs with reruns folded in.
 *
 * A row says why a run failed from its results, never from its script: the
 * script body is step-up gated and the list carries only its digest. The
 * results poll asks for the tasks on screen by id, so it never reads the
 * whole result store.
 *
 * Kept free of Vue so `node --test` covers it directly.
 */
import type { TaskListParams, TaskListResponse, TaskListStatus, TaskOrigin, TaskResult, TaskView } from "@/lib/api/types";
import type { QueryRecord, QueryValue } from "@/components/common/tableUrlState";
import type { TokenGrammar, TokenValues } from "@/lib/queryTokens";

export const TASK_LAYERS = ["runs", "new"] as const;
export type TaskLayer = (typeof TASK_LAYERS)[number];

export const TASK_PAGE_SIZE = 50;

/** The statuses GET /api/tasks accepts, in the order the field writes them. */
export const TASK_STATUSES = ["pending", "queued", "leased", "stalled", "failed", "finished", "cancelled", "expired"] as const satisfies readonly TaskListStatus[];

export const TASK_ORIGINS = ["approval", "rerun", "direct"] as const satisfies readonly TaskOrigin[];

/** The server takes at most this many ids in one task_id list. */
export const RESULT_ID_LIMIT = 100;

/** Result rows per page of the results poll; the server's maximum. */
export const RESULT_PAGE_LIMIT = 500;

/**
 * status, node, origin and approval. No free text: the task list has no text
 * search, and a word the server ignores would read as a filter that matched.
 */
export const TASK_GRAMMAR: TokenGrammar = {
  fields: [
    { key: "status", kind: "enum", values: TASK_STATUSES },
    { key: "node", kind: "value", resolve: "node", param: "node_id" },
    { key: "origin", kind: "enum", values: TASK_ORIGINS },
    { key: "approval", kind: "value", param: "approval_id" },
  ],
  flags: [],
  textParam: "q",
};

/** Ranges the task list can answer: it filters on `since` and has no upper bound. */
export const TASK_RANGES = ["1h", "24h", "7d", "30d", "all"] as const;

export interface TaskRequestInput {
  tokens: TokenValues;
  window: { from?: string };
  offset: number;
  limit?: number;
}

/**
 * The one GET /api/tasks a question, a window and a page mean. `limit` is
 * always sent: any parameter selects the paged envelope, and an older server
 * that knows only limit and offset still pages instead of answering every
 * task.
 */
export function taskListRequest(input: TaskRequestInput): TaskListParams {
  const params: TaskListParams = { limit: input.limit ?? TASK_PAGE_SIZE, offset: input.offset };
  const status = input.tokens.enums.status as TaskListStatus[] | undefined;
  const origin = input.tokens.enums.origin as TaskOrigin[] | undefined;
  if (status?.length) params.status = status;
  if (origin?.length) params.origin = origin;
  if (input.tokens.values.node) params.node_id = input.tokens.values.node;
  if (input.tokens.values.approval) params.approval_id = input.tokens.values.approval;
  if (input.window.from) params.since = input.window.from;
  return params;
}

function lastChange(task: TaskView): number {
  return Math.max(0, ...[task.created_at, task.started_at, task.finished_at].map((at) => (at ? Date.parse(at) || 0 : 0)));
}

/** Whether a row answers the question; used where the server did not filter. */
export function taskMatches(task: TaskView, params: TaskListParams): boolean {
  const statuses = params.status === undefined ? [] : Array.isArray(params.status) ? params.status : [params.status];
  const origins = params.origin === undefined ? [] : Array.isArray(params.origin) ? params.origin : [params.origin];
  if (statuses.length && !statuses.includes(task.status)) return false;
  if (origins.length && !origins.includes(task.origin ?? "direct")) return false;
  if (params.node_id && !task.targets.includes(params.node_id)) return false;
  if (params.approval_id && task.approval_id !== params.approval_id) return false;
  if (params.since && lastChange(task) < Date.parse(params.since)) return false;
  return true;
}

export interface TaskPage {
  tasks: TaskView[];
  total: number;
  /** The server filtered and paged; false when the console had to (an older server). */
  serverFiltered: boolean;
}

/**
 * One page, whatever the server answered. A server from before the list
 * filters answers every task as a bare array; the page then filters and
 * pages on its own, so an older control plane still shows the right rows.
 * A server that has the filters but not approval_id pages every task under
 * a lone approval_id; rows are checked against it either way.
 */
export function normalizeTaskPage(response: TaskListResponse | TaskView[] | { tasks: TaskView[] }, params: TaskListParams): TaskPage {
  const offset = params.offset ?? 0;
  const limit = params.limit ?? TASK_PAGE_SIZE;
  if (Array.isArray(response) || !("total" in response)) {
    const rows = (Array.isArray(response) ? response : response.tasks ?? []).filter((task) => taskMatches(task, params));
    return { tasks: rows.slice(offset, offset + limit), total: rows.length, serverFiltered: false };
  }
  const tasks = response.tasks ?? [];
  if (params.approval_id && tasks.some((task) => task.approval_id !== params.approval_id)) {
    const rows = tasks.filter((task) => task.approval_id === params.approval_id);
    return { tasks: rows, total: rows.length, serverFiltered: false };
  }
  return { tasks, total: response.total, serverFiltered: true };
}

/** The results poll for the rows on screen: their ids, no bodies, one page. */
export function resultsRequest(taskIds: readonly string[], offset = 0): { task_id: string; omit_output: number; limit: number; offset: number } {
  return { task_id: taskIds.slice(0, RESULT_ID_LIMIT).join(","), omit_output: 1, limit: RESULT_PAGE_LIMIT, offset };
}

/** Pages of results the poll reads before it stops (2,000 rows at the server's maximum page). */
export const RESULT_PAGES_READ = 4;

export interface ResultPages {
  results: TaskResult[];
  /**
   * The server had more rows than the poll read. A row whose targets have
   * not all reported may then have a failure nobody read, so it must not be
   * shown as passed.
   */
  truncated: boolean;
  /** Result rows the server sent, for every id asked (what the cap counts). */
  rowsRead: number;
}

/**
 * Every result for the rows on screen, page after page, up to `maxPages`.
 * A page of 50 fan-outs can hold more than one page of results. A bare
 * array (an older server) is the whole answer.
 */
export async function readResultPages(
  ids: readonly string[],
  read: (offset: number) => Promise<TaskResult[] | { results?: TaskResult[]; total?: number }>,
  maxPages = RESULT_PAGES_READ,
): Promise<ResultPages> {
  if (!ids.length) return { results: [], truncated: false, rowsRead: 0 };
  const wanted = new Set(ids);
  const results: TaskResult[] = [];
  let offset = 0;
  for (let page = 0; page < maxPages; page += 1) {
    const response = await read(offset);
    const rows = Array.isArray(response) ? response : (response.results ?? []);
    results.push(...rows.filter((row) => wanted.has(row.task_id)));
    if (Array.isArray(response)) return { results, truncated: false, rowsRead: rows.length };
    offset += rows.length;
    if (!rows.length || offset >= (response.total ?? offset)) return { results, truncated: false, rowsRead: offset };
  }
  return { results, truncated: true, rowsRead: offset };
}

/** Rows per page when the sheet walks the list for one run. */
export const TASK_LOOKUP_PAGE = 500;

type TaskListAnswer = TaskListResponse | TaskView[] | { tasks?: TaskView[] };

/**
 * Find one run by id for the sheet, when it is not on the page on screen.
 * The task list has no id filter, so this walks it, newest first,
 * TASK_LOOKUP_PAGE rows at a time. A run found before (`hint`) is looked for
 * first on a narrower question that must still contain it, its first target
 * and changed since it was queued (`since` is inclusive and a run's last
 * change is never before its queue time), so a refresh reads one short page
 * instead of walking again. The full walk is the fallback, for an older
 * server that ignores the filters or a run that is gone.
 */
export async function findTask(
  read: (params: TaskListParams) => Promise<TaskListAnswer>,
  id: string,
  hint?: TaskView | null,
  maxPages = 10,
): Promise<TaskView | null> {
  async function walk(base: TaskListParams): Promise<TaskView | null> {
    for (let offset = 0, page = 0; page < maxPages; page += 1) {
      const response = await read({ ...base, limit: TASK_LOOKUP_PAGE, offset });
      const list = Array.isArray(response) ? response : (response.tasks ?? []);
      const found = list.find((task) => task.id === id);
      if (found) return found;
      if (Array.isArray(response) || !("total" in response)) return null;
      offset += list.length;
      if (!list.length || offset >= response.total) return null;
    }
    return null;
  }
  const first = hint?.id === id ? hint.targets[0] : undefined;
  if (first && hint?.created_at) {
    const found = await walk({ node_id: first, since: hint.created_at });
    if (found) return found;
  }
  return walk({});
}

export function resultFailed(result: Pick<TaskResult, "error" | "exit_code">): boolean {
  return !!result.error || (result.exit_code ?? 0) !== 0;
}

/** The newest result per node for one task. */
export function latestByNode(results: readonly TaskResult[]): Map<string, TaskResult> {
  const out = new Map<string, TaskResult>();
  const time = (r: TaskResult) => (r.finished_at ? Date.parse(r.finished_at) || 0 : 0);
  for (const result of results) {
    const held = out.get(result.node_id);
    if (!held || time(result) >= time(held)) out.set(result.node_id, result);
  }
  return out;
}

export interface RunSummary {
  /** Distinct targets. */
  total: number;
  /** Targets that answered. */
  reported: number;
  passed: number;
  failed: number;
  /** The first failing target in target order, for the row's reason. */
  firstFailure?: { nodeId: string; result: TaskResult };
}

export function runSummary(task: Pick<TaskView, "targets">, results: readonly TaskResult[]): RunSummary {
  const latest = latestByNode(results);
  const targets = [...new Set(task.targets)];
  let passed = 0;
  let failed = 0;
  let firstFailure: RunSummary["firstFailure"];
  for (const nodeId of targets) {
    const result = latest.get(nodeId);
    if (!result) continue;
    if (resultFailed(result)) {
      failed += 1;
      firstFailure ??= { nodeId, result };
    } else passed += 1;
  }
  return { total: targets.length, reported: passed + failed, passed, failed, firstFailure };
}

/**
 * Why a target failed, in one line: the exit code, then the agent's error or
 * the first stderr line ("exit 127: sh: 1: curl: not found"). Without
 * either (an older server sends no stderr_head) the exit code stands alone.
 */
export function failureReason(result: Pick<TaskResult, "exit_code" | "error" | "stderr_head" | "stderr">, exitWord: (code: number) => string): string {
  const exit = exitWord(result.exit_code ?? 0);
  const firstStderr = (result.stderr ?? "").split("\n").map((line) => line.trim()).find(Boolean);
  const detail = (result.error ?? "").trim() || (result.stderr_head ?? "").trim() || firstStderr || "";
  return detail ? `${exit}: ${detail}` : exit;
}

/** A run that can still change on its own: waiting, running or stalled. */
export function taskLive(status: TaskView["status"]): boolean {
  return status === "queued" || status === "pending" || status === "leased" || status === "stalled";
}

/** Statuses the server cancels: every live run (nothing ran yet, or nothing is answering). */
export function taskCancellable(status: TaskView["status"]): boolean {
  return taskLive(status);
}

/**
 * An old link: the node page and older consoles linked `/tasks?id=<task>`.
 * Returns the query with the id moved to `open`, or null when there is
 * nothing to move.
 */
export function legacyOpenQuery(query: QueryRecord): Record<string, QueryValue> | null {
  const raw = query.id;
  const id = (Array.isArray(raw) ? raw.find((v) => typeof v === "string") : raw)?.trim();
  if (!id) return null;
  const next: Record<string, QueryValue> = {};
  for (const [key, value] of Object.entries(query)) {
    if (key === "id" || value === undefined) continue;
    next[key] = value;
  }
  if (!next.open) next.open = id;
  return next;
}

