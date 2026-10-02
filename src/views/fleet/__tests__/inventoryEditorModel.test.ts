import assert from "node:assert/strict";
import { test } from "node:test";

import { advanceRenewal, daysBetween, manualRenewalTarget, monthlyEquivalentCents, parseDay, parseReminderDaysInput, renewalChoice, renewalDefault, rollForwardPast } from "../inventoryEditorModel.ts";

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

test("reminder offsets keep whole days in range and name what they ignore", () => {
  assert.deepEqual(parseReminderDaysInput("14,7,1"), { days: [14, 7, 1], ignored: [] });
  assert.deepEqual(parseReminderDaysInput(" 1, 30 ,7,7 "), { days: [30, 7, 1], ignored: [] });
  assert.deepEqual(parseReminderDaysInput("30, 7, abc, -1, 400, 2.5"), {
    days: [30, 7],
    ignored: ["abc", "-1", "400", "2.5"],
  });
});

test("a blank or comma-only entry has no days and ignores nothing", () => {
  assert.deepEqual(parseReminderDaysInput(""), { days: [], ignored: [] });
  assert.deepEqual(parseReminderDaysInput(" , ,"), { days: [], ignored: [] });
  assert.deepEqual(parseReminderDaysInput("0"), { days: [0], ignored: [] });
});

test("a passed renewal rolls forward to the first date after today", () => {
  // The Overdue machine in the design review: annual, recorded 2026-09-05.
  assert.equal(rollForwardPast("2026-09-05", "annual", 0, "2026-09-11"), "2027-09-05");
  assert.equal(rollForwardPast("2026-06-01", "monthly", 0, "2026-09-11"), "2026-10-01");
  assert.equal(rollForwardPast("2026-09-11", "monthly", 0, "2026-09-11"), "2026-10-11");
  assert.equal(rollForwardPast("2026-08-01", "custom_days", 30, "2026-09-11"), "2026-09-30");
});

test("nothing to roll when the date is still ahead or there is no cycle", () => {
  assert.equal(rollForwardPast("2026-09-12", "monthly", 0, "2026-09-11"), undefined);
  assert.equal(rollForwardPast("2026-09-05", "", 0, "2026-09-11"), undefined);
  assert.equal(rollForwardPast("2026-09-05", "custom_days", 0, "2026-09-11"), undefined);
});

test("record renewal offers one cycle after the current due date", () => {
  // A monthly machine due 10-10 is next due 11-10 once renewed.
  assert.equal(renewalDefault("2026-10-10", "monthly", 0), "2026-11-10");
  assert.equal(renewalDefault("2026-10-10", "quarterly", 0), "2027-01-10");
  assert.equal(renewalDefault("2026-10-10", "annual", 0), "2027-10-10");
  assert.equal(renewalDefault("2026-10-10", "custom_days", 45), "2026-11-24");
  // Month ends overflow the way the server's AddDate does.
  assert.equal(renewalDefault("2026-01-31", "monthly", 0), "2026-03-03");
  // No due date or no usable cycle: the operator types the date.
  assert.equal(renewalDefault("", "monthly", 0), undefined);
  assert.equal(renewalDefault("2026-10-10", "", 0), undefined);
  assert.equal(renewalDefault("2026-10-10", "custom_days", 0), undefined);
});

test("a renewal records only a real day different from the stored one", () => {
  assert.equal(renewalChoice("2026-10-10", "2026-11-10"), "ok");
  // Earlier is allowed: correcting a date recorded by mistake.
  assert.equal(renewalChoice("2026-10-10", "2026-09-10"), "ok");
  assert.equal(renewalChoice("2026-10-10", "2026-10-10"), "unchanged");
  assert.equal(renewalChoice("2026-10-10", ""), "invalid");
  assert.equal(renewalChoice("2026-10-10", "2026-13-40"), "invalid");
});

test("the editor's record renewal for a manual machine never sends the date it already has", () => {
  // Untouched form: one cycle after the saved date.
  assert.equal(manualRenewalTarget("2026-10-10", "2026-10-10", "monthly", 0), "2026-11-10");
  assert.equal(manualRenewalTarget("2026-10-10", "", "monthly", 0), "2026-11-10");
  // A date the operator typed wins.
  assert.equal(manualRenewalTarget("2026-10-10", "2026-12-01", "monthly", 0), "2026-12-01");
  // A typed date that is not a day sends nothing.
  assert.equal(manualRenewalTarget("2026-10-10", "2026-12", "monthly", 0), undefined);
  // No cycle and nothing typed: nothing to record.
  assert.equal(manualRenewalTarget("2026-10-10", "2026-10-10", "", 0), undefined);
});
