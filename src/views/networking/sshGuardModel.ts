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
import { fieldNumber, fieldText, hasFieldText } from "@/lib/formValue";

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
export const STAGE_ORDER: Record<GuardStage, number> = {
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
  /** The eight overrides under the Advanced disclosure. Absent means none set. */
  advanced?: GuardAdvancedForm;
}

/**
 * The overrides the server accepts for an unusual host.
 *
 * Every field is a string, including the numeric ones, because "not set" has
 * to be distinguishable from zero: a zero here would be sent, and the server
 * treats a sent zero as "use the default" for some fields and as a range error
 * for others. Numbers are read through `fieldNumber`, which also absorbs the
 * number-typed input handing back a number where the form said string.
 */
export interface GuardAdvancedForm {
  /** Ports the gate covers, replacing what sshd reports. */
  gatePorts: string;
  /** Exactly three ports in 20000..60000, replacing the drawn sequence. */
  knockPorts: string;
  /** nftables timeout literal from KNOCK_OPEN_FOR_VALUES. */
  knockOpenFor: string;
  knockSeqTimeoutSec: string;
  loginGraceTimeSec: string;
  maxAuthTries: string;
  /** sshd "start:rate:full" or bare "start". */
  maxStartups: string;
  permitRootLogin: string;
}

/** What the server fills in when a field is omitted. Shown as placeholders, never sent. */
export const ADVANCED_DEFAULTS = {
  knockOpenFor: "12h",
  knockSeqTimeoutSec: 15,
  loginGraceTimeSec: 20,
  maxAuthTries: 3,
  maxStartups: "100:30:200",
  permitRootLogin: "prohibit-password",
} as const;

/** The literals the server's validateNFTTimeout accepts, in duration order. */
export const KNOCK_OPEN_FOR_VALUES = ["15m", "30m", "1h", "2h", "4h", "8h", "12h", "24h"] as const;
export const PERMIT_ROOT_LOGIN_VALUES = ["prohibit-password", "no", "yes", "forced-commands-only"] as const;
export const KNOCK_SEQUENCE_LEN = 3;
export const KNOCK_PORT_MIN = 20000;
export const KNOCK_PORT_MAX = 60000;

export function emptyAdvancedForm(): GuardAdvancedForm {
  return {
    gatePorts: "",
    knockPorts: "",
    knockOpenFor: "",
    knockSeqTimeoutSec: "",
    loginGraceTimeSec: "",
    maxAuthTries: "",
    maxStartups: "",
    permitRootLogin: "",
  };
}

export const MIN_CONFIRM_WINDOW_SEC = 120;
export const DEFAULT_CONFIRM_WINDOW_SEC = 900;

/**
 * The policy the sheet opens with. Knock on, no management source and no
 * fallback is refused by validateForm on purpose: a fleet whose only way in
 * is the knock sequence is one typo from unreachable, so the operator has to
 * add a source or allow the fallback before anything is filed. The sheet lists
 * that refusal from the moment it opens, not after the first keystroke.
 */
export function defaultGuardForm(nodeId = ""): GuardForm {
  return {
    nodeId,
    sshPort: 0,
    keepLegacyPort: true,
    mgmtSources: "",
    enableKnock: true,
    outOfBandFallback: false,
    confirmWindowSec: DEFAULT_CONFIRM_WINDOW_SEC,
    acceptFindings: false,
    advanced: emptyAdvancedForm(),
  };
}

export interface PlanRequest {
  node_id: string;
  ssh_port?: number;
  keep_legacy_port?: boolean;
  mgmt_sources?: string[];
  enable_knock?: boolean;
  out_of_band_fallback?: boolean;
  confirm_window_sec?: number;
  accept_findings?: boolean;
  gate_ports?: number[];
  knock_ports?: number[];
  knock_open_for?: string;
  knock_seq_timeout_sec?: number;
  login_grace_time_sec?: number;
  max_auth_tries?: number;
  max_startups?: string;
  permit_root_login?: string;
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
  if (form.advanced) Object.assign(req, buildAdvancedRequest(form.advanced));
  return req;
}

