import assert from "node:assert/strict";
import test from "node:test";

import { createMemoryHistory, createRouter, isNavigationFailure } from "vue-router";

import {
  PLUGIN_VIEW_ROUTE_NAME,
  consoleScrollBehavior,
  pendingNavigationOf,
  trackPendingNavigation,
} from "../navigationState.ts";
import { planPluginStateWrite } from "@/views/platform/pluginBridgeModel";

// ── scroll ──────────────────────────────────────────────────────────────────

test("a query-only change keeps the scroll position; a new path or hash starts at the top", () => {
  const at = (path: string, hash = "") => ({ path, hash });
  // A plugin's page-state replace changes only the query, every ~250 ms.
  assert.equal(consoleScrollBehavior(at("/plugins/vpn-core/lines"), at("/plugins/vpn-core/lines")), false);
  assert.equal(consoleScrollBehavior(at("/nodes", "#disk"), at("/nodes", "#disk")), false);
  assert.deepEqual(consoleScrollBehavior(at("/plugins/vpn-core/users"), at("/plugins/vpn-core/lines")), { top: 0 });
  assert.deepEqual(consoleScrollBehavior(at("/nodes", "#disk"), at("/nodes")), { top: 0 }, "a new hash is a new place");
});

// ── pending navigation, hook by hook ────────────────────────────────────────

type Hook = (...args: unknown[]) => unknown;

/** The three hooks the tracker registers, captured so a test can fire them. */
function fakeRouter() {
  const hooks = { before: [] as Hook[], after: [] as Hook[], error: [] as Hook[] };
  const router = {
    beforeEach: (hook: Hook) => { hooks.before.push(hook); return () => {}; },
    afterEach: (hook: Hook) => { hooks.after.push(hook); return () => {}; },
    onError: (hook: Hook) => { hooks.error.push(hook); return () => {}; },
  };
  return {
    router,
    start: (to: object) => hooks.before.forEach((hook) => hook(to, {})),
    end: (to: object) => hooks.after.forEach((hook) => hook(to, {}, undefined)),
    fail: (to: object) => hooks.error.forEach((hook) => hook(new Error("chunk"), to, {})),
  };
}

function tracked() {
  const fake = fakeRouter();
  const tracker = trackPendingNavigation(fake.router as never);
  let settled = 0;
  tracker.onSettled(() => { settled += 1; });
  return { ...fake, tracker, settled: () => settled };
}

test("a navigation is pending from its first guard until it lands", () => {
  const { tracker, start, end, settled } = tracked();
  const click = { path: "/b" };
  assert.equal(tracker.isPending(), false);
  start(click);
  assert.equal(tracker.isPending(), true);
  end(click);
  assert.equal(tracker.isPending(), false);
  assert.equal(settled(), 1);
});

test("a navigation cancelled by a newer one does not end the pending state", () => {
  const { tracker, start, end, settled } = tracked();
  const first = { path: "/b" };
  const second = { path: "/c" };
  start(first);
  start(second);
  // vue-router calls afterEach for the cancelled one, with a failure.
  end(first);
  assert.equal(tracker.isPending(), true, "the newer navigation is still under way");
  assert.equal(settled(), 0);
  end(second);
  assert.equal(tracker.isPending(), false);
  assert.equal(settled(), 1);
});

test("a duplicated navigation, which skips the guards, leaves the pending one alone", () => {
  const { tracker, start, end } = tracked();
  const click = { path: "/b" };
  start(click);
  end({ path: "/a" });
  assert.equal(tracker.isPending(), true);
});

test("a guard redirect hands the pending state to the navigation it starts", () => {
  const { tracker, start, end } = tracked();
  const asked = { path: "/b" };
  const redirected = { path: "/login" };
  start(asked);
  // No afterEach for a redirected navigation; the redirect runs its own guards.
  start(redirected);
  assert.equal(tracker.isPending(), true);
  end(redirected);
  assert.equal(tracker.isPending(), false);
});

test("a navigation that throws ends through onError, and only its own error counts", () => {
  const { tracker, start, fail, settled } = tracked();
  const stale = { path: "/b" };
  const current = { path: "/c" };
  start(stale);
  start(current);
  fail(stale);
  assert.equal(tracker.isPending(), true, "an error from a superseded navigation changes nothing");
  fail(current);
  assert.equal(tracker.isPending(), false);
  assert.equal(settled(), 1);
});

