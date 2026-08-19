import assert from "node:assert/strict";
import test from "node:test";

import { fieldNumber, fieldText, hasFieldText } from "../formValue.ts";

/**
 * The case this exists for: a field declared as a string that Vue turned into
 * a number the moment the operator typed in it.
 */
test("a numeric input's value reads as text without throwing", () => {
  assert.equal(fieldText(300), "300");
  assert.equal(fieldText("  300  "), "300");
  assert.equal(hasFieldText(0), true);
  assert.equal(fieldNumber(300), 300);
});

test("blank in every shape it arrives in is blank", () => {
  for (const blank of ["", "   ", null, undefined]) {
    assert.equal(fieldText(blank), "");
    assert.equal(hasFieldText(blank), false);
    assert.equal(fieldNumber(blank), undefined);
  }
});

/** Zero is a value an operator can mean; it must not read as empty text. */
test("zero is a value, not an absence", () => {
  assert.equal(fieldText(0), "0");
  assert.equal(hasFieldText(0), true);
  assert.equal(fieldNumber(0), 0);
});

test("a number that is not a number becomes undefined rather than NaN", () => {
  for (const bad of ["abc", "12abc", Number.NaN, Infinity, "1/2"]) {
    assert.equal(fieldNumber(bad), undefined, `${String(bad)} should not parse`);
  }
});

test("undefined never reaches a request body as NaN", () => {
  const body = { ...(fieldNumber("") === undefined ? {} : { ttl: fieldNumber("") }) };
  assert.deepEqual(body, {});
});
