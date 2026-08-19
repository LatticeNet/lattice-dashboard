/**
 * Pure model for tabs that live in the URL.
 *
 * A tab held in a local ref cannot be linked and does not survive a reload:
 * every visit lands on the first tab, and "look at the graph tab of the
 * policy page" is not something one operator can send another. Reading the
 * tab out of the route query fixes both, and costs one composable.
 *
 * Kept free of Vue so `node --test` covers it directly (house *Model.ts
 * pattern).
 */
import type { QueryValue } from "@/components/common/tableUrlState";

/** Default query parameter for a view's primary tab group. */
export const ROUTE_TAB_PARAM = "tab";

/**
 * Pick the tab a query asks for.
 *
 * Anything the view cannot render right now (an unknown value, a tab hidden
 * because the operator lacks the scope for it, a stale link from before a tab
 * was renamed) resolves to the fallback, so a bad URL still shows a working
 * page rather than an empty one.
 */
export function resolveRouteTab<T extends string>(
  raw: QueryValue | undefined,
  allowed: readonly T[],
  fallback: T,
): T {
  const value = Array.isArray(raw) ? raw.find((entry) => typeof entry === "string") : raw;
  const name = typeof value === "string" ? value.trim() : "";
  return (allowed as readonly string[]).includes(name) ? (name as T) : fallback;
}

/**
 * Merge a tab selection into a route query.
 *
 * The fallback tab is represented by the absence of the parameter, so the
 * default view of a page has a clean URL and a link only carries a tab when
 * it means to. Every other key is carried through untouched.
 */
export function writeRouteTab<T extends string>(
  query: Record<string, QueryValue | undefined>,
  param: string,
  tab: T,
  fallback: T,
): Record<string, QueryValue> {
  const next: Record<string, QueryValue> = {};
  for (const [key, value] of Object.entries(query)) {
    if (key === param || value === undefined) continue;
    next[key] = value;
  }
  if (tab !== fallback) next[param] = tab;
  return next;
}
