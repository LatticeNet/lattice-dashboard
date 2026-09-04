/**
 * The SSH Guard board: what the coverage table and the batch sheet reason
 * about, beyond the per-node state machine in sshGuardModel.
 *
 * Three things live here. The coverage buckets, which turn the stage machine
 * plus the scope decision into the seven chips an operator filters by. The
 * evidence fold, which reads the node's own guard-reality report so the table
 * can say what sshd listens on and when that was seen, instead of what a plan
 * intended. And the batch rules: which nodes may share one plan sheet, and
 * how the per-node outcomes of that sheet add up.
 *
 * Pure functions only, like the sibling model: no i18n, no colours, no HTTP.
 */
import type { ApprovalView, GuardNodeReality, GuardRealitySummary, Node } from "@/lib/api";

// Through the alias, not "./": the node test runner resolves only `@/`, and this
// module now pulls values from its sibling, not only types.
import { STAGE_ORDER, isSSHGuardApproval, revertWindowPassed, type Finding, type GuardStage, type NodeGuardState } from "@/views/networking/sshGuardModel";

// ── coverage ────────────────────────────────────────────────────────────────

export type ScopeState = "enrolled" | "excluded" | "undecided";

/**
 * The stage the board shows, which is the approval stage plus one thing the
 * approvals cannot say: an applied arm whose confirmation window has closed.
 * The server still records "applied, no confirm", but the box reverted on its
 * own when its timer fired, so the row reads "reverted" rather than counting
 * down past zero. Recomputed from the clock on every render.
 */
export type BoardStage = GuardStage | "reverted";

export function boardStage(state: NodeGuardState, now: number): BoardStage {
  return revertWindowPassed(state, now) ? "reverted" : state.stage;
}

/**
 * The seven chips. The words are the row words: a chip and the badge under it
 * name one state with one word, so "Reverting 2" above the table means two
 * rows read "reverting" (or a confirm stage of it, listed in the chip's
 * title), and "Not armed 16" means sixteen rows read "not armed".
 */
export type CoverageFilter = "all" | "confirmed" | "reverting" | "armPending" | "open" | "failed" | "excluded";
export const COVERAGE_FILTERS: readonly CoverageFilter[] = ["all", "confirmed", "reverting", "armPending", "open", "failed", "excluded"];

export function isCoverageFilter(value: unknown): value is CoverageFilter {
  return typeof value === "string" && (COVERAGE_FILTERS as readonly string[]).includes(value);
}

/**
 * Which chip a node counts under. Every node lands in exactly one, so the
 * chips add up to the fleet.
 *
 * Exclusion wins only while nothing is live on the box. A node someone
 * excluded after it was confirmed is still hardened, and hiding it under
 * "excluded" would take a real firewall change off the board; a node excluded
 * while idle, after a failed arm or after a revert has nothing running and is
 * simply out.
 *
 * A reverted node counts as a failed arm: the arm was applied and did not
 * survive, which is what "failed" means on this board, and the operator's
 * next move (read why, arm again) is the same.
 */
export function coverageBucket(stage: BoardStage, scope: ScopeState): Exclude<CoverageFilter, "all"> {
  if (stage === "confirmed") return "confirmed";
  const nothingLive = stage === "idle" || stage === "armFailed" || stage === "reverted";
  if (scope === "excluded" && nothingLive) return "excluded";
  if (stage === "armFailed" || stage === "reverted") return "failed";
  if (stage === "idle") return "open";
  if (stage === "armPending" || stage === "armApproved") return "armPending";
  return "reverting";
}

export function coverageCounts(
  states: readonly NodeGuardState[],
  scopeOf: (nodeId: string) => ScopeState,
  now: number,
): Record<CoverageFilter, number> {
  const counts: Record<CoverageFilter, number> = { all: states.length, confirmed: 0, reverting: 0, armPending: 0, open: 0, failed: 0, excluded: 0 };
  for (const state of states) counts[coverageBucket(boardStage(state, now), scopeOf(state.nodeId))] += 1;
  return counts;
}

