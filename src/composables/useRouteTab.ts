/**
 * Bind a tab group to the route query.
 *
 * Returns a writable computed that reads straight from the URL, so there is
 * no second copy of the state to keep in step: a reload, a pasted link and a
 * back-navigation all resolve through the same path as a click.
 *
 * Tab changes use `push`, not `replace`: switching tab is going somewhere,
 * and the back button should return to the tab the operator came from. Table
 * filters, which refine rather than navigate, keep using `replace`.
 */
import { computed, type WritableComputedRef } from "vue";
import { useRoute, useRouter } from "vue-router";

import { ROUTE_TAB_PARAM, resolveRouteTab, writeRouteTab } from "./routeTabModel";

export function useRouteTab<T extends string>(
  /** Tabs this view can render right now; may narrow with the operator's scopes. */
  allowed: () => readonly T[],
  /** Tab shown when the URL names none, or names one that is not allowed. */
  fallback: () => T,
  param: string = ROUTE_TAB_PARAM,
): WritableComputedRef<T> {
  const route = useRoute();
  const router = useRouter();

  return computed<T>({
    get: () => resolveRouteTab(route.query[param], allowed(), fallback()),
    set: (value) => {
      const next = resolveRouteTab(value, allowed(), fallback());
      const query = writeRouteTab(route.query, param, next, fallback());
      if (query[param] === route.query[param]) return;
      router.push({ query }).catch(() => {});
    },
  });
}
