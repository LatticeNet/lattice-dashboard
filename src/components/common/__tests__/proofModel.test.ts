import assert from "node:assert/strict";
import { test } from "node:test";

import { freshnessVisible, proofReason, proofState, staleAfterMs, type ProofInput } from "../proofModel.ts";

const NOW = 1_000_000;

function input(over: Partial<ProofInput>): ProofInput {
  return { hasData: true, pending: false, error: undefined, observedAt: NOW - 2_000, pollMs: 10_000, now: NOW, ...over };
}

test("a page turns stale at one and a half poll intervals, and never when it does not poll", () => {
  assert.equal(staleAfterMs(10_000), 15_000);
  assert.equal(staleAfterMs(12_000), 18_000);
  assert.equal(staleAfterMs(0), undefined);
  assert.equal(staleAfterMs(undefined), undefined);
  assert.equal(staleAfterMs(Number.NaN), undefined);
});

test("with nothing read yet, a failure is failed and anything else is loading", () => {
  assert.equal(proofState(input({ hasData: false, pending: true, observedAt: null })), "loading");
  assert.equal(proofState(input({ hasData: false, pending: false, observedAt: null })), "loading");
  assert.equal(proofState(input({ hasData: false, error: new Error("502") })), "failed");
});

test("a polled read is observed until it ages past the threshold", () => {
  assert.equal(proofState(input({})), "observed");
  assert.equal(proofState(input({ observedAt: NOW - 14_999 })), "observed");
  assert.equal(proofState(input({ observedAt: NOW - 15_000 })), "stale");
});

test("Inventory's 12 s poll no longer flickers: 9 s after a read is still observed", () => {
  // The old pill used one 8 s threshold for every page, so a 12 s poll went
  // amber for four seconds of every cycle.
  assert.equal(proofState(input({ pollMs: 12_000, observedAt: NOW - 9_000 })), "observed");
  assert.equal(proofState(input({ pollMs: 12_000, observedAt: NOW - 11_900 })), "observed");
});

test("a refresh in flight is refreshing, never blank, and a failed refresh keeps the last good read as stale", () => {
  assert.equal(proofState(input({ pending: true })), "refreshing");
  assert.equal(proofState(input({ error: new Error("timeout") })), "stale");
  assert.equal(proofState(input({ error: new Error("timeout"), pending: true })), "stale");
});

test("a refresh that has not answered for longer than promised is stale even while pending", () => {
  assert.equal(proofState(input({ pending: true, observedAt: NOW - 20_000 })), "stale");
});

test("a page that reads once is idle and never goes stale by age", () => {
  assert.equal(proofState(input({ pollMs: 0, observedAt: NOW - 3_600_000 })), "idle");
  assert.equal(proofState(input({ pollMs: undefined })), "idle");
  assert.equal(proofState(input({ pollMs: 0, pending: true })), "refreshing");
});

test("the reason is the server's sentence when there is one, on one line", () => {
  assert.equal(proofReason(undefined), "");
  assert.equal(proofReason(new Error("fetch failed")), "fetch failed");
  assert.equal(proofReason({ serverMessage: "tasks store busy", message: "tasks store busy (request r1)" }), "tasks store busy");
  assert.equal(proofReason(new Error("first\nsecond")), "first");
  assert.equal(proofReason(new Error("x".repeat(200))).length, 160);
});

test("the freshness pill shows only on a page that polls", () => {
  assert.equal(freshnessVisible(5_000), true);
  assert.equal(freshnessVisible(0), false);
  assert.equal(freshnessVisible(undefined), false);
});
