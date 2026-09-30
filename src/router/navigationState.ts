import type { RouteLocationNormalized, Router } from "vue-router";

/**
 * The name of the route that hosts a plugin page. A plugin's page-state write
 * applies only while this route is current (see PluginFrameHost).
 */
export const PLUGIN_VIEW_ROUTE_NAME = "plugin-view";

/**
 * Where the window scrolls after a navigation.
 *
 * A change of path or hash is a new place, so it starts at the top. A change
 * of the query alone is the same page saying where it is: a plugin writes its
 * page state into the query with a history replace, debounced by about 250 ms,
 * and a list filter or an open record does the same. Scrolling to the top on
 * each of those would throw the operator back up the page while they work, so
 * the position is kept.
 */
export function consoleScrollBehavior(
  to: Pick<RouteLocationNormalized, "path" | "hash">,
  from: Pick<RouteLocationNormalized, "path" | "hash">,
): false | { top: number } {
  if (to.path === from.path && to.hash === from.hash) return false;
  return { top: 0 };
}

/** Whether a navigation is under way, and a way to hear when it ends. */
export interface PendingNavigation {
  /**
   * True from the first global guard of a navigation until that navigation
   * lands, fails, or throws. A newer navigation takes over; the one it
   * cancelled does not end the pending state.
   */
  isPending(): boolean;
  /** Called each time the pending navigation ends. Returns an unsubscribe. */
  onSettled(listener: () => void): () => void;
}

type NavigationHooks = Pick<Router, "beforeEach" | "afterEach" | "onError">;

const trackers = new WeakMap<object, PendingNavigation>();

/**
 * Track the navigation in flight on this router.
 *
 * `route.path` changes only when a navigation is confirmed. Until then, a
 * pending navigation (a lazy chunk loading, a guard awaiting the session) is
 * invisible to anything that reads the current route, and a history replace
 * started in that window cancels it: the operator's click is lost. Anything
 * that writes to the address on its own schedule has to ask this first.
 *
 * vue-router passes one location object through every hook of a navigation:
 * beforeEach gets it first, afterEach gets it when the navigation lands, is
 * aborted, is cancelled by a newer one, or duplicates the current route, and
 * onError gets it when a guard or a chunk throws (afterEach is not called
 * then). A guard redirect starts a new navigation with a new object, so the
 * newest beforeEach is the navigation that matters, and only its own end
 * clears the pending state.
 *
 * Install it before any other beforeEach: guards run in registration order,
 * and a guard that awaits (the session bootstrap) would otherwise hide the
 * navigation for as long as it waits.
 */
export function trackPendingNavigation(router: NavigationHooks): PendingNavigation {
  let pending: object | null = null;
  const listeners = new Set<() => void>();

  function settle(to: object) {
    if (to !== pending) return;
    pending = null;
    for (const listener of [...listeners]) listener();
  }

  router.beforeEach((to) => {
    pending = to;
  });
  router.afterEach((to) => settle(to));
  router.onError((_error, to) => settle(to));

  const tracker: PendingNavigation = {
    isPending: () => pending !== null,
    onSettled(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  trackers.set(router, tracker);
  return tracker;
}

/**
 * The tracker installed on this router, or undefined when none was. A caller
 * that writes to the address must treat undefined as "cannot tell", not as
 * "nothing pending".
 */
export function pendingNavigationOf(router: object): PendingNavigation | undefined {
  return trackers.get(router);
}
