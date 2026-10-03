import assert from "node:assert/strict";
import { test } from "node:test";

import { clusterPlace, clusterPoints, clusterRadius, clusterTone, listInsteadOfZoom, project, ringPath, zoomToSplit, type MapPoint } from "../fleetMapModel.ts";

test("the projection puts 0,0 in the middle and clamps what is off the map", () => {
  assert.deepEqual(project(0, 0), { x: 500, y: 250 });
  assert.deepEqual(project(-200, 100), { x: 0, y: 0 });
  assert.equal(ringPath([0, 0, 10, 0]), "M500.0 250.0 L527.8 250.0 Z");
  assert.equal(ringPath([]), "");
});

test("thirteen nodes on one city are one cluster with a count, and the offline one sets its colour", () => {
  const la: MapPoint[] = Array.from({ length: 13 }, (_, i) => ({ id: `node_${String(i).padStart(3, "0")}`, x: 170 + (i % 3) * 0.2, y: 155, status: i === 7 ? "offline" : "online" }));
  const tokyo: MapPoint = { id: "node_100", x: 888, y: 151, status: "online" };
  const clusters = clusterPoints([...la, tokyo], 12);
  assert.equal(clusters.length, 2);
  const big = clusters.find((c) => c.ids.length === 13)!;
  assert.equal(big.tone, "destructive");
  assert.equal(big.down, 1);
  assert.equal(big.key, "node_000");
  assert.equal(clusters.find((c) => c.ids.length === 1)!.tone, "success");
});

test("clusters split once the radius shrinks (the operator zoomed in)", () => {
  const points: MapPoint[] = [
    { id: "a", x: 100, y: 100, status: "online" },
    { id: "b", x: 108, y: 100, status: "online" },
  ];
  assert.equal(clusterPoints(points, 12).length, 1);
  assert.equal(clusterPoints(points, 4).length, 2);
});

test("a cluster's colour: offline over degraded over quiet states over online", () => {
  assert.equal(clusterTone(["online", "degraded"]), "warning");
  assert.equal(clusterTone(["degraded", "offline"]), "destructive");
  assert.equal(clusterTone(["disabled", "never_reported"]), "muted");
  assert.equal(clusterTone(["online", "disabled"]), "success");
  // A never-reported node among online ones is in the down count, so the cluster is not green.
  assert.equal(clusterTone(["online", "never_reported", "online"]), "warning");
  assert.equal(clusterTone(["never_reported"]), "muted");
});

test("marks grow with their count and stop growing", () => {
  assert.equal(clusterRadius(1), 7);
  assert.ok(clusterRadius(13) > clusterRadius(4));
  assert.equal(clusterRadius(10_000), 7 * 2.6);
});

/** Clustering as the map does it: a 12 unit radius and a 6 unit target at zoom 1, both shrinking as the map zooms. */
const at = (scale: number) => ({ radius: 12 / scale, reach: () => [{ dx: 0, dy: 0, r: 6 / scale }] });
const spot = (id: string, x: number, y: number): MapPoint => ({ id, x, y, status: "online" });

test("a cluster on one spot cannot be split by zooming; a spread one gets a zoom", () => {
  assert.equal(zoomToSplit([spot("a", 1, 1), spot("b", 1.1, 1)], at, 1), undefined);
  const zoom = zoomToSplit([spot("a", 100, 100), spot("b", 106, 100)], at, 1);
  assert.ok(zoom !== undefined && zoom >= 2 && zoom <= 5, String(zoom));
  assert.equal(clusterPoints([spot("a", 100, 100), spot("b", 106, 100)], at(zoom!).radius, at(zoom!).reach).length, 2);
  assert.equal(zoomToSplit([spot("a", 100, 100), spot("b", 106, 100)], at, 5), undefined);
});

