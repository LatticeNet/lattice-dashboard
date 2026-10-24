import assert from "node:assert/strict";
import { test } from "node:test";

import { normalizeSelector, resolveTargetSelector, selectorCover, selectorIsBroad, selectorIsEmpty, setSelectorAll, toggleSelectorGroup, toggleSelectorNode } from "../targetSelector.ts";

const nodes = [{ id: "n-de" }, { id: "n-hk" }, { id: "n-jp" }, { id: "n-us" }];
const groups = [
  { id: "grp_pinned", resolved_members: ["n-de", "n-gone"] },
  { id: "grp_asia", resolved_members: ["n-hk", "n-jp"] },
];

// The same cases the server's groups.ResolveTargets pins, so the live line and the save agree.
test("a selector resolves as the server resolves it", () => {
  assert.deepEqual(resolveTargetSelector({}, nodes, groups), []);
  assert.deepEqual(resolveTargetSelector({ nodes: ["n-us", "n-gone", "n-us"] }, nodes, groups), ["n-us"]);
  assert.deepEqual(resolveTargetSelector({ groups: ["grp_pinned"] }, nodes, groups), ["n-de"]);
  assert.deepEqual(resolveTargetSelector({ groups: ["grp_none"], nodes: ["n-de"] }, nodes, groups), ["n-de"]);
  assert.deepEqual(resolveTargetSelector({ all: true }, nodes, groups), ["n-de", "n-hk", "n-jp", "n-us"]);
  assert.deepEqual(resolveTargetSelector({ all: true, nodes: ["n-jp"], groups: ["grp_asia"], exclude: ["n-jp", "n-de"] }, nodes, groups), ["n-hk", "n-us"]);
});

test("normalizing drops what the server would drop and sorts the rest", () => {
  assert.deepEqual(normalizeSelector({ nodes: [" b", "a", "a"], groups: [], all: false, exclude: [] }), { nodes: ["a", "b"] });
  assert.equal(selectorIsEmpty({ exclude: ["n-de"] }), true);
  assert.equal(selectorIsBroad({ nodes: ["n-de"] }), false);
  assert.equal(selectorIsBroad({ groups: ["grp_asia"] }), true);
});

test("turning off a node a group covers excludes it, and turning it on again drops the exclusion", () => {
  let sel = toggleSelectorGroup({}, "grp_asia", true, groups);
  sel = toggleSelectorNode(sel, "n-jp", false, groups);
  assert.deepEqual(sel, { groups: ["grp_asia"], exclude: ["n-jp"] });
  assert.deepEqual(selectorCover(sel, "n-jp", groups), { by: "group", groupId: "grp_asia" });
  sel = toggleSelectorNode(sel, "n-jp", true, groups);
  assert.deepEqual(sel, { groups: ["grp_asia"] });
  // A node nothing covers is named, and unnamed again.
  sel = toggleSelectorNode(sel, "n-us", true, groups);
  assert.deepEqual(sel.nodes, ["n-us"]);
  sel = toggleSelectorNode(sel, "n-us", false, groups);
  assert.equal(sel.nodes, undefined);
  assert.equal(sel.exclude, undefined);
});

test("dropping the group or the whole fleet drops the exclusions nothing covers any more", () => {
  let sel = setSelectorAll({}, true, groups);
  sel = toggleSelectorNode(sel, "n-us", false, groups);
  assert.deepEqual(sel, { all: true, exclude: ["n-us"] });
  assert.deepEqual(setSelectorAll(sel, false, groups), {});
  sel = toggleSelectorNode(toggleSelectorGroup({}, "grp_asia", true, groups), "n-hk", false, groups);
  assert.deepEqual(toggleSelectorGroup(sel, "grp_asia", false, groups), {});
});
