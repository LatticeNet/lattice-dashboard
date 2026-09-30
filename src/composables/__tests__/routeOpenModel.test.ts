import assert from "node:assert/strict";
import { test } from "node:test";

import { OPEN_PARAM, readOpenId, rowSelector, writeOpenId } from "../routeOpenModel.ts";

test("the open object is read from ?open=, and empty means closed", () => {
  assert.equal(OPEN_PARAM, "open");
  assert.equal(readOpenId({ open: "task_1" }), "task_1");
  assert.equal(readOpenId({ open: "  task_1 " }), "task_1");
  assert.equal(readOpenId({ open: "" }), null);
  assert.equal(readOpenId({ open: null }), null);
  assert.equal(readOpenId({}), null);
  assert.equal(readOpenId({ open: ["a", "b"] }), "a");
  assert.equal(readOpenId({ conn: "n:0:1:t" }, "conn"), "n:0:1:t");
});

test("opening and closing keep every other key", () => {
  assert.deepEqual(writeOpenId({ view: "history", q: "x" }, "open", "a1"), { view: "history", q: "x", open: "a1" });
  assert.deepEqual(writeOpenId({ view: "history", open: "a1" }, "open", null), { view: "history" });
  assert.deepEqual(writeOpenId({ open: "a1" }, "open", "  "), {});
});

test("a row is found again by its key, whatever characters the id holds", () => {
  assert.equal(rowSelector("task_1"), '[data-row-key="task_1"]');
  assert.equal(rowSelector('a"b'), '[data-row-key="a\\"b"]');
  assert.equal(rowSelector("a\\b"), '[data-row-key="a\\\\b"]');
});
