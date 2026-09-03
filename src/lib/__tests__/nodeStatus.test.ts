import assert from "node:assert/strict";
import test from "node:test";

import {
  ATTENTION_ORDER,
  NODE_STATUSES,
  compareByAttention,
  countNodeStatuses,
  describeNodeStatus,
  isReporting,
  metricFreshness,
  needsAttention,
  nodeStatus,
  nodeStatusSince,
} from "../nodeStatus.ts";

const BEAT = "2026-08-19T12:00:00Z";
const ZERO = "0001-01-01T00:00:00Z";

test("the server's word wins over every legacy field", () => {
  // A payload built to contradict itself on purpose: only `status` counts.
  assert.equal(nodeStatus({ status: "degraded", online: false, disabled: true, reachability: "never" }), "degraded");
  assert.equal(nodeStatus({ status: "never_reported", online: true, last_seen: BEAT }), "never_reported");
  assert.equal(nodeStatus({ status: "disabled", online: true }), "disabled");
});

test("an unknown status word is not trusted and the legacy derivation takes over", () => {
  assert.equal(nodeStatus({ status: "sleeping", online: true }), "online");
  assert.equal(nodeStatus({ status: "", reachability: "never" }), "never_reported");
});

test("against an older server the same precedence is rebuilt from what it sent", () => {
  assert.equal(nodeStatus({ disabled: true, reachability: "online", online: true }), "disabled");
  assert.equal(nodeStatus({ reachability: "never", online: false, last_seen: ZERO }), "never_reported");
  assert.equal(nodeStatus({ reachability: "offline", online: false, last_seen: BEAT }), "offline");
  assert.equal(nodeStatus({ reachability: "online", online: true, last_seen: BEAT }), "online");
  // No reachability either: the zero last_seen is the never-reported tell.
  assert.equal(nodeStatus({ online: false, last_seen: ZERO }), "never_reported");
  assert.equal(nodeStatus({ online: false, last_seen: BEAT }), "offline");
  assert.equal(nodeStatus({ online: true }), "online");
  // No signal at all cannot be shown as reporting.
  assert.equal(nodeStatus({}), "offline");
});

test("resource saturation is not a status input", () => {
  // The old client-side heuristic turned a busy node amber on one page while
  // another page called it online. Load is for the metric bars.
  const busy = { status: "online", online: true, metrics: { cpu_percent: 99 } };
  assert.equal(nodeStatus(busy), "online");
});

test("every status has a distinct label, hint and health", () => {
  const labels = new Set(NODE_STATUSES.map((s) => describeNodeStatus(s).labelKey));
  const hints = new Set(NODE_STATUSES.map((s) => describeNodeStatus(s).hintKey));
  const healths = new Set(NODE_STATUSES.map((s) => describeNodeStatus(s).health));
  assert.equal(labels.size, NODE_STATUSES.length);
  assert.equal(hints.size, NODE_STATUSES.length);
  assert.equal(healths.size, NODE_STATUSES.length);
  assert.equal(NODE_STATUSES.length, 5);
});

test("tones follow the meaning: only offline alarms, never and disabled stay quiet", () => {
  assert.equal(describeNodeStatus("online").tone, "success");
  assert.equal(describeNodeStatus("degraded").tone, "warning");
  assert.equal(describeNodeStatus("offline").tone, "destructive");
  // Unfinished setup and an operator's own switch are not failures.
  assert.equal(describeNodeStatus("never_reported").tone, "muted");
  assert.equal(describeNodeStatus("disabled").tone, "muted");
});

test("reporting means the agent is in contact: online and degraded, nothing else", () => {
  assert.equal(isReporting({ status: "online" }), true);
  assert.equal(isReporting({ status: "degraded" }), true);
  assert.equal(isReporting({ status: "offline" }), false);
  assert.equal(isReporting({ status: "never_reported" }), false);
  // Disabled outranks a live agent: the token is refused, so nothing it says counts.
  assert.equal(isReporting({ status: "disabled", online: true }), false);
});

test("attention is everything but online, worst first", () => {
  assert.equal(needsAttention({ status: "online" }), false);
  for (const status of ["degraded", "offline", "never_reported", "disabled"] as const) {
    assert.equal(needsAttention({ status }), true, status);
  }
  const sorted = [{ status: "disabled" }, { status: "degraded" }, { status: "never_reported" }, { status: "offline" }, { status: "online" }]
    .sort(compareByAttention)
    .map((n) => n.status);
  assert.deepEqual(sorted, ["never_reported", "offline", "degraded", "disabled", "online"]);
  assert.equal(ATTENTION_ORDER.online, Math.max(...Object.values(ATTENTION_ORDER)));
});

test("six counts from one pass, and they add up", () => {
  const fleet = [
    { status: "online" },
    { status: "online" },
    { status: "degraded" },
    { status: "offline" },
    { status: "never_reported" },
    { status: "disabled" },
    // Legacy payloads count too, through the same derivation.
    { reachability: "online", online: true },
  ];
  const c = countNodeStatuses(fleet);
  assert.deepEqual(c, {
    total: 7,
    online: 3,
    degraded: 1,
    offline: 1,
    never_reported: 1,
    disabled: 1,
    reporting: 4,
    attention: 4,
  });
  assert.equal(c.online + c.degraded + c.offline + c.never_reported + c.disabled, c.total);
  assert.equal(c.attention, c.total - c.online);
});

test("since comes from the server, or from the last beat only for a node that went quiet", () => {
  assert.equal(nodeStatusSince({ status: "offline", status_since: "2026-08-27T03:00:00Z", last_seen: BEAT }), "2026-08-27T03:00:00Z");
  // The zero time is not a since.
  assert.equal(nodeStatusSince({ status: "online", status_since: ZERO, last_seen: BEAT }), undefined);
  assert.equal(nodeStatusSince({ reachability: "offline", online: false, last_seen: BEAT }), BEAT);
  assert.equal(nodeStatusSince({ reachability: "online", online: true, last_seen: BEAT }), undefined);
  assert.equal(nodeStatusSince({ reachability: "never", last_seen: ZERO }), undefined);
});

test("resource numbers are live, remembered, or absent, and never a confident zero", () => {
  // A node in contact: the sample is now.
  assert.equal(metricFreshness({ status: "online" }, true), "live");
  assert.equal(metricFreshness({ status: "degraded" }, true), "live");
  // Out of contact but a sample survives from the last beat. Shown under a
  // label that says when, never as a current reading.
  assert.equal(metricFreshness({ status: "offline" }, true), "stale");
  assert.equal(metricFreshness({ status: "disabled" }, true), "stale");
  // Nothing was ever measured. This is the case that printed "0% / 0% / 0%".
  assert.equal(metricFreshness({ status: "never_reported" }, false), "none");
  assert.equal(metricFreshness({ status: "online" }, false), "none");
});
