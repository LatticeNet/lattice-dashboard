import assert from "node:assert/strict";
import test from "node:test";

import {
  clearUnavailableVpnExpression,
  expressionNeedsVpnLines,
  filterMapCapabilities,
  removeUnavailableVpnCapability,
  vpnMapFeatureAvailable,
} from "../mapPluginModel.ts";

test("the vpn-lines capability is invisible when vpn-core is inactive", () => {
  assert.deepEqual(filterMapCapabilities(["exec", "vpn-lines", "terminal"], false), ["exec", "terminal"]);
  assert.deepEqual(filterMapCapabilities(["exec", "vpn-lines", "terminal"], true), ["exec", "vpn-lines", "terminal"]);
});

test("deactivation removes stale vpn-lines selections without touching base filters", () => {
  assert.deepEqual(removeUnavailableVpnCapability(["exec", "vpn-lines", "root"], false), ["exec", "root"]);
  assert.deepEqual(removeUnavailableVpnCapability(["vpn-lines"], true), ["vpn-lines"]);
});

test("vpn expression tokens request plugin data only while vpn-core is active", () => {
  for (const expression of ["vpn", "vpn-core & online", "vpn_lines", "line-recorded", "lines | root"]) {
    assert.equal(expressionNeedsVpnLines(expression, false), false, expression);
    assert.equal(expressionNeedsVpnLines(expression, true), true, expression);
  }
  assert.equal(expressionNeedsVpnLines("linux & root", true), false);
});

test("deactivation clears expressions that would otherwise keep affecting the base Map", () => {
  assert.equal(clearUnavailableVpnExpression("root & vpn-lines", false), "");
  assert.equal(clearUnavailableVpnExpression("vpn-core | online", false), "");
  assert.equal(clearUnavailableVpnExpression("linux & root", false), "linux & root");
  assert.equal(clearUnavailableVpnExpression("root & vpn-lines", true), "root & vpn-lines");
});

test("the Map augmentation requires lifecycle, declared contribution visibility, and exact RBAC scope", () => {
  assert.equal(vpnMapFeatureAvailable(true, true, true), true);
  assert.equal(vpnMapFeatureAvailable(false, true, true), false);
  assert.equal(vpnMapFeatureAvailable(true, false, true), false);
  assert.equal(vpnMapFeatureAvailable(true, true, false), false);
});