export function filterByCoverage(
  states: readonly NodeGuardState[],
  filter: CoverageFilter,
  scopeOf: (nodeId: string) => ScopeState,
  now: number,
): NodeGuardState[] {
  if (filter === "all") return [...states];
  return states.filter((s) => coverageBucket(boardStage(s, now), scopeOf(s.nodeId)) === filter);
}

/** Nodes whose revert timer is still running: the urgent card's list. */
export function revertingNodes(states: readonly NodeGuardState[], now: number): NodeGuardState[] {
  return states.filter((s) => s.revertArmed && !revertWindowPassed(s, now));
}

/**
 * The rollout order with the board stage applied: a reverted node no longer
 * leads the table as if it were urgent; it sits with the failed arms, which is
 * what it is. Ties break by id, like the model's own order.
 */
export function orderForBoard(states: readonly NodeGuardState[], now: number): NodeGuardState[] {
  const rank = (s: NodeGuardState) => {
    const stage = boardStage(s, now);
    return stage === "reverted" ? STAGE_ORDER.armFailed : STAGE_ORDER[stage];
  };
  return [...states].sort((a, b) => rank(a) - rank(b) || a.nodeId.localeCompare(b.nodeId));
}

/** The numbers the proof line states. */
export interface ProofCounts {
  total: number;
  confirmed: number;
  /** Rejected, dismissed, failed, or applied and then reverted unconfirmed. */
  failedArms: number;
  /** Revert timers still running. A closed window is a failed arm, not a timer. */
  reverting: number;
}

export function proofCounts(states: readonly NodeGuardState[], now: number): ProofCounts {
  let confirmed = 0;
  let failedArms = 0;
  let reverting = 0;
  for (const s of states) {
    const stage = boardStage(s, now);
    if (stage === "confirmed") confirmed += 1;
    if (stage === "armFailed" || stage === "reverted") failedArms += 1;
    if (s.revertArmed && stage !== "reverted") reverting += 1;
  }
  return { total: states.length, confirmed, failedArms, reverting };
}

// ── evidence from the guard-reality report ──────────────────────────────────

/**
 * The ports a shell daemon is bound to, read the way the server's lint reads
 * them: tcp only, sshd or dropbear by process name, loopback skipped because a
 * loopback binding guards nothing reachable. Mirroring the server matters:
 * this is the same list the plan's gate is derived from, so what the table
 * calls "SSHD NOW" is what an arm would act on.
 */
export function sshdPorts(reality: GuardNodeReality | undefined): number[] {
  const seen = new Set<number>();
  for (const l of reality?.listeners ?? []) {
    if (l.protocol !== "tcp" || !(l.port > 0)) continue;
    const name = (l.process ?? "").trim().toLowerCase();
    if (!name.startsWith("sshd") && !name.startsWith("dropbear")) continue;
    const address = l.address ?? "";
    if (address.startsWith("127.") || address === "::1") continue;
    seen.add(l.port);
  }
  return [...seen].sort((a, b) => a - b);
}

export type SshdNowKind =
  /** No snapshot, or a snapshot without listeners: nothing to say. */
  | "unknown"
  /** Snapshot present, no shell daemon bound on a reachable address. */
  | "none"
  /** Bound on the legacy port only. */
  | "legacy"
  /** Bound on one port that is not the legacy one. */
  | "only"
  /** Bound on more than one port. */
  | "several";

export interface SshdNow {
  kind: SshdNowKind;
  ports: number[];
  /** ":58394 only", ":22 + :58394", ":22". Empty for unknown and none. */
  text: string;
}

export function describeSshdNow(ports: number[] | undefined, legacyPort = 22): SshdNow {
  if (ports === undefined) return { kind: "unknown", ports: [], text: "" };
  if (ports.length === 0) return { kind: "none", ports: [], text: "" };
  const list = ports.map((p) => `:${p}`).join(" + ");
  if (ports.length === 1) {
    const only = ports[0] as number;
    return only === legacyPort
      ? { kind: "legacy", ports, text: list }
      : { kind: "only", ports, text: `${list} only` };
  }
  return { kind: "several", ports, text: list };
}

