/**
 * How far a leased task has got on one node, and how to say it.
 *
 * The Tasks page showed one "leased" row from August while the node behind it
 * restarted its agent every six minutes for six days (KI-20). The row was not
 * wrong, it was silent: nothing said how long the lease had been held or how
 * many times the task had been handed out. The server now counts attempts and
 * stops after three; this is the client half, which turns those numbers into
 * the one line an operator needs on the row: "leased 41 min, attempt 2 of 3",
 * or the reason the store gave up.
 *
 * The server sends the fields only for leased tasks and only once it counts
 * attempts, so everything here returns undefined for an older server and the
 * views render exactly what they rendered before.
 *
 * No i18n and no formatting library: the rules are testable on bare node. The
 * one formatted piece, the lease age, is built here because the row needs a
 * short unit ("41 min") rather than the "41m" the dashboard uses in tables.
 */
import type { TaskView } from "@/lib/api";

export interface TaskLeaseProgress {
  /** Per-target status when the server sent one; the row's status otherwise. */
  status?: string;
  /** Leases issued to this node so far, the current one included. */
  attempts: number;
  /** How many the server allows before it stops re-leasing. */
  maxAttempts: number;
  /** Age of the current (or last) lease; absent when the node was never leased. */
  leaseAgeSeconds?: number;
  /** Why the store stopped re-leasing this target, verbatim from the server. */
  stalledReason?: string;
}

/**
 * Lease progress for one node of a task.
 *
 * Prefers the per-target record; falls back to the task-level scalars, which
 * the server fills only for single-target tasks, so the fallback is taken only
 * when the task has one target or the caller did not name one.
 */
export function taskLeaseProgress(task: TaskView, nodeId?: string): TaskLeaseProgress | undefined {
  const perTarget = nodeId ? task.target_states?.[nodeId] : undefined;
  if (perTarget) {
    if (!perTarget.attempts && !perTarget.stalled_reason) return undefined;
    return {
      status: perTarget.status,
      attempts: perTarget.attempts ?? 0,
      maxAttempts: perTarget.max_attempts ?? 0,
      leaseAgeSeconds: perTarget.lease_age_seconds,
      stalledReason: perTarget.stalled_reason || undefined,
    };
  }
  const single = (task.targets ?? []).length === 1;
  if (nodeId && !single) return undefined;
  if (!task.attempts && !task.stalled_reason) return undefined;
  return {
    attempts: task.attempts ?? 0,
    maxAttempts: task.max_attempts ?? 0,
    leaseAgeSeconds: task.lease_age_seconds,
    stalledReason: task.stalled_reason || undefined,
  };
}

/**
 * A lease age short enough for a table cell: "30 s", "41 min", "2 h 5 min",
 * "6 d 2 h". Two units at most, because the third never changes a decision.
 */
export function formatLeaseAge(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (d > 0) return h > 0 ? `${d} d ${h} h` : `${d} d`;
  if (h > 0) return m > 0 ? `${h} h ${m} min` : `${h} h`;
  if (m > 0) return `${m} min`;
  return `${total} s`;
}

/** The translated fragments the label is built from; the views pass `t`. */
export interface LeaseLabelText {
  leasedFor: (age: string) => string;
  attemptOf: (attempt: number, max: number) => string;
}

/**
 * The inline label for a row: "leased 41 min, attempt 2 of 3" while a lease
 * is held, the stalled reason once the store has given up (with the attempt
 * count kept, because "3 of 3" is the evidence for the reason), and nothing
 * at all when there is nothing to say.
 */
export function leaseAttemptLabel(progress: TaskLeaseProgress | undefined, text: LeaseLabelText): string {
  if (!progress) return "";
  const parts: string[] = [];
  if (progress.stalledReason) {
    parts.push(progress.stalledReason);
  } else if (progress.leaseAgeSeconds !== undefined) {
    parts.push(text.leasedFor(formatLeaseAge(progress.leaseAgeSeconds)));
  }
  if (progress.attempts > 0 && progress.maxAttempts > 0) {
    parts.push(text.attemptOf(progress.attempts, progress.maxAttempts));
  }
  return parts.join(", ");
}
