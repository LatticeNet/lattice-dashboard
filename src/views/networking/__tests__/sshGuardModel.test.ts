import assert from "node:assert/strict";
import { test } from "node:test";

import {
  armFailureText,
  armRejection,
  armSuperseded,
  buildAdvancedRequest,
  buildFleetStates,
  buildPlanRequest,
  defaultGuardForm,
  deriveNodeGuardState,
  emptyAdvancedForm,
  guardCoverage,
  hasBlocking,
  knockKnowledgeFor,
  knockRowKnowledge,
  nodesAwaitingConfirm,
  parseConfirmWindow,
  parseKnockDeclared,
  parseMgmtSources,
  parsePortList,
  revertDeadline,
  revertWindowPassed,
  sortFindings,
  validateAdvanced,
  validateForm,
  ROTATION_CONFIRM_WINDOW_SEC,
  buildRotationRequest,
  parseArmMgmtSources,
  rotateEligibility,
  rotateOpenable,
  rotationDeadline,
  rotationFallbackFor,
  rotationRefusal,
  rotationSshPort,
  type GuardForm,
} from "../sshGuardModel.ts";

const NODE = "hk-edge-01";

function arm(over: Record<string, unknown> = {}) {
  return { id: "arm1", node_id: NODE, plugin: "sshguard", action: "sshguard-arm:v1", plan: "", status: "pending", created_at: "2026-08-28T10:00:00Z", ...over } as never;
}
function confirm(over: Record<string, unknown> = {}) {
  return { id: "cfm1", node_id: NODE, plugin: "sshguard", action: "sshguard-confirm:v1", plan: "", status: "pending", created_at: "2026-08-28T11:00:00Z", ...over } as never;
}

test("a node nobody has planned for is idle, and nothing is armed", () => {
  const s = deriveNodeGuardState([], NODE);
  assert.equal(s.stage, "idle");
  assert.equal(s.revertArmed, false);
});

test("the sequence walks pending, approved, then awaiting confirmation", () => {
  assert.equal(deriveNodeGuardState([arm({ status: "pending" })], NODE).stage, "armPending");
  assert.equal(deriveNodeGuardState([arm({ status: "approved" })], NODE).stage, "armApproved");
  assert.equal(deriveNodeGuardState([arm({ status: "applied" })], NODE).stage, "awaitingConfirm");
});

test("an applied arm with no confirm means a revert timer is running", () => {
  const s = deriveNodeGuardState([arm({ status: "applied" })], NODE);
  assert.equal(s.revertArmed, true, "an applied arm without confirmation must read as urgent");
});

test("the timer stays armed until the confirm is actually applied", () => {
  for (const status of ["pending", "approved"]) {
    const s = deriveNodeGuardState([arm({ status: "applied" }), confirm({ status })], NODE);
    assert.equal(s.revertArmed, true, `confirm ${status} does not cancel the revert`);
  }
  const done = deriveNodeGuardState([arm({ status: "applied" }), confirm({ status: "applied" })], NODE);
  assert.equal(done.stage, "confirmed");
  assert.equal(done.revertArmed, false);
});

test("a confirm from an earlier attempt does not vouch for a newer arm", () => {
  const s = deriveNodeGuardState(
    [
      confirm({ id: "old-confirm", status: "applied", created_at: "2026-08-27T10:00:00Z" }),
      arm({ id: "new-arm", status: "applied", created_at: "2026-08-28T10:00:00Z" }),
    ],
    NODE,
  );
  assert.equal(s.stage, "awaitingConfirm");
  assert.equal(s.revertArmed, true);
});

test("re-planning after a rejection does not leave the node looking broken", () => {
  const s = deriveNodeGuardState(
    [
      arm({ id: "rejected", status: "rejected", created_at: "2026-08-28T09:00:00Z" }),
      arm({ id: "fresh", status: "pending", created_at: "2026-08-28T10:00:00Z" }),
    ],
    NODE,
  );
  assert.equal(s.stage, "armPending");
  assert.equal(s.actionableApprovalId, "fresh");
});

test("another node's approvals never leak into this node's state", () => {
  const s = deriveNodeGuardState([arm({ node_id: "somewhere-else", status: "applied" })], NODE);
  assert.equal(s.stage, "idle");
});

test("only nodes with a running revert timer are listed as urgent", () => {
  const armed = deriveNodeGuardState([arm({ status: "applied" })], NODE);
  const done = deriveNodeGuardState([arm({ status: "applied" }), confirm({ status: "applied" })], "other");
  assert.deepEqual(nodesAwaitingConfirm([armed, done]).map((s) => s.nodeId), [NODE]);
});

