import assert from "node:assert/strict";
import { test } from "node:test";

import { isDemoObject, onlyDemos } from "../demo.ts";

test("a record is a demo by its name prefix and nothing else", () => {
  assert.equal(isDemoObject("demo-geo-preview"), true);
  assert.equal(isDemoObject("  Demo-Edge"), true);
  // "demo" inside the name is not the contract; only the prefix is.
  assert.equal(isDemoObject("edge-demo"), false);
  assert.equal(isDemoObject("demonstration"), false);
  assert.equal(isDemoObject(undefined), false);
  assert.equal(isDemoObject(""), false);
});

test("the first-run explanation shows only while every record is a demo", () => {
  assert.equal(onlyDemos([]), false);
  assert.equal(onlyDemos(["demo-geo-preview"]), true);
  assert.equal(onlyDemos(["demo-geo-preview", "demo-second"]), true);
  // One real record and the page is in use; the teaching block steps aside.
  assert.equal(onlyDemos(["demo-geo-preview", "apex-edge"]), false);
});
