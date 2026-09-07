import assert from "node:assert/strict";
import test from "node:test";

import {
  GUIDE_STORAGE_PREFIX,
  guideExpanded,
  guideStorageKey,
  guideStoredValue,
} from "../planeGuideModel.ts";

test("with nothing remembered, an empty plane opens the guide and a full one collapses it", () => {
  assert.equal(guideExpanded(null, true), true);
  assert.equal(guideExpanded(null, false), false);
  assert.equal(guideExpanded(undefined, true), true);
});

test("a remembered choice outranks the plane", () => {
  // Closed over an empty plane: not shown again on the next visit.
  assert.equal(guideExpanded(guideStoredValue(false), true), false);
  // Opened over a full plane: stays open.
  assert.equal(guideExpanded(guideStoredValue(true), false), true);
});

test("a value this model never wrote reads as no choice", () => {
  assert.equal(guideExpanded("true", false), false);
  assert.equal(guideExpanded("", true), true);
  assert.equal(guideExpanded("collapsed", true), true);
});

test("the two pages persist under their own lattice.ui keys", () => {
  assert.equal(GUIDE_STORAGE_PREFIX, "lattice.ui.guide.");
  assert.equal(guideStorageKey("publishing"), "lattice.ui.guide.publishing");
  assert.equal(guideStorageKey("store"), "lattice.ui.guide.store");
  assert.notEqual(guideStorageKey("publishing"), guideStorageKey("store"));
});
