import assert from "node:assert/strict";
import { test } from "node:test";

import { NO_VALUE, formatAge, formatDateTime, formatMoney, isZeroTime, setFormatLocale } from "../format.ts";
import { canonicalCurrency, currencyInputCode, currencyRewrittenOnSave } from "../currency.ts";

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

test("an age reads in Chinese units for a zh locale and stays compact otherwise", () => {
  assert.equal(formatAge(13_000), "13s");
  assert.equal(formatAge(13_000, "en"), "13s");
  assert.equal(formatAge(13_000, "zh-CN"), "13 秒");
  assert.equal(formatAge(5 * 60_000, "zh-CN"), "5 分钟");
  assert.equal(formatAge(3 * 3_600_000, "zh-CN"), "3 小时");
  assert.equal(formatAge(50 * 3_600_000, "zh-CN"), "2 天");
});

test("CHY is the yuan and reads, formats and saves as CNY", () => {
  assert.equal(canonicalCurrency("CHY"), "CNY");
  assert.equal(canonicalCurrency(" chy "), "CNY");
  assert.equal(canonicalCurrency("cny"), "CNY");
  assert.equal(canonicalCurrency("USDT"), "USDT");
  assert.equal(canonicalCurrency(undefined), "");
  assert.equal(formatMoney(342683, "CHY"), formatMoney(342683, "CNY"));
  assert.equal(formatMoney(1000, ""), formatMoney(1000, "USD"));
});

test("money reads one way everywhere: the code, then the amount with two decimals, in either language", () => {
  // Inventory printed "CN¥3,426.83" (zh "¥3,426.83") beside Upcoming's "CNY 3,267.90".
  assert.equal(formatMoney(342683, "CNY"), "CNY 3,426.83");
  assert.equal(formatMoney(342683, "chy"), "CNY 3,426.83");
  assert.equal(formatMoney(8092, "USD"), "USD 80.92");
  assert.equal(formatMoney(0, "EUR"), "EUR 0.00");
  // A code Intl does not know keeps the same order.
  assert.equal(formatMoney(1250, "USDT"), "USDT 12.50");
  setFormatLocale("zh-CN");
  try {
    assert.equal(formatMoney(342683, "CNY"), "CNY 3,426.83");
  } finally {
    setFormatLocale(undefined);
  }
  assert.equal(formatMoney(undefined, "CNY"), NO_VALUE);
});

test("a stored code is read as stored; only the editor keeps letters and cuts to five", () => {
  // Display and totals: case, spaces and the alias, nothing else, so a
  // six-letter ticker is not cut into a different code.
  assert.equal(canonicalCurrency("usdtxx"), "USDTXX");
  assert.equal(canonicalCurrency("US-D"), "US-D");
  // The editor writes the field: letters only, at most five, alias folded.
  assert.equal(currencyInputCode(" us-d "), "USD");
  assert.equal(currencyInputCode("chy"), "CNY");
  assert.equal(currencyInputCode("USDTXX"), "USDTX");
  assert.equal(currencyInputCode(undefined), "");
  // Saving rewrites only what the editor would change, not case or spaces.
  assert.equal(currencyRewrittenOnSave("CHY"), true);
  assert.equal(currencyRewrittenOnSave(" chy "), true);
  assert.equal(currencyRewrittenOnSave("cny"), false);
  assert.equal(currencyRewrittenOnSave("USDT"), false);
  assert.equal(currencyRewrittenOnSave(""), false);
});
