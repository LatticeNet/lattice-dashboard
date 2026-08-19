import assert from "node:assert/strict";
import { test } from "node:test";

import { ROUTE_TAB_PARAM, resolveRouteTab, writeRouteTab } from "../routeTabModel.ts";

const TABS = ["matrix", "policies", "graph"] as const;

test("an absent, empty or unknown tab resolves to the fallback", () => {
  assert.equal(resolveRouteTab(undefined, TABS, "matrix"), "matrix");
  assert.equal(resolveRouteTab("", TABS, "matrix"), "matrix");
  assert.equal(resolveRouteTab("nope", TABS, "matrix"), "matrix");
  assert.equal(resolveRouteTab(null, TABS, "matrix"), "matrix");
});

test("a named tab is honoured, including surrounding whitespace", () => {
  assert.equal(resolveRouteTab("graph", TABS, "matrix"), "graph");
  assert.equal(resolveRouteTab(" graph ", TABS, "matrix"), "graph");
  assert.equal(resolveRouteTab(["policies"], TABS, "matrix"), "policies");
  assert.equal(resolveRouteTab([null, "graph"], TABS, "matrix"), "graph");
});

test("a tab the operator may not see falls back rather than rendering a dead panel", () => {
  // Plugins hides "registered" without audit:read; a stale link must not land there.
  assert.equal(resolveRouteTab("registered", ["lifecycle"], "lifecycle"), "lifecycle");
  assert.equal(resolveRouteTab("registered", ["registered", "lifecycle"], "registered"), "registered");
});

test("the fallback tab is written as the absence of the parameter", () => {
  assert.deepEqual(writeRouteTab({}, ROUTE_TAB_PARAM, "matrix", "matrix"), {});
  assert.deepEqual(writeRouteTab({ tab: "graph" }, ROUTE_TAB_PARAM, "matrix", "matrix"), {});
  assert.deepEqual(writeRouteTab({}, ROUTE_TAB_PARAM, "graph", "matrix"), { tab: "graph" });
});

test("writing a tab preserves the table state and filters already on the query", () => {
  const query = { "policies.q": "edge", "policies.page": "2", selected: "g1" };
  assert.deepEqual(writeRouteTab(query, ROUTE_TAB_PARAM, "graph", "matrix"), {
    ...query,
    tab: "graph",
  });
  assert.deepEqual(writeRouteTab({ ...query, tab: "graph" }, ROUTE_TAB_PARAM, "matrix", "matrix"), query);
});
