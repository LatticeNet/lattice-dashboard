import assert from "node:assert/strict";
import test from "node:test";
import { createMemoryHistory, createRouter } from "vue-router";

import {
  VIEW_MEMORY_KEY,
  VIEW_MEMORY_MAX,
  forgetView,
  installViewMemory,
  isRememberedPath,
  recallView,
  rememberView,
  resetRestoredView,
  restoredView,
  setViewMemoryOwner,
  viewQuery,
  viewToRestore,
  type ViewStorage,
} from "../viewMemory.ts";

function memoryStorage(): ViewStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

const A = "usr_alice";
const B = "usr_bob";

const CONSOLE = new Set(["/", "/nodes", "/tasks", "/approvals", "/upcoming"]);
const inApp = { path: "/approvals", matched: [{}] } as never;
const firstLoad = { path: "/", matched: [] } as never;

test("the view keeps layer, filter, sort and search, and drops object and one-shot keys", () => {
  assert.deepEqual(
    viewQuery({ view: "lines", status: "offline", sort: "-name", q: "dmit", open: "node_1", create: "1", for: "x", code: "abc", mfa: "required" }),
    { view: "lines", status: "offline", sort: "-name", q: "dmit" },
  );
  assert.deepEqual(viewQuery({ tag: ["a", null, "b"], empty: null }), { tag: ["a", "b"] });
  assert.deepEqual(viewQuery({ q: "x".repeat(600) }), {}, "an oversized value is left out, not cut");
});

test("console pages and plugin pages are remembered; Overview, the queues and detail pages are not", () => {
  assert.equal(isRememberedPath("/nodes", CONSOLE), true);
  assert.equal(isRememberedPath("/upcoming", CONSOLE), true);
  assert.equal(isRememberedPath("/plugins/latticenet.vpn-core/users", CONSOLE), true);
  assert.equal(isRememberedPath("/", CONSOLE), false);
  assert.equal(isRememberedPath("/approvals", CONSOLE), false, "a decision queue opens on what awaits a decision");
  assert.equal(isRememberedPath("/tasks", CONSOLE), false, "the run queue opens on its runs");
  assert.equal(isRememberedPath("/nodes/node_1", CONSOLE), false);
  assert.equal(isRememberedPath("/plugins", CONSOLE), false);
  assert.equal(isRememberedPath("/plugins/latticenet.vpn-core", CONSOLE), false);
});

test("a remembered view comes back, and an empty view forgets the page", () => {
  const storage = memoryStorage();
  rememberView(storage, A, "/nodes", { status: "offline", open: "node_1" }, 1);
  assert.deepEqual(recallView(storage, A, "/nodes"), { status: "offline" });
  rememberView(storage, A, "/nodes", { open: "node_2" }, 2);
  assert.equal(recallView(storage, A, "/nodes"), null);
  assert.equal(storage.data.get(VIEW_MEMORY_KEY), JSON.stringify({ owner: A, pages: {} }));
});

test("an unchanged view does not rewrite storage", () => {
  const storage = memoryStorage();
  let writes = 0;
  const counting: ViewStorage = { ...storage, setItem: (k, v) => { writes += 1; storage.setItem(k, v); } };
  rememberView(counting, A, "/upcoming", { status: "failed" }, 1);
  rememberView(counting, A, "/upcoming", { status: "failed" }, 2);
  rememberView(counting, A, "/upcoming", {}, 3);
  rememberView(counting, A, "/upcoming", {}, 4);
  assert.equal(writes, 2);
});

test("at most VIEW_MEMORY_MAX pages are kept, the least recently left dropped", () => {
  const storage = memoryStorage();
  for (let i = 0; i <= VIEW_MEMORY_MAX; i += 1) rememberView(storage, A, `/plugins/p/${i}`, { q: String(i) }, i);
  assert.equal(recallView(storage, A, "/plugins/p/0"), null);
  assert.deepEqual(recallView(storage, A, `/plugins/p/${VIEW_MEMORY_MAX}`), { q: String(VIEW_MEMORY_MAX) });
  forgetView(storage, A, `/plugins/p/${VIEW_MEMORY_MAX}`);
  assert.equal(recallView(storage, A, `/plugins/p/${VIEW_MEMORY_MAX}`), null);
});

