import assert from "node:assert/strict";
import { test } from "node:test";

import { geoDeleteImpact, hasRealTime } from "../geoRoutingModel.ts";

test("Go's zero time is not an apply", () => {
  assert.equal(hasRealTime("0001-01-01T00:00:00Z"), false);
  assert.equal(hasRealTime(undefined), false);
  assert.equal(hasRealTime(""), false);
  assert.equal(hasRealTime("2026-09-29T08:00:00Z"), true);
});

test("an applied routing names each DNS node that keeps answering and asks for the typed name", () => {
  const impact = geoDeleteImpact({
    name: "apex-edge",
    hostname: "edge.roobli.org",
    last_applied_at: "2026-09-29T08:00:00Z",
    dns_node_ids: ["node_fsn", "node_hel"],
  });
  assert.equal(impact.applied, true);
  assert.equal(impact.typed, true);
  assert.deepEqual(impact.lines, [
    { kind: "answering", nodeId: "node_fsn", hostname: "edge.roobli.org", appliedAt: "2026-09-29T08:00:00Z" },
    { kind: "answering", nodeId: "node_hel", hostname: "edge.roobli.org", appliedAt: "2026-09-29T08:00:00Z" },
    { kind: "noRemoval" },
  ]);
});

test("an applied routing with no DNS node listed still says something keeps answering", () => {
  const impact = geoDeleteImpact({ name: "apex-edge", hostname: "edge.roobli.org", last_applied_at: "2026-09-29T08:00:00Z", dns_node_ids: [] });
  assert.equal(impact.lines[0]?.kind, "answeringUnknown");
  assert.equal(impact.typed, true);
});

test("a routing never applied is deleted inside Lattice: the record goes, nothing is sent, no typed name", () => {
  for (const last of [undefined, "0001-01-01T00:00:00Z"]) {
    const impact = geoDeleteImpact({ name: "cdn-failover", hostname: "cdn.roobli.org", last_applied_at: last, dns_node_ids: ["node_fsn"] });
    assert.equal(impact.applied, false);
    assert.equal(impact.typed, false);
    assert.deepEqual(impact.lines, [{ kind: "record", hostname: "cdn.roobli.org" }, { kind: "nothingSent" }]);
  }
});

test("the demo preview reaches no node even when it carries a time", () => {
  const impact = geoDeleteImpact({ name: "demo-geo-preview", hostname: "geo-demo.invalid", last_applied_at: "2026-09-29T08:00:00Z", dns_node_ids: ["node_fsn"] });
  assert.equal(impact.applied, false);
  assert.equal(impact.typed, false);
});
