import assert from "node:assert/strict";
import { test } from "node:test";

import { TOAST_GAP_PX, TOAST_SHEET_GAP_PX, TOAST_VIEWPORT_OFFSET_PX, TOAST_WIDTH_PX, toastLift, toastPlacement } from "../toastClearance.ts";

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

test("from 768 px up with no sheet open, toasts stay top right", () => {
  assert.deepEqual(toastPlacement({ viewportWidth: 1440, viewportHeight: 900, mobile: false, sheets: [], footers: [] }), { position: "top-right" });
});

test("at 1440 a sheet beside the collection moves toasts to its left, still at the top", () => {
  // ObjectSheet at 1440: clamp(36rem, 40vw, 44rem) = 576 px, from 864 to 1440.
  const placement = toastPlacement({
    viewportWidth: 1440,
    viewportHeight: 900,
    mobile: false,
    sheets: [{ left: 864, right: 1440 }],
    footers: [{ top: 840, bottom: 900 }],
  });
  assert.deepEqual(placement, { position: "top-right", right: 1440 - 864 + TOAST_SHEET_GAP_PX });
  // The toast's box ends left of the sheet.
  const toastRight = 1440 - (placement as { right: number }).right;
  assert.ok(toastRight <= 864 - TOAST_SHEET_GAP_PX);
  assert.ok(toastRight - TOAST_WIDTH_PX >= TOAST_VIEWPORT_OFFSET_PX);
});

test("when the room left of the sheet is narrower than a toast, toasts rise above the sheet's footer at the bottom right", () => {
  // 900 px wide: the sheet is 576 px from 324, leaving no room for 356 px.
  assert.deepEqual(
    toastPlacement({ viewportWidth: 900, viewportHeight: 800, mobile: false, sheets: [{ left: 324, right: 900 }], footers: [{ top: 740, bottom: 800 }] }),
    { position: "bottom-right", bottom: 800 - 740 + TOAST_GAP_PX },
  );
});

test("a sheet that is not anchored right, or not laid out, does not move toasts", () => {
  const base = { viewportWidth: 1440, viewportHeight: 900, mobile: false, footers: [] };
  // The mobile sidebar drawer slides from the left.
  assert.deepEqual(toastPlacement({ ...base, sheets: [{ left: 0, right: 288 }] }), { position: "top-right" });
  assert.deepEqual(toastPlacement({ ...base, sheets: [{ left: 864, right: 864 }] }), { position: "top-right" });
  // Mid-slide, still short of the right edge.
  assert.deepEqual(toastPlacement({ ...base, sheets: [{ left: 900, right: 1400 }] }), { position: "top-right" });
});

test("below 768 px toasts keep rising from the bottom centre above any footer", () => {
  assert.deepEqual(
    toastPlacement({ viewportWidth: 375, viewportHeight: 812, mobile: true, sheets: [{ left: 0, right: 375 }], footers: [{ top: 744, bottom: 812 }] }),
    { position: "bottom-center", bottom: 812 - 744 + TOAST_GAP_PX },
  );
  assert.deepEqual(toastPlacement({ viewportWidth: 375, viewportHeight: 812, mobile: true, sheets: [], footers: [] }), { position: "bottom-center", bottom: null });
});
