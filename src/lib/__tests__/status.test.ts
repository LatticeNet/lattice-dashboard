import assert from "node:assert/strict";
import test from "node:test";

import { hasNeverReported, nodeHealth, statusMeta } from "../status.ts";

const BEAT = "2026-08-19T12:00:00Z";
const ZERO = "0001-01-01T00:00:00Z";

/**
 * The control plane's answer is the one that counts. It knows the difference
 * between a node that stopped reporting and one that never started; the
 * `online` boolean cannot express the second.
 */
test("reachability from the server decides, not the online boolean", () => {
  assert.equal(nodeHealth({ reachability: "never", online: false, last_seen: BEAT }), "never");
  assert.equal(nodeHealth({ reachability: "offline", online: false, last_seen: BEAT }), "offline");
  assert.equal(nodeHealth({ reachability: "online", online: true, last_seen: BEAT }), "online");
});

/**
 * Against a server that predates the field, the zero time says the same thing.
 * The API sends last_seen unconditionally, so a node that has never beaten
 * arrives carrying it rather than omitting it.
 */
test("a zero last_seen still reads as never when the server sent no reachability", () => {
  assert.equal(nodeHealth({ online: false, last_seen: ZERO }), "never");
  assert.equal(nodeHealth({ online: false, last_seen: "" }), "never");
  assert.equal(nodeHealth({ online: false, last_seen: "not a date" }), "never");
});

/**
 * The trap this rule can fall into. Health is derived from partial shapes all
 * over the console, many of which never carried a contact time; reading absence
 * as proof of never-reported would relabel every one of them.
 */
test("a missing last_seen is not evidence of anything", () => {
  assert.equal(nodeHealth({ online: true }), "online");
  assert.equal(nodeHealth({ online: false }), "offline");
  assert.equal(nodeHealth({}), "unknown");
  assert.equal(hasNeverReported({ online: true }), false);
});

test("never and offline are different states with different treatments", () => {
  const never = statusMeta("never");
  const offline = statusMeta("offline");
  assert.notEqual(never.badgeVariant, offline.badgeVariant);
  // Nothing broke, so the alarm treatment would be a lie.
  assert.notEqual(never.badgeVariant, "destructive");
  assert.equal(offline.badgeVariant, "destructive");
});

/**
 * Disabled keeps precedence: it is an explicit operator action and it is what
 * the operator needs to see first, whether or not the node ever reported.
 */
test("an operator-disabled node reads as disabled-shaped, not never", () => {
  assert.equal(nodeHealth({ disabled: true, last_seen: ZERO }), "offline");
  assert.equal(nodeHealth({ disabled: true, reachability: "never" }), "offline");
});

test("a reporting node still degrades on saturation", () => {
  assert.equal(
    nodeHealth({ reachability: "online", online: true, last_seen: BEAT, metrics: { cpu_percent: 95 } }),
    "degraded",
  );
});
