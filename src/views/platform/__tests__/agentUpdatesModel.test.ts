import assert from "node:assert/strict";
import { test } from "node:test";

import {
  agentStanding,
  bulkButtonState,
  bulkPlan,
  compareAgentVersion,
  fetchAttemptReading,
  fetchExitReading,
  fetchKindKey,
  fetchMirrorId,
  fetchRate,
  fetchReadout,
  fetchSecondsText,
  idToken,
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

// ── the last fetch a node reported ───────────────────────────────────────────

test("a cut source and a second pass add up per source, and the source that finished comes first", () => {
  const readout = fetchReadout({
    fetches: [
      { source: 1, kind: "cp.gz", exit_code: 28, bytes: 1_048_576, seconds: 30 },
      { source: 2, kind: "up", exit_code: 28, bytes: 2_621_440, seconds: 61 },
      { second_pass: true, kind: "cp.gz", exit_code: 0, bytes: 4_504_237, seconds: 88 },
    ],
    exit_code: 0,
    stage: "done",
  });
  assert.equal(readout.outcome, "installed");
  assert.deepEqual(
    readout.sources.map((source) => [source.kind, source.bytes, source.seconds, source.fetches, source.finished]),
    [
      ["cp.gz", 5_552_813, 118, 2, true],
      ["up", 2_621_440, 61, 1, false],
    ],
    "cp.gz finished, so it leads although up delivered more in the first pass",
  );
});

test("a failure keeps its stage and leads with the source that delivered most", () => {
  const readout = fetchReadout({
    fetches: [
      { source: 1, kind: "cp", exit_code: 7, bytes: 0, seconds: 20 },
      { source: 2, kind: "up", exit_code: 28, bytes: 3_000_000, seconds: 460 },
    ],
    exit_code: 28,
    stage: "fetch",
  });
  assert.deepEqual([readout.outcome, readout.stage, readout.stageKnown, readout.exitCode], ["failed", "fetch", true, 28]);
  assert.deepEqual(
    readout.sources.map((source) => [source.kind, source.bytes, source.lastExit, source.lastReading]),
    [
      ["up", 3_000_000, 28, "cut"],
      ["cp", 0, 7, "other"],
    ],
    "the control plane delivered nothing and comes last, with why",
  );
});

test("exit 28 is a cutoff only in a first pass with more than one source", () => {
  const walk = {
    fetches: [
      { source: 1, kind: "cp.gz", exit_code: 28, bytes: 524_288, seconds: 30 },
      { source: 2, kind: "up", exit_code: 28, bytes: 589_824, seconds: 30 },
      { second_pass: true, kind: "cp.gz", exit_code: 28, bytes: 2_097_152, seconds: 420 },
    ],
    exit_code: 28,
    stage: "fetch",
  };
  assert.deepEqual(walk.fetches.map((fetch) => fetchAttemptReading(walk, fetch)), ["cut", "cut", "timeout"]);
  const alone = { fetches: [{ source: 1, kind: "cp", exit_code: 28, bytes: 9_000_000, seconds: 480 }], exit_code: 28, stage: "fetch" };
  assert.equal(fetchAttemptReading(alone, alone.fetches[0]!), "timeout", "a single source runs without the cutoff");
  assert.equal(fetchReadout(walk).sources[0]?.lastReading, "timeout", "a source's last fetch decides its reading");
});

test("a source kind reads under a key without a dot, and an unknown kind has none", () => {
  assert.deepEqual(["cp", "cp.gz", "up", "ftp", "toString"].map(fetchKindKey), ["cp", "cpGz", "up", undefined, undefined]);
});

test("a mirror fetch is named by its registry id, and no other kind reads as a mirror", () => {
  assert.deepEqual(["m.r2", "m.hk-cache", "m.", "cp", "cp.gz", "up", "mirror.r2"].map(fetchMirrorId), ["r2", "hk-cache", undefined, undefined, undefined, undefined, undefined]);
  assert.equal(fetchKindKey("m.r2"), undefined, "a mirror kind has no fixed key; it is read through fetchMirrorId");
});

test("bad chunks add up per source and across the record, and blame only the source that sent them", () => {
  // Design 31 S5: a mirror first in the order appends wrong bytes fast; the
  // script cuts its file back to the first failing chunk, the control plane
  // continues, and the mirror gets no second pass.
  const readout = fetchReadout({
    fetches: [
      { source: 1, kind: "m.r2", exit_code: 0, bytes: 1_310_720, seconds: 4, bad_chunks: 3 },
      { source: 2, kind: "cp.gz", exit_code: 0, bytes: 5_552_813, seconds: 41 },
    ],
    exit_code: 0,
    stage: "done",
  });
  assert.equal(readout.outcome, "installed");
  assert.equal(readout.badChunks, 3);
  assert.deepEqual(
    readout.sources.map((source) => [source.kind, source.finished, source.badChunks]),
    [
      ["cp.gz", true, 0],
      ["m.r2", false, 3],
    ],
    "the mirror's exit 0 delivered a file the manifest cut back, so only the control plane finished",
  );
  assert.equal(readout.sources[1]?.lastReading, "corrupt", "its exit 0 reads as wrong bytes, not as finished");
  assert.equal(fetchReadout({ fetches: [{ source: 1, kind: "cp", exit_code: 0, bytes: 10, seconds: 1 }], exit_code: 0, stage: "done" }).badChunks, 0, "absent means none");
});

test("no fetch is a kept file on success and a stop before downloading on failure", () => {
  assert.equal(fetchReadout({ exit_code: 0, stage: "done" }).outcome, "kept");
  assert.equal(fetchReadout({ fetches: null, exit_code: 0, stage: "done" }).outcome, "kept");
  const prepare = fetchReadout({ exit_code: 1, stage: "prepare" });
  assert.deepEqual([prepare.outcome, prepare.sources], ["failed", []]);
  assert.equal(fetchReadout({ exit_code: 0, stage: "install" }).outcome, "failed", "exit 0 short of done is not a success");
  assert.equal(fetchReadout({ exit_code: 1, stage: "rollback" }).stageKnown, false, "an unknown stage is shown as it came");
});

test("a source that ran once without a clock has no total time, and zero seconds is not a rate", () => {
  const readout = fetchReadout({
    fetches: [
      { source: 1, kind: "cp", exit_code: 18, bytes: 500 },
      { second_pass: true, kind: "cp", exit_code: 0, bytes: 900, seconds: 4 },
    ],
    exit_code: 0,
    stage: "done",
  });
  assert.equal(readout.sources[0]?.seconds, undefined);
  assert.equal(readout.sources[0]?.bytes, 1400);
  assert.equal(fetchRate(900, 4), 225);
  assert.equal(fetchRate(900, 0), undefined);
  assert.equal(fetchRate(900, undefined), undefined);
});

test("only exit statuses that mean one thing for curl and wget get words", () => {
  assert.deepEqual([0, 28, 22, 33, 124, 4, 7].map(fetchExitReading), ["finished", "cut", "http", "range", "timeout", "other", "other"]);
});

test("a fetch time keeps its seconds past the first minute", () => {
  assert.deepEqual([0, 41, 60, 118, 480].map(fetchSecondsText), ["0s", "41s", "1m", "1m 58s", "8m"]);
  assert.equal(fetchSecondsText(undefined), undefined);
  assert.equal(fetchSecondsText(null), undefined);
});

test("an approval id reads by its token, not by the kind every approval shares", () => {
  assert.equal(idToken("approval_k3v7q2mzx5c4b6na"), "k3v7q2mz");
  assert.equal(idToken("k3v7q2mzx5c4b6na"), "k3v7q2mz");
});

test("an exit status of 0 short of done is a failure that keeps its status", () => {
  const readout = fetchReadout({ fetches: [{ source: 1, kind: "cp", exit_code: 0, bytes: 9, seconds: 1 }], exit_code: 0, stage: "fetch" });
  assert.deepEqual([readout.outcome, readout.exitCode, readout.stage], ["failed", 0, "fetch"]);
});
