import assert from "node:assert/strict";
import test from "node:test";

import { buildMatch, shortCommit } from "../aboutModel.ts";

test("the same commit on both sides is the matching pair", () => {
  assert.equal(buildMatch("3da5b3a9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3", "3da5b3a9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3"), "same");
});

test("a short and a full form of one commit still match", () => {
  assert.equal(buildMatch("3da5b3a", "3da5b3a9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3"), "same");
  assert.equal(buildMatch("3DA5B3A9E8", "3da5b3a"), "same");
});

test("a tab left open across a deploy runs a different commit", () => {
  assert.equal(buildMatch("3da5b3a9e8d7", "0f50eba7c1d2"), "different");
  // Too short to call a prefix the same commit.
  assert.equal(buildMatch("3da", "3da5b3a9e8d7"), "different");
});

test("a side without a commit makes no claim", () => {
  assert.equal(buildMatch(undefined, "3da5b3a"), "unknown");
  assert.equal(buildMatch("3da5b3a", "unknown"), "unknown");
  assert.equal(buildMatch("dev", "3da5b3a"), "unknown");
  assert.equal(buildMatch("", ""), "unknown");
});

test("commits print at 12 characters", () => {
  assert.equal(shortCommit("3da5b3a9e8d7c6b5a4f3"), "3da5b3a9e8d7");
  assert.equal(shortCommit("3da5b3a"), "3da5b3a");
  assert.equal(shortCommit(undefined), "");
});