test("management sources accept addresses and CIDRs, and reject typos", () => {
  const p = parseMgmtSources("203.0.113.5, 198.51.100.0/24\n2001:db8::1  bad.host 10.0.0.1/33");
  assert.deepEqual(p.values, ["203.0.113.5", "198.51.100.0/24", "2001:db8::1"]);
  assert.deepEqual(p.invalid, ["bad.host", "10.0.0.1/33"]);
});

test("a bare address stays bare rather than being silently widened", () => {
  assert.deepEqual(parseMgmtSources("203.0.113.5").values, ["203.0.113.5"]);
});

test("duplicates collapse so an approval does not carry the same source twice", () => {
  assert.deepEqual(parseMgmtSources("10.0.0.1 10.0.0.1").values, ["10.0.0.1"]);
});

function form(over: Partial<GuardForm> = {}): GuardForm {
  return {
    nodeId: NODE, sshPort: 58394, keepLegacyPort: false, mgmtSources: "203.0.113.5",
    enableKnock: true, outOfBandFallback: false, confirmWindowSec: 900, acceptFindings: false, ...over,
  };
}

test("the request omits what the operator did not choose, so tested defaults stand", () => {
  const req = buildPlanRequest(form({ sshPort: 0, mgmtSources: "", enableKnock: false, outOfBandFallback: true }));
  assert.deepEqual(req, { node_id: NODE, enable_knock: false, out_of_band_fallback: true });
});

test("a non-default confirmation window is sent, the default is not", () => {
  assert.equal(buildPlanRequest(form({ confirmWindowSec: 900 })).confirm_window_sec, undefined);
  assert.equal(buildPlanRequest(form({ confirmWindowSec: 300 })).confirm_window_sec, 300);
});

test("accepting blocking findings is explicit and travels with the request", () => {
  assert.equal(buildPlanRequest(form()).accept_findings, undefined);
  assert.equal(buildPlanRequest(form({ acceptFindings: true })).accept_findings, true);
});

test("a knock profile with no permanent way in and no fallback is refused here", () => {
  assert.ok(validateForm(form({ mgmtSources: "", outOfBandFallback: false })).includes("single_way_in"));
  assert.ok(!validateForm(form({ mgmtSources: "", outOfBandFallback: true })).includes("single_way_in"));
  assert.ok(!validateForm(form({ mgmtSources: "203.0.113.5" })).includes("single_way_in"));
});

test("moving ssh to 22 is not a move, and a short window is not a window", () => {
  assert.ok(validateForm(form({ sshPort: 22 })).includes("port_is_legacy"));
  assert.ok(validateForm(form({ confirmWindowSec: 60 })).includes("window_too_short"));
  assert.ok(validateForm(form({ sshPort: 70000 })).includes("port_range"));
  assert.ok(validateForm(form({ mgmtSources: "nope" })).includes("sources_invalid"));
});

test("blocking findings sort first, because they decide whether submit works", () => {
  const sorted = sortFindings([
    { code: "b_warn", severity: "warn", message: "" },
    { code: "a_block", severity: "block", message: "" },
    { code: "a_warn", severity: "warn", message: "" },
  ]);
  assert.deepEqual(sorted.map((f) => f.code), ["a_block", "a_warn", "b_warn"]);
  assert.equal(hasBlocking(sorted), true);
  assert.equal(hasBlocking(sorted.slice(1)), false);
});

test("the fleet view includes nodes nobody has armed, because those are the work", () => {
  const states = buildFleetStates([arm({ status: "applied" })], [
    { id: NODE, name: "HK edge" },
    { id: "untouched-1" },
    { id: "untouched-2" },
  ]);
  assert.equal(states.length, 3);
  assert.deepEqual(
    states.filter((s) => s.stage === "idle").map((s) => s.nodeId).sort(),
    ["untouched-1", "untouched-2"],
  );
});

test("a node that left the fleet keeps its history on the page", () => {
  const states = buildFleetStates([arm({ node_id: "retired", status: "applied" })], [{ id: "still-here" }]);
  assert.deepEqual(states.map((s) => s.nodeId).sort(), ["retired", "still-here"]);
});

test("urgent leads, finished sinks, because the list is read to decide what to do next", () => {
  const states = buildFleetStates(
    [
      arm({ id: "a1", node_id: "urgent", status: "applied" }),
      arm({ id: "a2", node_id: "done", status: "applied", created_at: "2026-08-28T09:00:00Z" }),
      confirm({ id: "c2", node_id: "done", status: "applied", created_at: "2026-08-28T09:30:00Z" }),
      arm({ id: "a3", node_id: "planned", status: "pending" }),
    ],
    [{ id: "urgent" }, { id: "done" }, { id: "planned" }, { id: "never" }],
  );
  assert.deepEqual(states.map((s) => s.nodeId), ["urgent", "planned", "never", "done"]);
});

