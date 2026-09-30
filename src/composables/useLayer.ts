/**
 * A page's layer, bound to `?view=` (design 23, section 3.4).
 *
 * useRouteTab on the `view` key, plus one thing it does not do: an old link
 * that says `?tab=` lands on the layer it named and is rewritten once, with
 * `replace`, to `?view=`. Switching layers pushes, so Back returns to the
 * layer the operator came from.
 *
 * Every read and write goes through the page's owned route: while the page
 * is leaving, the router already points at the next page, whose own `?tab=`
 * (plugin pages use it freely) is none of this page's business.
 */
import { computed, watch, type WritableComputedRef } from "vue";

import { canonicalLayerQuery, resolveLayer, writeLayer } from "@/composables/layerModel";
import { useOwnedRoute, type OwnedRoute } from "@/composables/useOwnedRoute";

export function bindLayer<T extends string>(
  owned: OwnedRoute,
  allowed: () => readonly T[],
  fallback: () => T,
): WritableComputedRef<T> {
  watch(
    () => owned.query(),
    (query) => {
      if (!owned.owns()) return;
      const canonical = canonicalLayerQuery(query, allowed(), fallback());
      if (canonical) owned.replace(canonical);
    },
    { immediate: true },
  );

  return computed<T>({
    get: () => resolveLayer(owned.query(), allowed(), fallback()),
    set: (value) => {
      const next = resolveLayer({ view: value }, allowed(), fallback());
      const query = owned.query();
      if (next === resolveLayer(query, allowed(), fallback())) return;
      owned.push(writeLayer(query, next, fallback()));
    },
  });
}

export function useLayer<T extends string>(
  /** Layers this page can render right now; may narrow with the operator's scopes. */
  allowed: () => readonly T[],
  /** Layer shown when the URL names none, or one that is not allowed. */
  fallback: () => T,
): WritableComputedRef<T> {
  return bindLayer(useOwnedRoute(), allowed, fallback);
}