test("a listener can unsubscribe, and each router has its own tracker", () => {
  const fake = fakeRouter();
  const tracker = trackPendingNavigation(fake.router as never);
  let calls = 0;
  const stop = tracker.onSettled(() => { calls += 1; });
  const to = { path: "/b" };
  fake.start(to);
  stop();
  fake.end(to);
  assert.equal(calls, 0);
  assert.equal(pendingNavigationOf(fake.router), tracker);
  assert.equal(pendingNavigationOf(fakeRouter().router), undefined, "an untracked router says it cannot tell");
});

// ── the real router: a page-state write never cancels the operator's click ──

function realRouter() {
  let releaseChunk: (component: object) => void = () => {};
  const chunk = new Promise<object>((resolve) => { releaseChunk = resolve; });
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: "/plugins/:pluginId/:route(.*)*", name: PLUGIN_VIEW_ROUTE_NAME, component: {} },
      // A view whose chunk has not arrived yet.
      { path: "/nodes", name: "nodes", component: () => chunk },
    ],
  });
  const tracker = trackPendingNavigation(router);
  return { router, tracker, releaseChunk };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("while the operator's click waits for a chunk, the write is held and the click lands", async () => {
  const { router, tracker, releaseChunk } = realRouter();
  const framePath = "/plugins/vpn-core/lines";
  await router.push(framePath);

  const click = router.push("/nodes");
  await tick();
  const current = router.currentRoute.value;
  // The route still says the plugin page: only the tracker knows better.
  assert.equal(current.path, framePath);
  assert.equal(tracker.isPending(), true);
  const plan = planPluginStateWrite({
    current: { name: current.name, path: current.path, query: current.query, hash: current.hash },
    framePath,
    navigationPending: tracker.isPending(),
    state: { view: "users" },
  });
  assert.deepEqual(plan, { kind: "hold" });

  releaseChunk({});
  const failure = await click;
  assert.equal(isNavigationFailure(failure), false, "the click was not cancelled");
  assert.equal(router.currentRoute.value.path, "/nodes");
  assert.equal(tracker.isPending(), false);

  // Retried after the click landed: another page, so the held state is dropped.
  const landed = router.currentRoute.value;
  assert.deepEqual(
    planPluginStateWrite({
      current: { name: landed.name, path: landed.path, query: landed.query, hash: landed.hash },
      framePath,
      navigationPending: tracker.isPending(),
      state: { view: "users" },
    }),
    { kind: "skip" },
  );
});

test("the write the host holds is exactly what would have cancelled the click", async () => {
  // The failure the hold prevents, reproduced against the real router so the
  // test goes red if vue-router ever stops cancelling on a newer navigation
  // (the hold would then be unnecessary, not wrong).
  const { router, releaseChunk } = realRouter();
  await router.push("/plugins/vpn-core/lines");
  const click = router.push("/nodes");
  await tick();
  const write = router.replace({ path: "/plugins/vpn-core/lines", query: { view: "users" } });
  releaseChunk({});
  assert.equal(isNavigationFailure(await click), true, "an unguarded replace cancels the pending click");
  await write;
  assert.equal(router.currentRoute.value.fullPath, "/plugins/vpn-core/lines?view=users");
});

test("a state write on the plugin route, with nothing pending, replaces the query only", async () => {
  const { router, tracker } = realRouter();
  const framePath = "/plugins/vpn-core/lines";
  await router.push({ path: framePath, hash: "#top" });
  const current = router.currentRoute.value;
  const plan = planPluginStateWrite({
    current: { name: current.name, path: current.path, query: current.query, hash: current.hash },
    framePath,
    navigationPending: tracker.isPending(),
    state: { view: "users" },
  });
  assert.equal(plan.kind, "replace");
  if (plan.kind !== "replace") return;
  await router.replace(plan.location);
  assert.equal(router.currentRoute.value.fullPath, "/plugins/vpn-core/lines?view=users#top");
  assert.equal(tracker.isPending(), false, "the write's own navigation ended");
});
