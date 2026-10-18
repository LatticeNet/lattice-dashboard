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

// ── the last fetch a node reported ───────────────────────────────────────────

/** One fetch as `last_fetch.fetches` carries it (lattice-sdk model.AgentUpdateFetchAttempt). */
export interface FetchAttemptLike {
  source?: number;
  second_pass?: boolean;
  kind: string;
  exit_code: number;
  bytes: number;
  seconds?: number | null;
  /** Chunks this fetch wrote that failed the plan's chunk manifest (design 31 S5); absent when none did. */
  bad_chunks?: number;
}

/** A policy's `last_fetch` (lattice-sdk model.AgentUpdateFetch). */
export interface FetchRecordLike {
  fetches?: readonly FetchAttemptLike[] | null;
  exit_code: number;
  stage: string;
}

/**
 * How the script ended. "kept" is a success with no fetch: a file an earlier
 * attempt kept already held the pinned bytes.
 */
export type FetchOutcome = "installed" | "kept" | "failed";

/** The stages the script names, in its order; any other is shown as it came. */
export const FETCH_STAGES = ["prepare", "fetch", "verify", "unpack", "install", "done"] as const;
export type FetchStage = (typeof FETCH_STAGES)[number];

/**
 * The source kinds the script names, with the message key each reads under:
 * a message path splits on dots, so "cp.gz" cannot be a key itself. Any
 * other kind is shown as it came.
 */
export const FETCH_KIND_KEYS: Readonly<Record<string, string>> = { cp: "cp", "cp.gz": "cpGz", up: "up" };

export function fetchKindKey(kind: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(FETCH_KIND_KEYS, kind) ? FETCH_KIND_KEYS[kind] : undefined;
}

/** A registry mirror's fetch is named m.<mirror id> (design 31 S5). */
export const FETCH_MIRROR_PREFIX = "m.";

/** The mirror id of a mirror fetch's kind, or undefined for any other kind. */
export function fetchMirrorId(kind: string): string | undefined {
  return kind.startsWith(FETCH_MIRROR_PREFIX) && kind.length > FETCH_MIRROR_PREFIX.length ? kind.slice(FETCH_MIRROR_PREFIX.length) : undefined;
}

/**
 * What a fetcher's exit status says, for the statuses that mean one thing
 * whichever fetcher ran. The summary does not say whether curl or wget ran,
 * and their numbers overlap (wget 4 is a network failure, curl 4 a missing
 * feature), so only the ones wget never uses get words: 22 an HTTP error, 33
 * a server that ignored the range, 124 the timeout wrapped around wget, and
 * 28 curl's time or speed limit, read by fetchAttemptReading.
 */
export type FetchExitReading = "finished" | "cut" | "http" | "range" | "timeout" | "other" | "corrupt";

export function fetchExitReading(code: number): FetchExitReading {
  switch (code) {
    case 0:
      return "finished";
    case 28:
      return "cut";
    case 22:
      return "http";
    case 33:
      return "range";
    case 124:
      return "timeout";
    default:
      return "other";
  }
}

/**
 * fetchExitReading for one fetch of a record. curl's 28 is the speed cutoff
 * or the fetch's share of the budget only in a first pass that had more than
 * one source; that is how the walk leaves a slow source, and it reads "cut
 * off". A second-pass fetch, and the only source of a walk, run without the
 * cutoff and with everything that is left, so there 28 means the budget ran
 * out. A walk's first pass names every source it could use, since a source
 * gets at least half of what is left, so one first-pass fetch means one
 * usable source.
 */
export function fetchAttemptReading(record: FetchRecordLike, attempt: FetchAttemptLike): FetchExitReading {
  // A fetch that wrote chunks failing the manifest sent wrong bytes, whatever
  // its fetcher's status: the script cut them back (design 31 S5).
  if (attempt.bad_chunks && attempt.bad_chunks > 0) return "corrupt";
  const reading = fetchExitReading(attempt.exit_code);
  if (reading !== "cut") return reading;
  const firstPass = (record.fetches ?? []).filter((fetch) => !fetch.second_pass).length;
  return attempt.second_pass || firstPass <= 1 ? "timeout" : "cut";
}

