import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

/**
 * A deep link outside the principal's scopes keeps its address and shows
 * RouteDenied instead of the page (router/accessModel decides, and its own
 * test covers the decision). What no unit test can see is the shell using
 * that decision: if AppLayout lost the branch, a denied page would mount and
 * fire its reads into 403s, and CI would stay green. This keeps the branch.
 */
const layout = readFileSync(new URL("../AppLayout.vue", import.meta.url), "utf8");

test("the shell decides a denied route from the route's scopes and the principal's", () => {
  assert.match(
    layout,
    /const deniedScopes = computed\(\(\) => missingRouteScopes\(route\.meta\.scopes, \(scopes\) => auth\.canAny\(scopes\)\)\);/,
  );
});

test("a denied route renders RouteDenied in place of the page, never beside it", () => {
  assert.match(
    layout,
    /<RouteDenied v-if="deniedScopes"[^>]*:scopes="deniedScopes"[^>]*\/>\s*<RouterView v-else\b/,
    "RouteDenied and the RouterView must be the two arms of one v-if",
  );
  assert.equal(layout.match(/<RouterView\b/g)?.length, 1, "one RouterView, the v-else arm");
});
