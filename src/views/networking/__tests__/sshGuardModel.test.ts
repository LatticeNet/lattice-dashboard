import assert from "node:assert/strict";
import { test } from "node:test";

import {
  armFailureText,
  buildAdvancedRequest,
  buildFleetStates,
  buildPlanRequest,
  deriveNodeGuardState,
  emptyAdvancedForm,
  guardCoverage,
  hasBlocking,
  nodesAwaitingConfirm,
  parseConfirmWindow,
  parseMgmtSources,
  parsePortList,
  revertDeadline,
  sortFindings,
  validateAdvanced,
  validateForm,
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
  const s = deriveNodeGuardState([arm({ status: "rejected", reason: "apply: step 3/5\nsshd -t: /etc/ssh/sshd_config.d/lattice.conf line 4: Bad configuration option" })], NODE);
  const text = armFailureText(s);
  assert.equal(text?.line, "sshd -t: /etc/ssh/sshd_config.d/lattice.conf line 4: Bad configuration option");
  assert.ok(text?.full.startsWith("apply: step 3/5"));
});

test("a failed arm with no reason, and a node that did not fail, print nothing", () => {
  assert.equal(armFailureText(deriveNodeGuardState([arm({ status: "rejected" })], NODE)), undefined);
  assert.equal(armFailureText(deriveNodeGuardState([arm({ status: "applied" })], NODE)), undefined);
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
