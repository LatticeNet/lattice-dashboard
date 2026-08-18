/**
 * One node's recent history, merged from every source that records what was
 * done to it.
 *
 * The node page already listed raw audit rows, which answers "what did the
 * server log" and not the question an operator actually arrives with: what
 * happened to this machine, in order. A task run, the approval that authorised
 * a change, and the audit line the change produced are three records of one
 * story, and reading them meant opening three screens and matching timestamps
 * by eye.
 *
 * This model does the merging and nothing else: no formatting, no colors, no
 * i18n. It takes what the API returns and produces a single ordered stream,
 * so the merge rules are testable without a browser.
 */
import type { ApprovalView, AuditEvent, TaskResult, TaskView } from "@/lib/api";

export type TimelineKind = "audit" | "task" | "approval";

export interface TimelineEntry {
  /** Stable across refreshes: source kind plus the source record's own id. */
  id: string;
  kind: TimelineKind;
  /** ISO timestamp this entry is ordered by. */
  at: string;
  /** Machine-readable label: an audit action, a task status, an approval action. */
  action: string;
  /** allow/deny for audit, ok/failed for a task result, the approval's status. */
  outcome: string;
  /** Who caused it, when the source records that. */
  actor?: string;
  /** One line of detail: an audit reason, a task's exit status, a plan target. */
  detail?: string;
  correlationId?: string;
  /** Where clicking should go, when the entry has a page of its own. */
  ref?: { kind: "task" | "approval"; id: string };
}

/** Sort newest first; ties break on id so the order is stable across polls. */
export function sortTimeline(entries: TimelineEntry[]): TimelineEntry[] {
  return [...entries].sort((a, b) => {
    const at = b.at.localeCompare(a.at);
    return at !== 0 ? at : a.id.localeCompare(b.id);
  });
}

export function auditEntries(events: readonly AuditEvent[]): TimelineEntry[] {
  return events.map((event) => ({
    id: `audit:${event.id}`,
    kind: "audit" as const,
    at: event.at,
    action: event.action,
    outcome: event.decision,
    actor: event.actor_id || event.token_id || undefined,
    detail: event.reason || undefined,
    correlationId: event.correlation_id || undefined,
  }));
}

/**
 * A task contributes the run itself and, when this node has a result, what the
 * node actually did. Both are kept: "the run was queued" and "it exited 1 here"
 * are different facts, and collapsing them hides the delay between them.
 */
export function taskEntries(
  nodeId: string,
  tasks: readonly TaskView[],
  results: readonly TaskResult[],
): TimelineEntry[] {
  const entries: TimelineEntry[] = [];
  const mine = tasks.filter((task) => task.targets?.includes(nodeId));
  const byTask = new Map(mine.map((task) => [task.id, task]));
  for (const task of mine) {
    if (!task.created_at) continue;
    entries.push({
      id: `task:${task.id}`,
      kind: "task",
      at: task.created_at,
      action: "task.queued",
      outcome: task.status,
      detail: task.interpreter,
      ref: { kind: "task", id: task.id },
    });
  }
  for (const result of results) {
    if (result.node_id !== nodeId) continue;
    if (!byTask.has(result.task_id)) continue;
    const finished = result.finished_at || result.started_at;
    if (!finished) continue;
    entries.push({
      id: `result:${result.task_id}:${result.node_id}`,
      kind: "task",
      at: finished,
      action: "task.finished",
      outcome: result.exit_code === 0 ? "ok" : "failed",
      detail: result.error || (result.exit_code === 0 ? undefined : `exit ${result.exit_code}`),
      ref: { kind: "task", id: result.task_id },
    });
  }
  return entries;
}

/**
 * Approvals for this node. A plan's own timestamp is when it was proposed;
 * an approval that has since been decided also carries when that happened,
 * and the decision is the more interesting event of the two.
 */
export function approvalEntries(nodeId: string, approvals: readonly ApprovalView[]): TimelineEntry[] {
  return approvals
    .filter((approval) => approval.node_id === nodeId && !!(approval.updated_at || approval.created_at))
    .map((approval) => ({
      id: `approval:${approval.id}`,
      kind: "approval" as const,
      at: (approval.updated_at || approval.created_at) as string,
      action: `${approval.plugin}.${approval.action}`,
      outcome: approval.status,
      actor: approval.approved_by || approval.actor_id || undefined,
      detail: approval.reason || undefined,
      ref: { kind: "approval", id: approval.id },
    }));
}

/**
 * The merged stream, newest first and bounded.
 *
 * The bound is applied after the merge, never per source: taking the newest
 * twenty of each first would silently drop a recent task when audit happened
 * to be chatty, which is exactly the entry an operator is looking for.
 */
export function buildNodeTimeline(input: {
  nodeId: string;
  audit?: readonly AuditEvent[];
  tasks?: readonly TaskView[];
  results?: readonly TaskResult[];
  approvals?: readonly ApprovalView[];
  limit?: number;
}): TimelineEntry[] {
  const merged = [
    ...auditEntries(input.audit ?? []),
    ...taskEntries(input.nodeId, input.tasks ?? [], input.results ?? []),
    ...approvalEntries(input.nodeId, input.approvals ?? []),
  ].filter((entry) => !!entry.at);
  const sorted = sortTimeline(merged);
  return typeof input.limit === "number" ? sorted.slice(0, input.limit) : sorted;
}

/** Calendar-day buckets, in stream order, for a timeline rendered by day. */
export function groupByDay(entries: readonly TimelineEntry[]): { day: string; entries: TimelineEntry[] }[] {
  const days: { day: string; entries: TimelineEntry[] }[] = [];
  for (const entry of entries) {
    const day = entry.at.slice(0, 10);
    const last = days[days.length - 1];
    if (last && last.day === day) last.entries.push(entry);
    else days.push({ day, entries: [entry] });
  }
  return days;
}