/** A comma or space separated port list, split and checked, order kept. */
export function parsePortList(raw: string): { values: number[]; invalid: string[] } {
  const values: number[] = [];
  const invalid: string[] = [];
  for (const token of fieldText(raw).split(/[\s,;]+/)) {
    if (!token) continue;
    const n = /^\d{1,5}$/.test(token) ? Number(token) : NaN;
    if (Number.isInteger(n) && n >= 1 && n <= 65535) values.push(n);
    else invalid.push(token);
  }
  return { values, invalid };
}

/**
 * Only the fields the operator set. A blank stays absent so the server's
 * verified default stands; the request never carries an empty string or a
 * zero on the operator's behalf.
 */
export function buildAdvancedRequest(adv: GuardAdvancedForm): Partial<PlanRequest> {
  const req: Partial<PlanRequest> = {};
  const gate = parsePortList(adv.gatePorts).values;
  if (gate.length) req.gate_ports = gate;
  const knock = parsePortList(adv.knockPorts).values;
  if (knock.length) req.knock_ports = knock;
  const openFor = fieldText(adv.knockOpenFor);
  if (openFor) req.knock_open_for = openFor;
  const seqTimeout = fieldNumber(adv.knockSeqTimeoutSec);
  if (seqTimeout !== undefined) req.knock_seq_timeout_sec = seqTimeout;
  const grace = fieldNumber(adv.loginGraceTimeSec);
  if (grace !== undefined) req.login_grace_time_sec = grace;
  const tries = fieldNumber(adv.maxAuthTries);
  if (tries !== undefined) req.max_auth_tries = tries;
  const startups = fieldText(adv.maxStartups);
  if (startups) req.max_startups = startups;
  const root = fieldText(adv.permitRootLogin);
  if (root) req.permit_root_login = root;
  return req;
}

/**
 * The server's own ranges, checked here so a typo is caught before it costs a
 * round trip. Codes, not copy: the view maps them.
 */
export function validateAdvanced(adv: GuardAdvancedForm): string[] {
  const errors: string[] = [];
  if (parsePortList(adv.gatePorts).invalid.length) errors.push("gate_ports_invalid");
  const knock = parsePortList(adv.knockPorts);
  if (knock.invalid.length) errors.push("knock_ports_invalid");
  else if (knock.values.length) {
    const inRange = knock.values.every((p) => p >= KNOCK_PORT_MIN && p <= KNOCK_PORT_MAX);
    const distinct = new Set(knock.values).size === knock.values.length;
    if (knock.values.length !== KNOCK_SEQUENCE_LEN || !inRange || !distinct) errors.push("knock_ports_invalid");
  }
  const openFor = fieldText(adv.knockOpenFor);
  if (openFor && !(KNOCK_OPEN_FOR_VALUES as readonly string[]).includes(openFor)) errors.push("knock_open_for_invalid");
  if (outOfRange(adv.knockSeqTimeoutSec, 3, 120)) errors.push("knock_seq_timeout_range");
  if (outOfRange(adv.loginGraceTimeSec, 5, 600)) errors.push("login_grace_range");
  if (outOfRange(adv.maxAuthTries, 1, 10)) errors.push("max_auth_tries_range");
  const startups = fieldText(adv.maxStartups);
  if (startups && !isMaxStartups(startups)) errors.push("max_startups_invalid");
  const root = fieldText(adv.permitRootLogin);
  if (root && !(PERMIT_ROOT_LOGIN_VALUES as readonly string[]).includes(root)) errors.push("permit_root_login_invalid");
  return errors;
}

