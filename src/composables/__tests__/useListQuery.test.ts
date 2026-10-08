import assert from "node:assert/strict";
import test from "node:test";

import { effectScope, nextTick, ref } from "vue";

import type { QuerySchema } from "../../lib/query/engine.ts";
import { SETTLE_MS, useListQuery } from "../useListQuery.ts";

/**
 * What a list page dims and makes inert while its query does not read.
 *
 * NodesView put `inert` on the whole table while the query was invalid, and
 * the table's empty slot holds the no-match state with its Clear the query
 * button. When the last valid query had kept no rows, that button was dead
 * exactly when the operator reached for it. `staleRows` holds only while
 * there are rows to dim.
 */

interface Row {
  host: string;
}

const schema: QuerySchema<Row> = {
  fields: [{ key: "host", type: "string", get: (row) => row.host }],
  text: (row) => [row.host],
};

const ROWS: Row[] = [{ host: "alpha" }, { host: "beta" }];
/** Not a field, so the query does not read. */
const INVALID = "hots:alpha";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function listQuery(text: string, rows: Row[] = ROWS) {
  const scope = effectScope();
  const textRef = ref(text);
  const query = scope.run(() => useListQuery(ref(rows), schema, textRef))!;
  return { query, text: textRef, stop: () => scope.stop() };
}

test("an invalid query over rows dims them", () => {
  // Invalid from the start (a pasted link): every row runs, and the error shows at once.
  const { query, stop } = listQuery(INVALID);
  assert.equal(query.invalid.value, true);
  assert.equal(query.rows.value.length, 2);
  assert.equal(query.staleRows.value, true);
  stop();
});

test("an invalid query over the no-match state leaves it live", async () => {
  const { query, text, stop } = listQuery("gamma");
  assert.equal(query.rows.value.length, 0);

  text.value = `gamma ${INVALID}`;
  await nextTick();
  query.reveal();
  assert.equal(query.invalid.value, true, "the bar says the query does not read");
  assert.equal(query.rows.value.length, 0, "the last valid query still runs, and keeps nothing");
  assert.equal(query.staleRows.value, false, "nothing to dim, so Clear the query stays live");

  text.value = "";
  await wait(SETTLE_MS + 50);
  assert.equal(query.invalid.value, false);
  assert.equal(query.rows.value.length, 2);
  stop();
});

test("an invalid query over a list with no rows at all dims nothing", () => {
  const { query, stop } = listQuery(INVALID, []);
  assert.equal(query.invalid.value, true);
  assert.equal(query.staleRows.value, false);
  stop();
});

test("a query that reads dims nothing", () => {
  const { query, stop } = listQuery("alpha");
  assert.equal(query.invalid.value, false);
  assert.equal(query.staleRows.value, false);
  stop();
});
