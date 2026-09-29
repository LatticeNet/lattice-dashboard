// Plugin page state in the console address (CONTRACTS, bridge v1 additive).
//
// The plugin writes its page state into the console route's query with a
// history replace. That is only safe if a query-only change leaves the plugin
// frame exactly where it is: same element, same document, same bridge session,
// no second init. Nothing in the bridge model can see that; it is decided by
// how three components are keyed and what the frame URL is computed from. The
// dashboard runs no component tests, so this reads the source, in the style of
// the other plugin audits, and goes red the day one of those links changes.
//
// Each assertion names the one line it depends on. If a refactor moves it, the
// failure message says what the new code must still guarantee.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

test("a query-only route change keeps the same plugin view", () => {
  const layout = source("../../../layout/AppLayout.vue");
  // The routed view is keyed by the path, never by the full path with the
  // query: a key that included the query would remount PluginView on every
  // page-state write, and the frame with it.
  assert.match(layout, /<component :is="Component" :key="route\.path"/, "AppLayout must key the routed view by route.path");
  assert.doesNotMatch(layout, /:key="route\.fullPath"/, "a fullPath key remounts the plugin view on every query change");
});

test("a query-only route change keeps the same plugin frame", () => {
  const view = source("../PluginView.vue");
  const key = view.match(/<PluginFrameHost[\s\S]*?:key="([^"]+)"/)?.[1] ?? "";
  assert.ok(key, "PluginView no longer keys PluginFrameHost; re-read this audit");
  // The frame host is rebuilt when the plugin, its assets, its route or its
  // callable interfaces change, and for nothing the query says.
  assert.match(key, /viewRoute/, "the frame key should still follow the plugin route");
  assert.doesNotMatch(key, /query|fullPath|route\.hash/, "the frame key must not depend on the query");

  // viewRoute is the route params, not the query.
  assert.match(view, /const viewRoute = computed\(\(\) => \{\s*const raw = route\.params\.route;/, "viewRoute must come from the path params");
});

test("the frame URL and the iframe element do not follow the query", () => {
  const host = source("../PluginFrameHost.vue");
  const frameSource = host.match(/const frameSource = computed\(\(\) =>([\s\S]*?)\n\s*: undefined\);/)?.[1] ?? "";
  assert.ok(frameSource, "PluginFrameHost no longer computes frameSource; re-read this audit");
  assert.doesNotMatch(frameSource, /route\./, "the frame URL must not be computed from the route");
  // resolvePluginFrameURL builds a content-addressed URL with no query.
  assert.match(frameSource, /resolvePluginFrameURL\(/);

  // The iframe is re-created only on a frame epoch (retry, document rotation).
  assert.match(host, /<iframe[\s\S]*?:key="frameEpoch"/, "the iframe must be keyed by frameEpoch only");
  // Nothing in the host watches the route; the query is read once, at ready,
  // for the init message.
  assert.doesNotMatch(host, /watch\(\s*\(\)\s*=>\s*route/, "the frame host must not react to route changes");
  assert.doesNotMatch(host, /watch\(\s*route\b/, "the frame host must not react to route changes");
  assert.match(host, /pageState: \(\) => route\.query/, "init reads the query when the plugin says ready");
  // A page-state write replaces the query on the same path; it never pushes.
  assert.match(host, /router\.replace\(next\)/, "page state is written with a history replace");
  assert.doesNotMatch(host, /router\.push\(next\)/);
});

test("init is sent only in answer to the plugin's ready", () => {
  const model = source("../pluginBridgeModel.ts");
  const inits = model.match(/type: "lattice\.host\.init",/g) ?? [];
  assert.equal(inits.length, 1, "exactly one place posts lattice.host.init");
  assert.match(
    model,
    /case "lattice\.plugin\.ready":\s*this\.options\.post\(\{\s*type: "lattice\.host\.init",/,
    "init is posted from the ready case and nowhere else",
  );
});
