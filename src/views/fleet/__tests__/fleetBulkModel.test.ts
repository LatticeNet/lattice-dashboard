import assert from "node:assert/strict";
import { test } from "node:test";

import {
  nameList,
  planBulkDisable,
  pruneSelection,
  selectionHeaderState,
  setSelected,
  summarizeBulk,
  toggleSelected,
} from "../fleetBulkModel.ts";

const FLEET = [
  { id: "a", name: "fra-edge-01", disabled: false },
  { id: "b", name: "ams-relay-02", disabled: true },
  { id: "c", name: "sin-exit-03" },
  { id: "d", name: "nrt-edge-04", disabled: true },
];

test("a disable plan skips nodes already disabled", () => {
  const plan = planBulkDisable(FLEET, new Set(["a", "b", "c"]), true);
  assert.deepEqual(plan.targets.map((n) => n.id), ["a", "c"]);
  assert.deepEqual(plan.unchanged.map((n) => n.id), ["b"]);
  assert.deepEqual(plan.missing, []);
});

test("an enable plan skips nodes already enabled, treating a missing flag as enabled", () => {
  const plan = planBulkDisable(FLEET, new Set(["a", "b", "c", "d"]), false);
  assert.deepEqual(plan.targets.map((n) => n.id), ["b", "d"]);
  assert.deepEqual(plan.unchanged.map((n) => n.id), ["a", "c"]);
});

test("a plan reports selected ids that left the fleet instead of dropping them", () => {
  const plan = planBulkDisable(FLEET, new Set(["a", "gone-2", "gone-1"]), true);
  assert.deepEqual(plan.targets.map((n) => n.id), ["a"]);
  assert.deepEqual(plan.missing, ["gone-1", "gone-2"]);
});

test("a plan with nothing to do produces no targets at all", () => {
  const plan = planBulkDisable(FLEET, new Set(["b", "d"]), true);
  assert.equal(plan.targets.length, 0);
  assert.equal(plan.unchanged.length, 2);
});

test("targets keep fleet order rather than selection order", () => {
  const plan = planBulkDisable(FLEET, new Set(["c", "a"]), true);
  assert.deepEqual(plan.targets.map((n) => n.id), ["a", "c"]);
});

test("pruning drops ids that are no longer on screen", () => {
  const pruned = pruneSelection(new Set(["a", "b", "zz"]), ["a", "c"]);
  assert.deepEqual([...pruned].sort(), ["a"]);
  assert.deepEqual([...pruneSelection(new Set(), ["a"])], []);
});

test("toggling and range selection return new sets and leave the rest alone", () => {
  const one = toggleSelected(new Set(["a"]), "b");
  assert.deepEqual([...one].sort(), ["a", "b"]);
  assert.deepEqual([...toggleSelected(one, "a")], ["b"]);
  const added = setSelected(new Set(["z"]), ["a", "b"], true);
  assert.deepEqual([...added].sort(), ["a", "b", "z"]);
  assert.deepEqual([...setSelected(added, ["a", "b"], false)], ["z"]);
});

test("the header checkbox reads all, none, some, and an empty run", () => {
  assert.equal(selectionHeaderState(new Set(["a", "b"]), ["a", "b"]), true);
  assert.equal(selectionHeaderState(new Set(["a"]), ["a", "b"]), "indeterminate");
  assert.equal(selectionHeaderState(new Set(["z"]), ["a", "b"]), false);
  assert.equal(selectionHeaderState(new Set(["a"]), []), false);
});

test("a batch that did nothing is never reported as a success", () => {
  assert.equal(summarizeBulk([], []).kind, "none");
  assert.equal(summarizeBulk([{ id: "a" }], []).kind, "all");
});

test("a batch that half worked is partial, and what failed stays selected", () => {
  const outcome = summarizeBulk([{ id: "a" }], [{ item: { id: "b" }, error: "409 conflict" }]);
  assert.equal(outcome.kind, "partial");
  assert.deepEqual(outcome.retryIds, ["b"]);
  assert.equal(outcome.failed[0]?.error, "409 conflict");
});

test("a batch where every call failed is failed, not partial", () => {
  const outcome = summarizeBulk([], [{ item: { id: "b" }, error: "boom" }, { item: { id: "c" }, error: "boom" }]);
  assert.equal(outcome.kind, "failed");
  assert.deepEqual(outcome.retryIds, ["b", "c"]);
});

test("a name list caps what it shows and counts the remainder", () => {
  assert.deepEqual(nameList(FLEET, 2), { names: "fra-edge-01, ams-relay-02", extra: 2 });
  assert.deepEqual(nameList(FLEET.slice(0, 1), 3), { names: "fra-edge-01", extra: 0 });
  assert.deepEqual(nameList([{ id: "raw-id" }], 3), { names: "raw-id", extra: 0 });
});
