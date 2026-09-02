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
    route: "/network/subscription-shares?create=1&for=openjobs-host",
  });
  assert.deepEqual(verdict, {
    kind: "navigate",
    route: "/network/subscription-shares?create=1&for=openjobs-host",
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
    { route: "/network/subscription-shares" }, // missing type
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
    "network/subscription-shares", // no leading slash
    "/network/%2e%2e/x:y", // colon is outside the charset
    " /network/subscription-shares", // leading whitespace
    "/network/subscription shares", // inner whitespace
    "/network/subscription-shares?for=a;b", // semicolon outside charset
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
    "/network/subscription-shares",
    "/network/subscription-shares?create=1&for=openjobs-host",
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
  assert.equal(isPluginNavigableRoute("/platform/evidence?lens=connections&node_id=n&line=VLESS-REALITY-17893.json&tab=policy"), true);
  assert.equal(isPluginNavigableRoute("/platform/evidence?apply=1"), false);
  assert.equal(isPluginNavigableRoute("/platform/logs?node_id=n"), false);
});
