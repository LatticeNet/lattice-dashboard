import assert from "node:assert/strict";
import test from "node:test";

import {
  buildExtensionPluginGroups,
  consoleSectionForPlugin,
  extensionWorkspaceVisible,
  nextNavIndex,
  partitionPluginNav,
  placeHoistedItems,
  pluginIdOfRoute,
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

/* ------------------------------------------------------------------ */
/* Official plugins in console sections                                 */
/* ------------------------------------------------------------------ */

test("the four official plugins signed by latticenet move into console sections", () => {
  assert.equal(consoleSectionForPlugin("latticenet.vpn-core", "latticenet"), "vpn");
  assert.equal(consoleSectionForPlugin("latticenet.sub-store", "latticenet"), "vpn");
  assert.equal(consoleSectionForPlugin("latticenet.netguard", "latticenet"), "networking");
  assert.equal(consoleSectionForPlugin("latticenet.wireguard", "latticenet"), "networking");
  assert.equal(consoleSectionForPlugin("latticenet.vpn-core", " latticenet "), "vpn");
});

test("an official id under another publisher, or no publisher, stays in Extensions", () => {
  assert.equal(consoleSectionForPlugin("latticenet.vpn-core", "acme"), null);
  assert.equal(consoleSectionForPlugin("latticenet.vpn-core", ""), null);
  assert.equal(consoleSectionForPlugin("latticenet.vpn-core", undefined), null);
  // A latticenet plugin that is not one of the four keeps the Extensions home.
  assert.equal(consoleSectionForPlugin("latticenet.experimental", "latticenet"), null);
  assert.equal(consoleSectionForPlugin("example.leases", "latticenet"), null);
});

test("placed pages follow the official plugin order whatever the listing order; Extensions keeps its order", () => {
  // The server lists plugins by id, so Sub-Store and NetGuard come first.
  const entries = [
    { pluginId: "latticenet.netguard", publisher: "latticenet", route: "firewall" },
    { pluginId: "example.leases", publisher: "", route: "leases" },
    { pluginId: "latticenet.sub-store", publisher: "latticenet", route: "sub-store" },
    { pluginId: "latticenet.vpn-core", publisher: "latticenet", route: "lines" },
    { pluginId: "acme.dns", publisher: "acme", route: "zones" },
    { pluginId: "latticenet.vpn-core", publisher: "latticenet", route: "users" },
    { pluginId: "latticenet.wireguard", publisher: "latticenet", route: "networks" },
  ];
  const { hoisted, extensions } = partitionPluginNav(entries);
  assert.deepEqual(hoisted.map((h) => [h.sectionId, h.entry.route]), [
    ["vpn", "lines"],
    ["vpn", "users"],
    ["vpn", "sub-store"],
    ["networking", "firewall"],
    ["networking", "networks"],
  ]);
  assert.deepEqual(extensions.map((e) => e.route), ["leases", "zones"]);
});

const ORDER = ["overview", "fleet", "vpn", "operations", "networking", "platform", "settings"];
const section = (id: string, items: string[]) => ({ id, items });

test("hoisted pages follow a section's own destinations, and VPN is created after Fleet", () => {
  const placed = placeHoistedItems(
    [section("overview", ["overview"]), section("fleet", ["nodes"]), section("operations", ["tasks"]), section("networking", ["network-policy"])],
    [
      { sectionId: "vpn", item: "vpn-core:lines" },
      { sectionId: "networking", item: "netguard:firewall" },
      { sectionId: "vpn", item: "sub-store:sub-store" },
    ],
    (id) => (id === "vpn" ? section("vpn", []) : undefined),
    ORDER,
  );
  assert.deepEqual(placed.map((s) => s.id), ["overview", "fleet", "vpn", "operations", "networking"]);
  assert.deepEqual(placed.find((s) => s.id === "vpn")?.items, ["vpn-core:lines", "sub-store:sub-store"]);
  assert.deepEqual(placed.find((s) => s.id === "networking")?.items, ["network-policy", "netguard:firewall"]);
});

test("a principal who sees no Networking page but holds a plugin's scope gets the section in its place", () => {
  const placed = placeHoistedItems(
    [section("overview", ["overview"]), section("platform", ["platform-plugins"]), section("settings", ["settings-about"])],
    [{ sectionId: "networking", item: "wireguard:networks" }],
    (id) => (id === "networking" ? section("networking", []) : undefined),
    ORDER,
  );
  assert.deepEqual(placed.map((s) => s.id), ["overview", "networking", "platform", "settings"]);
});

test("placing does not mutate the sections it was given, and an unknown section is dropped", () => {
  const fleet = section("fleet", ["nodes"]);
  const placed = placeHoistedItems([fleet], [{ sectionId: "fleet", item: "x" }, { sectionId: "nowhere", item: "y" }], () => undefined, ORDER);
  assert.deepEqual(fleet.items, ["nodes"]);
  assert.deepEqual(placed.map((s) => [s.id, s.items]), [["fleet", ["nodes", "x"]]]);
});

test("an official plugin's routes belong to the console workspace; others stay in Extensions", () => {
  const consoleIds = new Set(["latticenet.vpn-core", "latticenet.netguard"]);
  assert.equal(pluginIdOfRoute("/plugins/latticenet.vpn-core/users"), "latticenet.vpn-core");
  assert.equal(pluginIdOfRoute("/plugins/latticenet.vpn-core"), "latticenet.vpn-core");
  assert.equal(pluginIdOfRoute("/nodes"), null);
  assert.equal(workspaceForRoute("/plugins/latticenet.vpn-core/users", consoleIds), "console");
  assert.equal(workspaceForRoute("/plugins/latticenet.vpn-core/users/deep/path", consoleIds), "console");
  assert.equal(workspaceForRoute("/plugins/example.leases/leases", consoleIds), "extensions");
  assert.equal(workspaceForRoute("/plugins", consoleIds), "extensions");
  // A look-alike id is a different plugin.
  assert.equal(workspaceForRoute("/plugins/latticenet.vpn-core-evil/users", consoleIds), "extensions");
});

test("with only official plugins installed the Extensions switch is gone, except on a third-party route", () => {
  const consoleIds = new Set(["latticenet.vpn-core"]);
  assert.equal(extensionWorkspaceVisible(0, "/plugins/latticenet.vpn-core/lines", consoleIds), false);
  assert.equal(extensionWorkspaceVisible(0, "/plugins/example.removed/view", consoleIds), true);
});