test("broken, foreign or missing storage reads as nothing remembered", () => {
  const storage = memoryStorage();
  storage.data.set(VIEW_MEMORY_KEY, "not json");
  assert.equal(recallView(storage, A, "/nodes"), null);
  storage.data.set(VIEW_MEMORY_KEY, JSON.stringify({ owner: A, pages: { "/nodes": { q: "x", at: 1 }, "/upcoming": { q: { status: "failed", open: "t" }, at: 1 } } }));
  assert.equal(recallView(storage, A, "/nodes"), null);
  assert.deepEqual(recallView(storage, A, "/upcoming"), { status: "failed" });
  storage.data.set(VIEW_MEMORY_KEY, JSON.stringify({ "/upcoming": { q: { status: "failed" }, at: 1 } }));
  assert.equal(recallView(storage, A, "/upcoming"), null, "a map with no owner belongs to nobody");
  const denied = () => {
    throw new Error("denied");
  };
  const throwing: ViewStorage = { getItem: denied, setItem: denied, removeItem: denied };
  assert.equal(recallView(throwing, A, "/nodes"), null);
  assert.doesNotThrow(() => rememberView(throwing, A, "/nodes", { status: "offline" }));
  assert.doesNotThrow(() => setViewMemoryOwner(B, throwing));
  assert.equal(recallView(null, A, "/nodes"), null);
});

test("one principal never reads another's views, and signed out nothing is kept", () => {
  const storage = memoryStorage();
  rememberView(storage, A, "/plugins/latticenet.vpn-core/users", { q: "alice@example.com" }, 1);
  assert.equal(recallView(storage, B, "/plugins/latticenet.vpn-core/users"), null, "a stored map with another owner reads as nothing");
  assert.equal(recallView(storage, undefined, "/plugins/latticenet.vpn-core/users"), null);
  rememberView(storage, undefined, "/nodes", { q: "dmit" }, 2);
  assert.equal(JSON.parse(storage.data.get(VIEW_MEMORY_KEY)!).owner, A, "signed out, nothing is written");
  rememberView(storage, B, "/nodes", { q: "dmit" }, 3);
  assert.deepEqual(JSON.parse(storage.data.get(VIEW_MEMORY_KEY)!), { owner: B, pages: { "/nodes": { q: { q: "dmit" }, at: 3 } } }, "the next owner's first view replaces the last owner's map");
});

test("a change of principal clears the views; a refresh of the same principal keeps them", () => {
  const storage = memoryStorage();
  setViewMemoryOwner(A, storage);
  rememberView(storage, A, "/nodes", { q: "dmit" }, 1);
  setViewMemoryOwner(A, storage);
  assert.deepEqual(recallView(storage, A, "/nodes"), { q: "dmit" });
  setViewMemoryOwner(undefined, storage);
  assert.equal(storage.data.has(VIEW_MEMORY_KEY), false, "sign-out and expiry drop the stored views");
  rememberView(storage, A, "/nodes", { q: "dmit" }, 2);
  setViewMemoryOwner(B, storage);
  assert.equal(storage.data.has(VIEW_MEMORY_KEY), false, "another operator signing in on the tab drops them");
  storage.data.set(VIEW_MEMORY_KEY, JSON.stringify({ q: "not ours" }));
  setViewMemoryOwner(B, storage);
  assert.equal(storage.data.has(VIEW_MEMORY_KEY), false, "a map with no owner is cleared too");
});

test("only an in-app navigation from another page with no query of its own is restored", () => {
  const view = { status: "offline" };
  assert.deepEqual(viewToRestore({ path: "/nodes", query: {} }, inApp, view, CONSOLE), view);
  assert.equal(viewToRestore({ path: "/nodes", query: {} }, firstLoad, view, CONSOLE), null, "a typed or reloaded address is exact");
  assert.equal(viewToRestore({ path: "/nodes", query: { status: "online" } }, inApp, view, CONSOLE), null, "a link that says what it wants");
  assert.equal(viewToRestore({ path: "/nodes", query: { open: "node_1" } }, inApp, view, CONSOLE), null, "a link to an object");
  assert.equal(viewToRestore({ path: "/nodes", query: {} }, { path: "/nodes", matched: [{}] } as never, view, CONSOLE), null, "clearing a filter on the page");
  assert.equal(viewToRestore({ path: "/nodes", query: {} }, inApp, null, CONSOLE), null);
  assert.equal(viewToRestore({ path: "/", query: {} }, inApp, view, CONSOLE), null);
  assert.equal(viewToRestore({ path: "/approvals", query: {} }, { path: "/nodes", matched: [{}] } as never, view, CONSOLE), null, "a queue");
});

