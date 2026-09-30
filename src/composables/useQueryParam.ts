/**
 * One query key bound to a value, one way.
 *
 * The value is derived from the address and only an operator's change writes
 * it back, with `replace`: a filter refines the page rather than navigating.
 * There is no second copy of the state and no watcher, so nothing can write
 * while the page is leaving, and a reload, a pasted link and Back all land
 * on what the address says. Writes go through the page's owned route
 * (useOwnedRoute), so they can only address this page.
 */
import { computed, type WritableComputedRef } from "vue";

import type { QueryRecord, QueryValue } from "@/components/common/tableUrlState";

import { useOwnedRoute, type OwnedRoute } from "@/composables/useOwnedRoute";

export interface QueryParamCodec<T> {
  /** The value a raw query entry means; anything unrecognised is the default. */
  parse: (raw: QueryValue | undefined) => T;
  /** The spelling of a value in the query, or undefined for the bare URL. */
  format: (value: T) => string | undefined;
  /** Adjust the rest of the query in the same write (send a table back to page one). */
  alongside?: (query: QueryRecord) => void;
}

export function bindQueryParam<T>(owned: OwnedRoute, param: string, codec: QueryParamCodec<T>): WritableComputedRef<T> {
  return computed<T>({
    get: () => codec.parse(owned.query()[param]),
    set: (value) => {
      const current = owned.query();
      const want = codec.format(value);
      if ((current[param] ?? undefined) === want) return;
      const query: QueryRecord = { ...current };
      if (want === undefined) delete query[param];
      else query[param] = want;
      codec.alongside?.(query);
      owned.replace(query);
    },
  });
}

export function useQueryParam<T>(param: string, codec: QueryParamCodec<T>): WritableComputedRef<T> {
  return bindQueryParam(useOwnedRoute(), param, codec);
}
