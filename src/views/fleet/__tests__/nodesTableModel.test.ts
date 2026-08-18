import assert from "node:assert/strict";
import { test } from "node:test";

import type { Node } from "../../../lib/api/types.ts";
import {
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

test("sortNodes by status ranks online < offline < disabled", () => {
  const rows = [
    node({ id: "a", name: "down" }),
    node({ id: "b", name: "dead", disabled: true, online: true }),
    node({ id: "c", name: "up", online: true }),
  ];
  const sorted = sortNodes(rows, { key: "status", dir: "asc" });
  assert.deepEqual(
    sorted.map((n) => n.name),
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
  assert.deepEqual(parseHiddenColumns(null).size, 0);
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
