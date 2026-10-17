import assert from "node:assert/strict";
import { test } from "node:test";

import type { PathView, PathsResponse } from "@/lib/api/types";

import { buildPathsMatrix } from "../pathsModel.ts";
import { familyOf, isBad, isFresh, isGood, soleReporter, triangulate, verdictFor } from "../triangulationModel.ts";

const SOURCES = [
  { node_id: "sh", name: "cd-hs-sh" },
  { node_id: "hk", name: "hk-edge" },
  { node_id: "fra", name: "fra-1" },
];

function path(source: string, target: string, state: string, over: Partial<PathView> = {}): PathView {
  return { source, target_node: target, target: `203.0.113.9:443`, monitor_id: `mon_lat_${target}`, managed: true, method: "tcp", state, samples: 60, expected: 60, ...over };
}

function matrix(paths: PathView[], sources = SOURCES) {
  const targets = [...new Set(paths.map((p) => p.target_node!).filter(Boolean))].map((id) => ({ node_id: id, name: id }));
  const response: PathsResponse = { window: "1h", sources, targets, paths, degraded_at: "2026-10-16T08:00:00Z" };
  return buildPathsMatrix(response);
}

/** Every path from every source to one target, in a state per source. */
function row(target: string, states: Record<string, string>): PathView[] {
  return Object.entries(states).map(([source, state]) => path(source, target, state, state === "unknown" ? { reason: "results_stopped" } : {}));
}

test("families: reach is bad only when down; quality when down or degraded; unknown is never fresh", () => {
  assert.equal(isFresh("up"), true);
  assert.equal(isFresh("degraded"), true);
  assert.equal(isFresh("down"), true);
  assert.equal(isFresh("unknown"), false);
  assert.equal(isBad("degraded", "reach"), false);
  assert.equal(isGood("degraded", "reach"), true);
  assert.equal(isBad("degraded", "quality"), true);
  assert.equal(isGood("degraded", "quality"), false);
  assert.equal(familyOf("down"), "reach");
  assert.equal(familyOf("degraded"), "quality");
  assert.equal(familyOf("up"), undefined);
});

test("rule 1: a target down from every fresh source, two or more, is the target", () => {
  const m = matrix(row("tyo-3", { sh: "down", hk: "down", fra: "down" }));
  const tri = triangulate(m);
  for (const p of m.paths) {
    const v = verdictFor(tri, p)!;
    assert.equal(v.kind, "target");
    assert.equal(v.family, "reach");
    assert.deepEqual(v.evidence, { kind: "target", target: "tyo-3", sources: ["cd-hs-sh", "hk-edge", "fra-1"] }, "sources in the matrix's column order");
  }
});

test("rule 1 needs two fresh sources: a stale third does not count, one fresh source never makes it the target", () => {
  const two = triangulate(matrix(row("tyo-3", { sh: "down", hk: "down", fra: "unknown" })));
  assert.equal(two.reach.get("sh~tyo-3")!.kind, "target");
  assert.deepEqual(two.reach.get("sh~tyo-3")!.evidence, { kind: "target", target: "tyo-3", sources: ["cd-hs-sh", "hk-edge"] }, "the stale source is left out of the evidence");
  const one = triangulate(matrix(row("tyo-3", { sh: "down", hk: "unknown", fra: "unknown" })));
  assert.equal(one.reach.get("sh~tyo-3")!.kind, "path");
  assert.deepEqual(one.reach.get("sh~tyo-3")!.evidence, { kind: "alone", source: "cd-hs-sh", target: "tyo-3" }, "stale sources do not report on it");
});

test("a degraded source reaches in the reach family and fails in the quality family", () => {
  const m = matrix(row("tyo-3", { sh: "down", hk: "down", fra: "degraded" }));
  const tri = triangulate(m);
  assert.equal(tri.reach.get("sh~tyo-3")!.kind, "path", "fra-1 still reaches tyo-3");
  assert.deepEqual(tri.reach.get("sh~tyo-3")!.evidence, { kind: "path", target: "tyo-3", others: 1 });
  assert.equal(tri.quality.get("sh~tyo-3")!.kind, "target", "down or degraded from all three");
  assert.equal(tri.quality.get("fra~tyo-3")!.kind, "target");
  assert.equal(tri.reach.has("fra~tyo-3"), false, "a degraded path has no reach verdict");
  assert.equal(verdictFor(tri, m.paths.find((p) => p.key === "fra~tyo-3")!)!.family, "quality", "a degraded path reads its quality verdict");
});

function sourceFleet(bad: number, fresh: number, elsewhere: boolean): PathView[] {
  const out: PathView[] = [];
  for (let i = 0; i < fresh; i++) {
    const target = `t${i}`;
    out.push(path("sh", target, i < bad ? "down" : "up"));
    out.push(path("hk", target, elsewhere ? "up" : "unknown", elsewhere ? {} : { reason: "results_stopped" }));
  }
  return out;
}

