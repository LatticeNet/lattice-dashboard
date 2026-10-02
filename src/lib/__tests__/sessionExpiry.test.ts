import assert from "node:assert/strict";
import test from "node:test";

import { EXPIRED_REASON, createSessionWatch, expiredSignInLocation, isSessionSignal } from "../sessionExpiry.ts";

test("a 401 from a read or a write is a session signal; from the session, sign-in and second-factor paths it is not", () => {
  for (const path of ["/api/nodes", "/api/approvals?status=pending", "/api/tasks/counts", "/api/machines/renew", "/api/plugins/latticenet.vpn-core/call"]) {
    assert.equal(isSessionSignal(path), true, path);
  }
  for (const path of [
    "/api/me",
    "/api/me?x=1",
    "/api/login",
    "/api/login/totp",
    "/api/logout",
    "/api/auth/password",
    "/api/auth/webauthn/login/finish",
    "/api/auth/oidc",
    "/api/2fa/totp/activate",
    "/api/security/step-up",
    "/theme-init.js",
  ]) {
    assert.equal(isSessionSignal(path), false, path);
  }
  // A prefix is not a match: /api/metrics is not /api/me.
  assert.equal(isSessionSignal("/api/metrics"), true);
  assert.equal(isSessionSignal("/api/loginhistory"), true);
});

function watchWith(opts: { gone?: boolean | Error; signedIn?: boolean } = {}) {
  const calls = { checks: 0, expired: 0 };
  let signedIn = opts.signedIn ?? true;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const watch = createSessionWatch({
    sessionGone: async () => {
      calls.checks += 1;
      await gate;
      if (opts.gone instanceof Error) throw opts.gone;
      return opts.gone ?? true;
    },
    signedIn: () => signedIn,
    onExpired: () => {
      calls.expired += 1;
      signedIn = false;
    },
  });
  return { watch, calls, release, signOut: () => (signedIn = false) };
}

test("many 401s at once share one session check and expire the session once", async () => {
  const { watch, calls, release } = watchWith({ gone: true });
  const reports = [watch.report("/api/nodes"), watch.report("/api/approvals/counts"), watch.report("/api/tasks/counts")];
  release();
  await Promise.all(reports);
  assert.deepEqual(calls, { checks: 1, expired: 1 });
  // Signed out now: later 401s from reads still in flight ask nothing.
  await watch.report("/api/nodes");
  assert.deepEqual(calls, { checks: 1, expired: 1 });
});

test("a 401 that was a wrong code, not a lost session, leaves the operator where they are", async () => {
  const { watch, calls, release } = watchWith({ gone: false });
  release();
  await watch.report("/api/machines/reveal-link");
  assert.deepEqual(calls, { checks: 1, expired: 0 });
});

test("a session check that cannot answer decides nothing, and the next 401 asks again", async () => {
  const { watch, calls, release } = watchWith({ gone: new Error("offline") });
  release();
  await watch.report("/api/nodes");
  await watch.report("/api/nodes");
  assert.deepEqual(calls, { checks: 2, expired: 0 });
});

test("a 401 while signed out or signing out, or from an exempt path, checks nothing", async () => {
  const signedOut = watchWith({ signedIn: false });
  signedOut.release();
  await signedOut.watch.report("/api/nodes");
  assert.deepEqual(signedOut.calls, { checks: 0, expired: 0 });

  const exempt = watchWith();
  exempt.release();
  await exempt.watch.report("/api/security/step-up");
  await exempt.watch.report("/api/me");
  assert.deepEqual(exempt.calls, { checks: 0, expired: 0 });
});

test("a sign-out that lands while the check runs is not reported as an expiry", async () => {
  const { watch, calls, release, signOut } = watchWith({ gone: true });
  const report = watch.report("/api/nodes");
  signOut();
  release();
  await report;
  assert.deepEqual(calls, { checks: 1, expired: 0 });
});

test("an expired session goes to sign-in with the way back and the reason", () => {
  assert.deepEqual(expiredSignInLocation("/network/policy?open=x"), {
    name: "login",
    query: { redirect: "/network/policy?open=x", reason: EXPIRED_REASON },
  });
  // Never an off-site way back.
  assert.equal(expiredSignInLocation("//evil.example/x").query.redirect, "/");
  assert.equal(expiredSignInLocation("https://evil.example/").query.redirect, "/");
});