/** Set and outside [lo, hi], or set and not a whole number. Blank is never wrong. */
function outOfRange(value: unknown, lo: number, hi: number): boolean {
  if (!hasFieldText(value)) return false;
  const n = fieldNumber(value);
  return n === undefined || !Number.isInteger(n) || n < lo || n > hi;
}

function isMaxStartups(value: string): boolean {
  const parts = value.split(":");
  if (parts.length !== 1 && parts.length !== 3) return false;
  return parts.every((p) => /^\d{1,6}$/.test(p) && Number(p) <= 100000);
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
  if (form.advanced) errors.push(...validateAdvanced(form.advanced));
  return errors;
}

// ── evidence carried by the approvals ───────────────────────────────────────

/** The server's stale code on an SSH Guard arm it retired as superseded. */
export const SSHGUARD_SUPERSEDED_CODE = "sshguard_approval_superseded";

export interface ArmRejection {
  /** When the refusal was recorded. */
  at: string;
  /** Who refused it, when the server recorded that. Absent on a row written before it did. */
  by?: string;
}

/**
 * An arm a person refused, as opposed to one the node could not apply.
 *
 * Both end as `rejected`. The server now writes `rejected_by` and
 * `rejected_at` on the row when a person or token said no, and writes nothing
 * for a task failure or an automatic rejection, so that field is the split.
 *
 * Rows from before the server recorded the actor still exist, and for those
 * the old reading stands: a task only runs for an approval someone approved,
 * so a rejected arm with no approver was refused, not failed. The moment is
 * `updated_at`, and the actor is not known. An arm the server retired as
 * superseded (see armSuperseded) is neither.
 */
export function armRejection(state: NodeGuardState): ArmRejection | undefined {
  if (state.stage !== "armFailed" || !state.arm) return undefined;
  const arm = state.arm;
  if (arm.rejected_by) {
    return { at: arm.rejected_at || arm.updated_at || arm.created_at || "", by: arm.rejected_by };
  }
  if (arm.status !== "rejected" || arm.approved_by || armSuperseded(state)) return undefined;
  return { at: arm.updated_at || arm.created_at || "" };
}

/**
 * An arm the server retired because a newer plan replaced it.
 *
 * The server marks such a row with `stale_code` and never with a rejecting
 * actor: nobody refused it and nothing on the node failed, the record was
 * closed by the plan that took over. Printing it as a failure would send an
 * operator looking for a fault that never happened; printing it as a refusal
 * would blame someone. The server accepts the code on a dismissed row today
 * and on a rejected one by contract, so the status is not read here.
 */
export function armSuperseded(state: NodeGuardState): { at: string } | undefined {
  if (state.stage !== "armFailed" || !state.arm) return undefined;
  if (state.arm.rejected_by || state.arm.stale_code !== SSHGUARD_SUPERSEDED_CODE) return undefined;
  return { at: state.arm.updated_at || state.arm.created_at || "" };
}

/**
 * Why the last arm did not survive, in the server's words.
 *
 * A failed arm carries the task's summary in `reason`. The summary can run
 * to several lines; the last non-empty one is the line the task died on and
 * the one an operator reads first. The full text travels alongside for the
 * tooltip. An arm a person refused (see armRejection) or the server retired
 * (see armSuperseded) has no failure to print: its `reason` is the plan's
 * own summary or the retirement note, not a fault.
 */
export function armFailureText(state: NodeGuardState): { line: string; full: string } | undefined {
  if (state.stage !== "armFailed" || armRejection(state) || armSuperseded(state)) return undefined;
  const full = (state.arm?.reason ?? "").trim();
  if (!full) return undefined;
  const lines = full.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return { line: lines[lines.length - 1] ?? full, full };
}

