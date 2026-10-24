import assert from "node:assert/strict";
import { test } from "node:test";

import { rowExclusions, shownNames } from "../policyMatrixModel.ts";

const exclusions = [
  { from: "grp_a", policy_id: "gnp_1", label: "a-to-c", nodes: [{ id: "n2", name: "la-1" }], hidden: 0 },
  { from: "grp_a", policy_id: "gnp_2", label: "a-ops", nodes: [{ id: "n2", name: "la-1" }, { id: "n5" }], hidden: 1 },
  { policy_id: "gnp_f", label: "fleet-dns", nodes: [{ id: "n3", name: "sg-1" }] },
];

test("a group row lists each excluded member once, with hidden ones counted", () => {
  const row = rowExclusions(exclusions, "grp_a");
  assert.deepEqual(row.names, ["la-1", "n5"]);
  assert.equal(row.hidden, 1);
  assert.deepEqual(row.byPolicy.map((p) => p.label), ["a-to-c", "a-ops"]);
});

test("the fleet row reads only exclusions without a source group", () => {
  assert.deepEqual(rowExclusions(exclusions).names, ["sg-1"]);
  assert.deepEqual(rowExclusions(exclusions, "grp_b").names, []);
  assert.deepEqual(rowExclusions(undefined, "grp_a"), { names: [], hidden: 0, byPolicy: [] });
});

test("a narrow header shows two names and counts the rest, hidden ones included", () => {
  const row = rowExclusions(exclusions, "grp_a");
  assert.deepEqual(shownNames(row, 1), { names: ["la-1"], more: 2 });
  assert.deepEqual(shownNames(row), { names: ["la-1", "n5"], more: 1 });
});
