/**
 * The routings table has to survive a phone.
 *
 * It was a hand-rolled `<table class="w-full">` in an `overflow-x-auto`. At
 * 375 that fits Name, Hostname and Strategy and cuts the other six columns off
 * past the card edge, with no visible scrollbar and nothing hinting a swipe.
 * The Actions cell went with them, so the delete button the first-run copy
 * tells the reader to use was off-screen on the device most likely to be
 * holding the page. DataTable stacks a row into a definition list below `md`,
 * which is the layout that keeps nine columns readable at that width.
 *
 * A table-layout claim cannot be asserted from a model test, so it is asserted
 * against the template, the way DnsView's column sizing already is.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const view = readFileSync(new URL("../GeoRoutingView.vue", import.meta.url), "utf8");
const dataTable = readFileSync(
  new URL("../../../components/common/DataTable.vue", import.meta.url),
  "utf8",
);

/**
 * The routings collection only. The plan preview dialog keeps a plain
 * two-column table of continent to node, which is not a layout a phone loses
 * anything to.
 */
const routingsCard = view.slice(view.indexOf("<DataTable"), view.indexOf("<!-- Create / edit dialog -->"));

test("the routings list goes through DataTable, not a hand-rolled table", () => {
  assert.ok(routingsCard.length > 0, "GeoRoutingView no longer has a routings card");
  assert.match(view, /import DataTable, \{ type DataTableColumn \}/);
  assert.match(routingsCard, /<DataTable\b/);
  assert.doesNotMatch(
    routingsCard,
    /<table\b/,
    "the hand-rolled routings table is back, and with it the clipped row at 375",
  );
});

test("every column the desktop row carries reaches the phone, and the row menu holds delete", () => {
  // Both phone layouts render from `columns`, so a value that only exists as
  // a hard-coded <td> is a value a phone never sees. Applied state and the
  // error moved to the status cell and the sheet (design 23, 4.4).
  const block = view.slice(view.indexOf("const columns = computed"), view.indexOf("const openRoute"));
  for (const key of ["name", "hostname", "strategy", "nodes", "dns", "status", "actions"]) {
    assert.match(block, new RegExp(`key: "${key}"`), `the ${key} column is not in the column model`);
  }
  // The demo copy tells the reader to delete it from its row menu.
  const menu = view.slice(view.indexOf("function menuFor("), view.indexOf("const deleteImpact"));
  assert.match(menu, /previewConfig/);
  assert.match(menu, /common\.actions\.edit/);
  assert.match(menu, /common\.actions\.delete/);
  assert.match(view.slice(view.indexOf("#cell-actions="), view.indexOf("</DataTable>")), /<RowMenu\b/);
});

test("DataTable still renders every column on a phone, scrolling by default", () => {
  // Design 23, 3.7: a phone keeps the table and scrolls it sideways with the
  // first column pinned; cards are opt-in. Both layouts render from
  // `columns`, so the column model above is what a phone sees either way.
  assert.match(dataTable, /narrowLayout: "scroll",/);
  assert.match(dataTable, /<ul v-if="!isDesktop && narrowLayout === 'cards'" class="space-y-3 md:hidden">/);
  assert.match(dataTable, /v-for="column in columns"/);
  assert.match(dataTable, /:name="`cell-\$\{column\.key\}`"/);
});
