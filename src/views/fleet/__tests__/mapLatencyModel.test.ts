import assert from "node:assert/strict";
import { test } from "node:test";

import type { PathView, PathsResponse } from "@/lib/api/types";

import { mapLatency } from "../mapLatencyModel.ts";
import { buildPathsMatrix } from "../pathsModel.ts";

function cell(source: string, target: string, over: Partial<PathView> & { state: string }): PathView {
  return { source, target_node: target, target: "203.0.113.1:443", monitor_id: `mon_${source}_${target}`, check_definition_id: "chk_fleet_mesh", managed: true, method: "tcp", samples: 60, expected: 60, ...over };
}

function matrix(paths: PathView[]) {
  const response: PathsResponse = {
    window: "1h",
    degraded_at: "2026-10-24T09:00:00Z",
    sources: [
      { node_id: "sh", name: "cd-hs-sh" },
      { node_id: "hk", name: "hk-edge" },
    ],
    targets: [],
    paths,
  };
  return buildPathsMatrix(response);
}

// Design 32 R1: the path set is a check like any other, so the Map reads its arcs from the paths matrix, whichever
// check measures a pair: the source that measures the most nodes, one reading per target.
test("the map's latency layer is the busiest source's measured paths, one reading per target", () => {
  const m = matrix([
    cell("sh", "jp", { state: "up", p50_ms: 42, loss: 0 }),
    cell("sh", "de", { state: "degraded", reason: "degraded_latency", p50_ms: 260, loss: 0.01 }),
    cell("sh", "us", { state: "down", loss: 1 }),
    cell("sh", "sg", { state: "unknown", reason: "no_data", samples: 0 }),
    // Skipped: nothing to dial. Not a path (design 32 R2), so no arc.
    cell("sh", "bare", { state: "unknown", reason: "not_probeable", samples: 0, expected: 0 }),
    // A second check on sh to jp that is down: the reading is the one that speaks for the pair, the live up one.
    { ...cell("sh", "jp", { state: "unknown", reason: "agent_offline", samples: 0 }), monitor_id: "mon_ping", check_definition_id: undefined, managed: false, method: "icmp" },
    cell("hk", "jp", { state: "up", p50_ms: 30 }),
    // A check to an address is not a node: no arc.
    { source: "sh", target: "https://x.example", monitor_id: "mon_web", managed: false, method: "http", state: "up", samples: 60, expected: 60 },
  ]);
  const layer = mapLatency(m)!;
  assert.equal(layer.sourceId, "sh");
  assert.equal(layer.sourceName, "cd-hs-sh");
  assert.equal(layer.otherSources, 1);
  assert.deepEqual(Object.fromEntries(layer.readings), {
    jp: { kind: "measured", band: "success", p50Ms: 42, loss: 0, samples: 60, expected: 60 },
    de: { kind: "measured", band: "destructive", p50Ms: 260, loss: 0.01, samples: 60, expected: 60 },
    us: { kind: "failing", band: undefined, p50Ms: undefined, loss: 1, samples: 60, expected: 60 },
    sg: { kind: "unknown", band: undefined, p50Ms: undefined, loss: undefined, samples: 0, expected: 60 },
  });
  assert.equal(mapLatency(matrix([])), undefined, "no path between nodes: no source to draw from");
});

test("a tie between sources goes to the one the matrix lists first", () => {
  const m = matrix([cell("hk", "jp", { state: "up", p50_ms: 30 }), cell("sh", "de", { state: "up", p50_ms: 200 })]);
  assert.equal(mapLatency(m)!.sourceId, "sh");
});
