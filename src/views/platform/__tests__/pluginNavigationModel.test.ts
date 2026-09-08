import assert from "node:assert/strict";
import test from "node:test";

import {
  isPluginNavigableRoute,
  PLUGIN_NAVIGATE_MESSAGE_TYPE,
  classifyPluginNavigateMessage,
  isExpectedPluginFrameOrigin,
  isInternalDashboardRoute,
} from "../pluginNavigationModel.ts";

test("a well-formed navigate message with an internal route is accepted", () => {
  const verdict = classifyPluginNavigateMessage({
    type: PLUGIN_NAVIGATE_MESSAGE_TYPE,
    route: "/platform/publishing?origin=share&create=1&for=openjobs-host",
  });
  assert.deepEqual(verdict, {
    kind: "navigate",
    route: "/platform/publishing?origin=share&create=1&for=openjobs-host",
  });
});

test("bridge protocol traffic and non-objects are not navigation", () => {
  for (const data of [
    undefined,
    null,
    "lattice:navigate",
    42,
    { type: "lattice.plugin.ready", nonce: "abc" },
    { type: "lattice.plugin.call", nonce: "abc", id: "1" },
    { route: "/platform/publishing" }, // missing type
  ]) {
    assert.equal(classifyPluginNavigateMessage(data).kind, "not-navigation", JSON.stringify(data));
  }
});

test("navigate-shaped messages with missing or non-string routes are invalid", () => {
  for (const data of [
    { type: PLUGIN_NAVIGATE_MESSAGE_TYPE },
    { type: PLUGIN_NAVIGATE_MESSAGE_TYPE, route: 42 },
    { type: PLUGIN_NAVIGATE_MESSAGE_TYPE, route: "" },
  ]) {
    assert.equal(classifyPluginNavigateMessage(data).kind, "invalid", JSON.stringify(data));
  }
});

test("anything that is not a strictly internal path is rejected", () => {
  const rejected = [
    "https://evil.example/phish",
    "//evil.example/phish",
    "platform/publishing", // no leading slash
    "/platform/%2e%2e/x:y", // colon is outside the charset
    " /platform/publishing", // leading whitespace
    "/platform/publish ing", // inner whitespace
    "/platform/publishing?for=a;b", // semicolon outside charset
    "/EVIL<script>", // angle brackets
  ];
  for (const route of rejected) {
    assert.equal(isInternalDashboardRoute(route), false, route);
    assert.equal(
      classifyPluginNavigateMessage({ type: PLUGIN_NAVIGATE_MESSAGE_TYPE, route }).kind,
      "invalid",
      route,
    );
  }
});

test("internal paths with query strings pass the charset", () => {
  for (const route of [
    "/",
    "/platform/publishing",
    "/platform/publishing?origin=share&create=1&for=openjobs-host",
    "/operations/approvals?bucket=pending&q=a%20b",
    "/X-9_?=&%", // uppercase and the full allowed punctuation set
  ]) {
    assert.equal(isInternalDashboardRoute(route), true, route);
  }
});

test("the hosted frame's origin is its opaque sandbox origin or the host origin", () => {
  assert.equal(isExpectedPluginFrameOrigin("null", "https://dash.example"), true);
  assert.equal(isExpectedPluginFrameOrigin("https://dash.example", "https://dash.example"), true);
  assert.equal(isExpectedPluginFrameOrigin("https://evil.example", "https://dash.example"), false);
  assert.equal(isExpectedPluginFrameOrigin("", "https://dash.example"), false);
});

// vpn-core links a line to its evidence: the Evidence area opened on a lens
// with the node pre-filtered. Only the keys the view reads are allowed, so a
// frame cannot smuggle a parameter the page would act on.
test("the evidence area is navigable from a plugin with its lens and filter keys only", () => {
  assert.equal(isPluginNavigableRoute("/platform/evidence"), true);
  assert.equal(isPluginNavigableRoute("/platform/evidence?lens=log&node_id=node_ob46mh4ltshdpkhc"), true);
  assert.equal(isPluginNavigableRoute("/platform/evidence?lens=connections&node_id=n&line_uuid=0000abcd-0000-4000-8000-000000000001&tab=policy"), true);
  assert.equal(isPluginNavigableRoute("/platform/evidence?line=VLESS-REALITY-17893.json"), false);
  assert.equal(isPluginNavigableRoute("/platform/evidence?apply=1"), false);
  assert.equal(isPluginNavigableRoute("/platform/logs?node_id=n"), false);
});

// Shares live on Publishing's share lens (DESIGN-PROGRAM-2026-09 §9), and
// Sub-Store's "publish a share" button links there. It is the one path a
// frame may hand a create argument to.
test("publishing is navigable from a plugin with the lens and the create keys only", () => {
  assert.equal(isPluginNavigableRoute("/platform/publishing"), true);
  assert.equal(isPluginNavigableRoute("/platform/publishing?origin=share"), true);
  assert.equal(isPluginNavigableRoute("/platform/publishing?origin=share&create=1&for=openjobs-host"), true);
  assert.equal(isPluginNavigableRoute("/platform/publishing?create=1&for=openjobs-host"), true);
  // `share` selects a row and is the operator's to set, not a frame's.
  assert.equal(isPluginNavigableRoute("/platform/publishing?origin=share&share=share_1"), false);
  assert.equal(isPluginNavigableRoute("/platform/publishing?bucket=site"), false);
});

test("the retired shares path no longer takes arguments from a frame", () => {
  // The Networking path held an allowlist entry only while the installed
  // Sub-Store release still linked to it. The plugin now links to Publishing,
  // the redirect is gone, and default-deny does the rest: the bare path is
  // still an internal address a frame may name, but handing it `create` and
  // `for` is refused like any parameter to an undeclared path, and a frame
  // posting the old deep link gets nothing.
  assert.equal(isPluginNavigableRoute("/network/subscription-shares"), true);
  assert.equal(isPluginNavigableRoute("/network/subscription-shares?create=1&for=openjobs-host"), false);
  assert.equal(isPluginNavigableRoute("/network/subscription-shares?origin=share"), false);
  assert.deepEqual(
    classifyPluginNavigateMessage({
      type: PLUGIN_NAVIGATE_MESSAGE_TYPE,
      route: "/network/subscription-shares?create=1&for=openjobs-host",
    }),
    { kind: "invalid" },
  );
});
