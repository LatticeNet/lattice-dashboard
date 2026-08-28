/**
 * SSH Guard, as the screen needs to reason about it.
 *
 * The capability is two approvals, not one, and the gap between them is the
 * whole point: the first arms the hardening together with an automatic revert,
 * and the second cancels that revert. A human is supposed to do something in
 * between, namely open a fresh connection over the new path and get a shell.
 * Collapsing them would remove the only evidence that the change is survivable.
 *
 * So the state this screen renders is not "configured or not". It is where a
 * node sits in that sequence, and one of those positions is urgent: the arm has
 * applied, a revert timer is running, and nobody has confirmed yet. A page that
 * shows that as a neutral "in progress" would be lying about a deadline.
 *
 * Pure functions only: no i18n, no colors, no HTTP. The sequence rules are the
 * part worth testing, and they are testable without a browser.
 */
import type { ApprovalView } from "@/lib/api";

export const SSHGUARD_PLUGIN = "sshguard";
export const SSHGUARD_ARM_ACTION = "sshguard-arm:v1";
export const SSHGUARD_CONFIRM_ACTION = "sshguard-confirm:v1";

export type GuardStage =
  /** Nothing has been planned for this node. */
  | "idle"
  /** An arm plan is waiting for someone to approve it. */
  | "armPending"
  /** Approved, not yet applied on the box. */
  | "armApproved"
  /** Applied. The revert timer is running and nobody has confirmed. */
  | "awaitingConfirm"
  /** A confirm plan is waiting for approval; the timer is still running. */
  | "confirmPending"
  /** Confirm approved, not yet applied; the timer is still running. */
  | "confirmApproved"
  /** Confirmed. The revert is cancelled and the hardening stands. */
  | "confirmed"
  /** The last arm attempt did not survive: rejected, dismissed or failed. */
  | "armFailed";

export interface NodeGuardState {
  nodeId: string;
  /** Human name, when the node is still in the fleet. */
  name?: string;
  stage: GuardStage;
  /** True while an applied arm has no applied confirm: a revert is pending. */
  revertArmed: boolean;
  /** The approval the operator most likely wants to open next, if any. */
  actionableApprovalId?: string;
  arm?: ApprovalView;
  confirm?: ApprovalView;
}

export function isSSHGuardApproval(a: ApprovalView): boolean {
  return a.plugin === SSHGUARD_PLUGIN;
}

/**
 * Where one node sits in the arm/confirm sequence.
 *
 * Only the newest approval of each kind counts. Re-planning after a rejection
 * is normal, and an older rejected arm must not keep a node looking broken.
 */
export function deriveNodeGuardState(approvals: ApprovalView[], nodeId: string): NodeGuardState {
  const mine = approvals.filter((a) => isSSHGuardApproval(a) && a.node_id === nodeId);
  const arm = newest(mine.filter((a) => a.action === SSHGUARD_ARM_ACTION));
  const confirm = newest(mine.filter((a) => a.action === SSHGUARD_CONFIRM_ACTION));

  if (!arm) return { nodeId, stage: "idle", revertArmed: false };

  if (arm.status === "pending") {
    return { nodeId, stage: "armPending", revertArmed: false, actionableApprovalId: arm.id, arm };
  }
  if (arm.status === "approved") {
    return { nodeId, stage: "armApproved", revertArmed: false, actionableApprovalId: arm.id, arm };
  }
  if (arm.status !== "applied") {
    return { nodeId, stage: "armFailed", revertArmed: false, arm };
  }

  // Applied. A confirm that predates this arm belongs to an earlier attempt and
  // says nothing about this one.
  const current = confirm && after(confirm, arm) ? confirm : undefined;
  if (!current || (current.status !== "pending" && current.status !== "approved" && current.status !== "applied")) {
    return { nodeId, stage: "awaitingConfirm", revertArmed: true, arm, confirm: current };
  }
  if (current.status === "pending") {
    return { nodeId, stage: "confirmPending", revertArmed: true, actionableApprovalId: current.id, arm, confirm: current };
  }
  if (current.status === "approved") {
    return { nodeId, stage: "confirmApproved", revertArmed: true, actionableApprovalId: current.id, arm, confirm: current };
  }
  return { nodeId, stage: "confirmed", revertArmed: false, arm, confirm: current };
}