export interface FetchSourceTotal {
  kind: string;
  /** What every fetch from this source added to its file. */
  bytes: number;
  /** Their seconds added up; undefined when any of them ran without a clock. */
  seconds?: number;
  fetches: number;
  /** A fetch from this source completed its file. */
  finished: boolean;
  /** The exit status of this source's last fetch, which says why one that delivered nothing did. */
  lastExit: number;
  /** fetchAttemptReading of that last fetch. */
  lastReading: FetchExitReading;
  /**
   * Chunks this source's fetches wrote that failed the chunk manifest. The
   * script cuts every source's unchecked tail before the next one continues,
   * so the count blames exactly this source.
   */
  badChunks: number;
}

export interface FetchReadout {
  outcome: FetchOutcome;
  /** The stage the script stopped in, as it came. */
  stage: string;
  /** Known stages get words; the rest are shown as they came. */
  stageKnown: boolean;
  exitCode: number;
  /**
   * One entry per source the walk tried: the one that completed its file
   * first, then by bytes delivered, so the first entry is the source that
   * delivered and a source that delivered nothing (a control plane the node
   * could not reach) comes last.
   */
  sources: FetchSourceTotal[];
  /** Chunks that failed the manifest across every fetch: some source sent wrong bytes. */
  badChunks: number;
}

/** Read a node's last fetch into what its row and its sheet say. */
export function fetchReadout(record: FetchRecordLike): FetchReadout {
  const fetches = record.fetches ?? [];
  const byKind = new Map<string, FetchSourceTotal & { clockless: boolean }>();
  for (const fetch of fetches) {
    let total = byKind.get(fetch.kind);
    if (!total) {
      total = { kind: fetch.kind, bytes: 0, seconds: 0, fetches: 0, finished: false, lastExit: 0, lastReading: "finished", badChunks: 0, clockless: false };
      byKind.set(fetch.kind, total);
    }
    total.bytes += Math.max(0, fetch.bytes);
    total.fetches += 1;
    total.lastExit = fetch.exit_code;
    total.lastReading = fetchAttemptReading(record, fetch);
    total.badChunks += Math.max(0, fetch.bad_chunks ?? 0);
    // Exit 0 from a fetch whose chunks failed the manifest is a source that
    // sent the whole file wrong: the script cut it back, so it finished nothing.
    if (fetch.exit_code === 0 && !(fetch.bad_chunks && fetch.bad_chunks > 0)) total.finished = true;
    if (typeof fetch.seconds === "number") total.seconds = (total.seconds ?? 0) + fetch.seconds;
    else total.clockless = true;
  }
  const sources = [...byKind.values()]
    .map(({ clockless, ...total }) => (clockless ? { ...total, seconds: undefined } : total))
    .sort((a, b) => Number(b.finished) - Number(a.finished) || b.bytes - a.bytes);
  const succeeded = record.exit_code === 0 && record.stage === "done";
  return {
    outcome: succeeded ? (fetches.length ? "installed" : "kept") : "failed",
    stage: record.stage,
    stageKnown: (FETCH_STAGES as readonly string[]).includes(record.stage),
    exitCode: record.exit_code,
    sources,
    badChunks: sources.reduce((sum, source) => sum + source.badChunks, 0),
  };
}

/** Bytes per second, when the fetch took a measurable time. */
export function fetchRate(bytes: number, seconds: number | null | undefined): number | undefined {
  return typeof seconds === "number" && seconds > 0 ? bytes / seconds : undefined;
}

/**
 * A fetch's time to the second. formatDuration drops the seconds once there
 * is a minute, and a download's minutes alone hide the difference the
 * cutoff is about, so this keeps them on purpose; the unit letters match.
 */
export function fetchSecondsText(seconds: number | null | undefined): string | undefined {
  if (typeof seconds !== "number" || seconds < 0) return undefined;
  const whole = Math.round(seconds);
  if (whole < 60) return `${whole}s`;
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
}

/**
 * The part of a server id that tells two apart: ids are "<kind>_<base32>",
 * so the first eight characters of the whole id are the kind, the same for
 * every approval.
 */
export function idToken(id: string, length = 8): string {
  return id.replace(/^[a-z]+_/, "").slice(0, length);
}