/**
 * The same rules on a real router: the guard pair installViewMemory adds,
 * the first navigation of a load, the restore redirect (once, no loop),
 * Reset view, and a change of principal. Only storage is a fake.
 */
function shell(owner: string | undefined = A) {
  const storage = memoryStorage();
  setViewMemoryOwner(owner, storage);
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      ...["/", "/nodes", "/approvals", "/tasks", "/upcoming"].map((path) => ({ path, component: {} })),
      { path: "/plugins/:plugin/:page(.*)", component: {} },
    ],
  });
  let navigations = 0;
  router.beforeEach(() => {
    navigations += 1;
  });
  installViewMemory(router, CONSOLE, () => storage);
  return { router, storage, at: () => router.currentRoute.value.fullPath, navigations: () => navigations };
}

/** Wait for the navigation `start` begins (resetRestoredView does not return its promise). */
function settled(router: ReturnType<typeof shell>["router"], start: () => void): Promise<void> {
  const done = new Promise<void>((resolve) => {
    const off = router.afterEach(() => {
      off();
      resolve();
    });
  });
  start();
  return done;
}

test("on a router, a bare link lands once on the view left, and the first navigation is exact", async () => {
  const { router, storage, at, navigations } = shell();
  rememberView(storage, A, "/nodes", { status: "offline" }, 1);
  await router.push("/nodes");
  assert.equal(at(), "/nodes", "the first navigation of a load is the address as typed");
  await router.push("/nodes?q=dmit");
  await router.push("/upcoming");
  const before = navigations();
  await router.push("/nodes");
  assert.equal(at(), "/nodes?q=dmit");
  assert.equal(navigations() - before, 2, "the asked navigation and one redirect, no loop");
  assert.deepEqual(restoredView.value, { path: "/nodes", query: { q: "dmit" } });
  await router.push("/upcoming");
  await router.push("/nodes?status=online");
  assert.equal(at(), "/nodes?status=online", "a link with its own query is exact");
  await router.push("/nodes");
  assert.equal(at(), "/nodes", "clearing the filter on the page clears it");
  await router.push("/upcoming");
  await router.push("/nodes");
  assert.equal(at(), "/nodes", "and the cleared view is what the page remembers");
});

test("on a router, the queues open bare, and Reset view forgets the restored view", async () => {
  const { router, storage, at } = shell();
  await router.push("/approvals?view=history&status=rejected");
  await router.push("/tasks?view=new");
  await router.push("/nodes");
  await router.push("/approvals");
  assert.equal(at(), "/approvals");
  await router.push("/tasks");
  assert.equal(at(), "/tasks");
  assert.equal(storage.data.get(VIEW_MEMORY_KEY), undefined, "a queue's view is never stored");

  await router.push("/upcoming?status=failed");
  await router.push("/nodes");
  await router.push("/upcoming");
  assert.equal(at(), "/upcoming?status=failed");
  await settled(router, () => resetRestoredView(router, () => storage));
  assert.equal(at(), "/upcoming");
  assert.equal(restoredView.value, null);
  assert.equal(recallView(storage, A, "/upcoming"), null);
});

test("on a router, the next operator on the tab lands on default views", async () => {
  const { router, storage, at } = shell(A);
  await router.push("/plugins/latticenet.vpn-core/users?q=alice%40example.com");
  await router.push("/nodes?q=dmit");
  await router.push("/upcoming");
  await router.push("/nodes");
  assert.equal(at(), "/nodes?q=dmit");
  setViewMemoryOwner(B, storage);
  assert.equal(restoredView.value, null, "the last operator's Reset view goes with them");
  await router.push("/upcoming");
  await router.push("/nodes");
  assert.equal(at(), "/nodes");
  await router.push("/plugins/latticenet.vpn-core/users");
  assert.equal(at(), "/plugins/latticenet.vpn-core/users");
  setViewMemoryOwner(undefined, storage);
  await router.push("/nodes?q=after-sign-out");
  await router.push("/upcoming");
  await router.push("/nodes");
  assert.equal(at(), "/nodes", "signed out, nothing is remembered");
});