test("coverage counts the three things an operator is deciding between", () => {
  const states = buildFleetStates(
    [
      arm({ id: "a1", node_id: "done", status: "applied", created_at: "2026-08-28T09:00:00Z" }),
      confirm({ id: "c1", node_id: "done", status: "applied", created_at: "2026-08-28T09:30:00Z" }),
      arm({ id: "a2", node_id: "midway", status: "applied" }),
      arm({ id: "a3", node_id: "broken", status: "rejected" }),
    ],
    [{ id: "done" }, { id: "midway" }, { id: "broken" }, { id: "never" }],
  );
  const c = guardCoverage(states);
  assert.deepEqual(c, { total: 4, done: 1, inFlight: 1, open: 2 });
});

test("the node name travels with the state so the list can show more than an id", () => {
  const states = buildFleetStates([], [{ id: "n1", name: "HK edge" }]);
  assert.equal(states[0].name, "HK edge");
});

// ── advanced overrides ──────────────────────────────────────────────────────

test("advanced fields left blank send nothing, so verified defaults stand", () => {
  const req = buildPlanRequest(form({ advanced: emptyAdvancedForm() }));
  assert.deepEqual(req, { node_id: NODE, ssh_port: 58394, mgmt_sources: ["203.0.113.5"], enable_knock: true });
});

test("an advanced field that is set travels, in the server's shape", () => {
  const req = buildPlanRequest(form({
    advanced: {
      ...emptyAdvancedForm(),
      gatePorts: "22, 3434",
      knockPorts: "20001 30002 40003",
      knockOpenFor: "1h",
      knockSeqTimeoutSec: "30",
      loginGraceTimeSec: "10",
      maxAuthTries: "2",
      maxStartups: "10:30:60",
      permitRootLogin: "no",
    },
  }));
  assert.deepEqual(req.gate_ports, [22, 3434]);
  assert.deepEqual(req.knock_ports, [20001, 30002, 40003]);
  assert.equal(req.knock_open_for, "1h");
  assert.equal(req.knock_seq_timeout_sec, 30);
  assert.equal(req.login_grace_time_sec, 10);
  assert.equal(req.max_auth_tries, 2);
  assert.equal(req.max_startups, "10:30:60");
  assert.equal(req.permit_root_login, "no");
});

test("a number-typed input handing back a number is read the same as its text", () => {
  const adv = { ...emptyAdvancedForm(), maxAuthTries: 4 as unknown as string };
  assert.equal(buildAdvancedRequest(adv).max_auth_tries, 4);
  assert.deepEqual(validateAdvanced(adv), []);
});

test("advanced values are checked against the server's own ranges before a round trip", () => {
  const bad = validateAdvanced({
    gatePorts: "22, http",
    knockPorts: "20001, 20001, 40003",
    knockOpenFor: "3h",
    knockSeqTimeoutSec: "2",
    loginGraceTimeSec: "601",
    maxAuthTries: "0",
    maxStartups: "10:30",
    permitRootLogin: "maybe",
  });
  assert.deepEqual(bad.sort(), [
    "gate_ports_invalid",
    "knock_open_for_invalid",
    "knock_ports_invalid",
    "knock_seq_timeout_range",
    "login_grace_range",
    "max_auth_tries_range",
    "max_startups_invalid",
    "permit_root_login_invalid",
  ].sort());
  assert.deepEqual(validateAdvanced(emptyAdvancedForm()), []);
  assert.deepEqual(validateAdvanced({ ...emptyAdvancedForm(), knockPorts: "20001 30002" }), ["knock_ports_invalid"], "a knock sequence is exactly three ports");
  assert.deepEqual(validateAdvanced({ ...emptyAdvancedForm(), knockPorts: "1000 30002 40003" }), ["knock_ports_invalid"], "knock ports live in 20000..60000");
  assert.deepEqual(validateAdvanced({ ...emptyAdvancedForm(), maxStartups: "10" }), [], "a bare start is an sshd value");
});

test("advanced errors surface through the form validator so one list blocks submit", () => {
  const errors = validateForm(form({ advanced: { ...emptyAdvancedForm(), maxAuthTries: "99" } }));
  assert.ok(errors.includes("max_auth_tries_range"));
});

