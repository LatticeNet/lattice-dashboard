import assert from "node:assert/strict";
import test from "node:test";

import { allowsRuntimeScope } from "../../lib/scopes.ts";
import { missingRouteScopes } from "../accessModel.ts";

const canAnyWith = (granted: string[]) => (required: string[]) => required.some((scope) => allowsRuntimeScope(granted, scope));

test("a page outside the principal's scopes names the scopes it needs", () => {
  assert.deepEqual(missingRouteScopes(["netpolicy:read"], canAnyWith(["node:read"])), ["netpolicy:read"]);
  assert.deepEqual(missingRouteScopes(["monitor:read", "monitor:admin"], canAnyWith(["node:read"])), ["monitor:read", "monitor:admin"]);
});

test("any one listed scope opens the page, and a page without scopes is open to everyone signed in", () => {
  assert.equal(missingRouteScopes(["monitor:read", "monitor:admin"], canAnyWith(["monitor:admin"])), null);
  assert.equal(missingRouteScopes(["netpolicy:read"], canAnyWith(["netpolicy:read"])), null);
  assert.equal(missingRouteScopes([], canAnyWith([])), null);
  assert.equal(missingRouteScopes(undefined, canAnyWith([])), null);
});

test("the wildcard grant opens every page", () => {
  assert.equal(missingRouteScopes(["netpolicy:read"], canAnyWith(["*"])), null);
});

test("junk in route meta is not shown as a scope", () => {
  assert.deepEqual(missingRouteScopes(["netpolicy:read", "", 3], canAnyWith([])), ["netpolicy:read"]);
  assert.equal(missingRouteScopes(["", null], canAnyWith([])), null);
});
