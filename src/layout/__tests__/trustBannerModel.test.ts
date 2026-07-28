import assert from "node:assert/strict";
import test from "node:test";

import { OFFICIAL_PUBLISHER, trustBannerState } from "../trustBannerModel.ts";

const official = { non_official: false, publishers: [], allow_unsigned_host_risk: false };

test("stays hidden on a stock server that trusts only the official publisher", () => {
  assert.deepEqual(trustBannerState(official), {
    visible: false,
    publishers: [],
    unsignedHostRisk: false,
  });
});

test("stays hidden when the official publisher is listed explicitly", () => {
  const state = trustBannerState({ ...official, publishers: [OFFICIAL_PUBLISHER] });
  assert.equal(state.visible, false);
  assert.deepEqual(state.publishers, []);
});

test("shows, and names the publisher, when a dev key is trusted", () => {
  const state = trustBannerState({
    non_official: true,
    publishers: ["devkey-alice"],
    allow_unsigned_host_risk: false,
  });
  assert.equal(state.visible, true);
  assert.deepEqual(state.publishers, ["devkey-alice"]);
  assert.equal(state.unsignedHostRisk, false);
});

test("shows when signature enforcement is off, even with no extra publisher", () => {
  const state = trustBannerState({ ...official, allow_unsigned_host_risk: true });
  assert.equal(state.visible, true);
  assert.equal(state.unsignedHostRisk, true);
});

test("trusts the list over the flag when the server disagrees with itself", () => {
  const state = trustBannerState({ ...official, publishers: ["devkey-bob"] });
  assert.equal(state.visible, true);
  assert.deepEqual(state.publishers, ["devkey-bob"]);
});

test("dedupes, sorts, trims, and drops empty names", () => {
  const state = trustBannerState({
    non_official: true,
    publishers: ["zeta", " devkey-alice ", "zeta", "", "   ", OFFICIAL_PUBLISHER],
    allow_unsigned_host_risk: false,
  });
  assert.deepEqual(state.publishers, ["devkey-alice", "zeta"]);
});

test("renders nothing for an absent response rather than inventing a warning", () => {
  assert.equal(trustBannerState(null).visible, false);
  assert.equal(trustBannerState(undefined).visible, false);
});

test("survives a malformed payload without throwing", () => {
  const state = trustBannerState({
    non_official: true,
    publishers: [null, 7, "devkey-carol"],
    allow_unsigned_host_risk: "yes",
  } as unknown as { non_official: boolean });
  assert.equal(state.visible, true);
  assert.deepEqual(state.publishers, ["devkey-carol"]);
  assert.equal(state.unsignedHostRisk, false);
});