/** Nodes whose revert timer is running, which is the only urgent state here. */
export function nodesAwaitingConfirm(states: NodeGuardState[]): NodeGuardState[] {
  return states.filter((s) => s.revertArmed);
}

/**
 * Every node, not only the ones this capability has already touched.
 *
 * The remaining work on SSH Guard is rolling it across the fleet, and a list of
 * what has been armed cannot answer the question that work is made of: which
 * machines are still open. A node with no approvals belongs on this page as
 * plainly as one mid-sequence; it is just at the start.
 */
export function buildFleetStates(
  approvals: ApprovalView[],
  nodes: { id: string; name?: string }[],
): NodeGuardState[] {
  const ids = new Set(nodes.map((n) => n.id));
  // A node can be gone from the fleet and still have history worth showing.
  for (const a of approvals) {
    if (isSSHGuardApproval(a)) ids.add(a.node_id);
  }
  const byId = new Map(nodes.map((n) => [n.id, n.name ?? ""]));
  return Array.from(ids)
    .map((id) => ({ ...deriveNodeGuardState(approvals, id), name: byId.get(id) ?? "" }))
    .sort(compareForRollout);
}

/**
 * Urgent first, then work in flight, then untouched, then done.
 *
 * Finished nodes sink rather than lead: this list is read to decide what to do
 * next, and a node that needs nothing is the one thing that never does.
 */
const STAGE_ORDER: Record<GuardStage, number> = {
  awaitingConfirm: 0,
  confirmPending: 1,
  confirmApproved: 2,
  armApproved: 3,
  armPending: 4,
  armFailed: 5,
  idle: 6,
  confirmed: 7,
};

function compareForRollout(a: NodeGuardState, b: NodeGuardState): number {
  const rank = STAGE_ORDER[a.stage] - STAGE_ORDER[b.stage];
  if (rank !== 0) return rank;
  return a.nodeId.localeCompare(b.nodeId);
}

export interface GuardCoverage {
  total: number;
  /** Confirmed: hardened and the revert cancelled. */
  done: number;
  /** Anywhere between planned and awaiting confirmation. */
  inFlight: number;
  /** Never armed, or the last attempt did not survive. */
  open: number;
}

export function guardCoverage(states: NodeGuardState[]): GuardCoverage {
  const done = states.filter((s) => s.stage === "confirmed").length;
  const open = states.filter((s) => s.stage === "idle" || s.stage === "armFailed").length;
  return { total: states.length, done, open, inFlight: states.length - done - open };
}

function newest(list: ApprovalView[]): ApprovalView | undefined {
  return list.reduce<ApprovalView | undefined>((best, a) => (!best || after(a, best) ? a : best), undefined);
}

function after(a: ApprovalView, b: ApprovalView): boolean {
  const at = a.updated_at || a.created_at || "";
  const bt = b.updated_at || b.created_at || "";
  if (at !== bt) return at > bt;
  return a.id > b.id;
}

// ── management sources ──────────────────────────────────────────────────────

export interface SourceParse {
  values: string[];
  invalid: string[];
}

/**
 * Split and validate the management-source list.
 *
 * A bare address is accepted and left bare: the server decides how to widen it,
 * and silently appending /32 here would hide that decision. What is rejected is
 * anything that is not an address or a CIDR at all, because a typo in this
 * field is how a node ends up reachable from nowhere.
 */
export function parseMgmtSources(raw: string): SourceParse {
  const values: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const token of (raw ?? "").split(/[\s,;]+/)) {
    const value = token.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    (isAddressOrCIDR(value) ? values : invalid).push(value);
  }
  return { values, invalid };
}

function isAddressOrCIDR(value: string): boolean {
  const [address = "", prefix, ...rest] = value.split("/");
  if (rest.length || !address) return false;
  if (prefix !== undefined) {
    if (!/^\d{1,3}$/.test(prefix)) return false;
    const bits = Number(prefix);
    const max = address.includes(":") ? 128 : 32;
    if (bits > max) return false;
  }
  return address.includes(":") ? isIPv6(address) : isIPv4(address);
}