test("port lists split on commas or spaces and keep what could not be a port", () => {
  assert.deepEqual(parsePortList("22, 3434 65535"), { values: [22, 3434, 65535], invalid: [] });
  assert.deepEqual(parsePortList("0 70000 ssh"), { values: [], invalid: ["0", "70000", "ssh"] });
  assert.deepEqual(parsePortList(""), { values: [], invalid: [] });
});

// ── evidence carried by the approvals ───────────────────────────────────────

test("a failed arm prints the line the task died on, with the full reason alongside", () => {
  // A task only runs for an approval someone approved, so a failed arm always
  // carries an approver; that is what tells it apart from a refusal below.
  const s = deriveNodeGuardState([arm({ status: "rejected", approved_by: "cdcd", reason: "apply: step 3/5\nsshd -t: /etc/ssh/sshd_config.d/lattice.conf line 4: Bad configuration option" })], NODE);
  const text = armFailureText(s);
  assert.equal(text?.line, "sshd -t: /etc/ssh/sshd_config.d/lattice.conf line 4: Bad configuration option");
  assert.ok(text?.full.startsWith("apply: step 3/5"));
  assert.equal(armRejection(s), undefined, "a task failure is not a refusal");
});

test("a failed arm with no reason, and a node that did not fail, print nothing", () => {
  assert.equal(armFailureText(deriveNodeGuardState([arm({ status: "rejected", approved_by: "cdcd" })], NODE)), undefined);
  assert.equal(armFailureText(deriveNodeGuardState([arm({ status: "applied" })], NODE)), undefined);
});

test("an arm a person refused reads as a refusal with its moment, never as a failure", () => {
  // The live shape: the operator rejected the plan, the server left the
  // plan's own summary in `reason` and recorded no approver. Printing that
  // summary as a failure line is what made three NAT nodes look broken.
  const refused = deriveNodeGuardState(
    [arm({ status: "rejected", reason: "Harden sshd only, no firewall (auto-revert in 3600s)", updated_at: "2026-08-29T04:27:50Z" })],
    NODE,
  );
  assert.equal(refused.stage, "armFailed");
  assert.deepEqual(armRejection(refused), { at: "2026-08-29T04:27:50Z" });
  assert.equal(armFailureText(refused), undefined, "the plan summary is not a failure reason");
  // Neither a dismissal nor an applied arm is a refusal.
  assert.equal(armRejection(deriveNodeGuardState([arm({ status: "dismissed" })], NODE)), undefined);
  assert.equal(armRejection(deriveNodeGuardState([arm({ status: "applied" })], NODE)), undefined);
});

test("the server's rejecting actor is read off the row, with the moment it recorded", () => {
  // The server writes rejected_by and rejected_at only on a person's path.
  // The plan summary still sits in `reason`, and must not print as a fault.
  const refused = deriveNodeGuardState(
    [arm({ status: "rejected", reason: "Move sshd to :58394, knock on (auto-revert in 900s)", rejected_by: "user_ops", rejected_at: "2026-09-01T08:15:00Z", updated_at: "2026-09-01T08:15:02Z" })],
    NODE,
  );
  assert.deepEqual(armRejection(refused), { at: "2026-09-01T08:15:00Z", by: "user_ops" });
  assert.equal(armFailureText(refused), undefined);
  assert.equal(armSuperseded(refused), undefined);
  // The actor wins over the old approver reading: a row that carries both
  // was refused by the person named, whatever approved_by says.
  const both = deriveNodeGuardState([arm({ status: "rejected", approved_by: "cdcd", reason: "sshd -t: bad option", rejected_by: "user_ops" })], NODE);
  assert.equal(armRejection(both)?.by, "user_ops");
  assert.equal(armFailureText(both), undefined);
});

test("an arm retired as superseded is neither a failure nor a refusal", () => {
  // The server retires an arm that was approved and dispatched before apply
  // results reached approvals. The record carries its stale code and a
  // reason that explains the retirement; nothing on the node failed.
  const reason = "approval superseded: approved but never applied";
  for (const status of ["dismissed", "rejected"]) {
    const s = deriveNodeGuardState([arm({ status, stale_code: "sshguard_approval_superseded", reason, updated_at: "2026-08-31T02:00:00Z" })], NODE);
    assert.equal(s.stage, "armFailed", status);
    assert.deepEqual(armSuperseded(s), { at: "2026-08-31T02:00:00Z" }, status);
    assert.equal(armRejection(s), undefined, `${status}: a retirement is not a refusal`);
    assert.equal(armFailureText(s), undefined, `${status}: the retirement note is not a fault`);
  }
  // A person's rejection carrying the code by accident is still a rejection.
  const named = deriveNodeGuardState([arm({ status: "rejected", stale_code: "sshguard_approval_superseded", rejected_by: "user_ops" })], NODE);
  assert.equal(armSuperseded(named), undefined);
  assert.equal(armRejection(named)?.by, "user_ops");
  // A dismissed row without the code is what it always was: nothing to print.
  const plain = deriveNodeGuardState([arm({ status: "dismissed", reason: "operator cleanup" })], NODE);
  assert.equal(armSuperseded(plain), undefined);
  assert.equal(armFailureText(plain)?.line, "operator cleanup");
});

