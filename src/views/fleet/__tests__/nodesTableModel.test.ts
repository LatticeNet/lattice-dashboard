import assert from "node:assert/strict";
import { test } from "node:test";

import type { Node } from "../../../lib/api/types.ts";
import {
  DEFAULT_HIDDEN_COLUMNS,
  NODE_TABLE_COLUMNS,
  gridTemplate,
  nextSortState,
  parseHiddenColumns,
  parseSortState,
  serializeHiddenColumns,
  serializeSortState,
  sortNodes,
  visibleColumns,
} from "../nodesTableModel.ts";

function node(partial: Partial<Node>): Node {
  return { id: "node-x", name: "x", ...partial } as Node;
}

test("nextSortState cycles none -> default -> flipped -> none", () => {
  const none = { key: "", dir: "asc" } as const;
  const first = nextSortState(none, "cpu");
  assert.deepEqual(first, { key: "cpu", dir: "desc" }); // metrics start desc
  const second = nextSortState(first, "cpu");
  assert.deepEqual(second, { key: "cpu", dir: "asc" });
  const third = nextSortState(second, "cpu");
  assert.deepEqual(third, { key: "", dir: "asc" });
  // identity columns start asc
  assert.deepEqual(nextSortState(none, "name"), { key: "name", dir: "asc" });
  // non-sortable columns leave state untouched
  assert.deepEqual(nextSortState(first, "tags"), first);
});

test("sortNodes orders by cpu desc with name tiebreak and tolerates missing metrics", () => {
  const rows = [
    node({ id: "a", name: "alpha", metrics: { cpu_percent: 10 } as Node["metrics"] }),
    node({ id: "b", name: "beta" }),
    node({ id: "c", name: "gamma", metrics: { cpu_percent: 90 } as Node["metrics"] }),
    node({ id: "d", name: "delta", metrics: { cpu_percent: 10 } as Node["metrics"] }),
  ];
  const sorted = sortNodes(rows, { key: "cpu", dir: "desc" });
  assert.deepEqual(
    sorted.map((n) => n.name),
    ["gamma", "alpha", "delta", "beta"],
  );
});

test("sortNodes by status follows the ontology's display order", () => {
  // The server's word decides; the legacy fields are set to contradict it on
  // purpose so a regression to reading `online` would reorder the rows.
  const rows = [
    node({ id: "a", name: "down", status: "offline", online: true }),
    node({ id: "b", name: "dead", status: "disabled", online: true }),
    node({ id: "c", name: "up", status: "online", online: false }),
    node({ id: "d", name: "never", status: "never_reported", online: true }),
    node({ id: "e", name: "limping", status: "degraded", online: false }),
  ];
  const sorted = sortNodes(rows, { key: "status", dir: "asc" });
  assert.deepEqual(
    sorted.map((n) => n.name),
    ["up", "limping", "down", "never", "dead"],
  );
  // Older servers without the word: the same order rebuilt from the flags.
  const legacy = [node({ id: "a", name: "down" }), node({ id: "b", name: "dead", disabled: true, online: true }), node({ id: "c", name: "up", online: true })];
  assert.deepEqual(
    sortNodes(legacy, { key: "status", dir: "asc" }).map((n) => n.name),
    ["up", "down", "dead"],
  );
});

test("sortNodes by lastSeen desc puts newest first and empty last", () => {
  const rows = [
    node({ id: "a", name: "old", last_seen: "2026-01-01T00:00:00Z" as Node["last_seen"] }),
    node({ id: "b", name: "never" }),
    node({ id: "c", name: "fresh", last_seen: "2026-08-01T00:00:00Z" as Node["last_seen"] }),
  ];
  const sorted = sortNodes(rows, { key: "lastSeen", dir: "desc" });
  assert.deepEqual(
    sorted.map((n) => n.name),
    ["fresh", "old", "never"],
  );
});

test("hidden-column persistence round-trips and rejects unknown/required ids", () => {
  const hidden = parseHiddenColumns("role, update,nonsense,name,");
  assert.deepEqual([...hidden].sort(), ["role", "update"]);
  assert.equal(serializeHiddenColumns(hidden), "role,update");
});

test("a console that has never been configured gets the default column set", () => {
  const hidden = parseHiddenColumns(null);
  assert.deepEqual([...hidden].sort(), [...DEFAULT_HIDDEN_COLUMNS].sort());
  // The default has to leave the triage columns visible, or hiding things by
  // default would be a worse answer than the wide table it replaced.
  const visible = visibleColumns(hidden).map((c) => c.id);
  for (const id of ["name", "status", "role", "cpu", "memory", "disk", "lastSeen", "actions"]) {
    assert.ok(visible.includes(id), `${id} must be visible by default`);
  }
});

