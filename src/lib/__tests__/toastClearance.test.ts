import assert from "node:assert/strict";
import { test } from "node:test";

import { TOAST_GAP_PX, toastLift } from "../toastClearance.ts";

test("with nothing open the toaster keeps its own offset", () => {
  assert.equal(toastLift(812, []), null);
});

test("a full screen sheet's footer lifts the toast above its top edge", () => {
  // The object sheet at 375 x 812: footer from 744 to 812.
  assert.equal(toastLift(812, [{ top: 744, bottom: 812 }]), 812 - 744 + TOAST_GAP_PX);
});

test("a short dialog centred on the screen leaves the toast at the bottom", () => {
  assert.equal(toastLift(812, [{ top: 548, bottom: 600 }]), null);
});

test("a dialog over a sheet: the toast clears the highest footer in the band", () => {
  // A tall confirm whose footer reaches 700 sits over the sheet's footer.
  assert.equal(toastLift(812, [{ top: 744, bottom: 812 }, { top: 600, bottom: 700 }]), 812 - 600 + TOAST_GAP_PX);
  // A short confirm above the band does not move the toast past the sheet's footer.
  assert.equal(toastLift(812, [{ top: 744, bottom: 812 }, { top: 400, bottom: 452 }]), 812 - 744 + TOAST_GAP_PX);
});

test("a footer that wraps onto two rows lifts the toast by its full height", () => {
  assert.equal(toastLift(812, [{ top: 700, bottom: 812 }]), 812 - 700 + TOAST_GAP_PX);
});

test("an empty box (a footer that is not laid out) is ignored", () => {
  assert.equal(toastLift(812, [{ top: 0, bottom: 0 }]), null);
});