export interface RealityEvidence {
  /** unknown (never reported) | fresh | stale, from the server, never derived here. */
  status: "unknown" | "fresh" | "stale" | string;
  /** When the agent collected the snapshot. Absent until it has reported. */
  collectedAt?: string;
  /** When the snapshot stopped counting as fresh, from the server. */
  staleSince?: string;
  /** Undefined until the per-node detail has been read. */
  sshd?: SshdNow;
  /**
   * PasswordAuthentication as sshd -T printed it. Undefined until the detail
   * has been read, and undefined when the detail carries no sshd block: the
   * agent predates the field or could not prove it, and `sshdNote` says which.
   */
  password?: { enabled: boolean; observedAt: string };
  sshdNote?: string;
}

/**
 * Fold the fleet summary and, when it has been read, the per-node detail
 * onto one node. The summary alone can say when a node was observed; only
 * the detail can say what it was observed doing.
 */
export function foldReality(
  nodeId: string,
  summaries: ReadonlyMap<string, GuardRealitySummary>,
  details: ReadonlyMap<string, GuardNodeReality>,
): RealityEvidence {
  const summary = summaries.get(nodeId);
  const detail = details.get(nodeId);
  const out: RealityEvidence = { status: summary?.snapshot_status ?? "unknown" };
  if (summary?.collected_at) out.collectedAt = summary.collected_at;
  else if (detail?.collected_at) out.collectedAt = detail.collected_at;
  if (summary?.stale_after) out.staleSince = summary.stale_after;
  if (detail) {
    out.sshd = describeSshdNow(sshdPorts(detail));
    if (detail.sshd) out.password = { enabled: detail.sshd.password_authentication, observedAt: detail.sshd.observed_at };
    if (detail.sshd_note) out.sshdNote = detail.sshd_note;
  }
  return out;
}

/**
 * Which per-node details are worth another request.
 *
 * The listeners live only on the detail endpoint, and reading 33 details on
 * every poll is 33 requests a minute for a fleet that changes a few times a
 * day. The summary carries `collected_at`, so a detail is re-read only when
 * the summary says the snapshot it holds is newer than the one cached.
 */
export function realityDetailsToFetch(
  summaries: readonly GuardRealitySummary[],
  cachedCollectedAt: ReadonlyMap<string, string>,
): string[] {
  const out: string[] = [];
  for (const s of summaries) {
    if (!s.collected_at) continue;
    if (cachedCollectedAt.get(s.node_id) === s.collected_at) continue;
    out.push(s.node_id);
  }
  return out;
}

/** The newest observation across the fleet, for the proof line. */
export function newestObservation(summaries: readonly GuardRealitySummary[]): string | undefined {
  let best: string | undefined;
  for (const s of summaries) {
    if (s.collected_at && (!best || s.collected_at > best)) best = s.collected_at;
  }
  return best;
}

// ── knock knowledge from the server ─────────────────────────────────────────

/**
 * One string per node that changes whenever any of its SSH Guard approvals
 * does. The server's knock answer is a function of the node's whole arm and
 * confirm history, not only the newest row, so the print covers every row:
 * a cleanup that retires a three-week-old arm as superseded changes what the
 * server says without touching the newest approval.
 */
export function knockFingerprints(approvals: readonly ApprovalView[]): Map<string, string> {
  const parts = new Map<string, string[]>();
  for (const a of approvals) {
    if (!isSSHGuardApproval(a)) continue;
    const list = parts.get(a.node_id) ?? [];
    list.push(`${a.id}:${a.status}:${a.stale_code ?? ""}:${a.updated_at ?? ""}`);
    parts.set(a.node_id, list);
  }
  return new Map([...parts].map(([nodeId, list]) => [nodeId, list.sort().join("|")]));
}

/**
 * Which nodes are worth asking the server about. One request per node on
 * first load, then only for a node whose approvals moved: the approvals poll
 * every fifteen seconds and a fleet of thirty-three must not cost
 * thirty-three requests each time. A node with no approvals prints as the
 * empty string and is asked once, because "never planned" is an answer the
 * server states in its own words.
 */
