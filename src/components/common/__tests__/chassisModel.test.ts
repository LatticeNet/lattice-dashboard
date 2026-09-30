import assert from "node:assert/strict";
import { test } from "node:test";

import {
  destructiveTreatment,
  metricCapWarning,
  nodeDisplay,
  rowMenuSections,
  tableToolbarVisible,
  typedConfirmMatches,
} from "../chassisModel.ts";

test("a strip of four numbers is quiet and a fifth draws a development warning", () => {
  assert.equal(metricCapWarning(0), "");
  assert.equal(metricCapWarning(4), "");
  assert.match(metricCapWarning(5), /5 numbers/);
  assert.match(metricCapWarning(9, "OverviewView"), /^OverviewView: 9 numbers/);
});

test("dangerous menu items sit last and hidden ones are dropped", () => {
  const sections = rowMenuSections([
    { key: "delete", danger: true },
    { key: "terminal" },
    { key: "rotate" },
    { key: "disable", hidden: true },
    { key: "revoke", danger: true },
  ]);
  assert.deepEqual(sections.safe.map((i) => i.key), ["terminal", "rotate"]);
  assert.deepEqual(sections.danger.map((i) => i.key), ["delete", "revoke"]);
});

test("a table with no rows and no filter draws no toolbar; a filter that emptied it keeps one", () => {
  assert.equal(tableToolbarVisible({ rowCount: 0, filterActive: false }), false);
  assert.equal(tableToolbarVisible({ rowCount: 0, filterActive: true }), true);
  assert.equal(tableToolbarVisible({ rowCount: 3, filterActive: false }), true);
});

test("the typed name must match exactly once the ends are trimmed", () => {
  assert.equal(typedConfirmMatches("docs.roobli.org", "docs.roobli.org"), true);
  assert.equal(typedConfirmMatches("  docs.roobli.org ", "docs.roobli.org"), true);
  assert.equal(typedConfirmMatches("Docs.roobli.org", "docs.roobli.org"), false);
  assert.equal(typedConfirmMatches("docs", "docs.roobli.org"), false);
  assert.equal(typedConfirmMatches("", ""), false);
  assert.equal(typedConfirmMatches("anything", undefined), true);
});

test("each destructive class gets its treatment", () => {
  assert.deepEqual(destructiveTreatment("reversible"), { destructive: false, impact: false, typed: false });
  assert.deepEqual(destructiveTreatment("internal"), { destructive: true, impact: true, typed: false });
  assert.deepEqual(destructiveTreatment("outside"), { destructive: true, impact: true, typed: true });
  assert.deepEqual(destructiveTreatment("node-config"), { destructive: true, impact: true, typed: true });
});

test("a node shows by name, and an id the page does not know is shortened and marked", () => {
  const nodes = [{ id: "node_001f596b", name: "[cd]-Aaitr-ATT-VDS" }, { id: "node_nameless" }];
  assert.deepEqual(nodeDisplay("node_001f596b", nodes), { text: "[cd]-Aaitr-ATT-VDS", known: true });
  assert.deepEqual(nodeDisplay("node_0123456789abcdef", nodes), { text: "node_0123456", known: false });
  assert.deepEqual(nodeDisplay("node_nameless", nodes), { text: "node_nameles", known: true });
  assert.deepEqual(nodeDisplay("n1", undefined), { text: "n1", known: false });
  assert.deepEqual(nodeDisplay("", nodes), { text: "", known: false });
});
