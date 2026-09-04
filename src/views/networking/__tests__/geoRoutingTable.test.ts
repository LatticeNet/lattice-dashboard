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
 * The routings card only. The plan preview dialog keeps a plain two-column
 * table of continent to node, which is not a layout a phone loses anything to.
 */
const routingsCard = view.slice(
  view.indexOf("networking.geoRouting.routings"),
  view.indexOf("<!-- Create / edit dialog -->"),
);

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

test("every column the desktop row carries reaches the mobile card", () => {
  // The stacked card is rendered from `columns`, so a value that only exists
  // as a hard-coded <td> is a value a phone never sees.
  const block = view.slice(view.indexOf("const columns = computed"), view.indexOf("// ── Create / edit dialog"));
  for (const key of ["name", "hostname", "strategy", "nodes", "dns", "status", "lastApplied", "lastError", "actions"]) {
    assert.match(block, new RegExp(`key: "${key}"`), `the ${key} column is not in the column model`);
  }
  // And the actions cell still offers all three controls, delete included:
  // the demo copy on this page names the row's delete button by hand.
  const actions = view.slice(view.indexOf('#cell-actions='), view.indexOf("</DataTable>"));
  assert.match(actions, /previewConfig/);
  assert.match(actions, /common\.actions\.edit/);
  assert.match(actions, /common\.actions\.delete/);
});

test("DataTable still has the stacked-card branch this depends on", () => {
  assert.match(dataTable, /<ul v-if="!isDesktop" class="space-y-3 md:hidden">/);
  assert.match(dataTable, /v-for="column in columns"/);
  assert.match(dataTable, /:name="`cell-\$\{column\.key\}`"/);
});
