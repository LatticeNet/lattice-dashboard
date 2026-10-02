/**
 * Pure model for Agent Updates (design 23, section 4.5): which agent each
 * node runs, against the latest stable release, and which nodes a bulk plan
 * would cover. Kept free of Vue so `node --test` covers it directly.
 *
 * What a node runs comes from `Node.agent_version` (the node's own report),
 * never from a policy's last applied version, which is only written when a
 * plan through that policy confirmed.
 */

/** "v0.3.9" and " 0.3.9 " are the same release. */
export function normalizeAgentVersion(version: string | undefined): string {
  return (version ?? "").trim().replace(/^v(?=\d)/i, "");
}

function parts(version: string): { core: number[]; pre: string } {
  const release = version.split("+", 1)[0] ?? "";
  const dash = release.indexOf("-");
  const main = dash < 0 ? release : release.slice(0, dash);
  const pre = dash < 0 ? "" : release.slice(dash + 1);
  return { core: main.split(".").map((part) => Number.parseInt(part, 10) || 0), pre };
}

/**
 * Order two agent versions: negative when `a` is older. Numeric on the dotted
 * core; a prerelease sorts before its release (0.3.9-alpha.1 < 0.3.9), and
 * two prereleases compare by their tags, numerically where they are numbers.
 * Build metadata after "+" never orders a release (0.3.9+abc123 = 0.3.9).
 */
export function compareAgentVersion(a: string, b: string): number {
  const left = parts(normalizeAgentVersion(a));
  const right = parts(normalizeAgentVersion(b));
  const length = Math.max(left.core.length, right.core.length);
  for (let index = 0; index < length; index += 1) {
    const diff = (left.core[index] ?? 0) - (right.core[index] ?? 0);
    if (diff !== 0) return diff;
  }
  if (left.pre === right.pre) return 0;
  if (!left.pre) return 1;
  if (!right.pre) return -1;
  return left.pre.localeCompare(right.pre, undefined, { numeric: true });
}

export type AgentStanding = "current" | "behind" | "ahead" | "unknown";

/** Where a node stands against the latest release; unknown when either side was not read. */
export function agentStanding(nodeVersion: string | undefined, latest: string | undefined): AgentStanding {
  const running = normalizeAgentVersion(nodeVersion);
  const target = normalizeAgentVersion(latest);
  if (!running || !target) return "unknown";
  const order = compareAgentVersion(running, target);
  if (order === 0) return "current";
  return order < 0 ? "behind" : "ahead";
}

export interface VersionSlice {
  /** The normalized version, or "" for nodes that report none. */
  version: string;
  count: number;
  standing: AgentStanding;
}

/** The version bar: newest first, nodes that report no version last. */
export function versionDistribution(versions: ReadonlyArray<string | undefined>, latest: string | undefined): VersionSlice[] {
  const counts = new Map<string, number>();
  for (const raw of versions) {
    const version = normalizeAgentVersion(raw);
    counts.set(version, (counts.get(version) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([version, count]) => ({ version, count, standing: version ? agentStanding(version, latest) : ("unknown" as AgentStanding) }))
    .sort((a, b) => {
      if (!a.version) return 1;
      if (!b.version) return -1;
      return compareAgentVersion(b.version, a.version);
    });
}

export interface BulkPlanInput<P> {
  nodeId: string;
  version?: string;
  policy?: P;
}

export interface BulkPlan<P> {
  /** Behind nodes with a policy: one plan each. */
  plan: Array<BulkPlanInput<P> & { policy: P }>;
  /** Behind nodes without a policy: nothing to plan from. */
  skipped: BulkPlanInput<P>[];
}

/** Which behind nodes "Plan behind nodes" files a plan for, and which it cannot. */
export function bulkPlan<P>(rows: ReadonlyArray<BulkPlanInput<P>>, latest: string | undefined): BulkPlan<P> {
  const out: BulkPlan<P> = { plan: [], skipped: [] };
  for (const row of rows) {
    if (agentStanding(row.version, latest) !== "behind") continue;
    if (row.policy) out.plan.push(row as BulkPlanInput<P> & { policy: P });
    else out.skipped.push(row);
  }
  return out;
}

// ── reads that failed say so ─────────────────────────────────────────────────

/** Which of the page's reads has landed at least once. */
export interface FleetReads {
  nodesRead: boolean;
  policiesRead: boolean;
  /** The latest stable release, when the release read landed. */
  latest?: string;
}

/** Why "Plan behind nodes" cannot plan, in the order the page names it. */
export type BulkBlock = "noNodes" | "noLatest" | "noPolicies" | "none";

export interface BulkButtonState {
  /** The button prints its count only when every input was read. */
  counted: boolean;
  disabled: boolean;
  block?: BulkBlock;
}

/**
 * The head button. Behind needs the node list and the latest release, and a
 * plan needs a policy; while any of the three is unread a count would be a
 * claim about the fleet nobody read, so the button carries none and names the
 * read that failed.
 */
export function bulkButtonState(reads: FleetReads, planCount: number): BulkButtonState {
  const counted = reads.nodesRead && reads.policiesRead && !!reads.latest;
  let block: BulkBlock | undefined;
  if (!reads.nodesRead) block = "noNodes";
  else if (!reads.latest) block = "noLatest";
  else if (!reads.policiesRead) block = "noPolicies";
  else if (!planCount) block = "none";
  return { counted, disabled: !counted || !planCount, block };
}

export interface FleetCells {
  runs: "version" | "notReported" | "notRead";
  target: "policy" | "noPolicy" | "notRead";
  policy: "policy" | "none" | "notRead";
  lastPlanned: "time" | "never" | "notRead";
}

/** What each cell of a node's row may say, given which reads landed. */
export function fleetCells(
  row: { version?: string; policy?: { last_planned_at?: string | null } },
  reads: Pick<FleetReads, "nodesRead" | "policiesRead">,
): FleetCells {
  const runs = !reads.nodesRead ? "notRead" : row.version ? "version" : "notReported";
  if (row.policy) {
    return { runs, target: "policy", policy: "policy", lastPlanned: row.policy.last_planned_at ? "time" : "never" };
  }
  if (!reads.policiesRead) return { runs, target: "notRead", policy: "notRead", lastPlanned: "notRead" };
  return { runs, target: "noPolicy", policy: "none", lastPlanned: "never" };
}

/**
 * Which read the table's "could not refresh, showing the last data" banner
 * speaks for. It speaks only for a read that once succeeded; a read that
 * never landed shows as "not read" in its cells and the proof line instead,
 * and with neither read landed the table shows the failure itself.
 */
export function tableErrorSource(state: {
  nodesRead: boolean;
  nodesFailed: boolean;
  policiesRead: boolean;
  policiesFailed: boolean;
}): "nodes" | "policies" | null {
  if (!state.nodesRead && !state.policiesRead) return state.nodesFailed ? "nodes" : state.policiesFailed ? "policies" : null;
  if (state.nodesRead && state.nodesFailed) return "nodes";
  if (state.policiesRead && state.policiesFailed) return "policies";
  return null;
}
