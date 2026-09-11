import assert from "node:assert/strict";
import { test } from "node:test";

import { orderForGroup, orderMachines, parseInventoryGroup } from "../inventoryGroupingModel.ts";

type Row = { id?: string; name: string; days_until_renewal?: number; zeroDate?: boolean };

const name = (m: Row) => m.name;
const dated = (m: Row) => !m.zeroDate && m.days_until_renewal !== undefined;

// The production "Due soon" bucket on 2026-09-11, in the name order it showed.
const DUE_SOON: Row[] = [
  { id: "p1", name: "cd-gomami-jpn", days_until_renewal: 12 },
  { id: "p2", name: "cd-qqpw-vds-cd1", days_until_renewal: 13 },
  { id: "p3", name: "cd-volcengine-shanghai", days_until_renewal: 11 },
  { id: "p4", name: "cd-xuezhang-canada-nat", days_until_renewal: 4 },
  { id: "p5", name: "openjobs-vpn-dmit-2", days_until_renewal: 9 },
  { id: "p6", name: "openjobs-vpn-dmit-1", days_until_renewal: 9 },
  { id: "p7", name: "openjobs-vpn-qqpw-cd3", days_until_renewal: 14 },
];

test("the renewal grouping reads nearest due first, ties by name", () => {
  assert.deepEqual(
    orderMachines(DUE_SOON, "due", name, dated).map((m) => m.name),
    [
      "cd-xuezhang-canada-nat",
      "openjobs-vpn-dmit-1",
      "openjobs-vpn-dmit-2",
      "cd-volcengine-shanghai",
      "cd-gomami-jpn",
      "cd-qqpw-vds-cd1",
      "openjobs-vpn-qqpw-cd3",
    ],
  );
});

test("inside Overdue the machine overdue longest leads", () => {
  const overdue: Row[] = [
    { id: "a", name: "a", days_until_renewal: -1 },
    { id: "b", name: "b", days_until_renewal: -30 },
    { id: "c", name: "c", days_until_renewal: -5 },
  ];
  assert.deepEqual(orderMachines(overdue, "due", name, dated).map((m) => m.name), ["b", "c", "a"]);
});

test("machines without a usable date follow the dated ones in name order", () => {
  const rows: Row[] = [
    { id: "z", name: "zeta" },
    { id: "y", name: "alpha-zero-date", days_until_renewal: -739000, zeroDate: true },
    { id: "x", name: "mid", days_until_renewal: 40 },
    { id: "w", name: "beta" },
  ];
  assert.deepEqual(orderMachines(rows, "due", name, dated).map((m) => m.name), ["mid", "alpha-zero-date", "beta", "zeta"]);
});

test("unprofiled nodes stay after profiles in both orders", () => {
  const rows: Row[] = [
    { name: "aaa-unprofiled" },
    { id: "p", name: "zzz-profiled", days_until_renewal: 3 },
  ];
  for (const order of ["due", "name"] as const) {
    assert.deepEqual(orderMachines(rows, order, name, dated).map((m) => m.name), ["zzz-profiled", "aaa-unprofiled"]);
  }
});

test("name order ignores dates and does not reorder the input list", () => {
  const input = [...DUE_SOON];
  const out = orderMachines(input, "name", name, dated).map((m) => m.name);
  assert.deepEqual(out, [...out].sort((a, b) => a.localeCompare(b)));
  assert.deepEqual(input, DUE_SOON);
});

test("the grouping comes from the address bar and falls back to billing", () => {
  assert.equal(parseInventoryGroup("renewal"), "renewal");
  assert.equal(parseInventoryGroup("region"), "region");
  assert.equal(parseInventoryGroup("due"), "billing");
  assert.equal(parseInventoryGroup(["renewal"]), "billing");
  assert.equal(parseInventoryGroup(undefined), "billing");
});

test("only the renewal grouping orders by due date", () => {
  assert.equal(orderForGroup("renewal"), "due");
  for (const group of ["billing", "vendor", "region", "none"] as const) {
    assert.equal(orderForGroup(group), "name");
  }
});