export function knockStatesToFetch(
  nodeIds: readonly string[],
  fingerprints: ReadonlyMap<string, string>,
  asked: ReadonlyMap<string, string>,
): string[] {
  return nodeIds.filter((id) => asked.get(id) !== (fingerprints.get(id) ?? ""));
}

// ── time on screen ──────────────────────────────────────────────────────────

/** "43s", "2m", "3h", "2d". The floor is zero: an age is never negative. */
export function formatAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

/** "07:41", "1:02:03". Past deadlines read 00:00 rather than counting up. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

// ── batch ───────────────────────────────────────────────────────────────────

/**
 * The control-plane host, as far as the console can tell.
 *
 * Nothing in the node record marks it, so this uses the one fact both sides
 * share: the address the browser reached the console on. A node whose
 * reported address is that host is the machine serving this page, and a batch
 * that hardens it alongside others has no operator left to confirm the rest
 * if it goes wrong. This only matches when the console is reached by an
 * address the node reports (an IP, or a hostname the agent reports as its
 * address); a console reached through a DNS name that no node reports
 * matches nothing, and the refusal then rests on the operator ordering the
 * fleet by hand, as the design says they do. A server-side marker would make
 * this exact and is the right fix.
 */
export type ControlPlaneCandidate = Pick<Node, "id"> & Partial<Pick<Node, "public_ip" | "public_ipv6" | "internal_ip">>;

export function controlPlaneNodeIds(nodes: readonly ControlPlaneCandidate[], originHost: string): Set<string> {
  const host = normalizeHost(originHost);
  const out = new Set<string>();
  if (!host) return out;
  for (const n of nodes) {
    const candidates = [n.public_ip, n.public_ipv6, n.internal_ip].map((v) => normalizeHost(v ?? ""));
    if (candidates.includes(host)) out.add(n.id);
  }
  return out;
}

/** Lower-cased, port and IPv6 brackets stripped, so "[::1]:5273" and "::1" agree. */
function normalizeHost(value: string): string {
  let v = value.trim().toLowerCase();
  if (!v) return "";
  if (v.startsWith("[")) {
    const end = v.indexOf("]");
    return end > 0 ? v.slice(1, end) : v;
  }
  // A single colon is host:port; more than one is a bare IPv6 literal.
  const colons = v.split(":").length - 1;
  if (colons === 1) v = v.slice(0, v.indexOf(":"));
  return v;
}

export type BatchRefusal = "empty" | "control_plane_in_batch";

/**
 * Whether a set of nodes may share one plan sheet. The control-plane host may
 * be armed, on its own, after everything else has been confirmed; it may not
 * be one member of a larger batch.
 */
export function batchRefusal(nodeIds: readonly string[], controlPlane: ReadonlySet<string>): BatchRefusal | undefined {
  if (nodeIds.length === 0) return "empty";
  if (nodeIds.length > 1 && nodeIds.some((id) => controlPlane.has(id))) return "control_plane_in_batch";
  return undefined;
}

export type BatchOutcome =
  | { kind: "filed"; approvalId: string; findings: Finding[] }
  | { kind: "blocked"; findings: Finding[] }
  | { kind: "failed"; error: string };

export interface BatchMember {
  nodeId: string;
  name: string;
  outcome?: BatchOutcome;
}

export interface BatchSummary {
  filed: number;
  blocked: number;
  failed: number;
  pending: number;
}

export function summarizeBatch(members: readonly BatchMember[]): BatchSummary {
  const out: BatchSummary = { filed: 0, blocked: 0, failed: 0, pending: 0 };
  for (const m of members) {
    if (!m.outcome) out.pending += 1;
    else out[m.outcome.kind] += 1;
  }
  return out;
}

/** Members a file pass should still send: never one that already has an approval. */
export function membersToFile(members: readonly BatchMember[], retryBlocked: boolean): BatchMember[] {
  return members.filter((m) => !m.outcome || (retryBlocked && m.outcome.kind === "blocked"));
}
