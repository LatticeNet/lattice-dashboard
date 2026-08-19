import assert from "node:assert/strict";
import test from "node:test";

import {
  EMPTY_TABLE_STATE,
  queryChanged,
  readTableState,
  tableStateParams,
  writeTableState,
} from "../dataTableState.ts";

const SORTABLE = ["name", "status", "seen"];

test("an untouched table reads as the default state", () => {
  assert.deepEqual(readTableState({}, "nodes", SORTABLE), EMPTY_TABLE_STATE);
});

test("a deep link arrives already filtered, sorted and paged", () => {
  const state = readTableState(
    { nodes_q: "edge", nodes_f: "AND(status:ok)", nodes_sort: "seen", nodes_dir: "desc", nodes_page: "3" },
    "nodes",
    SORTABLE,
  );

  assert.deepEqual(state, {
    search: "edge",
    expression: "AND(status:ok)",
    sortKey: "seen",
    sortDir: "desc",
    page: 3,
  });
});

/**
 * A URL is user input. A sort on a column that no longer exists must degrade to
 * no sort, not to an empty table the operator cannot explain.
 */
test("a sort on an unknown column is dropped rather than applied", () => {
  const state = readTableState(
    { nodes_sort: "column-that-was-removed", nodes_dir: "asc" },
    "nodes",
    SORTABLE,
  );

  assert.equal(state.sortKey, null);
  assert.equal(state.sortDir, null);
});

test("a sort key without a usable direction is not a sort", () => {
  const state = readTableState({ nodes_sort: "name", nodes_dir: "sideways" }, "nodes", SORTABLE);

  assert.equal(state.sortKey, null);
  assert.equal(state.sortDir, null);
});

test("a nonsense page falls back to the first one", () => {
  for (const page of ["-3", "0", "abc", ""]) {
    assert.equal(readTableState({ nodes_page: page }, "nodes", SORTABLE).page, 1);
  }
  assert.equal(readTableState({ nodes_page: "2.9" }, "nodes", SORTABLE).page, 2);
});

test("repeated parameters take the first value instead of rendering an array", () => {
  const state = readTableState({ nodes_q: ["edge", "other"] }, "nodes", SORTABLE);

  assert.equal(state.search, "edge");
});

test("two tables on one page keep separate state", () => {
  const nodes = tableStateParams("nodes");
  const tasks = tableStateParams("tasks");

  assert.notEqual(nodes.search, tasks.search);
  const query = writeTableState(
    writeTableState({}, "nodes", { ...EMPTY_TABLE_STATE, search: "edge" }),
    "tasks",
    { ...EMPTY_TABLE_STATE, search: "deploy" },
  );
  assert.equal(readTableState(query, "nodes", SORTABLE).search, "edge");
  assert.equal(readTableState(query, "tasks", SORTABLE).search, "deploy");
});

test("defaults are not written, so an untouched table leaves the URL alone", () => {
  assert.deepEqual(writeTableState({}, "nodes", EMPTY_TABLE_STATE), {});
});

test("clearing a filter removes its parameter rather than leaving it empty", () => {
  const withSearch = writeTableState({}, "nodes", { ...EMPTY_TABLE_STATE, search: "edge" });
  assert.deepEqual(withSearch, { nodes_q: "edge" });

  const cleared = writeTableState(withSearch, "nodes", EMPTY_TABLE_STATE);
  assert.deepEqual(cleared, {});
});

test("parameters this table does not own are preserved", () => {
  const next = writeTableState({ node: "edge-0", tab: "policies" }, "nodes", {
    ...EMPTY_TABLE_STATE,
    search: "hk",
  });

  assert.equal(next.node, "edge-0");
  assert.equal(next.tab, "policies");
  assert.equal(next.nodes_q, "hk");
});

test("an unchanged table does not report a change, so it never navigates", () => {
  const query = { nodes_q: "edge", other: "kept" };

  assert.equal(queryChanged(query, { ...query }), false);
  assert.equal(queryChanged(query, { ...query, nodes_q: "edge-1" }), true);
  assert.equal(queryChanged(query, { other: "kept" }), true);
});

test("a round trip through the URL preserves the state exactly", () => {
  const state = {
    search: "hk-edge",
    expression: "AND(status:ok)",
    sortKey: "status",
    sortDir: "asc" as const,
    page: 4,
  };

  assert.deepEqual(readTableState(writeTableState({}, "n", state), "n", SORTABLE), state);
});
