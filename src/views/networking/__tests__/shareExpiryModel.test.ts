import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  DURATION_DAYS,
  daysRemaining,
  expiryFormError,
  expiryInstant,
  expiryLabel,
  isExpired,
  type ExpiryForm,
} from "../shareExpiryModel.ts";

const NOW = Date.UTC(2026, 0, 1, 12, 0, 0);
const DAY = 86_400_000;

function form(over: Partial<ExpiryForm> = {}): ExpiryForm {
  return { mode: "never", amount: 1, unit: "year", on: "", ...over };
}

describe("what the form describes", () => {
  it("never means no expiry at all", () => {
    assert.equal(expiryInstant(form(), NOW), null);
  });

  it("counts a duration from now", () => {
    const at = expiryInstant(form({ mode: "duration", amount: 2, unit: "month" }), NOW);
    assert.ok(at);
    assert.equal(at.getTime(), NOW + 60 * DAY);
  });

  // A date input means "through that day". Taking it as the day's start would
  // silently cut the last day off every share an operator sets this way.
  it("runs a chosen date to the end of that day", () => {
    const at = expiryInstant(form({ mode: "datetime", on: "2026-03-05" }), NOW);
    assert.ok(at);
    const local = new Date("2026-03-05T23:59:59");
    assert.equal(at.getTime(), local.getTime());
  });

  it("treats an unreadable date as no expiry rather than as now", () => {
    assert.equal(expiryInstant(form({ mode: "datetime", on: "not-a-date" }), NOW), null);
  });
});

describe("what the form refuses", () => {
  it("rejects a duration below one", () => {
    assert.match(expiryFormError(form({ mode: "duration", amount: 0 }), NOW), /at least one/);
  });

  // A share whose expiry is already past answers exactly like a wrong token, so
  // an operator who set one by accident would get no feedback at all.
  it("rejects a date that has already passed", () => {
    assert.match(expiryFormError(form({ mode: "datetime", on: "2020-01-01" }), NOW), /already passed/);
  });

  it("asks for a date when the mode needs one", () => {
    assert.match(expiryFormError(form({ mode: "datetime" }), NOW), /Pick the date/);
  });

  it("accepts a valid form", () => {
    assert.equal(expiryFormError(form({ mode: "duration", amount: 1, unit: "day" }), NOW), "");
    assert.equal(expiryFormError(form(), NOW), "");
  });
});

describe("how long is left", () => {
  // Rounded up: "0 days" and "expired" are indistinguishable at a glance and
  // mean very different things to whoever is holding the link.
  it("reports a part-day as one day", () => {
    const at = new Date(NOW + 6 * 3_600_000).toISOString();
    assert.equal(daysRemaining(at, NOW), 1);
  });

  it("counts whole days exactly", () => {
    assert.equal(daysRemaining(new Date(NOW + 30 * DAY).toISOString(), NOW), 30);
  });

  it("goes negative once past", () => {
    assert.ok(daysRemaining(new Date(NOW - DAY).toISOString(), NOW) < 0);
  });

  it("knows expired from live", () => {
    assert.equal(isExpired(new Date(NOW - 1).toISOString(), NOW), true);
    assert.equal(isExpired(new Date(NOW + DAY).toISOString(), NOW), false);
    // A share with no expiry is not expired, however the caller asks.
    assert.equal(isExpired(undefined, NOW), false);
  });
});

describe("what the list says", () => {
  it("says so when a share never expires", () => {
    assert.equal(expiryLabel(undefined, NOW), "never expires");
  });

  it("counts down while live", () => {
    assert.match(expiryLabel(new Date(NOW + 3 * DAY).toISOString(), NOW), /3 days left/);
  });

  it("says one day, not one days", () => {
    assert.match(expiryLabel(new Date(NOW + DAY).toISOString(), NOW), /1 day left/);
  });

  it("says expired rather than a negative countdown", () => {
    const label = expiryLabel(new Date(NOW - DAY).toISOString(), NOW);
    assert.match(label, /^expired /);
    assert.ok(!label.includes("-"), `a negative day count reached the label: ${label}`);
  });
});

describe("the duration table", () => {
  // A calendar month would make "1 month" mean 28 days in February, so these
  // are deliberately fixed.
  it("is fixed rather than calendar-based", () => {
    assert.equal(DURATION_DAYS.day, 1);
    assert.equal(DURATION_DAYS.month, 30);
    assert.equal(DURATION_DAYS.quarter, 91);
    assert.equal(DURATION_DAYS.year, 365);
  });
});
