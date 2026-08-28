import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildPlanRequest,
  deriveNodeGuardState,
  hasBlocking,
  nodesAwaitingConfirm,
  parseMgmtSources,
  sortFindings,
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
