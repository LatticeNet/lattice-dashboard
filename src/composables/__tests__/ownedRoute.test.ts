/**
 * A page that is leaving must not write the next page's address.
 *
 * AppLayout keys the routed view by path, so the leaving page is still
 * mounted, with its pre-flush watchers live, when the router already points
 * at the next page. These tests drive a real memory router through that
 * moment: the page binds on its own path, the router moves to a target that
 * carries the same query key, the scheduler runs, and the target's query
 * must be exactly what the navigation asked for.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { nextTick, ref, watch } from "vue";
import { createMemoryHistory, createRouter, type Router } from "vue-router";

import { nodeStatusFilterCodec, type NodeStatusFilter } from "../../views/fleet/nodesTableModel.ts";
import { bindLayer } from "../useLayer.ts";
import { bindQueryParam } from "../useQueryParam.ts";
import { bindRouteOpen } from "../useRouteOpen.ts";
import { ownRoute } from "../useOwnedRoute.ts";

async function routerAt(location: string): Promise<Router> {
  const page = { render: () => null };
  const router = createRouter({
    history: createMemoryHistory(),
    routes: ["/nodes", "/tasks", "/evidence", "/approvals", "/plugins/:id"].map((path) => ({ path, component: page })),
  });
  await router.push(location);
  return router;
}

function owned(router: Router) {
  return ownRoute(() => router.currentRoute.value, router);
}

/** Let the navigation land and every watcher and queued write run. */
async function settle(router: Router): Promise<void> {
  await nextTick();
  await router.isReady();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
}

test("control: a two-way status mirror rewrites the page it is leaving to", async () => {
  // The shape Nodes had: a ref seeded from the address, a watcher writing it
  // back, a watcher reading it in. This is the bug the owned route removes.
  const router = await routerAt("/nodes?status=offline");
  const route = router.currentRoute;
  const filter = ref<NodeStatusFilter>(nodeStatusFilterCodec.parse(route.value.query.status ?? undefined));
  watch(filter, (value) => {
    const query = { ...route.value.query };
    const want = nodeStatusFilterCodec.format(value);
    if ((query.status ?? undefined) === want) return;
    if (want) query.status = want;
    else delete query.status;
    router.replace({ query }).catch(() => {});
  });
  watch(
    () => route.value.query.status,
    (raw) => {
      filter.value = nodeStatusFilterCodec.parse(raw ?? undefined);
    },
  );

  await router.push("/tasks?status=queued");
  await settle(router);
  assert.equal(route.value.path, "/tasks");
  assert.deepEqual(route.value.query, {}, "the unguarded mirror deleted the target's status");
});

test("Nodes: leaving with ?status= on the target leaves the target untouched", async () => {
  const router = await routerAt("/nodes?status=offline");
  const status = bindQueryParam(owned(router), "status", nodeStatusFilterCodec);
  assert.equal(status.value, "offline");

  await router.push("/tasks?status=queued");
  await settle(router);
  assert.equal(router.currentRoute.value.fullPath, "/tasks?status=queued");
  // The leaving page keeps showing its own filter rather than flipping to "all".
  assert.equal(status.value, "offline");

  // A late write from the leaving page (a Select closing as it unmounts) goes nowhere.
  status.value = "all";
  await settle(router);
  assert.equal(router.currentRoute.value.fullPath, "/tasks?status=queued");
});

test("Nodes: the operator's change writes the status back, and all is the bare URL", async () => {
  const router = await routerAt("/nodes?status=offline&q=edge");
  const status = bindQueryParam(owned(router), "status", nodeStatusFilterCodec);

  status.value = "degraded";
  await settle(router);
  assert.deepEqual(router.currentRoute.value.query, { status: "degraded", q: "edge" });
  assert.equal(status.value, "degraded");

  status.value = "all";
  await settle(router);
  assert.deepEqual(router.currentRoute.value.query, { q: "edge" });

  // Back lands on the filter the address held, with no second copy to resync.
  await router.replace("/nodes?status=never_reported");
  await settle(router);
  assert.equal(status.value, "never_reported");
  await router.replace("/nodes?status=bogus");
  await settle(router);
  assert.equal(status.value, "all");
});

test("layers: an old ?tab= link is rewritten on the page's own route only", async () => {
  const router = await routerAt("/evidence?tab=explore&q=1");
  const layer = bindLayer(owned(router), () => ["overview", "explore"] as const, () => "overview");
  await settle(router);
  assert.equal(router.currentRoute.value.path, "/evidence");
  assert.deepEqual(router.currentRoute.value.query, { view: "explore", q: "1" });
  assert.equal(layer.value, "explore");

  // A plugin page uses ?tab= for its own tabs; the leaving page must not canonicalise it.
  await router.push("/plugins/sub-store?tab=settings");
  await settle(router);
  assert.equal(router.currentRoute.value.fullPath, "/plugins/sub-store?tab=settings");
  assert.equal(layer.value, "explore");

  layer.value = "overview";
  await settle(router);
  assert.equal(router.currentRoute.value.fullPath, "/plugins/sub-store?tab=settings");
});

test("layers: switching layers pushes on the page's own path", async () => {
  const router = await routerAt("/evidence");
  const layer = bindLayer(owned(router), () => ["overview", "explore"] as const, () => "overview");
  layer.value = "explore";
  await settle(router);
  assert.equal(router.currentRoute.value.fullPath, "/evidence?view=explore");
  router.back();
  await settle(router);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(router.currentRoute.value.fullPath, "/evidence");
});

test("sheets: the leaving page neither shows nor clears the next page's ?open=", async () => {
  const router = await routerAt("/tasks?open=task_1");
  const sheet = bindRouteOpen(owned(router));
  assert.equal(sheet.openId.value, "task_1");

  await router.push("/approvals?open=appr_9");
  await settle(router);
  assert.equal(sheet.openId.value, "task_1", "the leaving sheet does not flip to the target's object");

  // The dialog closing as the page unmounts must not clear the target's sheet.
  sheet.close();
  await settle(router);
  assert.equal(router.currentRoute.value.fullPath, "/approvals?open=appr_9");
});

test("sheets: closing on the page's own route clears only ?open=", async () => {
  const router = await routerAt("/tasks?open=task_1&view=history");
  const sheet = bindRouteOpen(owned(router));
  sheet.close();
  await settle(router);
  assert.deepEqual(router.currentRoute.value.query, { view: "history" });
  assert.equal(sheet.openId.value, null);
});