test("an empty stored value means the operator wants every column, not the defaults", () => {
  // `null` (never configured) and `""` (configured, nothing hidden) are
  // different answers. Collapsing them would push the built-in defaults back
  // at an operator who has explicitly turned every column on.
  assert.equal(parseHiddenColumns("").size, 0);
  assert.ok(parseHiddenColumns(null).size > 0);
});

test("visibleColumns always keeps required columns and gridTemplate matches", () => {
  const hidden = parseHiddenColumns(
    NODE_TABLE_COLUMNS.filter((c) => c.optional)
      .map((c) => c.id)
      .join(","),
  );
  const visible = visibleColumns(hidden);
  assert.deepEqual(
    visible.map((c) => c.id),
    ["name", "status", "actions"],
  );
  assert.equal(gridTemplate(hidden).split(" ").length, visible.length);
});

test("sort-state persistence round-trips and rejects unknown keys", () => {
  assert.equal(serializeSortState({ key: "", dir: "asc" }), "");
  assert.deepEqual(parseSortState(null), { key: "", dir: "asc" });
  assert.deepEqual(parseSortState("cpu:desc"), { key: "cpu", dir: "desc" });
  assert.deepEqual(parseSortState(serializeSortState({ key: "name", dir: "desc" })), {
    key: "name",
    dir: "desc",
  });
  assert.deepEqual(parseSortState("bogus:desc"), { key: "", dir: "asc" });
});

test("sortNodes does not depend on the order the poll delivered tied rows in", () => {
  // Two machines can carry one name (the console ships a duplicate-node report
  // for exactly that), and then the primary key and the name tiebreak are both
  // equal. Without a tiebreak on the id, the rendered order is whatever order
  // the last poll happened to return, and the rows swap under the operator.
  const rows = [
    node({ id: "node-2", name: "edge-01", metrics: { cpu_percent: 4 } as Node["metrics"] }),
    node({ id: "node-1", name: "edge-01", metrics: { cpu_percent: 4 } as Node["metrics"] }),
    node({ id: "node-3", name: "edge-02", metrics: { cpu_percent: 4 } as Node["metrics"] }),
  ];
  const asDelivered = sortNodes(rows, { key: "cpu", dir: "desc" }).map((n) => n.id);
  const reshuffled = sortNodes([...rows].reverse(), { key: "cpu", dir: "desc" }).map((n) => n.id);
  assert.deepEqual(asDelivered, reshuffled);
  assert.deepEqual(asDelivered, ["node-1", "node-2", "node-3"]);
});

test("sortNodes ranks metrics at the precision the cell prints", () => {
  const poll = (alpha: number, bravo: number) => [
    node({ id: "node-a", name: "alpha", metrics: { cpu_percent: alpha } as Node["metrics"] }),
    node({ id: "node-b", name: "bravo", metrics: { cpu_percent: bravo } as Node["metrics"] }),
  ];
  // Both rows print "8%" whichever way the jitter lands between two polls, so
  // neither may move: this is the churn the fleet list actually showed.
  const first = sortNodes(poll(7.92, 7.51), { key: "cpu", dir: "desc" }).map((n) => n.id);
  const second = sortNodes(poll(7.51, 7.92), { key: "cpu", dir: "desc" }).map((n) => n.id);
  assert.deepEqual(first, second);
  assert.deepEqual(first, ["node-a", "node-b"]);
  // A change the operator can see still reorders: 7.4 prints "7%", 8.6 prints "9%".
  assert.deepEqual(
    sortNodes(poll(7.4, 8.6), { key: "cpu", dir: "desc" }).map((n) => n.id),
    ["node-b", "node-a"],
  );
  // Same for the used/total columns: 63.4% and 63.2% both print "63%", so the
  // pair falls through to the name tiebreak instead of trading places.
  const mem = (used: number) =>
    node({
      id: `mem-${used}`,
      name: `mem-${used}`,
      metrics: { memory_used: used, memory_total: 1000 } as Node["metrics"],
    });
  assert.deepEqual(
    sortNodes([mem(634), mem(632)], { key: "memory", dir: "desc" }).map((n) => n.id),
    ["mem-632", "mem-634"],
  );
});
