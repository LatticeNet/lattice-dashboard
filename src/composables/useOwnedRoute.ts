/**
 * The route a page was mounted on, so the page never writes another page's
 * address.
 *
 * AppLayout keys the routed view by path. During a navigation the leaving
 * page is still mounted while `useRoute()` already describes the page it is
 * going to, and its pre-flush watchers run before it unmounts. A page that
 * mirrors a query key both ways then reads the target's value, "corrects"
 * it, and replaces the target's query: /nodes?status=offline to
 * /tasks?status=queued landed on /tasks with the status gone.
 *
 * The page captures its path at setup. Reads return the query it last saw
 * as its own, so nothing on the leaving page flips to the target's state;
 * writes do nothing once the router has moved on, and carry the page's path
 * so they can only ever address this page.
 *
 * A write is not in `route.query` until the router confirms it, a tick or
 * more later. Two writes in the same tick (a filter and its page reset, two
 * bindings on one page) would each build on the same stale query, and the
 * later would cancel the earlier. The last requested query is therefore the
 * base, and what reads return, until the router confirms or drops it.
 */
import { shallowRef } from "vue";
import { useRoute, useRouter, type LocationQueryRaw } from "vue-router";

import type { QueryRecord } from "@/components/common/tableUrlState";

export interface RouteView {
  readonly path: string;
  readonly query: QueryRecord;
}

export interface QueryNavigator {
  push(to: { path: string; query: LocationQueryRaw }): Promise<unknown>;
  replace(to: { path: string; query: LocationQueryRaw }): Promise<unknown>;
}

export interface OwnedRoute {
  /** The path the page was mounted on. */
  readonly path: string;
  /** True while the router still points at this page. */
  owns(): boolean;
  /** This page's query: the live one while it owns the route, the last one it saw after. */
  query(): QueryRecord;
  /** Replace this page's query. Does nothing once the router has moved on. */
  replace(query: LocationQueryRaw): void;
  /** Push a new entry with this query. Does nothing once the router has moved on. */
  push(query: LocationQueryRaw): void;
}

export function ownRoute(read: () => RouteView, router: QueryNavigator): OwnedRoute {
  const path = read().path;
  let last = read().query;
  /** The query last asked for and not yet confirmed or dropped by the router. */
  const requested = shallowRef<QueryRecord | null>(null);
  let writes = 0;

  const owns = () => read().path === path;

  function write(navigate: QueryNavigator["replace"], query: LocationQueryRaw): void {
    if (!owns()) return;
    const mine = ++writes;
    requested.value = query as QueryRecord;
    // Settled either way (done, redundant, cancelled by a later navigation):
    // from then on the route itself says what the query is.
    const settle = () => {
      if (writes === mine) requested.value = null;
    };
    navigate({ path, query }).then(settle, settle);
  }

  return {
    path,
    owns,
    query() {
      const current = read();
      if (current.path !== path) return last;
      last = current.query;
      return requested.value ?? last;
    },
    replace(query) {
      write((to) => router.replace(to), query);
    },
    push(query) {
      write((to) => router.push(to), query);
    },
  };
}

export function useOwnedRoute(): OwnedRoute {
  const route = useRoute();
  const router = useRouter();
  return ownRoute(() => route, router);
}
