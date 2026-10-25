import assert from "node:assert/strict";
import { test } from "node:test";

import { ApiError } from "../api/client.ts";
import { changedFields, conflictValue, isVersionConflict, pathSteps, refusalFocusIndex, refusalOf, resolveField, theirValues, valueAt } from "../saveRefusal.ts";

// Design 32 R6: the server names the deepest field it can; the editor
// registers the controls it has. The longest registered ancestor wins.
test("a server path lands on the control that edits it", () => {
  const registered = ["name", "targets", "targets.exclude", "addresses", "rules", "rules[2]"];
  assert.equal(resolveField("targets.exclude[1]", registered), "targets.exclude");
  assert.equal(resolveField("targets.nodes[0]", registered), "targets");
  assert.equal(resolveField("addresses[3]", registered), "addresses");
  assert.equal(resolveField("rules[2].ports", registered), "rules[2]");
  assert.equal(resolveField("rules[10]", registered), "rules");
  assert.equal(resolveField("name", registered), "name");
  // A prefix that is not an ancestor is not a match.
  assert.equal(resolveField("names", registered), undefined);
  assert.equal(resolveField("degraded", registered), undefined);
  assert.equal(resolveField(undefined, registered), undefined);
});

// A refusal focuses the control that edits the field, never a button: in a
// selector the first button removes a chip, one keypress from losing it.
test("a refusal focuses the chosen option, else the field that takes input, else a widget, never a button", () => {
  const remove = { tag: "button" };
  const search = { tag: "input", type: "search" };
  assert.equal(refusalFocusIndex([remove, remove, search]), 2);
  const radio = { tag: "input", type: "radio" };
  assert.equal(refusalFocusIndex([radio, { ...radio, checked: true }, { tag: "input", type: "number" }]), 1);
  assert.equal(refusalFocusIndex([{ tag: "button", role: "radio" }, { tag: "button", role: "radio", checked: true }]), 1);
  assert.equal(refusalFocusIndex([{ tag: "button" }, { tag: "textarea" }, { tag: "select" }]), 1);
  assert.equal(refusalFocusIndex([remove, { tag: "button", role: "switch" }]), 1);
  assert.equal(refusalFocusIndex([radio, { tag: "input", type: "checkbox" }]), 0);
  // Only buttons: the holder itself takes focus.
  assert.equal(refusalFocusIndex([remove, { tag: "button" }]), -1);
  assert.equal(refusalFocusIndex([]), -1);
});

test("paths walk keys and indexes", () => {
  assert.deepEqual(pathSteps("rules[2].ports"), ["rules", 2, "ports"]);
  assert.deepEqual(pathSteps("a[0][1].b"), ["a", 0, 1, "b"]);
  const value = { rules: [{}, {}, { ports: [443] }], targets: { all: true } };
  assert.deepEqual(valueAt(value, "rules[2].ports"), [443]);
  assert.equal(valueAt(value, "targets.all"), true);
  assert.equal(valueAt(value, "targets.nodes[0]"), undefined);
});

// A conflict names what changed between the version the editor opened and
// the server's current one; an absent list reads as an empty one.
test("the changed fields are the paths whose values differ", () => {
  const base = { name: "web", interval_sec: 30, sources: { nodes: ["a"] }, excluded_pairs: undefined, version: 3 };
  const current = { name: "web edge", interval_sec: 30, sources: { nodes: ["a", "b"] }, excluded_pairs: [], version: 4 };
  assert.deepEqual(changedFields(base, current, ["name", "interval_sec", "sources", "excluded_pairs"]), ["name", "sources"]);
  assert.deepEqual(changedFields(base, base, ["name", "sources"]), []);
  assert.deepEqual(changedFields({ targets: { all: true, exclude: [] } }, { targets: { all: true } }, ["targets"]), []);
});

// The conflict says what a changed field holds now when that reads at a
// glance: a name, a number, a switch. Lists and objects (node ids, selectors)
// stay a label only.
test("a conflict shows the server's value for scalar fields only", () => {
  assert.equal(conflictValue(" edge check "), "edge check");
  assert.equal(conflictValue(60), "60");
  assert.equal(conflictValue(false), false);
  assert.equal(conflictValue(""), undefined);
  assert.equal(conflictValue(Number.NaN), undefined);
  assert.equal(conflictValue(["node_a"]), undefined);
  assert.equal(conflictValue({ all: true }), undefined);
  assert.equal(conflictValue(null), undefined);
  const long = conflictValue("x".repeat(80));
  assert.equal(typeof long === "string" && long.length, 60);
  assert.ok(typeof long === "string" && long.endsWith("\u2026"));
  const current = { name: "web edge", interval_sec: 60, enabled: false, sources: { nodes: ["a", "b"] } };
  assert.deepEqual(theirValues(current, ["name", "interval_sec", "enabled", "sources", "missing"]), { name: "web edge", interval_sec: "60", enabled: false });
});

test("an error reads as a conflict only by its code, and a refusal keeps its field", () => {
  const conflict = new ApiError(409, "version_conflict", "check definition changed since it was read");
  const other409 = new ApiError(409, "request_failed", "monitor is expanded from a check definition");
  assert.equal(isVersionConflict(conflict), true);
  assert.equal(isVersionConflict(other409), false);
  assert.equal(isVersionConflict(new Error("x")), false);
  const refused = new ApiError(400, "bad_request", "addresses[1]: a tcp target is host:port", "req_1", {
    error: { code: "bad_request", message: "addresses[1]: a tcp target is host:port", request_id: "req_1", field: "addresses[1]" },
  });
  assert.deepEqual(refusalOf(refused, "failed"), { message: "addresses[1]: a tcp target is host:port", field: "addresses[1]" });
  assert.deepEqual(refusalOf(new Error(""), "failed"), { message: "failed" });
  assert.equal(new ApiError(400, "bad_request", "m").field, undefined);
});