test("the split zoom is one where the map's own clustering splits the members", () => {
  // A phone: 18 px merge radius, 44 px targets. London, Falkenstein and Helsinki 25 px apart are one mark.
  const phone = (scale: number) => ({ radius: 18 / scale, reach: () => [{ dx: 0, dy: 0, r: 22 / scale }] });
  const chain = [spot("lon", 100, 100), spot("fsn", 125, 100), spot("hel", 150, 100)];
  assert.equal(clusterPoints(chain, phone(1).radius, phone(1).reach).length, 1);
  const zoom = zoomToSplit(chain, phone, 1);
  assert.ok(zoom !== undefined && zoom <= 5);
  assert.ok(clusterPoints(chain, phone(zoom).radius, phone(zoom).reach).length > 1, `still one mark at ${zoom}`);
  // Two nodes 0.2 apart: no zoom up to the limit splits them, so the page lists them.
  assert.equal(zoomToSplit([spot("a", 0, 0), spot("b", 0.2, 0)], phone, 1), undefined);
});

test("a cluster mostly on one spot lists on the first click instead of zooming", () => {
  const la = Array.from({ length: 12 }, () => ({ x: 172.2, y: 151.9 }));
  const near = { x: 174, y: 150 };
  assert.equal(listInsteadOfZoom([...la, near], 2), true, "12 of 13 on one spot");
  assert.equal(listInsteadOfZoom([...la, near], undefined), true, "no zoom splits them");
  const spread = [{ x: 500, y: 100 }, { x: 503, y: 101 }, { x: 506, y: 99 }, { x: 500, y: 100 }];
  assert.equal(listInsteadOfZoom(spread, 3), true, "two of four on one spot is half");
  assert.equal(listInsteadOfZoom([{ x: 500, y: 100 }, { x: 503, y: 101 }, { x: 506, y: 99 }], 3), false);
  assert.equal(listInsteadOfZoom([{ x: 1, y: 1 }], 2), false);
});

test("a cluster's place comes from all its members", () => {
  assert.deepEqual(clusterPlace([{ city: "Los Angeles", country: "US" }, { city: "Los Angeles", country: "US" }]), { kind: "city", city: "Los Angeles", country: "US" });
  assert.deepEqual(clusterPlace([{ city: "Osaka", country: "JP" }, { city: "Tokyo", country: "JP" }, { city: "Tokyo", country: "JP" }]), { kind: "country", country: "JP" });
  assert.deepEqual(clusterPlace([{ city: "Frankfurt", country: "DE" }, { city: "Amsterdam", country: "NL" }]), { kind: "places", count: 2 });
  assert.deepEqual(clusterPlace([undefined, {}]), { kind: "unknown" });
});

test("clusters whose targets would overlap merge, so a tap cannot land on a neighbour", () => {
  // London and a two-node cluster 18 px apart on a phone, each with a 44 px target.
  const points: MapPoint[] = [
    { id: "lon", x: 100, y: 100, status: "online" },
    { id: "fsn", x: 118, y: 100, status: "online" },
  ];
  assert.equal(clusterPoints(points, 12).length, 2, "the merge radius alone keeps them apart");
  const merged = clusterPoints(points, 12, () => [{ dx: 0, dy: 0, r: 22 }]);
  assert.equal(merged.length, 1);
  assert.deepEqual(merged[0]!.ids, ["fsn", "lon"]);
  assert.equal(merged[0]!.x, 109);
  // Reaches that only meet at the edge leave both.
  assert.equal(clusterPoints(points, 12, () => [{ dx: 0, dy: 0, r: 9 }]).length, 2);
});

test("a merge that grows a cluster's reach keeps merging until nothing touches", () => {
  const points: MapPoint[] = [
    { id: "a", x: 0, y: 0, status: "online" },
    { id: "b", x: 10, y: 0, status: "offline" },
    { id: "c", x: 26.5, y: 0, status: "online" },
  ];
  // Six per member and four for a down one: a and b overlap (10 apart, reach 6 + 10); c clears b (16.5 apart,
  // reach 10 + 6) but not the merged a and b (21.5 from their centre, reach 16 + 6).
  const reach = (count: number, down: number) => [{ dx: 0, dy: 0, r: 6 * count + 4 * down }];
  assert.equal(clusterPoints(points.slice(1), 1, reach).length, 2, "b and c alone stay apart");
  const clusters = clusterPoints(points, 1, reach);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0]!.down, 1);
  assert.equal(clusters[0]!.tone, "destructive");
});

