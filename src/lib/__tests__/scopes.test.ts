import assert from "node:assert/strict";
import test from "node:test";

import { allowsRuntimeScope, allowsScopeGrant } from "../scopes.ts";

test("legacy proxy grants open migrated vpn-core and sub-store surfaces", () => {
  assert.equal(allowsRuntimeScope(["proxy:read"], "vpncore:read"), true);
  assert.equal(allowsRuntimeScope(["proxy:read"], "substore:read"), true);
  assert.equal(allowsRuntimeScope(["proxy:read"], "vpncore:admin"), false);
  assert.equal(allowsRuntimeScope(["proxy:read"], "substore:admin"), false);
  assert.equal(allowsRuntimeScope(["proxy:admin"], "vpncore:admin"), true);
  assert.equal(allowsRuntimeScope(["proxy:admin"], "substore:admin"), true);
});

test("vpn-core grants open native proxy surfaces without crossing into sub-store", () => {
  assert.equal(allowsRuntimeScope(["vpncore:read"], "proxy:read"), true);
  assert.equal(allowsRuntimeScope(["vpncore:read"], "proxy:admin"), false);
  assert.equal(allowsRuntimeScope(["vpncore:read"], "substore:read"), false);
  assert.equal(allowsRuntimeScope(["substore:admin"], "proxy:admin"), false);
  assert.equal(allowsRuntimeScope(["substore:admin"], "vpncore:admin"), false);
});

test("runtime wildcards preserve compatibility direction and privilege strength", () => {
  for (const required of ["vpncore:read", "vpncore:admin", "substore:read", "substore:admin"]) {
    assert.equal(allowsRuntimeScope(["proxy:*"], required), true, `proxy:* should allow ${required}`);
  }
  for (const required of ["proxy:read", "proxy:admin", "vpncore:read", "vpncore:admin"]) {
    assert.equal(allowsRuntimeScope(["vpncore:*"], required), true, `vpncore:* should allow ${required}`);
  }
  assert.equal(allowsRuntimeScope(["vpncore:*"], "substore:read"), false);
  assert.equal(allowsRuntimeScope(["*"], "substore:admin"), true);
  assert.equal(allowsRuntimeScope(["proxy:read"], "vpncore:admin"), false);
});

test("legacy proxy grants may delegate equal-strength canonical scopes", () => {
  assert.equal(allowsScopeGrant(["proxy:read"], "vpncore:read"), true);
  assert.equal(allowsScopeGrant(["proxy:read"], "substore:read"), true);
  assert.equal(allowsScopeGrant(["proxy:read"], "vpncore:admin"), false);
  assert.equal(allowsScopeGrant(["proxy:admin"], "vpncore:admin"), true);
  assert.equal(allowsScopeGrant(["proxy:admin"], "substore:admin"), true);
  assert.equal(allowsScopeGrant(["proxy:admin"], "substore:read"), false);
  assert.equal(allowsScopeGrant(["proxy:*"], "vpncore:read"), true);
  assert.equal(allowsScopeGrant(["proxy:*"], "substore:admin"), true);
  assert.equal(allowsScopeGrant(["proxy:*"], "vpncore:*"), true);
  assert.equal(allowsScopeGrant(["proxy:*"], "substore:*"), true);
});

test("canonical delegation cannot launder scopes or accept unknown candidates", () => {
  assert.equal(allowsRuntimeScope(["vpncore:admin"], "proxy:admin"), true);
  assert.equal(allowsScopeGrant(["vpncore:admin"], "proxy:admin"), false);
  assert.equal(allowsScopeGrant(["vpncore:admin"], "vpncore:admin"), true);
  assert.equal(allowsScopeGrant(["vpncore:admin"], "substore:admin"), false);
  assert.equal(allowsScopeGrant(["vpncore:*"], "vpncore:read"), true);
  assert.equal(allowsScopeGrant(["vpncore:*"], "vpncore:admin"), true);
  assert.equal(allowsScopeGrant(["vpncore:*"], "proxy:admin"), false);
  assert.equal(allowsScopeGrant(["substore:*"], "vpncore:read"), false);
  assert.equal(allowsScopeGrant(["*"], "unknown:admin"), false);
  assert.equal(allowsScopeGrant(["*"], "*"), false);
  assert.equal(allowsScopeGrant(["*"], "proxy:admin"), true);
  assert.equal(allowsScopeGrant(["*"], "substore:admin"), true);
});
