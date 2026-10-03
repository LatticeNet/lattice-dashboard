import assert from "node:assert/strict";
import { test } from "node:test";

import type { MachineView } from "@/lib/api/types";
import { likelyUnpaid, nodeMachine, renewalState } from "../nodeMachineModel.ts";

const machine = (over: Partial<MachineView>): MachineView => ({
  id: "mch_1",
  node_id: "node_1",
  online: true,
  vendor: "DMIT",
  renewal_cycle: "monthly",
  next_renewal: "2026-10-24T00:00:00Z",
  days_until_renewal: 21,
  ...over,
});

test("the node's row decides: a profile, a node not in Inventory yet, or no row the principal may read", () => {
  const rows = [machine({}), machine({ id: "", node_id: "node_2", vendor: undefined, renewal_cycle: undefined, next_renewal: undefined, days_until_renewal: undefined })];
  const profiled = nodeMachine(rows, "node_1");
  assert.equal(profiled.kind, "profiled");
  assert.deepEqual(profiled.kind === "profiled" && profiled.renewal, { kind: "upcoming", date: "2026-10-24", days: 21, soon: false });
  assert.equal(nodeMachine(rows, "node_2").kind, "unprofiled");
  assert.equal(nodeMachine(rows, "node_3").kind, "unreadable");
  assert.equal(nodeMachine([], "node_1").kind, "unreadable");
});

test("a renewal reads as passed, today, soon, later, untracked or incomplete", () => {
  assert.deepEqual(renewalState(machine({ next_renewal: "2026-09-26T00:00:00Z", days_until_renewal: -7 })), { kind: "passed", date: "2026-09-26", days: 7 });
  assert.deepEqual(renewalState(machine({ next_renewal: "2026-10-03T00:00:00Z", days_until_renewal: 0 })), { kind: "today", date: "2026-10-03" });
  assert.deepEqual(renewalState(machine({ next_renewal: "2026-10-17T00:00:00Z", days_until_renewal: 14 })), { kind: "upcoming", date: "2026-10-17", days: 14, soon: true });
  assert.deepEqual(renewalState(machine({ renewal_cycle: undefined, next_renewal: undefined, days_until_renewal: undefined })), { kind: "untracked" });
  // Go's zero time is no date.
  assert.deepEqual(renewalState(machine({ renewal_cycle: undefined, next_renewal: "0001-01-01T00:00:00Z" })), { kind: "untracked" });
  // A cycle without a date is a renewal someone meant to track.
  assert.deepEqual(renewalState(machine({ next_renewal: undefined, days_until_renewal: undefined })), { kind: "incomplete" });
});

test("a passed renewal explains a quiet node only when it went quiet on or after the day before the due date", () => {
  const passed = renewalState(machine({ next_renewal: "2026-09-26T00:00:00Z", days_until_renewal: -7 }));
  assert.equal(likelyUnpaid(passed, false, "2026-09-27T03:10:00Z"), true, "quiet the day after");
  assert.equal(likelyUnpaid(passed, false, "2026-09-25T00:00:00Z"), true, "quiet the day before");
  assert.equal(likelyUnpaid(passed, false, "2026-09-19T00:00:00Z"), false, "quiet a week before the bill");
  assert.equal(likelyUnpaid(passed, false, undefined), true, "no time it went quiet");
  assert.equal(likelyUnpaid(passed, true, "2026-09-27T03:10:00Z"), false, "still reporting");
  const later = renewalState(machine({}));
  assert.equal(likelyUnpaid(later, false, "2026-09-27T03:10:00Z"), false, "renewal still ahead");
});
