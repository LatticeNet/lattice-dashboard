import assert from "node:assert/strict";
import test from "node:test";

import {
  VIEW_MEMORY_KEY,
  VIEW_MEMORY_MAX,
  forgetView,
  isRememberedPath,
  recallView,
  rememberView,
  viewQuery,
  viewToRestore,
  type ViewStorage,
} from "../viewMemory.ts";

function memoryStorage(): ViewStorage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (key) => data.get(key) ?? null, setItem: (key, value) => void data.set(key, value) };
}

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

test("console pages and plugin pages are remembered; Overview and detail pages are not", () => {
  assert.equal(isRememberedPath("/nodes", CONSOLE), true);
  assert.equal(isRememberedPath("/plugins/latticenet.vpn-core/users", CONSOLE), true);
  assert.equal(isRememberedPath("/", CONSOLE), false);
  assert.equal(isRememberedPath("/nodes/node_1", CONSOLE), false);
  assert.equal(isRememberedPath("/plugins", CONSOLE), false);
  assert.equal(isRememberedPath("/plugins/latticenet.vpn-core", CONSOLE), false);
});

test("a remembered view comes back, and an empty view forgets the page", () => {
  const storage = memoryStorage();
  rememberView(storage, "/nodes", { status: "offline", open: "node_1" }, 1);
  assert.deepEqual(recallView(storage, "/nodes"), { status: "offline" });
  rememberView(storage, "/nodes", { open: "node_2" }, 2);
  assert.equal(recallView(storage, "/nodes"), null);
  assert.equal(storage.data.get(VIEW_MEMORY_KEY), "{}");
});

test("an unchanged view does not rewrite storage", () => {
  const storage = memoryStorage();
  let writes = 0;
  const counting: ViewStorage = { getItem: storage.getItem, setItem: (k, v) => { writes += 1; storage.setItem(k, v); } };
  rememberView(counting, "/tasks", { status: "failed" }, 1);
  rememberView(counting, "/tasks", { status: "failed" }, 2);
  rememberView(counting, "/tasks", {}, 3);
  rememberView(counting, "/tasks", {}, 4);
  assert.equal(writes, 2);
});

test("at most VIEW_MEMORY_MAX pages are kept, the least recently left dropped", () => {
  const storage = memoryStorage();
  for (let i = 0; i <= VIEW_MEMORY_MAX; i += 1) rememberView(storage, `/plugins/p/${i}`, { q: String(i) }, i);
  assert.equal(recallView(storage, "/plugins/p/0"), null);
  assert.deepEqual(recallView(storage, `/plugins/p/${VIEW_MEMORY_MAX}`), { q: String(VIEW_MEMORY_MAX) });
  forgetView(storage, `/plugins/p/${VIEW_MEMORY_MAX}`);
  assert.equal(recallView(storage, `/plugins/p/${VIEW_MEMORY_MAX}`), null);
});

test("broken, foreign or missing storage reads as nothing remembered", () => {
  const storage = memoryStorage();
  storage.data.set(VIEW_MEMORY_KEY, "not json");
  assert.equal(recallView(storage, "/nodes"), null);
  storage.data.set(VIEW_MEMORY_KEY, JSON.stringify({ "/nodes": { q: "x", at: 1 }, "/tasks": { q: { status: "failed", open: "t" }, at: 1 } }));
  assert.equal(recallView(storage, "/nodes"), null);
  assert.deepEqual(recallView(storage, "/tasks"), { status: "failed" });
  const throwing: ViewStorage = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
  assert.equal(recallView(throwing, "/nodes"), null);
  assert.doesNotThrow(() => rememberView(throwing, "/nodes", { status: "offline" }));
  assert.equal(recallView(null, "/nodes"), null);
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
});
