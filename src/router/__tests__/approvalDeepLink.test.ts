import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryHistory, createRouter } from "vue-router";

import { approvalIdRoute } from "../approvalIdRoute.ts";

/**
 * The Approvals list plus the /approvals/:id rewrite, under the same catch-all
 * that used to send Bark click URLs to Overview.
 */
function makeRouter() {
  const Dummy = { name: "Dummy" };
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      {
        path: "/",
        component: Dummy,
        children: [
          { path: "", name: "overview", component: Dummy },
          { path: "approvals", name: "approvals", component: Dummy },
          approvalIdRoute,
        ],
      },
      { path: "/:pathMatch(.*)*", redirect: "/" },
    ],
  });
}

test("/approvals/:id opens the list with that row selected, not Overview", async () => {
  const router = makeRouter();
  await router.push("/approvals/ap-1");
  assert.equal(router.currentRoute.value.name, "approvals");
  assert.equal(router.currentRoute.value.path, "/approvals");
  assert.equal(router.currentRoute.value.query.selected, "ap-1");
});

test("/approvals?selected= is left alone", async () => {
  const router = makeRouter();
  await router.push("/approvals?selected=ap-query");
  assert.equal(router.currentRoute.value.path, "/approvals");
  assert.equal(router.currentRoute.value.query.selected, "ap-query");
});

test("a path id keeps other query keys and does not overwrite ?selected=", async () => {
  const router = makeRouter();
  await router.push("/approvals/ap-path?tab=individual&selected=ap-query");
  assert.equal(router.currentRoute.value.query.selected, "ap-query");
  assert.equal(router.currentRoute.value.query.tab, "individual");
});

test("a percent-encoded path id is decoded into ?selected=", async () => {
  const router = makeRouter();
  await router.push("/approvals/ap%201");
  assert.equal(router.currentRoute.value.path, "/approvals");
  assert.equal(router.currentRoute.value.query.selected, "ap 1");
});
