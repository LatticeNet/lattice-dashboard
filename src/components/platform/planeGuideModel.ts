/**
 * The guide block on Store and Publishing: open when the plane is empty,
 * one line otherwise, and the operator's choice remembered per browser
 * (DESIGN-PROGRAM-2026-09 §9, Decision B).
 *
 * Kept free of Vue so `node --test` covers it directly (house *Model.ts
 * pattern). The persistence key follows the `lattice.ui.*` family the ui and
 * theme stores use.
 */

export const GUIDE_STORAGE_PREFIX = "lattice.ui.guide.";

/** The pages that carry a guide; the id is the storage key suffix. */
export type GuidePage = "publishing" | "store";

export function guideStorageKey(page: GuidePage): string {
  return `${GUIDE_STORAGE_PREFIX}${page}`;
}

const EXPANDED = "1";
const COLLAPSED = "0";

/**
 * Whether the guide is open.
 *
 * A remembered choice wins: an operator who closed the guide over an empty
 * plane is not shown it again on every visit, and one who opened it over a
 * full plane keeps it open. With nothing remembered the plane decides: empty
 * opens, anything else is one line.
 */
export function guideExpanded(stored: string | null | undefined, planeEmpty: boolean): boolean {
  if (stored === EXPANDED) return true;
  if (stored === COLLAPSED) return false;
  return planeEmpty;
}

/** The value to store for a choice; anything else in storage reads as no choice. */
export function guideStoredValue(expanded: boolean): string {
  return expanded ? EXPANDED : COLLAPSED;
}
