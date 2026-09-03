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
 * It also owns the one thing a task state maps to on screen: its semantic
 * colour. Tasks and the node queue used to keep private copies of that table
 * and they had drifted, so the same target read amber "Stalled" on one page
 * and red "Stalled" on the other. One table, both pages.
 *
 * No i18n and no formatting library: the rules are testable on bare node. The
 * one formatted piece, the lease age, is built here because the row needs a
 * short unit ("41 min") rather than the "41m" the dashboard uses in tables;
 * the unit words come from the caller so a Chinese console does not read
 * "已租出 41 min".
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
    // A record with no attempts still carries this node's own status, which
    // is what tells a never-leased or already-finished target apart from the
    // fan-out's "leased"; the label just has nothing to say for it.
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
 * The unit words a lease age is spelled with, one function per unit so a
 * locale can put the number wherever its grammar wants it. English is the
 * default so the pure rules stay testable without a message catalogue.
 */
export interface DurationText {
  days: (n: number) => string;
  hours: (n: number) => string;
  minutes: (n: number) => string;
  seconds: (n: number) => string;
}

export const EN_DURATION: DurationText = {
  days: (n) => `${n} d`,
  hours: (n) => `${n} h`,
  minutes: (n) => `${n} min`,
  seconds: (n) => `${n} s`,
};

/**
 * A lease age short enough for a table cell: "30 s", "41 min", "2 h 5 min",
 * "6 d 2 h". Two units at most, because the third never changes a decision.
 */
export function formatLeaseAge(seconds: number, text: DurationText = EN_DURATION): string {
  const total = Math.max(0, Math.floor(seconds));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (d > 0) return h > 0 ? `${text.days(d)} ${text.hours(h)}` : text.days(d);
  if (h > 0) return m > 0 ? `${text.hours(h)} ${text.minutes(m)}` : text.hours(h);
  if (m > 0) return text.minutes(m);
  return text.seconds(total);
}

/** The translated fragments the label is built from; the views pass `t`. */
export interface LeaseLabelText {
  leasedFor: (age: string) => string;
  attemptOf: (attempt: number, max: number) => string;
  /** Unit words for the lease age. English when the caller does not say. */
  duration?: DurationText;
  /** What a stalled target says when the server sent no reason of its own. */
  stalledNoLease?: string;
}

/**
 * Strip the punctuation a sentence ends on so the attempt count can be joined
 * to it with a comma.
 *
 * `stalled_reason` arrives from the server as a finished sentence, and pasting
 * ", attempt 3 of 3" after it produced "...08:51:00Z)., attempt 3 of 3". Both
 * scripts are handled because the reason is passed through verbatim and a
 * Chinese server writes the full stop as a different character.
 */
function unterminate(sentence: string): string {
  return sentence.replace(/[\s.;,\u3002\uFF1B\uFF0C]+$/u, "");
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
    parts.push(unterminate(progress.stalledReason));
  } else if (progress.leaseAgeSeconds !== undefined) {
    parts.push(text.leasedFor(formatLeaseAge(progress.leaseAgeSeconds, text.duration ?? EN_DURATION)));
  }
  if (progress.attempts > 0 && progress.maxAttempts > 0) {
    parts.push(text.attemptOf(progress.attempts, progress.maxAttempts));
  }
  return parts.join(", ");
}

/**
 * Everything a stalled target has to say, said once.
 *
 * The row used to print the badge word, then the server's reason, then the
 * attempt count, then a generic sentence that restated the reason: "Stalled",
 * "stopped re-leasing after 3 attempts (...)", "attempt 3 of 3", "Nothing is
 * running this and no result arrived". The server's account is the specific
 * one and wins; the generic sentence is what a server too old to send a reason
 * falls back to.
 */
export function stalledText(progress: TaskLeaseProgress | undefined, text: LeaseLabelText): string {
  return leaseAttemptLabel(progress, text) || text.stalledNoLease || "";
}

/* ------------------------------------------------------------------ */
/* Task state -> semantic colour. The only table.                      */
/* ------------------------------------------------------------------ */

/** Every state a task, or one node's share of a task, can be in. */
export type TaskRunState = "queued" | "leased" | "finished" | "failed" | "cancelled" | "expired" | "stalled";

/** Badge variants that really exist; mirrors `badgeVariants.ts` so it cannot drift. */
export type TaskStateVariant = "default" | "secondary" | "destructive" | "outline" | "warning";

export interface TaskStateStyle {
  /** Bind straight to `<Badge :variant>`. */
  variant: TaskStateVariant;
  /** Foreground class for prose that carries the same state. */
  textClass: string;
}

/**
 * One semantic token per state, for every surface that prints one.
 *
 * - `failed` is the only destructive state: something ran and came back wrong.
 * - `stalled` is warning, not destructive. Nothing broke; the store stopped
 *   re-leasing and the run needs a person. That is the same weight `degraded`
 *   carries in the node ontology.
 * - `leased` is neutral rather than amber: work in progress is not a warning.
 *   The node queue painted it amber and made every running task look wrong.
 * - `cancelled` and `expired` are the deliberate stops, and read alike.
 * - `queued` is the only outline state: nothing has started yet.
 */
const TASK_STATE_STYLE: Record<TaskRunState, TaskStateStyle> = {
  finished: { variant: "default", textClass: "text-muted-foreground" },
  failed: { variant: "destructive", textClass: "text-destructive" },
  stalled: { variant: "warning", textClass: "text-warning" },
  leased: { variant: "secondary", textClass: "text-muted-foreground" },
  cancelled: { variant: "secondary", textClass: "text-muted-foreground" },
  expired: { variant: "secondary", textClass: "text-muted-foreground" },
  queued: { variant: "outline", textClass: "text-muted-foreground" },
};

/** Colour for a task state. An unknown word from a newer server reads as queued. */
export function taskStateStyle(state: string): TaskStateStyle {
  return { ...(TASK_STATE_STYLE[state as TaskRunState] ?? TASK_STATE_STYLE.queued) };
}
