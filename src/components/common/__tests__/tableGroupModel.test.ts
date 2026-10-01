import assert from "node:assert/strict";
import { test } from "node:test";

import { groupedEntries, groupRows, toggleGroup } from "../tableGroupModel.ts";

interface Row {
  id: string;
  owner: string;
}

const rows: Row[] = [
  { id: "a", owner: "cd" },
  { id: "b", owner: "Metix" },
  { id: "c", owner: "cd" },
  { id: "d", owner: "" },
  { id: "e", owner: "Metix" },
];
const owner = (row: Row) => row.owner;
const id = (row: Row) => row.id;

test("rows keep their sorted order inside a group and groups follow their first row", () => {
  const groups = groupRows(rows, owner);
  assert.deepEqual(groups.map((g) => g.key), ["cd", "Metix", ""]);
  assert.deepEqual(groups[0]!.rows.map(id), ["a", "c"]);
  assert.deepEqual(groups[1]!.rows.map(id), ["b", "e"]);
});

test("a requested order comes first and a key with no rows is left out", () => {
  const groups = groupRows(rows, owner, ["", "Metix", "nobody"]);
  assert.deepEqual(groups.map((g) => g.key), ["", "Metix", "cd"]);
});

test("a page draws one group row before the first row of each group it holds", () => {
  const groups = groupRows(rows, owner);
  const flat = groups.flatMap((g) => g.rows);
  const entries = groupedEntries(flat, groups, owner, id, new Set());
  assert.deepEqual(
    entries.map((e) => (e.kind === "group" ? `[${e.group.key}]` : e.row.id)),
    ["[cd]", "a", "c", "[Metix]", "b", "e", "[]", "d"],
  );
});

test("a collapsed group keeps its row and hides its members; totals span the whole group", () => {
  const groups = groupRows(rows, owner);
  const flat = groups.flatMap((g) => g.rows);
  // The second page starts inside Metix: its group row still counts both.
  const entries = groupedEntries(flat.slice(3), groups, owner, id, new Set(["Metix"]));
  assert.deepEqual(
    entries.map((e) => (e.kind === "group" ? `[${e.group.key}:${e.group.rows.length}:${e.collapsed}]` : e.row.id)),
    ["[Metix:2:true]", "[:1:false]", "d"],
  );
});

test("group and row entries never share a key", () => {
  const clash = [{ id: "cd", owner: "cd" }];
  const groups = groupRows(clash, owner);
  const keys = groupedEntries(clash, groups, owner, id, new Set()).map((e) => e.key);
  assert.equal(new Set(keys).size, keys.length);
});

test("toggling flips one group and leaves the rest", () => {
  const once = toggleGroup(new Set(["a"]), "b");
  assert.deepEqual([...once].sort(), ["a", "b"]);
  assert.deepEqual([...toggleGroup(once, "a")], ["b"]);
});