test("the confirm window is read back from the plan the arm was rendered with", () => {
  assert.equal(parseConfirmWindow("stage: arm\nnode_id: x\nconfirm_window_sec: 300\n"), 300);
  assert.equal(parseConfirmWindow("no such line"), undefined);
  assert.equal(parseConfirmWindow(undefined), undefined);
});

test("the revert deadline is the applied moment plus the plan's window", () => {
  const applied = arm({ status: "applied", updated_at: "2026-09-02T03:00:00Z", plan: "confirm_window_sec: 300\n" });
  const d = revertDeadline(deriveNodeGuardState([applied], NODE));
  assert.equal(d?.windowSec, 300);
  assert.equal(d?.startedAt, Date.parse("2026-09-02T03:00:00Z"));
  assert.equal(d?.at, Date.parse("2026-09-02T03:05:00Z"));
});

test("a plan with no window line falls back to the server default, and no timer means no deadline", () => {
  const applied = arm({ status: "applied", updated_at: "2026-09-02T03:00:00Z" });
  assert.equal(revertDeadline(deriveNodeGuardState([applied], NODE))?.windowSec, 900);
  assert.equal(revertDeadline(deriveNodeGuardState([arm({ status: "pending" })], NODE)), undefined);
  assert.equal(revertDeadline(deriveNodeGuardState([arm({ status: "applied", created_at: "not a date" })], NODE)), undefined);
});

test("the window is closed once the clock reaches the deadline, and never before", () => {
  const applied = arm({ status: "applied", updated_at: "2026-09-02T03:00:00Z", plan: "confirm_window_sec: 300\n" });
  const s = deriveNodeGuardState([applied], NODE);
  assert.equal(revertWindowPassed(s, Date.parse("2026-09-02T03:04:59Z")), false);
  assert.equal(revertWindowPassed(s, Date.parse("2026-09-02T03:05:00Z")), true);
  assert.equal(revertWindowPassed(deriveNodeGuardState([arm({ status: "pending" })], NODE), Date.parse("2030-01-01T00:00:00Z")), false, "no timer, no window to close");
});

test("the sheet's default policy is refused before anything is typed, so the refusal must show from the start", () => {
  const form = defaultGuardForm(NODE);
  assert.deepEqual(validateForm(form), ["single_way_in"]);
  assert.deepEqual(validateForm({ ...form, mgmtSources: "203.0.113.5" }), []);
  assert.deepEqual(validateForm({ ...form, outOfBandFallback: true }), []);
  assert.deepEqual(validateForm(defaultGuardForm()), ["node_required", "single_way_in"], "with no member left, the missing node is listed too");
});


/* ------------------------------------------------------------------ */
/* The knock sequence: what the page may say about it.                  */
/* ------------------------------------------------------------------ */

// RenderArmPlan writes `knock:` into the header block, next to ssh_port.
const PLAN_WITH_KNOCK = "# Lattice SSH Guard plan\n\nstage: arm\nnode_id: hk-edge-01\nssh_port: 58394\nkeep_legacy_port: true\nknock: true\nconfirm_window_sec: 900\n";
const PLAN_WITHOUT_KNOCK = PLAN_WITH_KNOCK.replace("knock: true", "knock: false");

test("the header says whether a plan carries a knock sequence, without reading the sequence", () => {
  assert.equal(parseKnockDeclared(PLAN_WITH_KNOCK), true);
  assert.equal(parseKnockDeclared(PLAN_WITHOUT_KNOCK), false);
  assert.equal(parseKnockDeclared(undefined), undefined);
  assert.equal(parseKnockDeclared("not a plan"), undefined);
});

// The question the operator actually asked. A node with no plan and a node
// whose plan turned knocking off are different answers, and reading either as
// silence is what sent him to the operations note.
test("a node the control plane has never planned for reports unknown, not no-knock", () => {
  const s = deriveNodeGuardState([], NODE);
  assert.equal(knockKnowledgeFor(s), "unknown");
});

