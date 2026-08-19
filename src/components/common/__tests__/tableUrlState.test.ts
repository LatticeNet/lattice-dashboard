import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEFAULT_TABLE_URL_STATE,
  isDefaultTableUrlState,
  readTableUrlState,
  tableStateParams,
  tableUrlStatesEqual,
  writeTableUrlState,
  type TableUrlState,
} from "../tableUrlState.ts";

const SORTABLE = ["name", "status", "created"];

test("params are namespaced so two tables on one route cannot collide", () => {
  assert.deepEqual(tableStateParams("tokens"), {
    q: "tokens.q",
    expr: "tokens.expr",
    sort: "tokens.sort",
    dir: "tokens.dir",
    page: "tokens.page",
  });
  const a = tableStateParams("installed");
  const b = tableStateParams("catalog");
  assert.equal(Object.values(a).some((name) => Object.values(b).includes(name)), false);
});

test("an empty query reads as the default view", () => {
  assert.deepEqual(readTableUrlState({}, "t", SORTABLE), DEFAULT_TABLE_URL_STATE);
  assert.equal(isDefaultTableUrlState(readTableUrlState({}, "t", SORTABLE)), true);
});

test("a full query round-trips through read and write", () => {
  const state: TableUrlState = { q: "edge", expr: "AND(a:1)", sort: "status", dir: "desc", page: 4 };
  const query = writeTableUrlState({}, "t", state);
  assert.deepEqual(query, {
    "t.q": "edge",
    "t.expr": "AND(a:1)",
    "t.sort": "status",
    "t.dir": "desc",
    "t.page": "4",
  });
  assert.deepEqual(readTableUrlState(query, "t", SORTABLE), state);
});

test("defaults are absent from the URL rather than written as empty values", () => {
  assert.deepEqual(writeTableUrlState({}, "t", DEFAULT_TABLE_URL_STATE), {});
  const narrowed = writeTableUrlState({}, "t", { ...DEFAULT_TABLE_URL_STATE, q: "x", page: 3 });
  assert.deepEqual(narrowed, { "t.q": "x", "t.page": "3" });
  // Widening back to the default clears the keys instead of leaving stale ones.
  assert.deepEqual(writeTableUrlState(narrowed, "t", DEFAULT_TABLE_URL_STATE), {});
});

test("writing preserves foreign query keys, including a sibling table's", () => {
  const query = { view: "list", status: "online", "other.q": "keep", "t.q": "old" };
  const next = writeTableUrlState(query, "t", { ...DEFAULT_TABLE_URL_STATE, q: "new" });
  assert.deepEqual(next, { view: "list", status: "online", "other.q": "keep", "t.q": "new" });
});

test("an unsortable or unknown sort key is dropped along with its direction", () => {
  const state = readTableUrlState({ "t.sort": "not-a-column", "t.dir": "desc" }, "t", SORTABLE);
  assert.equal(state.sort, "");
  assert.equal(state.dir, null);
  // A sort with no columns declared sortable is likewise refused.
  assert.equal(readTableUrlState({ "t.sort": "name" }, "t", []).sort, "");
});

test("a sort with a missing or nonsense direction falls back to ascending", () => {
  assert.deepEqual(readTableUrlState({ "t.sort": "name" }, "t", SORTABLE).dir, "asc");
  assert.deepEqual(readTableUrlState({ "t.sort": "name", "t.dir": "sideways" }, "t", SORTABLE).dir, "asc");
  assert.deepEqual(readTableUrlState({ "t.sort": "name", "t.dir": "DESC" }, "t", SORTABLE).dir, "desc");
});

test("a nonsense page falls back to page one rather than an empty table", () => {
  for (const page of ["0", "-3", "2.5", "abc", "", "1e3"]) {
    const state = readTableUrlState({ "t.page": page }, "t", SORTABLE);
    assert.equal(state.page >= 1 && Number.isInteger(state.page), true, `page=${page}`);
  }
  assert.equal(readTableUrlState({ "t.page": "0" }, "t", SORTABLE).page, 1);
  assert.equal(readTableUrlState({ "t.page": "12" }, "t", SORTABLE).page, 12);
});

test("array-valued and null query params are tolerated", () => {
  assert.equal(readTableUrlState({ "t.q": ["edge", "other"] }, "t", SORTABLE).q, "edge");
  assert.equal(readTableUrlState({ "t.q": [null, "edge"] }, "t", SORTABLE).q, "edge");
  assert.equal(readTableUrlState({ "t.q": null }, "t", SORTABLE).q, "");
  assert.equal(readTableUrlState({ "t.q": "  spaced  " }, "t", SORTABLE).q, "spaced");
});

test("equality is exact so a redundant navigation can be skipped", () => {
  const a: TableUrlState = { q: "x", expr: "", sort: "name", dir: "asc", page: 2 };
  assert.equal(tableUrlStatesEqual(a, { ...a }), true);
  assert.equal(tableUrlStatesEqual(a, { ...a, page: 3 }), false);
  assert.equal(tableUrlStatesEqual(a, { ...a, dir: "desc" }), false);
});
