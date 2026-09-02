/**
 * What is still waiting to run on one node.
 *
 * The node timeline already answers "what happened here, in order", which is a
 * question about the past. It does not answer the one an operator arrives with
 * when a machine has been down: what is queued against it, and in what order
 * will it run when the machine comes back. Those entries are in the timeline,
 * but interleaved with everything that already finished, so the pending set has
 * to be reconstructed by eye.
 *
 * A task is fanned out to many nodes at once, so "waiting" is a property of the
 * task, not of this node's row in it: a task that is still queued is waiting for
 * every target that has not reported. A leased task has been handed to an agent
 * and is running now.
 *
 * Ordering is oldest first, because that is the order the agent will take them
 * in. Everywhere else in this app newest is first; the queue is the exception
 * precisely because it is a plan rather than a record.
 *
 * No formatting, no colors, no i18n: the rules are testable without a browser.
 */
import type { TaskView } from "@/lib/api";
import { taskLeaseProgress, type TaskLeaseProgress } from "@/lib/taskLease";

/**
 * Statuses that mean the task has not finished on this node yet. Stalled is
 * in the set on purpose: a task the store gave up re-leasing is not going to
 * run, but hiding it from the node page is exactly how six days of agent
 * restarts went unseen (KI-20). It is shown, marked, and counted separately.
 */
const PENDING_STATUSES = new Set(["queued", "leased", "stalled"]);

export interface NodeQueueEntry {
  id: string;
  status: TaskView["status"];
  /** True once an agent holds the lease, i.e. it is running rather than waiting. */
  running: boolean;
  /** True when the store stopped waiting on this node: nothing runs, nothing will. */
  stalled: boolean;
  /** Attempt count, lease age and stall reason for this node, when the server sends them. */
  lease?: TaskLeaseProgress;
  interpreter: string;
  createdAt: string;
  startedAt?: string;
  /** How many nodes this task targets; 1 means it was aimed at this node alone. */
  targetCount: number;
  /** Set when the task exists only because an approval authorised it. */
  approvalId?: string;
  scriptSizeBytes?: number;
  timeoutSec?: number;
}

export interface NodeQueue {
  entries: NodeQueueEntry[];
  queued: number;
  running: number;
  stalled: number;
}

/**
 * Pending tasks for one node, oldest first.
 *
 * Filtering by target here rather than trusting the caller keeps the rule in one
 * place: the tasks endpoint can be asked for a node, but the unfiltered list is
 * also a legitimate source and the node page already holds one.
 */
export function buildNodeQueue(tasks: TaskView[], nodeId: string): NodeQueue {
  const id = (nodeId ?? "").trim();
  if (!id) return { entries: [], queued: 0, running: 0, stalled: 0 };

  const entries = tasks
    .filter((task) => PENDING_STATUSES.has(task.status))
    .filter((task) => (task.targets ?? []).includes(id))
    .map<NodeQueueEntry>((task) => {
      // A fan-out is "leased" while any node still runs it, so this node's own
      // record decides between running and stalled when the server sends one.
      const lease = taskLeaseProgress(task, id);
      const status = lease?.status === "stalled" || lease?.status === "leased" ? lease.status : task.status;
      return {
        id: task.id,
        status,
        running: status === "leased",
        stalled: status === "stalled",
        lease,
        interpreter: task.interpreter ?? "",
        createdAt: task.created_at ?? "",
        startedAt: task.started_at,
        targetCount: (task.targets ?? []).length,
        approvalId: task.approval_id,
        scriptSizeBytes: task.script_size_bytes,
        timeoutSec: task.timeout_sec,
      };
    })
    .sort(compareByRunThenAge);

  return {
    entries,
    queued: entries.filter((entry) => !entry.running && !entry.stalled).length,
    running: entries.filter((entry) => entry.running).length,
    stalled: entries.filter((entry) => entry.stalled).length,
  };
}

/**
 * Running first, then oldest queued first.
 *
 * A task the agent already holds is the one producing output right now, so it
 * belongs at the top whatever its age. The rest follow in the order they will be
 * taken. A missing created_at sorts last rather than first: an entry with no
 * time is not evidence that it is the oldest.
 */
function compareByRunThenAge(a: NodeQueueEntry, b: NodeQueueEntry): number {
  if (a.running !== b.running) return a.running ? -1 : 1;
  if (!a.createdAt) return b.createdAt ? 1 : 0;
  if (!b.createdAt) return -1;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : 1;
}
