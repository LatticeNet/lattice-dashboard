import assert from "node:assert/strict";
import { test } from "node:test";

import type { MachineView } from "@/lib/api/types";
import { aggregateSpend, billingCategory, isoDay, monthlyEquivCents, renewalDate } from "../inventoryCostModel.ts";

let seq = 0;
function machine(fields: Partial<MachineView>): MachineView {
  seq += 1;
  return {
    id: `machine_${seq}`,
    node_id: `node_${seq}`,
    renewal_cycle: "monthly",
    next_renewal: "2026-11-01T00:00:00Z",
    ...fields,
  } as MachineView;
}

test("CHY and CNY profiles are one CNY line in the Inventory totals", () => {
  // The production shape: most yuan boxes stored as CHY, a few as CNY.
  const spend = aggregateSpend([
    machine({ price_cents: 80460, currency: "CHY", renewal_cycle: "semiannual" }),
    machine({ price_cents: 2000, currency: "chy " }),
    machine({ price_cents: 1500, currency: "CNY" }),
    machine({ price_cents: 990, currency: "USD" }),
  ]);
  assert.deepEqual(
    spend.map((entry) => [entry.currency, entry.monthly, entry.count]),
    [
      ["CNY", 13410 + 2000 + 1500, 3],
      ["USD", 990, 1],
    ],
  );
  assert.equal(spend[0].annual, (13410 + 2000 + 1500) * 12);
  assert.ok(!spend.some((entry) => entry.currency === "CHY"));
});

test("a stored code is summed as stored, apart from case, spaces and the alias", () => {
  const spend = aggregateSpend([
    machine({ price_cents: 100, currency: "usdtxx" }),
    machine({ price_cents: 100, currency: "USDTXX" }),
    machine({ price_cents: 100, currency: "" }),
  ]);
  assert.deepEqual(
    spend.map((entry) => [entry.currency, entry.count]),
    [
      ["USDTXX", 2],
      ["USD", 1],
    ],
  );
});

test("only recurring machines count toward spend", () => {
  const list = [
    machine({ price_cents: 500, currency: "CNY" }),
    machine({ price_cents: 900, currency: "CNY", renewal_cycle: "", next_renewal: undefined }),
    machine({ price_cents: 0, currency: "CNY" }),
    machine({ price_cents: 700, currency: "CNY", next_renewal: "0001-01-01T00:00:00Z" }),
    machine({ id: undefined, price_cents: 800, currency: "CNY" }),
  ];
  assert.deepEqual(list.map(billingCategory), ["recurring", "onetime", "unpriced", "renewalIncomplete", "unprofiled"]);
  assert.deepEqual(
    aggregateSpend(list).map((entry) => [entry.currency, entry.monthly, entry.count]),
    [["CNY", 500, 1]],
  );
});

test("each cycle comes to a monthly figure", () => {
  assert.equal(monthlyEquivCents(machine({ price_cents: 1200, renewal_cycle: "annual" })), 100);
  assert.equal(monthlyEquivCents(machine({ price_cents: 900, renewal_cycle: "quarterly" })), 300);
  assert.equal(monthlyEquivCents(machine({ price_cents: 3000, renewal_cycle: "custom_days", cycle_days: 60 })), (3000 * 30.4375) / 60);
  // An unknown custom span is read as monthly rather than dropped.
  assert.equal(monthlyEquivCents(machine({ price_cents: 3000, renewal_cycle: "custom_days", cycle_days: 0 })), 3000);
  assert.equal(monthlyEquivCents(machine({ price_cents: 3000, renewal_cycle: "", next_renewal: undefined })), 0);
});

test("renewal days are UTC days and Go's zero time is unset", () => {
  assert.equal(isoDay("2026-11-01T23:30:00-05:00"), "2026-11-02");
  assert.equal(isoDay("not a date"), "");
  assert.equal(renewalDate(machine({ next_renewal: "0001-01-01T00:00:00Z" })), "");
  assert.equal(renewalDate(undefined), "");
});
