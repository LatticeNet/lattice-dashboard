import assert from "node:assert/strict";
import { test } from "node:test";

import { mergePluginRows, nextLifecycleStates, pluginHealth, pluginPagePath, pluginPages } from "../pluginsModel.ts";

const ui = { nav: [{ route: "firewall", title: "NetGuard" }], views: [{ route: "firewall", title: "NetGuard" }, { route: "audit", title: "Audit" }] };

test("a plugin's pages are its nav entries first, then views no entry points at, each once", () => {
  assert.deepEqual(pluginPages({ id: "latticenet.netguard", ui }), [
    { route: "firewall", title: "NetGuard", to: "/plugins/latticenet.netguard/firewall" },
    { route: "audit", title: "Audit", to: "/plugins/latticenet.netguard/audit" },
  ]);
  assert.equal(pluginPagePath({ id: "x" }), null, "a plugin without ui contributes no page");
});

test("one row per plugin, from whichever reads the session holds", () => {
  const lifecycle = [
    {
      id: "latticenet.netguard",
      name: "NetGuard",
      version: "0.1.0",
      status: "active",
      available: true,
      artifact_sha256: "3f9a",
      runtime: { state: "armed" },
      verified_at: "2026-09-01T00:00:00Z",
      activated_at: "2026-09-02T00:00:00Z",
      installed_at: "2026-09-01T12:00:00Z",
    },
  ];
  const contributions = [{ id: "latticenet.netguard", name: "NetGuard", ui }, { id: "latticenet.vpn-core", name: "vpn-core", active: true, ui: { nav: [{ route: "lines", title: "Lines" }] } }];
  const rows = mergePluginRows(undefined, lifecycle, contributions);
  assert.deepEqual(rows.map((row) => row.id), ["latticenet.netguard", "latticenet.vpn-core"]);
  const [netguard, vpn] = rows;
  assert.equal(netguard!.lifecycleRead, true);
  assert.equal(netguard!.artifactSha256, "3f9a");
  assert.deepEqual(netguard!.transitions.map((entry) => entry.key), ["verified", "installed", "activated"], "transitions in time order");
  assert.equal(netguard!.pages.length, 2, "pages come from the contributions read");
  assert.equal(vpn!.lifecycleRead, false);
  assert.equal(vpn!.status, "active");
  assert.equal(vpn!.pages[0]!.to, "/plugins/latticenet.vpn-core/lines");
});

test("health: a failed runtime or a missing bundle is red, disabled is a choice, unread is never running", () => {
  assert.equal(pluginHealth({ status: "active", runtime: { state: "armed" }, available: true, lifecycleRead: true }), "running");
  assert.equal(pluginHealth({ status: "active", runtime: { state: "failed" }, available: true, lifecycleRead: true }), "failed");
  assert.equal(pluginHealth({ status: "active", runtime: { state: "stopped" }, available: true, lifecycleRead: true }), "stopped");
  assert.equal(pluginHealth({ status: "active", runtime: { state: "armed" }, available: false, lifecycleRead: true }), "missing");
  assert.equal(pluginHealth({ status: "disabled", runtime: { state: "stopped" }, available: true, lifecycleRead: true }), "disabled");
  assert.equal(pluginHealth({ status: "installed", lifecycleRead: true, available: true }), "pending");
  assert.equal(pluginHealth({ status: "active", lifecycleRead: false }), "unknown");
});

test("lifecycle moves forward to active, and active and disabled swap", () => {
  assert.deepEqual(nextLifecycleStates("verified"), ["installed"]);
  assert.deepEqual(nextLifecycleStates("installed"), ["active"]);
  assert.deepEqual(nextLifecycleStates("active"), ["disabled"]);
  assert.deepEqual(nextLifecycleStates("disabled"), ["active"]);
  assert.deepEqual(nextLifecycleStates(undefined), []);
});
