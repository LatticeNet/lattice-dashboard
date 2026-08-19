import assert from "node:assert/strict";
import test from "node:test";

import { pickerDegradeReason } from "../resourcePickerModel.ts";

const HEALTHY = {
  canRead: true,
  failed: false,
  loaded: true,
  optionCount: 3,
  valueKnown: true,
  hasValue: true,
};

test("a list it can offer stays a list", () => {
  assert.equal(pickerDegradeReason(HEALTHY), undefined);
  assert.equal(pickerDegradeReason({ ...HEALTHY, hasValue: false, valueKnown: false }), undefined);
});

test("no scope, a failed list, and an empty list each give up for their own reason", () => {
  assert.equal(pickerDegradeReason({ ...HEALTHY, canRead: false }), "scope");
  assert.equal(pickerDegradeReason({ ...HEALTHY, failed: true }), "failed");
  assert.equal(pickerDegradeReason({ ...HEALTHY, optionCount: 0, valueKnown: false }), "empty");
});

/**
 * A Select cannot represent a value that is not one of its options, so binding
 * one would silently blank the field the operator is looking at.
 */
test("a value the list does not contain falls back rather than being dropped", () => {
  assert.equal(pickerDegradeReason({ ...HEALTHY, valueKnown: false }), "unknown");
});

test("an empty field is not 'unknown' just because the list does not contain nothing", () => {
  assert.equal(
    pickerDegradeReason({ ...HEALTHY, hasValue: false, valueKnown: false }),
    undefined,
  );
});

test("while loading it stays a list, so the field does not flip shape under the operator", () => {
  assert.equal(
    pickerDegradeReason({ ...HEALTHY, loaded: false, optionCount: 0, valueKnown: false }),
    undefined,
  );
});

test("the earliest cause wins, because it is the one worth acting on", () => {
  assert.equal(
    pickerDegradeReason({ canRead: false, failed: true, loaded: true, optionCount: 0, valueKnown: false, hasValue: true }),
    "scope",
  );
  assert.equal(
    pickerDegradeReason({ canRead: true, failed: true, loaded: true, optionCount: 0, valueKnown: false, hasValue: true }),
    "failed",
  );
});
