import assert from "node:assert/strict";
import test from "node:test";

import { resolvePluginBreadcrumb } from "../headerModel.ts";

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
