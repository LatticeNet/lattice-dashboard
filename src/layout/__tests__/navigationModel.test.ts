import assert from "node:assert/strict";
import test from "node:test";

import {
  buildExtensionPluginGroups,
  extensionWorkspaceVisible,
  nextNavIndex,
  reconcileCollapsedSections,
  toggleCollapsedSection,
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

test("extension navigation groups destinations by provider instead of shared manifest sections", () => {
  const groups = buildExtensionPluginGroups([
    {
      pluginId: "latticenet.vpn-core",
      pluginName: "vpn-core (sing-box)",
      section: "extensions",
      title: "Lines",
      route: "lines",
      to: "/plugins/latticenet.vpn-core/lines",
    },
    {
      pluginId: "latticenet.vpn-core",
      pluginName: "vpn-core (sing-box)",
      section: "operations",
      title: "Users",
      route: "users",
      to: "/plugins/latticenet.vpn-core/users",
    },
    {
      pluginId: "latticenet.sub-store",
      pluginName: "Sub-Store companion",
      section: "extensions",
      title: "Sub-Store",
      route: "sub-store",
      to: "/plugins/latticenet.sub-store/sub-store",
    },
    {
      pluginId: "latticenet.netguard",
      pluginName: "NetGuard (nftables security groups)",
      section: "extensions",
      title: "Firewall",
      route: "firewall",
      to: "/plugins/latticenet.netguard/firewall",
    },
    {
      pluginId: "latticenet.wireguard",
      pluginName: "WireGuard (VPN networks)",
      section: "extensions",
      title: "Networks",
      route: "networks",
      to: "/plugins/latticenet.wireguard/networks",
    },
  ]);

  assert.deepEqual(
    groups.map((group) => ({
      id: group.id,
      title: group.title,
      items: group.items.map((item) => item.title),
    })),
    [
      {
        id: "latticenet.vpn-core",
        title: "vpn-core (sing-box)",
        items: ["Lines", "Users"],
      },
      {
        id: "latticenet.sub-store",
        title: "Sub-Store companion",
        items: ["Sub-Store"],
      },
      {
        id: "latticenet.netguard",
        title: "NetGuard (nftables security groups)",
        items: ["Firewall"],
      },
      {
        id: "latticenet.wireguard",
        title: "WireGuard (VPN networks)",
        items: ["Networks"],
      },
    ],
  );
});

test("plugin and destination order remain first-seen contribution order", () => {
  const groups = buildExtensionPluginGroups([
    { pluginId: "b", pluginName: "Second plugin", section: "same", title: "Second", route: "second", to: "/second" },
    { pluginId: "a", pluginName: "First plugin", section: "same", title: "First", route: "first", to: "/first" },
    { pluginId: "b", pluginName: "Ignored conflicting name", section: "other", title: "Third", route: "third", to: "/third" },
  ]);

  assert.deepEqual(groups.map((group) => group.id), ["b", "a"]);
  assert.deepEqual(groups[0]?.items.map((item) => item.title), ["Second", "Third"]);
  assert.equal(groups[0]?.title, "Second plugin");
});

test("blank plugin names fall back to the stable plugin id", () => {
  const [group] = buildExtensionPluginGroups([
    { pluginId: "latticenet.netguard", pluginName: "  ", section: "extensions", title: "Firewall", route: "firewall", to: "/firewall" },
  ]);

  assert.equal(group?.title, "latticenet.netguard");
});

test("a fresh console has every section open, because nothing has been shut yet", () => {
  const collapsed = reconcileCollapsedSections(new Set(), ["fleet", "operations", "networking"]);

  assert.deepEqual([...collapsed], []);
});

test("shutting one section leaves its siblings alone", () => {
  const collapsed = toggleCollapsedSection(new Set(["fleet"]), "operations");

  assert.deepEqual([...collapsed].sort(), ["fleet", "operations"]);
  assert.deepEqual([...toggleCollapsedSection(collapsed, "fleet")], ["operations"]);
});

test("the section owning the current route is reopened, so the active page is never hidden", () => {
  assert.deepEqual(
    [...reconcileCollapsedSections(new Set(["fleet", "operations"]), ["fleet", "operations"], "fleet")],
    ["operations"],
  );
});

test("a section that no longer exists stops being remembered", () => {
  assert.deepEqual(
    [...reconcileCollapsedSections(new Set(["latticenet.vpn-core", "removed-plugin"]), ["latticenet.vpn-core"])],
    ["latticenet.vpn-core"],
  );
});

test("arrow keys wrap through the destination list and Home/End jump to its ends", () => {
  assert.equal(nextNavIndex(5, 0, "ArrowDown"), 1);
  assert.equal(nextNavIndex(5, 4, "ArrowDown"), 0);
  assert.equal(nextNavIndex(5, 0, "ArrowUp"), 4);
  assert.equal(nextNavIndex(5, 2, "Home"), 0);
  assert.equal(nextNavIndex(5, 2, "End"), 4);
});

test("keys the navigation does not own, and an empty list, are left to the browser", () => {
  assert.equal(nextNavIndex(5, 2, "Tab"), -1);
  assert.equal(nextNavIndex(5, 2, "a"), -1);
  assert.equal(nextNavIndex(0, -1, "ArrowDown"), -1);
});

test("focus starts at the top when nothing in the list is focused yet", () => {
  assert.equal(nextNavIndex(3, -1, "ArrowDown"), 1);
  assert.equal(nextNavIndex(3, -1, "ArrowUp"), 2);
});
