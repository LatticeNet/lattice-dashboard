/**
 * A page's layer, bound to `?view=` (design 23, section 3.4).
 *
 * useRouteTab on the `view` key, plus one thing it does not do: an old link
 * that says `?tab=` lands on the layer it named and is rewritten once, with
 * `replace`, to `?view=`. Switching layers pushes, so Back returns to the
 * layer the operator came from.
 */
import { computed, watch, type WritableComputedRef } from "vue";
import { useRoute, useRouter } from "vue-router";

import { canonicalLayerQuery, resolveLayer, writeLayer } from "./layerModel";

export function useLayer<T extends string>(
  /** Layers this page can render right now; may narrow with the operator's scopes. */
  allowed: () => readonly T[],
  /** Layer shown when the URL names none, or one that is not allowed. */
  fallback: () => T,
): WritableComputedRef<T> {
  const route = useRoute();
  const router = useRouter();

  watch(
    () => route.query,
    (query) => {
      const canonical = canonicalLayerQuery(query, allowed(), fallback());
      if (canonical) router.replace({ query: canonical }).catch(() => {});
    },
    { immediate: true },
  );

  return computed<T>({
    get: () => resolveLayer(route.query, allowed(), fallback()),
    set: (value) => {
      const next = resolveLayer({ view: value }, allowed(), fallback());
      if (next === resolveLayer(route.query, allowed(), fallback())) return;
      router.push({ query: writeLayer(route.query, next, fallback()) }).catch(() => {});
    },
  });
}