test("rule 2: a source failing three or more and most of its fresh rows, corroborated by another source, is its network", () => {
  const tri = triangulate(matrix(sourceFleet(7, 9, true)));
  const v = tri.reach.get("sh~t0")!;
  assert.equal(v.kind, "source");
  assert.deepEqual(v.evidence, { kind: "source", source: "cd-hs-sh", bad: 7, fresh: 9, elsewhere: 7 });
});

test("rule 2 holds at three bad rows of five, not at two, and not at exactly half", () => {
  assert.equal(triangulate(matrix(sourceFleet(3, 5, true))).reach.get("sh~t0")!.kind, "source");
  assert.equal(triangulate(matrix(sourceFleet(2, 3, true))).reach.get("sh~t0")!.kind, "path", "two bad rows is below the floor");
  assert.equal(triangulate(matrix(sourceFleet(3, 6, true))).reach.get("sh~t0")!.kind, "path", "half is not more than half");
});

test("rule 2 needs corroboration: without another source reaching one of the rows, it is this path", () => {
  const tri = triangulate(matrix(sourceFleet(7, 9, false)));
  const v = tri.reach.get("sh~t0")!;
  assert.equal(v.kind, "path");
  assert.deepEqual(v.evidence, { kind: "alone", source: "cd-hs-sh", target: "t0" }, "hk-edge's stale paths do not report on t0");
});

test("rule order: the target wins over the source when both hold", () => {
  // sh fails t0 to t4; t0 is down from hk too, so t0 is the target; t1 to t4 are reached by hk.
  const paths = sourceFleet(5, 6, true).map((p) => (p.source === "hk" && p.target_node === "t0" ? { ...p, state: "down" } : p));
  const tri = triangulate(matrix(paths));
  assert.equal(tri.reach.get("sh~t0")!.kind, "target");
  assert.equal(tri.reach.get("sh~t1")!.kind, "source");
  assert.deepEqual(tri.reach.get("sh~t1")!.evidence, { kind: "source", source: "cd-hs-sh", bad: 5, fresh: 6, elsewhere: 4 }, "t0 is bad from hk too, so it does not corroborate");
});

test("one source: every verdict is this path, whatever it fails", () => {
  const paths: PathView[] = [];
  for (let i = 0; i < 9; i++) paths.push(path("sh", `t${i}`, i < 8 ? "down" : "up"));
  paths.push(path("sh", "slow", "degraded", { reason: "degraded_latency" }));
  const m = matrix(paths, [SOURCES[0]!]);
  const tri = triangulate(m);
  for (const p of m.paths.filter((p) => p.state !== "up")) {
    const v = verdictFor(tri, p)!;
    assert.equal(v.kind, "path", p.key);
    assert.equal(v.evidence.kind, "alone");
  }
});

test("operator check rows triangulate like node rows", () => {
  const check = (source: string, state: string): PathView => ({ source, target: "https://status.example.com/health", monitor_id: "mon_status", managed: false, method: "http", state, samples: 60, expected: 60 });
  const m = matrix([check("sh", "down"), check("hk", "down")]);
  const v = triangulate(m).reach.get("sh~@mon_status")!;
  assert.equal(v.kind, "target");
  assert.deepEqual((v.evidence as { sources: string[] }).sources, ["cd-hs-sh", "hk-edge"]);
});

test("up, unknown and paused paths get no verdict", () => {
  const m = matrix([...row("a", { sh: "up", hk: "unknown" }), path("fra", "a", "unknown", { reason: "path_paused" })]);
  const tri = triangulate(m);
  assert.equal(tri.reach.size + tri.quality.size, 0);
  for (const p of m.paths) assert.equal(verdictFor(tri, p), undefined);
});

test("sole reporter: one source behind every unplaced verdict is said once; anything placed or mixed is not", () => {
  // The single-source fleet: every down and degraded verdict is "alone" from cd-hs-sh.
  const one: PathView[] = [path("sh", "a", "down"), path("sh", "b", "degraded", { reason: "degraded_loss" }), path("sh", "c", "up")];
  const m1 = matrix(one, [SOURCES[0]!]);
  const t1 = triangulate(m1);
  assert.equal(soleReporter(m1.paths.map((p) => verdictFor(t1, p))), "cd-hs-sh", "undefined verdicts of up paths are skipped");
  // A verdict that is placed, or a "this path" with other sources beside it, keeps the per-line verdicts.
  const t3 = triangulate(matrix(row("tyo-3", { sh: "down", hk: "down", fra: "up" })));
  assert.equal(soleReporter([...t3.reach.values()]), undefined, "other sources reach tyo-3");
  const placed = triangulate(matrix(row("tyo-3", { sh: "down", hk: "down" })));
  assert.equal(soleReporter([...placed.reach.values()]), undefined, "the target is placed");
  // Two different lone sources (each the only one on its own target) do not share a note.
  const mixed = triangulate(matrix([path("sh", "a", "down"), path("hk", "b", "down")]));
  assert.equal(soleReporter([...mixed.reach.values()]), undefined);
  assert.equal(soleReporter([]), undefined, "no verdict, no note");
  assert.equal(soleReporter([undefined]), undefined);
});
