/**
 * What the sidebar knows about where you need to go.
 *
 * A navigation that only says where you CAN go makes an operator open four
 * pages to find the one thing that needs them. The console already knows: an
 * approval is waiting, three nodes stopped reporting, a task failed. Surfacing
 * that on the nav item is the difference between a directory and a control
 * plane you can run a fleet from.
 *
 * Rules this file exists to keep honest:
 *  - Nothing is shown until the data has actually loaded. A silent zero and an
 *    unknown are different states, and a nav that reads "0 pending" before the
 *    first response is lying with a number.
 *  - Zero is not a signal. A badge that is always there stops being read.
 *  - Severity is the point, not the count: something failing outranks something
 *    waiting, because that is the order an operator should walk them in.
 */

export type SignalTone = "attention" | "warning";

export interface NavSignal {
  /** How many things are in this state. Rendered as a number when small. */
  count: number;
  tone: SignalTone;
  /** Read aloud, and shown in the collapsed rail's tooltip. */
  label: string;
}

export interface SignalInputs {
  /** undefined means "not loaded yet" for each source, and stays silent. */
  approvalsPending?: number;
  nodesOffline?: number;
  nodesTotal?: number;
  tasksFailed?: number;
  tasksQueued?: number;
}

/** Counts above this are shown as "99+": the exact number stops mattering. */
export const MAX_BADGE = 99;

export function formatBadge(count: number): string {
  return count > MAX_BADGE ? `${MAX_BADGE}+` : String(count);
}

/**
 * Signals keyed by nav item name, matching the router's `name` field so the
 * sidebar can look one up without knowing anything about what produced it.
 */
export function buildNavSignals(input: SignalInputs): Record<string, NavSignal> {
  const signals: Record<string, NavSignal> = {};

  if (typeof input.approvalsPending === "number" && input.approvalsPending > 0) {
    signals.approvals = {
      count: input.approvalsPending,
      // Waiting on a human is not a fault; it is work queued for them.
      tone: "warning",
      label: `${input.approvalsPending} awaiting a decision`,
    };
  }

  if (typeof input.nodesOffline === "number" && input.nodesOffline > 0) {
    signals.nodes = {
      count: input.nodesOffline,
      tone: "attention",
      label: `${input.nodesOffline} not reporting`,
    };
  }

  if (typeof input.tasksFailed === "number" && input.tasksFailed > 0) {
    signals.tasks = {
      count: input.tasksFailed,
      tone: "attention",
      label: `${input.tasksFailed} failed`,
    };
  } else if (typeof input.tasksQueued === "number" && input.tasksQueued > 0) {
    // Queued work is worth knowing about, but never at the expense of hiding a
    // failure: a failure replaces it rather than adding a second badge.
    signals.tasks = {
      count: input.tasksQueued,
      tone: "warning",
      label: `${input.tasksQueued} queued`,
    };
  }

  return signals;
}

/**
 * The signal a collapsed SECTION should show: the worst of its children.
 *
 * With the section shut, its items are invisible, and a section that stays
 * quiet while something inside it is failing is exactly how the collapse
 * becomes a place things go to be forgotten.
 */
export function sectionSignal(
  signals: Readonly<Record<string, NavSignal>>,
  itemNames: readonly string[],
): NavSignal | undefined {
  let worst: NavSignal | undefined;
  let total = 0;
  for (const name of itemNames) {
    const signal = signals[name];
    if (!signal) continue;
    total += signal.count;
    if (!worst || (signal.tone === "attention" && worst.tone !== "attention")) worst = signal;
  }
  if (!worst) return undefined;
  return { count: total, tone: worst.tone, label: worst.label };
}
