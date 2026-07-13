import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

test("the dashboard host contains no plugin-owned pages or API fallbacks", () => {
  for (const relative of [
    "../../networking/GuardView.vue",
    "../../networking/WireGuardView.vue",
    "../../proxy/DiscoveredView.vue",
    "../../proxy/InboundsView.vue",
    "../../proxy/LinesView.vue",
    "../../proxy/ProfilesView.vue",
    "../../proxy/SubStoreView.vue",
    "../../proxy/SubscriptionsView.vue",
    "../../proxy/UsageView.vue",
    "../../proxy/UsersView.vue",
    "../../proxy/VpnCoreProfilesView.vue",
    "../../proxy/VpnCoreSubscriptionsView.vue",
    "../../proxy/VpnCoreUsageView.vue",
    "../../proxy/VpnUsersView.vue",
  ]) {
    assert.equal(existsSync(new URL(relative, import.meta.url)), false, `${relative} must be plugin-owned`);
  }

  for (const [name, contents] of [
    ["plugin host", source("../PluginView.vue")],
    ["router", source("../../../router/index.ts")],
    ["API client", source("../../../lib/api/index.ts")],
    ["getting started", source("../../../components/common/GettingStarted.vue")],
    ["node detail", source("../../fleet/NodeDetailView.vue")],
    ["nodes", source("../../fleet/NodesView.vue")],
    ["inventory", source("../../fleet/InventoryView.vue")],
    ["map", source("../../fleet/MapView.vue")],
    ["tasks", source("../../operations/TasksView.vue")],
  ] as const) {
    assert.equal(contents.includes("SubStoreView"), false, `${name} imports the removed native page`);
    assert.equal(contents.includes("proxy.substore"), false, `${name} retains the native component key`);
    assert.equal(contents.includes("/api/substore/"), false, `${name} retains the native API fallback`);
    assert.equal(contents.includes("latticenet.vpn-core"), false, `${name} hard-codes vpn-core`);
    assert.equal(contents.includes("/api/proxy/"), false, `${name} retains a vpn-core REST fallback`);
    assert.equal(contents.includes("/api/netguard/"), false, `${name} retains a NetGuard REST fallback`);
    assert.equal(contents.includes("/api/network/wireguard"), false, `${name} retains a WireGuard REST fallback`);
  }

  const host = source("../PluginView.vue");
  assert.doesNotMatch(host, /BUILTIN_COMPONENTS|defineAsyncComponent|component_key/);

  const router = source("../../../router/index.ts");
  assert.doesNotMatch(router, /network\/guard|network\/wireguard|proxy\//);
});

test("the plugin iframe keeps the strict opaque-origin boundary", () => {
  const host = source("../PluginFrameHost.vue");
  assert.match(host, /sandbox="allow-scripts"/);
  assert.match(host, /referrerpolicy="no-referrer"/);
  assert.doesNotMatch(host, /allow-same-origin/);
  assert.match(host, /nonce\.value = createNonce\(\)/);
  assert.match(host, /session\?\.dispose\(\)/);
  assert.match(host, /ready: markReady/);
  assert.match(host, /startHandshakeTimer\(\)/);
  assert.doesNotMatch(host, /onLoad[\s\S]{0,500}loaded\.value = true/);

  const view = source("../PluginView.vue");
  assert.match(view, /callableInterfaceFingerprint/);
  assert.match(view, /interfaceMethodScopes/);
});
