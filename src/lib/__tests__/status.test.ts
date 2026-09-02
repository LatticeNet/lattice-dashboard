import assert from "node:assert/strict";
import test from "node:test";

import { hasNeverReported, nodeHealth, statusMeta } from "../status.ts";

const BEAT = "2026-08-19T12:00:00Z";
const ZERO = "0001-01-01T00:00:00Z";

/**
 * Health is the control plane's status word mapped onto a treatment bucket.
 * The word wins; the legacy fields only matter against an older server.
 */
test("the server status decides the health bucket", () => {
  assert.equal(nodeHealth({ status: "never_reported", online: false, last_seen: BEAT }), "never");
  assert.equal(nodeHealth({ status: "offline", online: true, last_seen: BEAT }), "offline");
  assert.equal(nodeHealth({ status: "degraded", online: true, last_seen: BEAT }), "degraded");
  assert.equal(nodeHealth({ status: "online", online: false }), "online");
  assert.equal(nodeHealth({ status: "disabled", online: true }), "disabled");
});

test("reachability from an older server decides, not the online boolean", () => {
  assert.equal(nodeHealth({ reachability: "never", online: false, last_seen: BEAT }), "never");
  assert.equal(nodeHealth({ reachability: "offline", online: false, last_seen: BEAT }), "offline");
  assert.equal(nodeHealth({ reachability: "online", online: true, last_seen: BEAT }), "online");
});

/**
 * Against a server that predates both fields, the zero time says the same
 * thing. The API sends last_seen unconditionally, so a node that has never
 * beaten arrives carrying it rather than omitting it.
 */
test("a zero last_seen still reads as never when the server sent nothing else", () => {
  assert.equal(nodeHealth({ online: false, last_seen: ZERO }), "never");
  assert.equal(nodeHealth({ online: false, last_seen: "" }), "never");
  assert.equal(nodeHealth({ online: false, last_seen: "not a date" }), "never");
  assert.equal(hasNeverReported({ online: false, last_seen: ZERO }), true);
  assert.equal(hasNeverReported({ online: true }), false);
});

/**
 * Partial shapes without a contact time exist across the console; absence is
 * not evidence of never-reported, and a shape with no signal cannot be shown
 * as reporting.
 */
test("a missing last_seen is not evidence of anything", () => {
  assert.equal(nodeHealth({ online: true }), "online");
  assert.equal(nodeHealth({ online: false }), "offline");
  assert.equal(nodeHealth({}), "offline");
});

test("never, offline and disabled are different states with different treatments", () => {
  const never = statusMeta("never");
  const offline = statusMeta("offline");
  const disabled = statusMeta("disabled");
  assert.notEqual(never.badgeVariant, offline.badgeVariant);
  assert.notEqual(disabled.badgeVariant, offline.badgeVariant);
  // Nothing broke in either case, so the alarm treatment would be a lie.
  assert.notEqual(never.badgeVariant, "destructive");
  assert.notEqual(disabled.badgeVariant, "destructive");
  assert.equal(offline.badgeVariant, "destructive");
});

/**
 * Disabled keeps precedence: it is an explicit operator action and it is what
 * the operator needs to see first, whether or not the node ever reported.
 */
test("an operator-disabled node reads as disabled, not never or offline", () => {
  assert.equal(nodeHealth({ disabled: true, last_seen: ZERO }), "disabled");
  assert.equal(nodeHealth({ disabled: true, reachability: "never" }), "disabled");
  assert.equal(nodeHealth({ disabled: true, reachability: "online", online: true }), "disabled");
});

/**
 * The client no longer folds resource saturation into health. That heuristic
 * is what let one page call a busy node degraded while another called it
 * online; load belongs to the metric bars, degraded to a failed probe.
 */
test("a reporting node does not degrade on saturation", () => {
  assert.equal(
    nodeHealth({ reachability: "online", online: true, last_seen: BEAT, metrics: { cpu_percent: 95 } } as never),
    "online",
  );
});
