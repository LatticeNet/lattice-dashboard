import assert from "node:assert/strict";
import test from "node:test";

import {
  pluginLifecycleActions,
  pluginLifecycleAvailability,
  pluginLifecycleCapabilities,
  pluginLifecycleDigestShort,
  pluginLifecycleRuntimeLabel,
  pluginLifecycleStatusLabel,
  pluginLifecycleTransitionMessage,
  pluginLifecycleTransitionPayload,
  confirmPluginLifecycleTransition,
} from "./plugin-lifecycle.js";

test("pluginLifecycleStatusLabel maps known status values", () => {
  assert.equal(pluginLifecycleStatusLabel("verified"), "verified");
  assert.equal(pluginLifecycleStatusLabel("installed"), "installed");
  assert.equal(pluginLifecycleStatusLabel("active"), "active");
  assert.equal(pluginLifecycleStatusLabel("disabled"), "disabled");
  assert.equal(pluginLifecycleStatusLabel("unexpected"), "unknown");
  assert.equal(pluginLifecycleStatusLabel(""), "unknown");
});

test("pluginLifecycleActions follows the server transition rules", () => {
  assert.deepEqual(pluginLifecycleActions({ status: "verified", available: true }), [
    { status: "installed", label: "Install" },
  ]);
  assert.deepEqual(pluginLifecycleActions({ status: "verified", available: false }), []);
  assert.deepEqual(pluginLifecycleActions({ status: "installed", available: true }), [
    { status: "active", label: "Activate" },
    { status: "disabled", label: "Disable" },
  ]);
  assert.deepEqual(pluginLifecycleActions({ status: "installed", available: false }), [
    { status: "disabled", label: "Disable" },
  ]);
  assert.deepEqual(pluginLifecycleActions({ status: "active", available: false }), [
    { status: "disabled", label: "Disable" },
  ]);
  assert.deepEqual(pluginLifecycleActions({ status: "disabled", available: true }), [
    { status: "active", label: "Activate" },
  ]);
  assert.deepEqual(pluginLifecycleActions({ status: "disabled", available: false }), []);
});

test("pluginLifecycleAvailability separates verified loader presence from lifecycle status", () => {
  assert.equal(pluginLifecycleAvailability({ available: true }), "available");
  assert.equal(pluginLifecycleAvailability({ available: false }), "unavailable");
  assert.equal(pluginLifecycleAvailability({}), "unavailable");
});

test("pluginLifecycleRuntimeLabel names armed/stopped runtime health", () => {
  assert.equal(pluginLifecycleRuntimeLabel({ runtime: { state: "armed", runner: "noop" } }), "runtime: armed (noop)");
  assert.equal(pluginLifecycleRuntimeLabel({ runtime: { state: "stopped" } }), "runtime: stopped");
  assert.equal(pluginLifecycleRuntimeLabel({ runtime: { state: "failed" } }), "runtime: failed");
  assert.equal(pluginLifecycleRuntimeLabel({ runtime: null }), "");
  assert.equal(pluginLifecycleRuntimeLabel({ runtime: { state: "<script>" } }), "runtime: unknown");
});

test("pluginLifecycleCapabilities normalizes capability arrays defensively", () => {
  const caps = ["node:read", "", " kv:read ", 42, "node:read"];
  assert.deepEqual(pluginLifecycleCapabilities({ capabilities: caps }), ["node:read", "kv:read"]);
  assert.deepEqual(pluginLifecycleCapabilities({ capabilities: null }), []);
});

test("pluginLifecycleDigestShort keeps digest useful without filling the card", () => {
  assert.equal(pluginLifecycleDigestShort(""), "");
  assert.equal(pluginLifecycleDigestShort("abc123"), "abc123");
  assert.equal(
    pluginLifecycleDigestShort("0123456789abcdef0123456789abcdef0123456789abcdef"),
    "0123456789ab...89abcdef",
  );
});

test("pluginLifecycleTransitionPayload trims only the two accepted fields", () => {
  assert.deepEqual(pluginLifecycleTransitionPayload(" ops.bundle ", " active "), {
    id: "ops.bundle",
    status: "active",
  });
});

test("pluginLifecycleTransitionMessage names the target plugin and status", () => {
  assert.equal(
    pluginLifecycleTransitionMessage({ id: "ops.bundle", name: "Ops" }, "active"),
    'Change plugin "Ops" status to active? This does not execute plugin code in the current build.',
  );
  assert.equal(
    pluginLifecycleTransitionMessage({ id: "ops.bundle", name: "" }, "disabled"),
    'Change plugin "ops.bundle" status to disabled? This does not execute plugin code in the current build.',
  );
});

test("confirmPluginLifecycleTransition delegates the final decision", () => {
  const messages = [];
  assert.equal(confirmPluginLifecycleTransition({ id: "ops.bundle" }, "active", (message) => {
    messages.push(message);
    return false;
  }), false);
  assert.deepEqual(messages, [
    'Change plugin "ops.bundle" status to active? This does not execute plugin code in the current build.',
  ]);
  assert.equal(confirmPluginLifecycleTransition({ id: "ops.bundle" }, "active", () => true), true);
  assert.equal(confirmPluginLifecycleTransition({ id: "ops.bundle" }, "active", null), false);
});
