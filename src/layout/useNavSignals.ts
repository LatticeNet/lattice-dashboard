/**
 * Feeds the sidebar's signals.
 *
 * Deliberately one shared poller rather than a subscription per nav item: the
 * console already polls these three collections on their own pages, and a
 * sidebar that added a fourth request per page would make the nav the most
 * expensive thing on screen.
 *
 * Every read is soft. A denied scope or a transient failure leaves the count
 * undefined, and an undefined count shows nothing. The nav degrades to what it
 * was rather than claiming a fleet is healthy because it could not look.
 */
import { computed } from "vue";

import { api, unwrap } from "@/lib/api";
import { countNodeStatuses } from "@/lib/nodeStatus";
import type { ApprovalCounts, Node, TaskCounts } from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { useAuthStore } from "@/stores/auth";
import { buildNavSignals, type NavSignal } from "./navSignals";

const SIGNAL_POLL_MS = 30000;

export function useNavSignals() {
  const auth = useAuthStore();

  const soft = <T>(load: () => Promise<T>) => async (): Promise<T | undefined> => {
    try {
      return await load();
    } catch {
      return undefined;
    }
  };

  const nodes = useAsyncData<Node[] | undefined>(
    soft(() => (auth.can("node:read") ? api.nodes.list().then((r) => unwrap(r, "nodes")) : Promise.resolve(undefined))),
    { pollInterval: SIGNAL_POLL_MS },
  );
  // Counts only. The sidebar used to read the whole listing, plan text and
  // all, every thirty seconds, on every page; the count it wanted is a few
  // hundred bytes. Stale agent updates are counted under "stale", not
  // "pending", so this is the same number the Approvals page calls needs
  // review.
  const approvals = useAsyncData<ApprovalCounts | undefined>(
    soft(() => api.approvals.counts()),
    { pollInterval: SIGNAL_POLL_MS },
  );
  // Counts only, from the server. The sidebar used to read all 1,771 tasks
  // every thirty seconds to count three statuses, and its failed figure
  // counted every failure ever, so the badge never cleared. failed_24h moves.
  // An older server without the counts read answers 404, and the badge says
  // nothing rather than guess.
  const tasks = useAsyncData<TaskCounts | undefined>(
    soft(() => (auth.can("task:read") ? api.tasks.counts() : Promise.resolve(undefined))),
    { pollInterval: SIGNAL_POLL_MS },
  );

  const signals = computed<Record<string, NavSignal>>(() => {
    const nodeRows = nodes.data.value;
    const approvalCounts = approvals.data.value;
    const taskCounts = tasks.data.value;
    return buildNavSignals({
      // "Not reporting" is offline plus never reported, by the same status
      // word every page prints. Disabled is off on purpose and degraded still
      // answers, so neither is a fault here.
      nodesOffline: nodeRows ? (() => {
        const c = countNodeStatuses(nodeRows);
        return c.offline + c.never_reported;
      })() : undefined,
      nodesTotal: nodeRows?.length,
      approvalsPending: approvalCounts?.pending,
      tasksFailed: taskCounts?.failed_24h,
      tasksStalled: taskCounts?.stalled,
      // Rows stored as pending were never delivered; they wait like queued ones.
      tasksQueued: taskCounts ? taskCounts.queued + (taskCounts.pending ?? 0) : undefined,
    });
  });

  return { signals };
}
