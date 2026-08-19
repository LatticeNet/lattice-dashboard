import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";

import { claimViewportPane, resetViewportPaneClaims, viewportPaneClaimed } from "../viewportPane.ts";

beforeEach(() => {
  resetViewportPaneClaims();
});

test("the main region is a scrolling document until something claims the pane", () => {
  assert.equal(viewportPaneClaimed.value, false);
  const release = claimViewportPane();
  assert.equal(viewportPaneClaimed.value, true);
  release();
  assert.equal(viewportPaneClaimed.value, false);
});

test("a plugin route following a plugin route never drops the pane between them", () => {
  // Vue mounts the incoming view before unmounting the outgoing one, so the
  // order really is claim, claim, release. A boolean flag would go false here
  // and the arriving plugin would render into a scrolling document.
  const leaving = claimViewportPane();
  const arriving = claimViewportPane();
  leaving();
  assert.equal(viewportPaneClaimed.value, true);
  arriving();
  assert.equal(viewportPaneClaimed.value, false);
});

test("releasing twice cannot free a claim another view still holds", () => {
  const first = claimViewportPane();
  claimViewportPane();
  first();
  first();
  assert.equal(viewportPaneClaimed.value, true);
});
