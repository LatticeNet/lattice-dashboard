import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createMemoryHistory, createRouter, isNavigationFailure } from "vue-router";

import { reportUnauthorized, setUnauthorizedListener } from "@/lib/api/client";
import { EXPIRED_REASON } from "@/lib/sessionExpiry";
import { installSessionExpiry, type SessionOwner } from "../expiredSession.ts";
import { trackPendingNavigation } from "../navigationState.ts";

/**
 * The 401 path end to end on a real router: the API client's own report,
 * the session check, the principal forgotten, and the replace to sign-in
 * with the way back. Only the auth store is a fake.
 */

function fakeAuth(opts: { gone?: boolean } = {}) {
  const state = { signedIn: true, signingOut: false, checks: 0, expired: 0 };
  const owner: SessionOwner = {
    get isAuthenticated() {
      return state.signedIn;
    },
    get signingOut() {
      return state.signingOut;
    },
    async sessionGone() {
      state.checks += 1;
      return opts.gone ?? true;
    },
    expire() {
      state.expired += 1;
      state.signedIn = false;
    },
  };
  return { owner, state };
}

function shell(opts: { gone?: boolean } = {}) {
  let releaseChunk: (component: object) => void = () => {};
  const chunk = new Promise<object>((resolve) => {
    releaseChunk = resolve;
  });
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/login", name: "login", component: {}, meta: { public: true } },
      { path: "/nodes", name: "nodes", component: {} },
      // A view whose chunk has not arrived yet.
      { path: "/tasks", name: "tasks", component: () => chunk },
    ],
  });
  trackPendingNavigation(router);
  const auth = fakeAuth(opts);
  const watch = installSessionExpiry(router, () => auth.owner, setUnauthorizedListener);
  /** Report a 401 the way the client does, and wait for the check and any navigation it started. */
  async function unauthorized(path: string): Promise<void> {
    reportUnauthorized(path);
    // The same report again joins the check the first one started.
    await watch.report(path);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return { router, auth, unauthorized, releaseChunk };
}

test("an expired session leaves the page for sign-in, with the way back and the reason", async () => {
  const { router, auth, unauthorized } = shell({ gone: true });
  await router.push("/nodes?group=status");

  await unauthorized("/api/nodes");

  const at = router.currentRoute.value;
  assert.equal(at.name, "login");
  assert.deepEqual(at.query, { redirect: "/nodes?group=status", reason: EXPIRED_REASON });
  assert.deepEqual({ checks: auth.state.checks, expired: auth.state.expired }, { checks: 1, expired: 1 });

  // Reads still in flight answer 401 too; signed out now, they ask nothing.
  await unauthorized("/api/approvals/counts");
  assert.equal(auth.state.checks, 1);
});

test("the way back is the page a navigation in flight was opening, and that navigation is cancelled", async () => {
  const { router, unauthorized, releaseChunk } = shell({ gone: true });
  await router.push("/nodes");
  const click = router.push("/tasks?status=failed");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(router.currentRoute.value.path, "/nodes", "the route still names the page being left");

  await unauthorized("/api/tasks");

  assert.equal(router.currentRoute.value.name, "login");
  assert.equal(router.currentRoute.value.query.redirect, "/tasks?status=failed");
  releaseChunk({});
  assert.equal(isNavigationFailure(await click), true, "the click does not land after sign-in took over");
  assert.equal(router.currentRoute.value.name, "login");
});

test("on a public page the session is forgotten and nobody is moved", async () => {
  const { router, auth, unauthorized } = shell({ gone: true });
  await router.push("/login?redirect=/nodes");

  await unauthorized("/api/nodes");

  assert.equal(auth.state.expired, 1);
  assert.equal(router.currentRoute.value.fullPath, "/login?redirect=/nodes");
});

test("a 401 that was a wrong code, or one that lands while signing out, moves nobody", async () => {
  const wrongCode = shell({ gone: false });
  await wrongCode.router.push("/nodes");
  await wrongCode.unauthorized("/api/security/step-up");
  assert.equal(wrongCode.router.currentRoute.value.path, "/nodes");
  assert.deepEqual({ checks: wrongCode.auth.state.checks, expired: wrongCode.auth.state.expired }, { checks: 1, expired: 0 });

  const signingOut = shell({ gone: true });
  await signingOut.router.push("/nodes");
  signingOut.auth.state.signingOut = true;
  await signingOut.unauthorized("/api/nodes");
  assert.equal(signingOut.router.currentRoute.value.path, "/nodes");
  assert.equal(signingOut.auth.state.checks, 0);
});

test("the console router installs this wiring on the API client's 401 listener", () => {
  const source = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
  assert.match(source, /installSessionExpiry\(router, useAuthStore, setUnauthorizedListener\);/);
  // A denied route is not redirected by the guard: the shell renders RouteDenied in its place.
  assert.doesNotMatch(source, /canAny\(/, "the guard must not send a denied route elsewhere");
});