test("a plan that turned knocking off says so rather than looking like a missing secret", () => {
  const s = deriveNodeGuardState([arm({ status: "applied", plan: PLAN_WITHOUT_KNOCK })], NODE);
  assert.equal(knockKnowledgeFor(s), "no_knock");
});

// Only a sequence that reached the box is one an operator can knock. Reporting
// a pending plan as installed would send him to knock ports nothing is
// listening for, and that failure is indistinguishable from a wrong sequence.
test("an arm that has not applied is planned, not installed", () => {
  for (const status of ["pending", "approved"]) {
    const s = deriveNodeGuardState([arm({ status, plan: PLAN_WITH_KNOCK })], NODE);
    assert.equal(knockKnowledgeFor(s), "planned", status);
  }
});

test("an applied arm is installed, whether or not the confirm has landed", () => {
  const armed = deriveNodeGuardState([arm({ status: "applied", plan: PLAN_WITH_KNOCK })], NODE);
  assert.equal(armed.stage, "awaitingConfirm");
  assert.equal(knockKnowledgeFor(armed), "installed");

  const done = deriveNodeGuardState(
    [arm({ status: "applied", plan: PLAN_WITH_KNOCK }), confirm({ status: "applied" })],
    NODE,
  );
  assert.equal(done.stage, "confirmed");
  assert.equal(knockKnowledgeFor(done), "installed");
});

// A plan the reader cannot parse must not be reported as a sequence that
// exists: offering a reveal that then fails is worse than saying it is unknown.
// A rejected arm's sequence never reached the node. Calling it planned would
// send an operator to knock ports nothing is listening for, and that failure
// is indistinguishable from the sequence being wrong.
test("a rejected arm is not a planned sequence", () => {
  const s = deriveNodeGuardState([arm({ status: "rejected", plan: PLAN_WITH_KNOCK })], NODE);
  assert.equal(s.stage, "armFailed");
  assert.equal(knockKnowledgeFor(s), "unknown");
});

test("an unreadable plan reports unknown rather than claiming a sequence", () => {
  const s = deriveNodeGuardState([arm({ status: "applied", plan: "garbage" })], NODE);
  assert.equal(knockKnowledgeFor(s), "unknown");
});

// The server reads the node's whole history and the page reads one plan, so
// the two can disagree; when they do, the server is right. A retired record
// that still governs the box is the case the plan cannot see.
test("the row reads its plan until the server answers, then the server's word stands", () => {
  const retired = deriveNodeGuardState([arm({ status: "dismissed", stale_code: "sshguard_approval_superseded", plan: PLAN_WITH_KNOCK })], NODE);
  assert.equal(retired.stage, "armFailed");
  const waiting = knockRowKnowledge(retired, undefined);
  assert.deepEqual(waiting, { knowledge: "unknown", previousHonoured: false, fromServer: false });

  const note = "The control plane knows this node's knock sequence from an arm record that was later dismissed as superseded.";
  const answered = knockRowKnowledge(retired, { knowledge: "installed_superseded", note, previous_honoured: true });
  assert.deepEqual(answered, { knowledge: "installed_superseded", note, previousHonoured: true, fromServer: true });

  // The flag is read only when the server sets it; an omitted field is false.
  const plain = knockRowKnowledge(retired, { knowledge: "unknown", note: "Every SSH Guard plan for this node was rejected or dismissed." });
  assert.equal(plain.previousHonoured, false);
  assert.equal(plain.knowledge, "unknown");
});

// ── knock rotation ──────────────────────────────────────────────────────────

const PREVIOUS = "27431 45902 38117";

test("rotation is offered by digest for an installed sequence, plain or from a retired record", () => {
  assert.deepEqual(rotateEligibility([{ knowledge: "installed" }], "", 58394), { ok: true, path: "digest" });
  assert.deepEqual(rotateEligibility([{ knowledge: "installed_superseded" }], "", 58394), { ok: true, path: "digest" });
  // The digest path never reads the advanced field, even when it is filled.
  assert.deepEqual(rotateEligibility([{ knowledge: "installed" }], PREVIOUS, 58394), { ok: true, path: "digest" });
});

test("rotation acts on exactly one row", () => {
  assert.deepEqual(rotateEligibility([], "", 58394), { ok: false, code: "select_one" });
  assert.deepEqual(rotateEligibility([{ knowledge: "installed" }, { knowledge: "installed" }], "", 58394), { ok: false, code: "select_one" });
});

