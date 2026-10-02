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

/* ------------------------------------------------------------------ */
/* From 768 px up: clear of a sheet open beside the collection          */
/* ------------------------------------------------------------------ */

/**
 * From 768 px up toasts sit top right, which is exactly where an object
 * sheet beside the collection keeps its title and close button (36 to 44 rem
 * wide, anchored right). A success toast after "Approve and queue" sat on
 * both. While such a sheet is open, toasts move left of it, still at the
 * top; when the room left of the sheet is narrower than a toast (about 768
 * to 1000 px wide), they drop to the bottom right and rise above the sheet's
 * footer instead, so neither the header nor Approve and Reject is covered.
 */

/** Open sheets the toasts must keep clear of. */
export const TOAST_SHEET_SELECTOR = '[data-slot="sheet-content"][data-state="open"]';

/** vue-sonner's toast width. */
export const TOAST_WIDTH_PX = 356;

/** vue-sonner's offset from the viewport edge from 600 px up. */
export const TOAST_VIEWPORT_OFFSET_PX = 24;

/** Space left between a toast and the sheet it moved aside for. */
export const TOAST_SHEET_GAP_PX = 16;

export interface SheetBox {
  left: number;
  right: number;
}

export type ToastPlacement =
  | { position: "top-right"; right?: number }
  | { position: "bottom-right"; bottom: number | null }
  | { position: "bottom-center"; bottom: number | null };

export interface ToastPlacementInput {
  viewportWidth: number;
  viewportHeight: number;
  /** Below 768 px, where a sheet takes the whole screen. */
  mobile: boolean;
  sheets: readonly SheetBox[];
  footers: readonly FooterBox[];
}

export function toastPlacement(input: ToastPlacementInput): ToastPlacement {
  if (input.mobile) return { position: "bottom-center", bottom: toastLift(input.viewportHeight, input.footers) };
  // Sheets anchored to the right edge and laid out; the leftmost decides.
  let left = Number.POSITIVE_INFINITY;
  for (const sheet of input.sheets) {
    if (sheet.right <= sheet.left || sheet.right < input.viewportWidth - 1 || sheet.left <= 0) continue;
    left = Math.min(left, sheet.left);
  }
  if (!Number.isFinite(left)) return { position: "top-right" };
  if (left - TOAST_SHEET_GAP_PX >= TOAST_WIDTH_PX + TOAST_VIEWPORT_OFFSET_PX) {
    return { position: "top-right", right: Math.ceil(input.viewportWidth - left + TOAST_SHEET_GAP_PX) };
  }
  return { position: "bottom-right", bottom: toastLift(input.viewportHeight, input.footers) };
}
