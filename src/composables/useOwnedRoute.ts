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
 */
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

  const owns = () => read().path === path;

  return {
    path,
    owns,
    query() {
      const current = read();
      if (current.path === path) last = current.query;
      return last;
    },
    replace(query) {
      if (owns()) router.replace({ path, query }).catch(() => {});
    },
    push(query) {
      if (owns()) router.push({ path, query }).catch(() => {});
    },
  };
}

export function useOwnedRoute(): OwnedRoute {
  const route = useRoute();
  const router = useRouter();
  return ownRoute(() => route, router);
}