test("a planned or knock-less row has nothing to rotate from, and says which", () => {
  assert.deepEqual(rotateEligibility([{ knowledge: "planned" }], PREVIOUS, 58394), { ok: false, code: "planned" });
  assert.deepEqual(rotateEligibility([{ knowledge: "no_knock" }], PREVIOUS, 58394), { ok: false, code: "no_knock" });
});

test("an unknown row rotates only by the advanced path, once the previous ports are well formed", () => {
  assert.deepEqual(rotateEligibility([{ knowledge: "unknown" }], "", 3434), { ok: false, code: "previous_ports_required" });
  assert.deepEqual(rotateEligibility([{ knowledge: "unknown" }], "   ", 3434), { ok: false, code: "previous_ports_required" });
  for (const bad of ["1 2 3", "27431 45902", "27431 45902 45902", "27431,45902,38117,20001", "27431 abc 38117"]) {
    assert.deepEqual(rotateEligibility([{ knowledge: "unknown" }], bad, 3434), { ok: false, code: "previous_ports_invalid" }, bad);
  }
  assert.deepEqual(rotateEligibility([{ knowledge: "unknown" }], "27431, 45902, 38117", 3434), {
    ok: true,
    path: "previous_ports",
    ports: [27431, 45902, 38117],
  });
});

test("no known ssh port refuses the rotation before a request is built", () => {
  assert.deepEqual(rotateEligibility([{ knowledge: "installed" }], "", undefined), { ok: false, code: "port_unknown" });
});

test("the dialog opens for an installed row and for an unknown row that still needs its ports, not for the rest", () => {
  assert.equal(rotateOpenable({ ok: true, path: "digest" }), true);
  assert.equal(rotateOpenable({ ok: false, code: "previous_ports_required" }), true);
  assert.equal(rotateOpenable({ ok: false, code: "previous_ports_invalid" }), true);
  assert.equal(rotateOpenable({ ok: false, code: "planned" }), false);
  assert.equal(rotateOpenable({ ok: false, code: "no_knock" }), false);
  assert.equal(rotateOpenable({ ok: false, code: "select_one" }), false);
});

test("the ssh port comes from the server, then the arm plan, then what sshd is seen listening on", () => {
  assert.equal(rotationSshPort({ ssh_port: 58394 }, { plan: "ssh_port: 4000\n" }, [22]), 58394);
  assert.equal(rotationSshPort(undefined, { plan: "stage: arm\nssh_port: 4000\nknock: true\n" }, [22]), 4000);
  assert.equal(rotationSshPort(undefined, { plan: "stage: arm\n" }, [3434, 22]), 3434);
  assert.equal(rotationSshPort(undefined, undefined, []), undefined);
});

test("the request names the installed sequence by digest, keeps the row's port, and asks for the longest window", () => {
  const req = buildRotationRequest({
    nodeId: NODE,
    sshPort: 58394,
    from: { sha256: "ab".repeat(32) },
    fallback: { kind: "terminal" },
  });
  assert.deepEqual(req, {
    node_id: NODE,
    ssh_port: 58394,
    enable_knock: true,
    confirm_window_sec: ROTATION_CONFIRM_WINDOW_SEC,
    rotate_from_sha256: "ab".repeat(32),
    out_of_band_fallback: true,
  });
  assert.equal(ROTATION_CONFIRM_WINDOW_SEC, 3600);
  assert.equal("previous_knock_ports" in req, false, "the digest path must not carry ports");
  assert.equal("knock_ports" in req, false, "the new sequence is drawn server-side");
});

test("the advanced request carries the previous ports and the sources the last arm listed", () => {
  const req = buildRotationRequest({
    nodeId: NODE,
    sshPort: 3434,
    from: { previousPorts: [27431, 45902, 38117] },
    fallback: { kind: "sources", sources: ["203.0.113.5/32", "2001:db8::/64"] },
  });
  assert.deepEqual(req, {
    node_id: NODE,
    ssh_port: 3434,
    enable_knock: true,
    confirm_window_sec: 3600,
    previous_knock_ports: [27431, 45902, 38117],
    mgmt_sources: ["203.0.113.5/32", "2001:db8::/64"],
  });
  assert.equal("rotate_from_sha256" in req, false);
  assert.equal("out_of_band_fallback" in req, false, "sources and the terminal fallback are alternatives");
});

test("a node on the legacy port keeps its current port rather than naming 22, which the server refuses", () => {
  for (const port of [0, 22]) {
    const req = buildRotationRequest({ nodeId: NODE, sshPort: port, from: { sha256: "x" }, fallback: { kind: "terminal" } });
    assert.equal("ssh_port" in req, false, `port ${port}`);
  }
});

