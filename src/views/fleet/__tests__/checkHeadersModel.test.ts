import assert from "node:assert/strict";
import { test } from "node:test";

import type { MonitorHeader } from "@/lib/api/types";

import {
  buildHeaderEdits,
  headerProblems,
  headersForCreate,
  keepCurrent,
  keptSecret,
  newHeaderRow,
  rowsFromHeaders,
  setSecret,
  startReplace,
  type HeaderRow,
} from "../checkHeadersModel.ts";

/** What an M2a server returns for a check with one secret and one plain header. */
const READ: MonitorHeader[] = [
  { name: "X-Api-Key", secret: true, set: true },
  { name: "Accept", value: "application/json" },
];

function edit(rows: HeaderRow[], key: string, next: (r: HeaderRow) => HeaderRow): HeaderRow[] {
  return rows.map((r) => (r.key === key ? next(r) : r));
}

test("a read becomes rows: a secret holds no value and reads as kept", () => {
  const rows = rowsFromHeaders(READ);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.value, "");
  assert.equal(rows[0]!.secret, true);
  assert.equal(keptSecret(rows[0]!), true);
  assert.equal(rows[1]!.value, "application/json");
  assert.equal(keptSecret(rows[1]!), false);
});

test("an editor that echoes the read sends nothing, so it can neither wipe nor leak a secret", () => {
  assert.equal(buildHeaderEdits(READ, rowsFromHeaders(READ)), undefined);
  assert.equal(buildHeaderEdits(undefined, []), undefined);
});

test("replacing a secret sends set with the new value, the plain header nothing", () => {
  let rows = rowsFromHeaders(READ);
  rows = edit(rows, "saved-0", startReplace);
  assert.equal(keptSecret(rows[0]!), false);
  rows = edit(rows, "saved-0", (r) => ({ ...r, value: "new-token" }));
  assert.deepEqual(buildHeaderEdits(READ, rows), [{ name: "X-Api-Key", op: "set", value: "new-token", secret: true }]);
  // Keep current puts it back: nothing is sent.
  rows = edit(rows, "saved-0", keepCurrent);
  assert.equal(buildHeaderEdits(READ, rows), undefined);
});

test("removing a header sends delete by its saved name; adding one sends set", () => {
  let rows = rowsFromHeaders(READ).filter((r) => r.key !== "saved-1");
  rows = [...rows, { ...newHeaderRow("new-1"), name: "x-trace", value: "on" }];
  assert.deepEqual(buildHeaderEdits(READ, rows), [
    { name: "Accept", op: "delete" },
    { name: "x-trace", op: "set", value: "on" },
  ]);
});

test("a header removed and added again under the same name is one set, never delete and set", () => {
  const rows = [...rowsFromHeaders(READ).filter((r) => r.key !== "saved-1"), { ...newHeaderRow("new-1"), name: "accept", value: "text/plain" }];
  assert.deepEqual(buildHeaderEdits(READ, rows), [{ name: "accept", op: "set", value: "text/plain" }]);
});

test("a plain header turned secret is set with its value; a secret turned plain needs a value typed again", () => {
  let rows = rowsFromHeaders(READ);
  rows = edit(rows, "saved-1", (r) => setSecret(r, true));
  assert.deepEqual(buildHeaderEdits(READ, rows), [{ name: "Accept", op: "set", value: "application/json", secret: true }]);

  rows = edit(rowsFromHeaders(READ), "saved-0", (r) => setSecret(r, false));
  assert.equal(rows[0]!.replacing, true);
  assert.equal(rows[0]!.value, "");
  assert.deepEqual(headerProblems(rows, { https: true, newCheck: false }).rows["saved-0"], ["valueRequired"]);
  rows = edit(rows, "saved-0", (r) => ({ ...r, value: "visible" }));
  assert.deepEqual(buildHeaderEdits(READ, rows), [{ name: "X-Api-Key", op: "set", value: "visible" }]);
});

test("problems: names, duplicates without regard to case, values, the count and https", () => {
  const rows: HeaderRow[] = [
    { ...newHeaderRow("a"), name: "Host", value: "x" },
    { ...newHeaderRow("b"), name: "X-Dup", value: "1" },
    { ...newHeaderRow("c"), name: "x-dup", value: "2" },
    { ...newHeaderRow("d"), name: "X-Empty", value: "" },
    { ...newHeaderRow("e"), name: "X-Bad", value: "a\nb", secret: true },
  ];
  const p = headerProblems(rows, { https: false, newCheck: false });
  assert.deepEqual(p.rows.a, ["nameForbidden"]);
  assert.deepEqual(p.rows.b, ["nameDuplicate"]);
  assert.deepEqual(p.rows.c, ["nameDuplicate"]);
  assert.deepEqual(p.rows.d, ["valueRequired"]);
  assert.deepEqual(p.rows.e, ["valueControl"]);
  assert.deepEqual(p.list, ["secretsNeedHttps"]);
  assert.equal(p.any, true);
  const nine = Array.from({ length: 9 }, (_, i) => ({ ...newHeaderRow(`r${i}`), name: `X-${i}`, value: "v" }));
  assert.deepEqual(headerProblems(nine, { https: true, newCheck: false }).list, ["tooMany"]);
  assert.equal(headerProblems(rowsFromHeaders(READ), { https: true, newCheck: false }).any, false);
});

test("a new check cannot carry a saved secret: it must be entered again or removed", () => {
  const rows = rowsFromHeaders(READ);
  const p = headerProblems(rows, { https: true, newCheck: true });
  assert.deepEqual(p.rows["saved-0"], ["secretNotCarried"]);
  assert.equal(p.rows["saved-1"], undefined);
  const entered = edit(rows, "saved-0", (r) => ({ ...startReplace(r), value: "again" }));
  assert.equal(headerProblems(entered, { https: true, newCheck: true }).any, false);
  assert.deepEqual(headersForCreate(entered), [
    { name: "X-Api-Key", value: "again", secret: true },
    { name: "Accept", value: "application/json" },
  ]);
  assert.equal(headersForCreate([]), undefined);
});
