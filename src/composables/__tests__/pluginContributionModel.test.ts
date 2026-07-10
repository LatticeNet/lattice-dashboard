import assert from "node:assert/strict";
import test from "node:test";

import {
  createLatestRequestEpoch,
  pluginCacheIdentity,
  withoutPlugin,
} from "../pluginContributionModel.ts";

test("a known deactivation removes only the target plugin from the last-good contribution cache", () => {
  const current = [
    { id: "latticenet.vpn-core", status: "active" },
    { id: "latticenet.netguard", status: "active" },
    { id: "latticenet.wireguard", status: "active" },
  ];

  const next = withoutPlugin(current, "latticenet.netguard");

  assert.deepEqual(next.map((plugin) => plugin.id), ["latticenet.vpn-core", "latticenet.wireguard"]);
  assert.equal(current.length, 3, "the last-good array must not be mutated in place");
});

test("older contribution responses cannot overwrite a forced refresh or lifecycle invalidation", () => {
  const epoch = createLatestRequestEpoch();
  const firstRequest = epoch.next();
  const forcedRefresh = epoch.next();

  assert.equal(epoch.isCurrent(firstRequest), false);
  assert.equal(epoch.isCurrent(forcedRefresh), true);

  epoch.invalidate();
  assert.equal(epoch.isCurrent(forcedRefresh), false);
});

test("plugin cache identity changes across principals or permission boundaries", () => {
  const admin = pluginCacheIdentity("operator-a", ["proxy:read", "node:read"], ["node-b", "node-a"]);
  const sameAdmin = pluginCacheIdentity("operator-a", ["node:read", "proxy:read"], ["node-a", "node-b"]);
  const restricted = pluginCacheIdentity("operator-a", ["node:read"], ["node-a", "node-b"]);
  const otherOperator = pluginCacheIdentity("operator-b", ["proxy:read", "node:read"], ["node-a", "node-b"]);

  assert.equal(admin, sameAdmin);
  assert.notEqual(admin, restricted);
  assert.notEqual(admin, otherOperator);
});
