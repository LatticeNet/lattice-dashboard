import assert from "node:assert/strict";
import test from "node:test";

import { breadcrumbTrail, resolvePluginBreadcrumb } from "../headerModel.ts";

test("plugin breadcrumbs use the plugin display name as the section label", () => {
  assert.deepEqual(
    resolvePluginBreadcrumb({
      pluginId: "latticenet.netguard",
      pluginDisplayName: "NetGuard Firewall Controls",
      viewTitle: "Rules",
      viewRoute: "rules",
    }),
    {
      sectionLabel: "NetGuard Firewall Controls",
      title: "Rules",
    },
  );
});

test("plugin breadcrumb fallbacks stay plugin-owned when display name or tab title is missing", () => {
  assert.deepEqual(
    resolvePluginBreadcrumb({
      pluginId: "latticenet.netguard",
      pluginDisplayName: " ",
      viewTitle: "",
      viewRoute: "rules",
    }),
    {
      sectionLabel: "latticenet.netguard",
      title: "rules",
    },
  );
});


const SECTIONS = [
  { id: "overview", items: [{ name: "overview" }] },
  { id: "fleet", items: [{ name: "nodes", scopes: ["node:read"] }, { name: "groups", scopes: ["group:read"] }, { name: "monitoring", scopes: ["monitor:read"] }] },
  { id: "settings", items: [{ name: "settings-security" }, { name: "settings-users", scopes: ["user:admin"] }] },
];

test("a collection page reads Section / Page, and the section links to its first page the operator can open", () => {
  const all = () => true;
  assert.deepEqual(breadcrumbTrail("groups", SECTIONS, all), [
    { kind: "section", id: "fleet", to: { name: "nodes" } },
    { kind: "page", name: "groups" },
  ]);
  const noNodes = (item: { scopes?: readonly string[] }) => !item.scopes?.includes("node:read");
  assert.deepEqual(breadcrumbTrail("groups", SECTIONS, noNodes)[0], { kind: "section", id: "fleet", to: { name: "groups" } });
});

test("an object page adds its collection as a link", () => {
  assert.deepEqual(breadcrumbTrail("node-detail", SECTIONS, () => true), [
    { kind: "section", id: "fleet", to: { name: "nodes" } },
    { kind: "collection", name: "nodes", to: { name: "nodes" } },
    { kind: "page", name: "node-detail" },
  ]);
});

test("home has no section crumb, and a route no section owns is the page alone", () => {
  assert.deepEqual(breadcrumbTrail("overview", SECTIONS, () => true), [{ kind: "page", name: "overview" }]);
  assert.deepEqual(breadcrumbTrail("login", SECTIONS, () => true), [{ kind: "page", name: "login" }]);
  assert.deepEqual(breadcrumbTrail("groups", SECTIONS, () => false)[0], { kind: "section", id: "fleet", to: undefined });
});
