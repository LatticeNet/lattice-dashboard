import assert from "node:assert/strict";
import { test } from "node:test";

import {
  coverageMap,
  isEmptySelector,
  nodeCoverage,
  normalizeSelector,
  resolveSelector,
  selectorEquals,
  selectorParts,
  setWholeFleet,
  toggleExclude,
  toggleGroup,
  toggleNode,
  type SelectorGroup,
  type SelectorNode,
} from "../selectorModel.ts";

const nodes: SelectorNode[] = [
  { id: "a", name: "alpha" },
  { id: "b", name: "bravo" },
  { id: "c", name: "charlie" },
  { id: "d" },
];
const groups: SelectorGroup[] = [
  { id: "g-web", name: "Web", resolved_members: ["a", "b"] },
  // A member this session cannot read is not in the visible fleet.
  { id: "g-db", name: "DB", resolved_members: ["c", "hidden"] },
];

test("the stored form is trimmed, deduplicated and sorted, with empty fields left out", () => {
  assert.deepEqual(normalizeSelector({ nodes: [" c", "a", "a", ""], groups: [], exclude: [] }), { nodes: ["a", "c"] });
  assert.deepEqual(normalizeSelector({}), {});
});

test("a whole-fleet selector names no nodes or groups, the shape the server accepts", () => {
  assert.deepEqual(normalizeSelector({ all: true, nodes: ["a"], groups: ["g-web"], exclude: ["b"] }), { all: true, exclude: ["b"] });
});

test("exclusions stand only beside a group or the whole fleet, and never on a named node", () => {
  assert.deepEqual(normalizeSelector({ nodes: ["a"], exclude: ["b"] }), { nodes: ["a"] });
  assert.deepEqual(normalizeSelector({ nodes: ["a"], groups: ["g-web"], exclude: ["a", "b"] }), { nodes: ["a"], groups: ["g-web"], exclude: ["b"] });
});

test("resolution is the union minus the exclusions, over the visible fleet only", () => {
  assert.deepEqual(resolveSelector({ nodes: ["d"], groups: ["g-web", "g-db"] }, nodes, groups), ["a", "b", "c", "d"]);
  assert.deepEqual(resolveSelector({ groups: ["g-web"], exclude: ["a"] }, nodes, groups), ["b"]);
  assert.deepEqual(resolveSelector({ all: true, exclude: ["c"] }, nodes, groups), ["a", "b", "d"]);
  assert.deepEqual(resolveSelector({ nodes: ["gone"] }, nodes, groups), []);
  assert.deepEqual(resolveSelector({ groups: ["g-missing"] }, nodes, groups), []);
});

test("an empty selector targets nothing", () => {
  assert.equal(isEmptySelector({}), true);
  assert.equal(isEmptySelector({ exclude: ["a"] }), true);
  assert.equal(isEmptySelector({ all: true }), false);
  assert.equal(isEmptySelector({ groups: ["g-db"] }), false);
});

test("coverage says why a node is targeted", () => {
  const sel = { nodes: ["d"], groups: ["g-web"], exclude: ["b"] };
  assert.deepEqual(nodeCoverage(sel, "a", groups), { explicit: false, via: ["g-web"], fleet: false, excluded: false, targeted: true });
  assert.deepEqual(nodeCoverage(sel, "b", groups), { explicit: false, via: ["g-web"], fleet: false, excluded: true, targeted: false });
  assert.deepEqual(nodeCoverage(sel, "d", groups), { explicit: true, via: [], fleet: false, excluded: false, targeted: true });
  assert.equal(nodeCoverage({ all: true }, "c", groups).targeted, true);
});

test("the coverage map agrees with per-node coverage for every node", () => {
  for (const sel of [{ nodes: ["d"], groups: ["g-web"], exclude: ["b"] }, { all: true, exclude: ["c"] }, { groups: ["g-db", "g-missing"] }, {}]) {
    const map = coverageMap(sel, nodes, groups);
    assert.equal(map.size, nodes.length);
    for (const node of nodes) assert.deepEqual(map.get(node.id), nodeCoverage(sel, node.id, groups), `${JSON.stringify(sel)} ${node.id}`);
  }
});

test("naming a node brings it back from the exclusions, and leaving it out stops naming it", () => {
  const sel = { groups: ["g-web"], exclude: ["a"] };
  assert.deepEqual(toggleNode(sel, "a", true), { nodes: ["a"], groups: ["g-web"] });
  assert.deepEqual(toggleExclude({ nodes: ["a"], groups: ["g-web"] }, "a", true), { groups: ["g-web"], exclude: ["a"] });
  assert.deepEqual(toggleNode({ nodes: ["a", "b"] }, "a", false), { nodes: ["b"] });
});

test("dropping the last group drops the exclusions that stood beside it", () => {
  assert.deepEqual(toggleGroup({ groups: ["g-web"], exclude: ["a"] }, "g-web", false), {});
  assert.deepEqual(toggleGroup({ nodes: ["c"] }, "g-db", true), { nodes: ["c"], groups: ["g-db"] });
});

test("the whole fleet toggles without losing the picks it replaced", () => {
  const picks = { nodes: ["d"], groups: ["g-web"] };
  const fleet = setWholeFleet({ ...picks, exclude: ["b"] }, true);
  assert.deepEqual(fleet, { all: true, exclude: ["b"] });
  assert.deepEqual(setWholeFleet(fleet, false, picks), { nodes: ["d"], groups: ["g-web"], exclude: ["b"] });
  assert.deepEqual(setWholeFleet(fleet, false), {});
});

test("equality ignores order and empty fields", () => {
  assert.equal(selectorEquals({ nodes: ["b", "a"], exclude: [] }, { nodes: ["a", "b"] }), true);
  assert.equal(selectorEquals({ nodes: ["a"] }, { groups: ["a"] }), false);
});

test("the chips read the fleet or groups, then nodes, then exclusions, by name", () => {
  assert.deepEqual(selectorParts({ nodes: ["d", "a"], groups: ["g-db"], exclude: ["c"] }, nodes, groups), [
    { kind: "group", id: "g-db", name: "DB" },
    { kind: "node", id: "a", name: "alpha" },
    { kind: "node", id: "d", name: "d" },
    { kind: "exclude", id: "c", name: "charlie" },
  ]);
  assert.deepEqual(selectorParts({ all: true }, nodes, groups), [{ kind: "fleet" }]);
});