/** The confirm window the arm plan was rendered with, read back from its text. */
export function parseConfirmWindow(plan: string | undefined): number | undefined {
  const m = /^confirm_window_sec:\s*(\d+)\s*$/m.exec(plan ?? "");
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * What the control plane knows about a node's knock sequence.
 *
 * Mirrors the server's `knowledge` field so the table and the endpoint cannot
 * disagree about a node. Derived here from the arm plan the page already
 * holds, so every row can say something without a request per node; the reveal
 * dialog then asks the server, which is the authority.
 */
export type KnockKnowledge = "installed" | "planned" | "no_knock" | "unknown";

/**
 * Whether the arm plan declares port knocking, read from the plan header.
 *
 * The header line is `knock: true|false`, written by RenderArmPlan next to
 * ssh_port. Reading that rather than the fenced knockd block is deliberate:
 * the question "is there a sequence" is answerable without going anywhere
 * near the sequence itself.
 */
export function parseKnockDeclared(plan: string | undefined): boolean | undefined {
  const m = /^knock:\s*(true|false)\s*$/m.exec(plan ?? "");
  if (!m) return undefined;
  return m[1] === "true";
}

/** The stages that mean the arm reached the box. */
const ARM_APPLIED_STAGES: ReadonlySet<GuardStage> = new Set<GuardStage>([
  "awaitingConfirm",
  "confirmPending",
  "confirmApproved",
  "confirmed",
]);

/**
 * The stages where a sequence is written down and still on its way.
 *
 * `armFailed` is deliberately absent. A rejected or failed arm carries a
 * sequence that was never written to the node and never will be, so calling it
 * planned would send an operator to knock ports nothing is listening for.
 */
const ARM_PENDING_STAGES: ReadonlySet<GuardStage> = new Set<GuardStage>(["armPending", "armApproved"]);

/**
 * What the page can say about this node's knock sequence.
 *
 * The distinction that matters is between "there is no sequence" and "there is
 * one and this console will not tell you": an operator locked out reads
 * silence as the first and goes hunting through an operations note. Only
 * `installed` means the node is listening for the sequence now.
 */
export function knockKnowledgeFor(state: NodeGuardState): KnockKnowledge {
  if (!state.arm) return "unknown";
  const declared = parseKnockDeclared(state.arm.plan);
  if (declared === undefined) return "unknown";
  if (!declared) return "no_knock";
  if (ARM_APPLIED_STAGES.has(state.stage)) return "installed";
  return ARM_PENDING_STAGES.has(state.stage) ? "planned" : "unknown";
}

export interface RevertDeadline {
  /** Epoch milliseconds when the node reverts on its own. */
  at: number;
  windowSec: number;
  /** Epoch milliseconds when the arm was recorded as applied. */
  startedAt: number;
}

/**
 * When a node reverts unless confirmed.
 *
 * The server has no deadline field. What it has is the moment the arm was
 * recorded as applied (`updated_at`, set when the task result arrived) and the
 * window the plan was rendered with. The timer on the box started a little
 * before the record did, so this deadline is the latest it can be, never
 * earlier: an operator who trusts it has slightly less time than it says.
 */
export function revertDeadline(state: NodeGuardState): RevertDeadline | undefined {
  if (!state.revertArmed || !state.arm) return undefined;
  const startedAt = Date.parse(state.arm.updated_at || state.arm.created_at || "");
  if (Number.isNaN(startedAt)) return undefined;
  const windowSec = parseConfirmWindow(state.arm.plan) ?? DEFAULT_CONFIRM_WINDOW_SEC;
  return { at: startedAt + windowSec * 1000, windowSec, startedAt };
}

/**
 * Whether the window on an applied arm has closed with no confirm applied.
 *
 * The approvals still read "applied arm, no confirm", which is why the stage
 * machine keeps saying the revert is armed. The box does not: its timer fired
 * at or before the deadline above, so past it the node has reverted and a
 * confirm would cancel a revert that already ran. Callers pass the clock in
 * so the answer is recomputed on every render, not once at load.
 */
export function revertWindowPassed(state: NodeGuardState, now: number): boolean {
  const deadline = revertDeadline(state);
  return deadline !== undefined && deadline.at <= now;
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
