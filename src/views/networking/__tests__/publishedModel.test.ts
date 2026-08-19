import assert from "node:assert/strict";
import { test } from "node:test";

import { clientUrl, isServing, publishedState, sharePath, sourceLabel } from "../publishedModel.ts";

const NOW = Date.parse("2026-08-18T12:00:00Z");

function share(overrides: Record<string, unknown> = {}) {
  return {
    id: "sh1",
    slug: "team",
    token: "t".repeat(32),
    source: { kind: "plugin", plugin_id: "latticenet.sub-store", subscription_id: "home" },
    enabled: true,
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-01T00:00:00Z",
    ...overrides,
  } as never;
}

test("a paused share is not confused with a lapsed one", () => {
  // Both stop serving; only one of them is a decision someone made.
  assert.equal(publishedState(share({ enabled: false }), NOW), "paused");
  assert.equal(publishedState(share({ expires_at: "2026-08-17T00:00:00Z" }), NOW), "expired");
  assert.equal(publishedState(share(), NOW), "live");
});

test("an expiry inside the warning window is called out before it bites", () => {
  assert.equal(publishedState(share({ expires_at: "2026-08-20T00:00:00Z" }), NOW), "expiring");
  assert.equal(publishedState(share({ expires_at: "2026-09-30T00:00:00Z" }), NOW), "live");
  // An unparseable expiry must not silently read as expired and hide a URL
  // that is in fact still serving.
  assert.equal(publishedState(share({ expires_at: "not-a-date" }), NOW), "live");
});

test("only a serving share is worth handing to a client", () => {
  assert.equal(isServing(share(), NOW), true);
  assert.equal(isServing(share({ expires_at: "2026-08-20T00:00:00Z" }), NOW), true);
  assert.equal(isServing(share({ enabled: false }), NOW), false);
  assert.equal(isServing(share({ expires_at: "2026-08-17T00:00:00Z" }), NOW), false);
});

test("the source says who produces the bytes, with the id kept", () => {
  assert.equal(sourceLabel(share()), "latticenet.sub-store · home");
  assert.equal(
    sourceLabel(share({ source: { kind: "core.proxy_user", proxy_user_id: "pu-1" } })),
    "proxy user · pu-1",
  );
});

test("the client URL names the client and survives odd targets", () => {
  assert.equal(sharePath(share()), `/sub/team/${"t".repeat(32)}`);
  assert.equal(
    clientUrl("https://host", share(), "sing-box"),
    `https://host/sub/team/${"t".repeat(32)}?target=sing-box`,
  );
  assert.match(clientUrl("https://host", share(), "Surge Mac"), /target=Surge%20Mac$/);
});
