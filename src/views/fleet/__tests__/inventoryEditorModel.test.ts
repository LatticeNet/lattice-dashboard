import assert from "node:assert/strict";
import { test } from "node:test";

import { advanceRenewal, daysBetween, monthlyEquivalentCents, parseDay } from "../inventoryEditorModel.ts";

test("a price per cycle becomes a monthly figure", () => {
  // CHY 804.60 every six months, the production AaiTr box.
  assert.equal(monthlyEquivalentCents(80460, "semiannual", 0), 13410);
  assert.equal(monthlyEquivalentCents(29800, "annual", 0), 29800 / 12);
  assert.equal(monthlyEquivalentCents(2900, "monthly", 0), 2900);
  assert.equal(Math.round(monthlyEquivalentCents(3000, "custom_days", 45)), Math.round((3000 * 30.4375) / 45));
});

test("no monthly figure without a price, a cycle, or a positive custom count", () => {
  assert.equal(monthlyEquivalentCents(0, "monthly", 0), 0);
  assert.equal(monthlyEquivalentCents(1000, "", 0), 0);
  assert.equal(monthlyEquivalentCents(1000, "custom_days", 0), 0);
  assert.equal(monthlyEquivalentCents(1000, "weekly", 0), 0);
});

test("a renewal rolls forward by its cycle", () => {
  assert.equal(advanceRenewal("2026-12-18", "semiannual", 0), "2027-06-18");
  assert.equal(advanceRenewal("2026-09-23", "monthly", 0), "2026-10-23");
  assert.equal(advanceRenewal("2026-09-23", "quarterly", 0), "2026-12-23");
  assert.equal(advanceRenewal("2026-02-28", "annual", 0), "2027-02-28");
  assert.equal(advanceRenewal("2026-09-11", "custom_days", 45), "2026-10-26");
});

test("month overflow matches Go's AddDate, which is how the server rolls", () => {
  assert.equal(advanceRenewal("2026-01-31", "monthly", 0), "2026-03-03");
});

test("no roll without a cycle, a valid custom count, or a date", () => {
  assert.equal(advanceRenewal("2026-09-11", "", 0), undefined);
  assert.equal(advanceRenewal("2026-09-11", "custom_days", 0), undefined);
  assert.equal(advanceRenewal("2026-09-11", "custom_days", 2.5), undefined);
  assert.equal(advanceRenewal("", "monthly", 0), undefined);
  assert.equal(advanceRenewal("09/11/2026", "monthly", 0), undefined);
});

test("days between two form dates, negative when overdue", () => {
  assert.equal(daysBetween("2026-09-11", "2026-09-23"), 12);
  assert.equal(daysBetween("2026-09-11", "2026-09-05"), -6);
  assert.equal(daysBetween("2026-09-11", "2026-09-11"), 0);
  assert.equal(daysBetween("2026-09-11", ""), undefined);
  assert.equal(parseDay(" 2026-09-11 ")?.toISOString(), "2026-09-11T00:00:00.000Z");
});
