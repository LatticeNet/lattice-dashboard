import assert from "node:assert/strict";
import { test } from "node:test";

import { agentStanding, bulkPlan, compareAgentVersion, normalizeAgentVersion, versionDistribution } from "../agentUpdatesModel.ts";

test("versions compare numerically, and a prerelease sorts before its release", () => {
  assert.equal(normalizeAgentVersion(" v0.3.9 "), "0.3.9");
  assert.ok(compareAgentVersion("0.3.10", "0.3.9") > 0, "10 is newer than 9");
  assert.ok(compareAgentVersion("v0.3.8", "0.3.9") < 0);
  assert.equal(compareAgentVersion("0.3.9", "v0.3.9"), 0);
  assert.ok(compareAgentVersion("0.3.9-alpha.1", "0.3.9") < 0);
  assert.ok(compareAgentVersion("0.3.9-alpha.10", "0.3.9-alpha.2") > 0);
});

test("build metadata never makes a release older, and a prerelease keeps every hyphen", () => {
  assert.equal(compareAgentVersion("0.3.9+abc123", "0.3.9"), 0);
  assert.equal(agentStanding("v0.3.9+abc123", "0.3.9"), "current");
  assert.ok(compareAgentVersion("0.3.9-rc.1+abc123", "0.3.9") < 0, "still a prerelease");
  assert.equal(compareAgentVersion("0.3.9-rc.1+abc123", "0.3.9-rc.1+def456"), 0);
  assert.ok(compareAgentVersion("0.3.9-alpha-2", "0.3.9-alpha-10") < 0, "the tag after the first hyphen is compared whole");
});

test("a node stands current, behind or ahead of the latest, and unknown when either was not read", () => {
  assert.equal(agentStanding("0.3.9", "v0.3.9"), "current");
  assert.equal(agentStanding("0.3.3", "0.3.9"), "behind");
  assert.equal(agentStanding("0.4.0-alpha.1", "0.3.9"), "ahead");
  assert.equal(agentStanding(undefined, "0.3.9"), "unknown");
  assert.equal(agentStanding("0.3.9", undefined), "unknown");
});

test("the version bar lists newest first and nodes without a version last", () => {
  const slices = versionDistribution(["0.3.9", "0.3.8", "0.3.9", undefined, "0.3.3", "0.3.8", "0.3.9"], "0.3.9");
  assert.deepEqual(
    slices.map((slice) => [slice.version, slice.count, slice.standing]),
    [
      ["0.3.9", 3, "current"],
      ["0.3.8", 2, "behind"],
      ["0.3.3", 1, "behind"],
      ["", 1, "unknown"],
    ],
  );
});

test("plan behind nodes covers behind nodes with a policy and names the ones it cannot plan", () => {
  const rows = [
    { nodeId: "a", version: "0.3.9", policy: { id: "a" } },
    { nodeId: "b", version: "0.3.8", policy: { id: "b" } },
    { nodeId: "c", version: "0.3.6" },
    { nodeId: "d", version: undefined, policy: { id: "d" } },
  ];
  const plan = bulkPlan(rows, "0.3.9");
  assert.deepEqual(plan.plan.map((row) => row.nodeId), ["b"]);
  assert.deepEqual(plan.skipped.map((row) => row.nodeId), ["c"]);
  assert.deepEqual(bulkPlan(rows, undefined), { plan: [], skipped: [] }, "no latest read, nothing is behind");
});