function isIPv4(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 4) return false;
  return parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}

function isIPv6(value: string): boolean {
  // Deliberately permissive on shape and strict on alphabet: this guards
  // against a typo, and the server parses it properly before it is used.
  if (!/^[0-9a-fA-F:]+$/.test(value)) return false;
  return (value.match(/::/g) ?? []).length <= 1 && value.split(":").length <= 9;
}

// ── plan request ────────────────────────────────────────────────────────────

export interface GuardForm {
  nodeId: string;
  sshPort: number;
  keepLegacyPort: boolean;
  mgmtSources: string;
  enableKnock: boolean;
  outOfBandFallback: boolean;
  confirmWindowSec: number;
  acceptFindings: boolean;
}

export const MIN_CONFIRM_WINDOW_SEC = 120;
export const DEFAULT_CONFIRM_WINDOW_SEC = 900;

export interface PlanRequest {
  node_id: string;
  ssh_port?: number;
  keep_legacy_port?: boolean;
  mgmt_sources?: string[];
  enable_knock?: boolean;
  out_of_band_fallback?: boolean;
  confirm_window_sec?: number;
  accept_findings?: boolean;
}

/**
 * Turn the form into a request, leaving out everything the operator did not
 * choose.
 *
 * Omission is not laziness: every hardening value the server fills in for an
 * absent field is one that was verified on the reference host, and sending a
 * zero would replace a tested default with an untested literal.
 */
export function buildPlanRequest(form: GuardForm): PlanRequest {
  const req: PlanRequest = { node_id: form.nodeId.trim() };
  if (form.sshPort > 0) req.ssh_port = form.sshPort;
  if (form.keepLegacyPort) req.keep_legacy_port = true;
  const sources = parseMgmtSources(form.mgmtSources).values;
  if (sources.length) req.mgmt_sources = sources;
  // Sent explicitly in both directions: the server's own default depends on
  // whether a port was set, and the checkbox is what the operator saw.
  req.enable_knock = form.enableKnock;
  if (form.outOfBandFallback) req.out_of_band_fallback = true;
  if (form.confirmWindowSec > 0 && form.confirmWindowSec !== DEFAULT_CONFIRM_WINDOW_SEC) {
    req.confirm_window_sec = form.confirmWindowSec;
  }
  if (form.acceptFindings) req.accept_findings = true;
  return req;
}

/** Form problems worth blocking submit on, as stable codes the view maps to copy. */
export function validateForm(form: GuardForm): string[] {
  const errors: string[] = [];
  if (!form.nodeId.trim()) errors.push("node_required");
  if (form.sshPort < 0 || form.sshPort > 65535) errors.push("port_range");
  if (form.sshPort === 22) errors.push("port_is_legacy");
  if (parseMgmtSources(form.mgmtSources).invalid.length) errors.push("sources_invalid");
  if (form.confirmWindowSec > 0 && form.confirmWindowSec < MIN_CONFIRM_WINDOW_SEC) errors.push("window_too_short");
  // A profile with no permanent way in and no out-of-band fallback stands
  // entirely on the knock sequence. The server lints for this too; saying it
  // here means the operator finds out before spending an approval.
  if (form.enableKnock && !parseMgmtSources(form.mgmtSources).values.length && !form.outOfBandFallback) {
    errors.push("single_way_in");
  }
  return errors;
}

// ── findings ────────────────────────────────────────────────────────────────

export interface Finding {
  code: string;
  severity: "block" | "warn" | string;
  message: string;
}

/** Blocking findings first: they are the ones that decide whether submit works. */
export function sortFindings(findings: Finding[]): Finding[] {
  const rank = (f: Finding) => (f.severity === "block" ? 0 : f.severity === "warn" ? 1 : 2);
  return [...findings].sort((a, b) => rank(a) - rank(b) || a.code.localeCompare(b.code));
}

export function hasBlocking(findings: Finding[]): boolean {
  return findings.some((f) => f.severity === "block");
}
