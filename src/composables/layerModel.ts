/**
 * Pure model for a page's layer tabs (design 23, section 3.4; design 22,
 * section 2, rule 2).
 *
 * A page that holds several kinds of object has one tab row for its layers,
 * mirrored in `?view=`. Pages that used `?tab=` read it once for old links,
 * and the address is rewritten to `?view=` so the link an operator copies is
 * the one this page writes.
 *
 * Kept free of Vue so `node --test` covers it directly.
 */
import type { QueryRecord, QueryValue } from "@/components/common/tableUrlState";

import { resolveRouteTab, writeRouteTab } from "./routeTabModel.ts";

/** The query key every layer row writes. */
export const LAYER_PARAM = "view";
/** The key pages used before design 23; read once, never written. */
export const LEGACY_LAYER_PARAM = "tab";

function present(raw: QueryValue | undefined): boolean {
  const value = Array.isArray(raw) ? raw.find((entry) => typeof entry === "string") : raw;
  return typeof value === "string" && value.trim() !== "";
}

/**
 * The layer a query asks for: `view` when it names an allowed layer, then the
 * old `tab`, then the fallback. A value the page cannot render right now (an
 * unknown name, a layer hidden by scope) lands on the fallback, so a bad link
 * still shows a working page.
 */
export function resolveLayer<T extends string>(query: QueryRecord, allowed: readonly T[], fallback: T): T {
  if (present(query[LAYER_PARAM])) {
    const named = resolveRouteTab(query[LAYER_PARAM], allowed, fallback);
    if (named !== fallback || !present(query[LEGACY_LAYER_PARAM])) return named;
  }
  return resolveRouteTab(query[LEGACY_LAYER_PARAM], allowed, fallback);
}

/** Merge a layer into a query. The fallback layer is the bare URL. */
export function writeLayer<T extends string>(query: QueryRecord, layer: T, fallback: T): Record<string, QueryValue> {
  const next = writeRouteTab(query, LAYER_PARAM, layer, fallback);
  delete next[LEGACY_LAYER_PARAM];
  return next;
}

/**
 * The canonical spelling of an old link, or null when the query is already
 * canonical. Applied once with `replace`, so the old link does not sit in the
 * history as a second entry.
 */
export function canonicalLayerQuery<T extends string>(
  query: QueryRecord,
  allowed: readonly T[],
  fallback: T,
): Record<string, QueryValue> | null {
  if (!(LEGACY_LAYER_PARAM in query) || query[LEGACY_LAYER_PARAM] === undefined) return null;
  return writeLayer(query, resolveLayer(query, allowed, fallback), fallback);
}