test("the fallback is read off the arm plan: listed sources, or the terminal when none were", () => {
  const withSources = "stage: arm\n\n## Management sources (reach SSH without knocking, no expiry)\n\n- 203.0.113.5/32\n- 198.51.100.0/24\n\n## sshd drop-in: /etc/ssh/sshd_config.d/50-lattice-guard.conf\n\n- not a source\n";
  assert.deepEqual(parseArmMgmtSources(withSources), ["203.0.113.5/32", "198.51.100.0/24"]);
  assert.deepEqual(rotationFallbackFor({ plan: withSources }), { kind: "sources", sources: ["203.0.113.5/32", "198.51.100.0/24"] });
  const none = "stage: arm\n\n## Management sources (reach SSH without knocking, no expiry)\n\n- (none)\n\n## sshd drop-in\n";
  assert.deepEqual(parseArmMgmtSources(none), []);
  assert.deepEqual(rotationFallbackFor({ plan: none }), { kind: "terminal" });
  assert.equal(parseArmMgmtSources("stage: arm\n"), undefined);
  assert.deepEqual(rotationFallbackFor(undefined), { kind: "terminal" });
});

test("a lint refusal is rendered from the findings the server sent, verbatim, blocking first", () => {
  const overridden = {
    code: "sshguard_overridden_by_guard",
    severity: "block",
    message: "this node's lattice_guard ruleset is policy drop and does not accept tcp/58394. An accept in the knock table does not let a packet skip lattice_guard, so knocking would appear to succeed and the connection would still never open. Open tcp/58394 in netguard first.",
  };
  const warn = { code: "sshguard_no_reality", severity: "warn", message: "this node has never reported its listeners" };
  const err = Object.assign(new Error("conflict"), {
    status: 409,
    body: { error: "plan blocked by lint findings", findings: [warn, overridden] },
  });
  const refusal = rotationRefusal(err);
  assert.equal(refusal.message, "plan blocked by lint findings");
  assert.deepEqual(refusal.findings, [overridden, warn]);
  assert.equal(refusal.findings[0]?.message, overridden.message, "the message must reach the screen unedited");
});

test("a refusal without findings is its message, and a malformed body is not mistaken for findings", () => {
  const plain = rotationRefusal(new Error("rotate_from_sha256 does not name the sequence the control plane holds as installed (from approval_1); reveal it again, or pass previous_knock_ports if the node runs something else"));
  assert.match(plain.message, /^rotate_from_sha256 does not name/);
  assert.deepEqual(plain.findings, []);
  const odd = rotationRefusal(Object.assign(new Error("conflict"), { body: { findings: [{ code: 1 }, "x", null] } }));
  assert.equal(odd.message, "conflict");
  assert.deepEqual(odd.findings, []);
  assert.equal(rotationRefusal("boom").message, "boom");
});

test("mid-rotation the previous sequence is honoured until the applied moment plus the arm's window", () => {
  const applied = "2026-09-04T10:00:00Z";
  const state = deriveNodeGuardState(
    [arm({ status: "applied", updated_at: applied, plan: "stage: arm\nknock: true\nconfirm_window_sec: 3600\n" })],
    NODE,
  );
  const deadline = rotationDeadline(state, { previous_honoured: true });
  assert.ok(deadline);
  assert.equal(deadline.windowSec, 3600);
  assert.equal(deadline.startedAt, Date.parse(applied));
  assert.equal(deadline.at, Date.parse(applied) + 3600 * 1000);
});

test("the server's applied_at wins over the record's timestamp, and no previous_honoured means no deadline", () => {
  const state = deriveNodeGuardState(
    [arm({ status: "applied", updated_at: "2026-09-04T10:00:00Z", plan: "confirm_window_sec: 3600\n" })],
    NODE,
  );
  const serverAt = "2026-09-04T09:58:30Z";
  assert.equal(rotationDeadline(state, { previous_honoured: true, applied_at: serverAt })?.at, Date.parse(serverAt) + 3600_000);
  assert.equal(rotationDeadline(state, { previous_honoured: false }), undefined);
  assert.equal(rotationDeadline(state, {}), undefined);
  assert.equal(rotationDeadline(state, undefined), undefined);
});

test("a sequence known from a retired record has no applied moment, so no deadline is invented", () => {
  const state = deriveNodeGuardState(
    [arm({ status: "dismissed", stale_code: "sshguard_approval_superseded", updated_at: "2026-09-01T00:00:00Z", plan: "confirm_window_sec: 3600\n" })],
    NODE,
  );
  assert.equal(state.stage, "armFailed");
  assert.equal(rotationDeadline(state, { previous_honoured: true }), undefined);
});
