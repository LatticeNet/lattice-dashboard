import assert from "node:assert/strict";
import { test } from "node:test";

import type { MachineView } from "@/lib/api/types";
import { MACHINES_FRESH_MS, consoleAction, likelyUnpaid, machinesNeedRead, nodeMachine, renewalState } from "../nodeMachineModel.ts";

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

test("the sheet reads the machine list again when it is old or has no row for a node that enrolled since", () => {
  const rows = [machine({})];
  const read = (listed: string[], at = 1_000) => ({ at, listed: new Set(listed) });
  assert.equal(machinesNeedRead(undefined, "node_1", read([], 0), 1_000), true, "never read");
  assert.equal(machinesNeedRead(rows, "node_1", read(["node_1"]), 1_000 + MACHINES_FRESH_MS - 1), false, "a fresh list with the row serves it");
  assert.equal(machinesNeedRead(rows, "node_1", read(["node_1"]), 1_000 + MACHINES_FRESH_MS + 1), true, "past a minute");
  // A node the page did not list when the read started may have enrolled after it; reading again tells that from a lack of access.
  assert.equal(machinesNeedRead(rows, "node_new", read(["node_1"]), 1_001), true);
  assert.equal(machinesNeedRead([], "node_1", read([]), 1_001), true, "a read that started before the page's list landed");
});

test("stepping through nodes the principal may not read re-reads nothing once a read could have listed them", () => {
  // The page listed node_1 to node_4 when the read started; the principal may read only node_1.
  const rows = [machine({})];
  const read = { at: 1_000, listed: new Set(["node_1", "node_2", "node_3", "node_4"]) };
  for (const [step, id] of ["node_2", "node_3", "node_4", "node_2"].entries()) {
    assert.equal(machinesNeedRead(rows, id, read, 1_001 + step * 300), false, `${id} at step ${step}: the missing row is the answer`);
  }
  // Past a minute the list is read again whatever it holds (a grant may have changed).
  assert.equal(machinesNeedRead(rows, "node_2", read, 1_000 + MACHINES_FRESH_MS + 1), true);
});

test("the provider console is revealed only with inventory:admin; without it the row says a link is stored", () => {
  assert.equal(consoleAction({ has_console_url: true }, true), "reveal");
  assert.equal(consoleAction({ has_console_url: true }, false), "stored");
  assert.equal(consoleAction({ has_console_url: false }, true), "none");
  assert.equal(consoleAction({}, true), "none");
});
