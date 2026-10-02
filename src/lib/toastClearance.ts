/**
 * Where a bottom toast sits so it never covers the actions of an open sheet
 * or dialog (design 23 review, wave 2).
 *
 * Below 768 px toasts rise from the bottom (a top toast covered the full
 * screen sheet's title and close button), and the bottom is where an object
 * sheet and a tall dialog keep Approve, Reject, Cancel task, Delete and
 * Rerun. vue-sonner toasts take pointer events, so a toast over a footer
 * blocks the next decision for as long as it shows. The toaster measures
 * the footers that are open and lifts itself above any that reaches into
 * the band a bottom toast occupies; a footer higher up (a short dialog
 * centred on the screen) leaves the toast where it is.
 *
 * Kept free of the DOM so `node --test` covers the rule directly.
 */

/** The footers a toast must not cover: dialog and sheet footers, and the object sheet's own. */
export const TOAST_AVOID_SELECTOR = '[data-slot="dialog-footer"], [data-slot="sheet-footer"], [data-slot="sheet-content"] > footer';

/**
 * The height from the bottom of the screen that a bottom toast can occupy:
 * the toaster's offset (16 or 24 px) and a toast of up to three lines with
 * its description, rounded up.
 */
export const TOAST_BAND_PX = 160;

/** Space left between a lifted toast and the top of the footer under it. */
export const TOAST_GAP_PX = 8;

export interface FooterBox {
  top: number;
  bottom: number;
}

/**
 * The bottom offset in px that keeps a toast above every footer reaching
 * into the toast band, or null when no footer does and the toaster keeps its
 * own offset.
 */
export function toastLift(viewportHeight: number, footers: readonly FooterBox[]): number | null {
  const bandTop = viewportHeight - TOAST_BAND_PX;
  let highest = Number.POSITIVE_INFINITY;
  for (const footer of footers) {
    if (footer.bottom <= footer.top || footer.bottom <= bandTop) continue;
    highest = Math.min(highest, footer.top);
  }
  if (!Number.isFinite(highest)) return null;
  return Math.max(0, Math.ceil(viewportHeight - highest + TOAST_GAP_PX));
}
