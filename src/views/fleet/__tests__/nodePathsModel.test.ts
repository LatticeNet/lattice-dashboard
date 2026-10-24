import assert from "node:assert/strict";
import { test } from "node:test";

import type { PathView, PathsResponse } from "@/lib/api/types";

import { degradedFigures, monitoringQuery, nodePaths, otherEnd, stateCounts, worstFirst } from "../nodePathsModel.ts";
import { GOLDEN_PATHS_7D } from "@/testing/m3Golden";
import { buildPathsMatrix } from "../pathsModel.ts";

function path(over: Partial<PathView>): PathView {
  return { source: "sh", target_node: "jp", target: "203.0.113.12:50231", monitor_id: "mon_latb_jp", managed: true, method: "beacon", state: "up", p50_ms: 68, samples: 60, expected: 60, ...over };
}

function matrix(paths: PathView[]) {
  const response: PathsResponse = {
    window: "24h",
    degraded_at: "2026-10-16T08:00:00Z",
    sources: [
      { node_id: "sh", name: "cd-hs-sh" },
      { node_id: "fsn", name: "hetzner-fsn" },
      { node_id: "jp", name: "xuezhang-jp-nat" },
    ],
    targets: [
      { node_id: "jp", name: "xuezhang-jp-nat", country: "JP" },
      { node_id: "de", name: "hetzner-fsn", country: "DE" },
      { node_id: "us", name: "racknerd-la", country: "US" },
    ],
    paths,
  };
  return buildPathsMatrix(response, { checkName: (id) => (id === "mon_ping_jp" ? "Ping xuezhang-jp-nat" : id === "mon_status" ? "Status page" : undefined) });
}

test("a node's paths split into those that end at it and those that start from it", () => {
  const m = matrix([
    path({}),
    path({ source: "fsn", state: "unknown", reason: "firewall_pending", p50_ms: null }),
    path({ source: "sh", monitor_id: "mon_ping_jp", managed: false, method: "icmp" }),
    path({ source: "jp", target_node: "de", monitor_id: "mon_lat_de", method: "tcp", state: "down", p50_ms: null, loss: 1 }),
    path({ source: "jp", target_node: "us", monitor_id: "mon_lat_us", method: "tcp", p50_ms: 120 }),
    path({ source: "jp", target_node: undefined, target: "https://status.example.com/health", monitor_id: "mon_status", managed: false, method: "http", p50_ms: 140 }),
    // Neither: a path from the node to itself, and the beacon's reachability check.
    path({ source: "jp", target_node: "jp", monitor_id: "mon_lat_jp", method: "tcp" }),
    path({ source: "sh", monitor_id: "mon_beaconr_jp", managed: false }),
  ]);
  const lists = nodePaths(m, "jp");
  assert.deepEqual(lists.reachedBy.map((p) => [p.source, p.monitorId]), [
    // Two up paths on one pair with the same p50 keep a stable order, by their ids. The pair waiting on
    // fsn's firewall is skipped, so the lens leaves it out like every default view (design 32 R2).
    ["sh", "mon_latb_jp"],
    ["sh", "mon_ping_jp"],
  ]);
  assert.deepEqual(lists.reaches.map((p) => p.monitorId), ["mon_lat_de", "mon_status", "mon_lat_us"]);
  assert.deepEqual(nodePaths(undefined, "jp"), { reachedBy: [], reaches: [] });
});

test("worst first: down, degraded, unknown, paused, up; then the lossiest, then the slowest", () => {
  const m = matrix([
    path({ source: "sh", target_node: "de", monitor_id: "f", state: "degraded", reason: "degraded_latency", p50_ms: 300 }),
    path({ source: "sh", target_node: "us", monitor_id: "a", state: "up", p50_ms: 120 }),
    path({ source: "sh", target_node: "de", monitor_id: "b", state: "up", p50_ms: 240, loss: 0.02 }),
    path({ source: "sh", target_node: "jp", monitor_id: "c", state: "unknown", reason: "path_paused", p50_ms: null }),
    path({ source: "fsn", target_node: "jp", monitor_id: "d", state: "unknown", reason: "beacon_filtered", p50_ms: null }),
    path({ source: "fsn", target_node: "us", monitor_id: "e", state: "down", p50_ms: null }),
  ]);
  // The paused pair is not a path (design 32 R2); shown on request it sorts after unknown.
  assert.deepEqual([...m.paths].sort(worstFirst).map((p) => p.monitorId), ["e", "f", "d", "b", "a"]);
  assert.deepEqual([...m.paths, ...m.unmeasured].sort(worstFirst).map((p) => p.monitorId), ["e", "f", "d", "c", "b", "a"]);
  assert.deepEqual(stateCounts(m.paths), { up: 2, degraded: 1, down: 1, unknown: 1, paused: 0, skipped: 0 });
});

test("the other end is the source when reached, the target when reaching; checks carry their names", () => {
  const m = matrix([path({}), path({ source: "sh", monitor_id: "mon_ping_jp", managed: false, method: "icmp" })]);
  const [generated, check] = [m.paths[0]!, m.paths[1]!];
  // Every check is named (design 32 R3); the path set's, unmigrated, by the name it goes by.
  assert.deepEqual(otherEnd(generated, "reachedBy"), { name: "cd-hs-sh", check: "Fleet mesh" });
  assert.deepEqual(otherEnd(check, "reachedBy"), { name: "cd-hs-sh", check: "Ping xuezhang-jp-nat" });
  assert.deepEqual(otherEnd(generated, "reaches"), { name: "xuezhang-jp-nat", check: "Fleet mesh" });
  // A check to a node reaches the node (design 32 D1); the check is named beside it.
  assert.deepEqual(otherEnd(check, "reaches"), { name: "xuezhang-jp-nat", check: "Ping xuezhang-jp-nat" });
  // The pair sits in the node's row whichever check measures it (design 32 R1).
  assert.equal(check.targetName, "xuezhang-jp-nat");
  assert.equal(check.targetNodeName, "xuezhang-jp-nat");
});

test("the Monitoring link filters by target or by source, quoting names the query would split", () => {
  assert.equal(monitoringQuery("reachedBy", "xuezhang-jp-nat"), "target:xuezhang-jp-nat");
  assert.equal(monitoringQuery("reaches", "my node: 2"), 'source:"my node: 2"');
});

test("a degraded row shows the evidence its reason is about, never the window's p50", () => {
  // The node card's default window is 24h; the golden week shows the same gap: a 40 ms week beside a slow quarter hour.
  const week = buildPathsMatrix(GOLDEN_PATHS_7D);
  const path = (key: string, check?: string) => week.paths.find((p) => p.key === key && (!check || p.checkId === check))!;
  const slow = path("node-fra~node-jp");
  assert.equal(slow.p50Ms, 40, "the week's median is the usual figure");
  assert.deepEqual(degradedFigures(slow), { latencyMs: 140 }, "the 15-minute median the reason is about");
  assert.deepEqual(degradedFigures(path("node-sh~node-jp")), { loss: 0.082 }, "the hour's loss the reason is about");
  assert.deepEqual(degradedFigures(path("node-sh~node-jp", "mon-web")), { latencyMs: 140, loss: 0.082 });
  assert.deepEqual(degradedFigures(path("node-hk~node-fra")), {}, "an up path has no evidence");
  assert.deepEqual(degradedFigures({ state: "degraded", degraded: undefined }), {}, "no evidence sent: the reason alone");
});
