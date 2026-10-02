import assert from "node:assert/strict";
import { test } from "node:test";

import {
  agentStanding,
  bulkButtonState,
  bulkPlan,
  compareAgentVersion,
  fleetCells,
  normalizeAgentVersion,
  tableErrorSource,
  versionDistribution,
} from "../agentUpdatesModel.ts";

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

// ── reads that failed say so ─────────────────────────────────────────────────

const allRead = { nodesRead: true, policiesRead: true, latest: "0.3.9" };

test("the plan button counts only when the nodes, the policies and the release were all read", () => {
  assert.deepEqual(bulkButtonState(allRead, 4), { counted: true, disabled: false, block: undefined });
  assert.deepEqual(bulkButtonState(allRead, 0), { counted: true, disabled: true, block: "none" });
  assert.deepEqual(bulkButtonState({ ...allRead, nodesRead: false }, 4), { counted: false, disabled: true, block: "noNodes" });
  assert.deepEqual(bulkButtonState({ ...allRead, latest: undefined }, 0), { counted: false, disabled: true, block: "noLatest" });
  assert.deepEqual(bulkButtonState({ ...allRead, policiesRead: false }, 0), { counted: false, disabled: true, block: "noPolicies" });
});

test("a failed policy read makes a row without a policy say not read, never no policy or never planned", () => {
  const cells = fleetCells({ version: "0.3.9" }, { nodesRead: true, policiesRead: false });
  assert.deepEqual(cells, { runs: "version", target: "notRead", policy: "notRead", lastPlanned: "notRead" });
});

test("a failed node read makes the runs cell say not read, never not reported", () => {
  assert.equal(fleetCells({ policy: { last_planned_at: null } }, { nodesRead: false, policiesRead: true }).runs, "notRead");
  assert.equal(fleetCells({}, { nodesRead: true, policiesRead: true }).runs, "notReported");
});

test("with both reads in, a missing policy and a policy never planned are stated as facts", () => {
  assert.deepEqual(fleetCells({ version: "0.3.3" }, { nodesRead: true, policiesRead: true }), { runs: "version", target: "noPolicy", policy: "none", lastPlanned: "never" });
  assert.equal(fleetCells({ version: "0.3.3", policy: {} }, { nodesRead: true, policiesRead: true }).lastPlanned, "never");
  assert.equal(fleetCells({ version: "0.3.3", policy: { last_planned_at: "2026-09-30T10:00:00Z" } }, { nodesRead: true, policiesRead: false }).lastPlanned, "time");
});

test("the last-data banner speaks only for a read that once succeeded", () => {
  assert.equal(tableErrorSource({ nodesRead: false, nodesFailed: true, policiesRead: true, policiesFailed: false }), null, "first load, nodes never read: no banner");
  assert.equal(tableErrorSource({ nodesRead: true, nodesFailed: false, policiesRead: false, policiesFailed: true }), null);
  assert.equal(tableErrorSource({ nodesRead: true, nodesFailed: true, policiesRead: true, policiesFailed: false }), "nodes");
  assert.equal(tableErrorSource({ nodesRead: true, nodesFailed: false, policiesRead: true, policiesFailed: true }), "policies");
  assert.equal(tableErrorSource({ nodesRead: false, nodesFailed: true, policiesRead: false, policiesFailed: true }), "nodes", "nothing read: the table shows the failure");
  assert.equal(tableErrorSource({ nodesRead: true, nodesFailed: false, policiesRead: true, policiesFailed: false }), null);
});
