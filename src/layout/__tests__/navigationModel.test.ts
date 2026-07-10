import assert from "node:assert/strict";
import test from "node:test";

import {
  buildExtensionSections,
  extensionWorkspaceVisible,
  workspaceForRoute,
} from "../navigationModel.ts";

test("plugin routes select Extensions and native routes select Console", () => {
  assert.equal(workspaceForRoute("/plugins/latticenet.netguard/netguard"), "extensions");
  assert.equal(workspaceForRoute("/plugins"), "extensions");
  assert.equal(workspaceForRoute("/map"), "console");
  assert.equal(workspaceForRoute("/network/policy"), "console");
});

test("Extensions stays absent from a pure base console but remains recoverable on a stale plugin route", () => {
  assert.equal(extensionWorkspaceVisible(0, "/"), false);
  assert.equal(extensionWorkspaceVisible(0, "/map"), false);
  assert.equal(extensionWorkspaceVisible(0, "/plugins/latticenet.removed/view"), true);
  assert.equal(extensionWorkspaceVisible(1, "/"), true);
});

test("extension sections flatten multiple plugin packages into task-oriented manifest sections", () => {
  const sections = buildExtensionSections([
    {
      pluginId: "latticenet.vpn-core",
      section: "vpn-manage",
      sectionTitle: "VPN Manage",
      title: "Lines",
      route: "lines",
      to: "/plugins/latticenet.vpn-core/lines",
    },
    {
      pluginId: "latticenet.vpn-core",
      section: "vpn-manage",
      sectionTitle: "VPN Manage",
      title: "Users",
      route: "users",
      to: "/plugins/latticenet.vpn-core/users",
    },
    {
      pluginId: "latticenet.sub-store",
      section: "vpn-manage",
      sectionTitle: "VPN Manage",
      title: "Sub-Store",
      route: "sub-store",
      to: "/plugins/latticenet.sub-store/sub-store",
    },
    {
      pluginId: "latticenet.netguard",
      section: "network-security",
      sectionTitle: "Network Plugins",
      title: "NetGuard",
      route: "netguard",
      to: "/plugins/latticenet.netguard/netguard",
    },
    {
      pluginId: "latticenet.wireguard",
      section: "network-security",
      sectionTitle: "Network Plugins",
      title: "WireGuard",
      route: "wireguard",
      to: "/plugins/latticenet.wireguard/wireguard",
    },
  ]);

  assert.deepEqual(
    sections.map((section) => ({
      id: section.id,
      title: section.title,
      items: section.items.map((item) => `${item.pluginId}:${item.title}`),
    })),
    [
      {
        id: "vpn-manage",
        title: "VPN Manage",
        items: [
          "latticenet.vpn-core:Lines",
          "latticenet.vpn-core:Users",
          "latticenet.sub-store:Sub-Store",
        ],
      },
      {
        id: "network-security",
        title: "Network Plugins",
        items: [
          "latticenet.netguard:NetGuard",
          "latticenet.wireguard:WireGuard",
        ],
      },
    ],
  );
});

test("section and item order remain the signed manifest contribution order", () => {
  const sections = buildExtensionSections([
    { pluginId: "b", section: "z-last", sectionTitle: "Z", title: "Second", route: "second", to: "/second" },
    { pluginId: "a", section: "a-first", sectionTitle: "A", title: "First", route: "first", to: "/first" },
    { pluginId: "c", section: "z-last", sectionTitle: "Ignored conflicting title", title: "Third", route: "third", to: "/third" },
  ]);

  assert.deepEqual(sections.map((section) => section.id), ["z-last", "a-first"]);
  assert.deepEqual(sections[0]?.items.map((item) => item.title), ["Second", "Third"]);
  assert.equal(sections[0]?.title, "Z");
});

test("blank section titles fall back to a readable section label", () => {
  const [section] = buildExtensionSections([
    { pluginId: "x", section: "network-security", sectionTitle: "  ", title: "NetGuard", route: "netguard", to: "/netguard" },
  ]);

  assert.equal(section?.title, "Network Security");
});
