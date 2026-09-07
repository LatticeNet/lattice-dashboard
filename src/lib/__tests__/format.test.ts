import assert from "node:assert/strict";
import { test } from "node:test";

import { NO_VALUE, formatDateTime, isZeroTime } from "../format.ts";

const GO_ZERO = "0001-01-01T00:00:00Z";

test("Go's zero time is 'never', however it is spelled", () => {
  // The wire form of a time.Time nobody set. omitempty does not drop it, so
  // "no first line yet" reaches the console as a non-empty string.
  assert.equal(isZeroTime(GO_ZERO), true);
  // The same instant with fractional seconds, and serialised in another zone:
  // the year is read in UTC so neither lands in a real date.
  assert.equal(isZeroTime("0001-01-01T00:00:00.000000Z"), true);
  assert.equal(isZeroTime("0001-01-01T08:00:00+08:00"), true);
  assert.equal(isZeroTime("0001-01-01T00:00:00+08:00"), true);
  // Absent counts as never too, so one guard covers a field that was omitted
  // and a field that was zeroed.
  assert.equal(isZeroTime(undefined), true);
  assert.equal(isZeroTime(""), true);
});

test("a real timestamp is not zero, and junk is not zero either", () => {
  assert.equal(isZeroTime("2026-09-07T09:42:50.790518Z"), false);
  // The Unix epoch is a real instant somebody might have recorded.
  assert.equal(isZeroTime("1970-01-01T00:00:00Z"), false);
  // Unparseable input is not evidence of "never": the caller's formatter
  // already prints the no-value mark for it.
  assert.equal(isZeroTime("not a date"), false);
  assert.equal(formatDateTime("not a date"), NO_VALUE);
});

test("formatDateTime alone would print the zero time as a year-1 date, which is why the guard exists", () => {
  // Pins the failure the guard prevents, so a future formatter that starts
  // treating year 1 as absent would make this test say so.
  assert.notEqual(formatDateTime(GO_ZERO), NO_VALUE);
});
