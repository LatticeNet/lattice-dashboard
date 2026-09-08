import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DURATION_DAYS,
  emptyExpiryForm,
  expiryCreateValue,
  expiryFormError,
  expiryFormFor,
  expiryInstant,
  expiryUpdateBody,
  type ExpiryForm,
} from "../shareExpiryModel.ts";

const NOW = Date.parse("2026-08-21T12:00:00Z");
const form = (o: Partial<ExpiryForm> = {}): ExpiryForm => ({ ...emptyExpiryForm(), ...o });

test("never means no instant at all, not an instant far away", () => {
  assert.equal(expiryInstant(form(), NOW), null);
  assert.equal(expiryCreateValue(form(), NOW), undefined);
});

test("a duration is counted in fixed days, so the same choice always lasts the same time", () => {
  // A calendar month would make "1 month" mean 28 days in February. An operator
  // picking a month wants about a month, not a length that depends on when they
  // clicked.
  const at = expiryInstant(form({ mode: "duration", amount: 1, unit: "month" }), NOW);
  assert.equal(at?.getTime(), NOW + 30 * 86_400_000);
  assert.deepEqual(DURATION_DAYS, { day: 1, month: 30, quarter: 91, year: 365 });
});

test("a date means through the end of that day, not the moment it begins", () => {
  // Taking the date input at midnight would cut the last day off: a share set
  // to expire on the 30th would stop working as the 30th started.
  const at = expiryInstant(form({ mode: "date", on: "2026-09-30" }), NOW);
  assert.ok(at);
  assert.equal(at.getHours(), 23);
  assert.equal(at.getMinutes(), 59);
  assert.equal(at.getDate(), 30);
});

test("a duration below one, or fractional, is refused rather than rounded", () => {
  assert.equal(expiryFormError(form({ mode: "duration", amount: 0 }), NOW), "durationTooSmall");
  assert.equal(expiryFormError(form({ mode: "duration", amount: -3 }), NOW), "durationTooSmall");
  assert.equal(expiryFormError(form({ mode: "duration", amount: 1.5 }), NOW), "durationTooSmall");
  assert.equal(expiryFormError(form({ mode: "duration", amount: Number.NaN }), NOW), "durationTooSmall");
  assert.equal(expiryFormError(form({ mode: "duration", amount: 1 }), NOW), "");
});

test("a date in the past is refused here rather than by the server", () => {
  // The server rejects it too, but a share that is dead on arrival answers
  // exactly like a wrong token, so catching it in the form is the difference
  // between a message and a mystery.
  assert.equal(expiryFormError(form({ mode: "date", on: "2026-08-20" }), NOW), "datePast");
  assert.equal(expiryFormError(form({ mode: "date", on: "" }), NOW), "datePickOne");
  assert.equal(expiryFormError(form({ mode: "date", on: "not-a-date" }), NOW), "dateUnreadable");
  assert.equal(expiryFormError(form({ mode: "date", on: "2026-12-01" }), NOW), "");
});

test("never travels as clear_expiry, because an omitted field means leave it alone", () => {
  // This is the whole reason the update body is composed here. The server takes
  // pointers: omitting expires_at keeps the current expiry. If "never" sent an
  // empty body the dialog would close, the toast would say saved, and the share
  // would still expire.
  assert.deepEqual(expiryUpdateBody(form(), NOW), { clear_expiry: true });

  const body = expiryUpdateBody(form({ mode: "duration", amount: 7, unit: "day" }), NOW);
  assert.equal(body.clear_expiry, undefined);
  assert.equal(body.expires_at, new Date(NOW + 7 * 86_400_000).toISOString());
});

test("an existing expiry opens the dialog as a date, never as a guessed duration", () => {
  // The server stores an instant. "90 days" is not recoverable from it, and
  // showing a duration the operator never chose would be a lie the next save
  // would act on.
  const at = new Date(NOW + 45 * 86_400_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  const local = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
  assert.deepEqual(expiryFormFor({ expires_at: at.toISOString() }), {
    mode: "date",
    amount: 30,
    unit: "day",
    on: local,
  });
});

test("a share with no expiry, or an unreadable one, opens on never", () => {
  assert.equal(expiryFormFor({ expires_at: undefined }).mode, "never");
  assert.equal(expiryFormFor({ expires_at: "nonsense" }).mode, "never");
});
