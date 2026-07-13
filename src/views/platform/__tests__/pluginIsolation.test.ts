import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

test("the dashboard host has no built-in Sub-Store page or API fallback", () => {
  assert.equal(existsSync(new URL("../../proxy/SubStoreView.vue", import.meta.url)), false);
  for (const [name, contents] of [
    ["plugin host", source("../PluginView.vue")],
    ["router", source("../../../router/index.ts")],
    ["API client", source("../../../lib/api/index.ts")],
  ] as const) {
    assert.equal(contents.includes("SubStoreView"), false, `${name} imports the removed native page`);
    assert.equal(contents.includes("proxy.substore"), false, `${name} retains the native component key`);
    assert.equal(contents.includes("/api/substore/"), false, `${name} retains the native API fallback`);
  }
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
