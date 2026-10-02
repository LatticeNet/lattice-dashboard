import type { Router } from "vue-router";
import { createSessionWatch, expiredSignInLocation, type SessionWatch } from "@/lib/sessionExpiry";
import { pendingNavigationOf } from "@/router/navigationState";

/** The part of the auth store an expired session touches. */
export interface SessionOwner {
  readonly isAuthenticated: boolean;
  readonly signingOut: boolean;
  /** One uncached session read: true when refused, false when answered; throws otherwise. */
  sessionGone(): Promise<boolean>;
  /** Forget the principal. */
  expire(): void;
}

/**
 * An expired session goes to sign-in, once, with the way back: the client
 * reports each 401 to `listen`'s listener, lib/sessionExpiry confirms with
 * /api/me that the session is really gone, and then the principal is
 * forgotten and the operator lands on sign-in with a note and ?redirect= to
 * the page they were on. Leaving the shell unmounts every page, which stops
 * their polling. On a public page (sign-in itself) nobody is moved.
 *
 * The way back is the navigation in flight when there is one: the current
 * route still names the page being left until a navigation lands, and the
 * replace to sign-in cancels that navigation, so the page the operator asked
 * for would otherwise be lost.
 *
 * Kept apart from router/index.ts (which needs a browser history) so a test
 * can drive it on a real router with a memory history.
 */
export function installSessionExpiry(
  router: Router,
  auth: () => SessionOwner,
  listen: (listener: (path: string) => void) => void,
): SessionWatch {
  const watch = createSessionWatch({
    sessionGone: () => auth().sessionGone(),
    signedIn: () => {
      const owner = auth();
      return owner.isAuthenticated && !owner.signingOut;
    },
    onExpired: () => {
      const from = pendingNavigationOf(router)?.target() ?? router.currentRoute.value;
      auth().expire();
      if (from.meta.public) return;
      void router.replace(expiredSignInLocation(from.fullPath));
    },
  });
  listen((path) => void watch.report(path));
  return watch;
}