test("no two clusters' reaches overlap, whatever the points", () => {
  let seed = 7;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let round = 0; round < 40; round += 1) {
    const points: MapPoint[] = Array.from({ length: 30 }, (_, i) => ({
      id: `n${i}`,
      x: random() * 1000,
      y: random() * 500,
      status: random() < 0.2 ? "offline" : "online",
    }));
    // A target at the centre and, with a member down, a badge at the upper right.
    const reach = (count: number, down: number) => [
      { dx: 0, dy: 0, r: 20 + Math.sqrt(count) * 4 },
      ...(down ? [{ dx: 14, dy: -14, r: 6 }] : []),
    ];
    const clusters = clusterPoints(points, 15, reach);
    assert.equal(clusters.reduce((sum, c) => sum + c.ids.length, 0), 30);
    for (let i = 0; i < clusters.length; i += 1) {
      for (let j = i + 1; j < clusters.length; j += 1) {
        const a = clusters[i]!;
        const b = clusters[j]!;
        for (const p of reach(a.ids.length, a.down)) {
          for (const q of reach(b.ids.length, b.down)) {
            assert.ok(Math.hypot(a.x + p.dx - b.x - q.dx, a.y + p.dy - b.y - q.dy) >= p.r + q.r - 1e-9);
          }
        }
      }
    }
  }
});

test("a badge counts only where it is drawn: up and right of its mark", () => {
  const withBadge = (count: number, down: number) => [
    { dx: 0, dy: 0, r: 8 },
    ...(down ? [{ dx: 9, dy: -9, r: 6 }] : []),
  ];
  const big: MapPoint[] = [
    { id: "a1", x: 100, y: 100, status: "offline" },
    { id: "a2", x: 100, y: 100, status: "online" },
  ];
  // 20 below and left of the badge: clear of the marks (16 needed), and the badge is on the other side.
  assert.equal(clusterPoints([...big, { id: "sw", x: 86, y: 114, status: "online" }], 1, withBadge).length, 2);
  // The same distance up and right lands under the badge.
  assert.equal(clusterPoints([...big, { id: "ne", x: 114, y: 86, status: "online" }], 1, withBadge).length, 1);
});

test("500 nodes separate in one pass: each reach is computed once per cluster and once per merge", () => {
  // 500 nodes 3 units apart in a row: the merge radius keeps them apart and every reach overlaps its neighbour's, so
  // the separation pass merges them pair by pair. Rescanning every pair after each merge took 1.7 s and 40 million
  // reach calls here, and the map ran it on every pinch frame.
  const row: MapPoint[] = Array.from({ length: 500 }, (_, i) => ({ id: `n${String(i).padStart(3, "0")}`, x: i * 3, y: 250, status: i % 9 ? "online" : "offline" }));
  let calls = 0;
  const reach = (count: number, down: number) => {
    calls += 1;
    return [{ dx: 0, dy: 0, r: 2.5 + Math.sqrt(count) * 0.5 }, ...(down && count > 1 ? [{ dx: 3, dy: -3, r: 2 }] : [])];
  };
  const started = performance.now();
  const clusters = clusterPoints(row, 1, reach);
  const elapsed = performance.now() - started;
  const merges = row.length - clusters.length;
  assert.equal(clusters.reduce((sum, c) => sum + c.ids.length, 0), 500);
  assert.equal(calls, row.length + merges, "one reach per starting cluster and one per merge");
  // About 20 ms on a laptop; the budget only catches a return to the cubic pass.
  assert.ok(elapsed < 250, `${elapsed.toFixed(0)} ms`);
});
