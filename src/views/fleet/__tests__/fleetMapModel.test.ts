import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MAP_HEIGHT,
  MAP_WIDTH,
  MIN_MAX_ZOOM,
  PAN_SLACK,
  arcPaths,
  cardBesideSpread,
  centreOn,
  clampViewport,
  clusterAction,
  clusterArcTone,
  clusterPlace,
  clusterPoints,
  clusterRadius,
  clusterTone,
  fitViewport,
  latencyLayerState,
  leadersClear,
  maxZoomFor,
  nearestInDirection,
  project,
  ringPath,
  spreadBox,
  spreadCapacity,
  splitView,
  spreadSlots,
  viewportBetween,
  zoomAround,
  zoomToSplit,
  type ArcReading,
  type MapPoint,
  type SpreadSlot,
  type Viewport,
} from "../fleetMapModel.ts";

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

test("twelve on one point and one nearby: a zoom splits off the neighbour, then nothing splits the twelve", () => {
  // Los Angeles at 1440: 18 px merge radius and 11 px mouse targets at 1.39 px per map unit, x8.28 at the deepest.
  const desk = (scale: number) => ({ radius: 18 / 1.392 / scale, reach: () => [{ dx: 0, dy: 0, r: 11 / 1.392 / scale }] });
  const la = Array.from({ length: 12 }, (_, i) => spot(`la${String(i).padStart(2, "0")}`, 171.6, 155.4));
  const sanJose = spot("sj", 161.4, 146.3);
  const zoom = zoomToSplit([...la, sanJose], desk, 1, 8.28);
  assert.ok(zoom !== undefined, "San Jose parts from Los Angeles by zooming");
  const parts = clusterPoints([...la, sanJose], desk(zoom).radius, desk(zoom).reach);
  assert.deepEqual(parts.map((part) => part.ids.length).sort((a, b) => a - b), [1, 12]);
  assert.equal(zoomToSplit(la, desk, zoom, 8.28), undefined, "the twelve on one point are spread instead");
});

test("one zoom splits a pile as far as the deepest zoom will, not one neighbour per tap", () => {
  // A 343 px phone: 18 px merge radius, 44 px targets, 0.343 px per map unit at x1, x33.6 at the deepest.
  const phone = (scale: number) => ({ radius: 18 / 0.343 / scale, reach: () => [{ dx: 0, dy: 0, r: 22 / 0.343 / scale }] });
  const six = Array.from({ length: 6 }, (_, i) => spot(`la${i}`, 171.6, 155.4));
  // Neighbours 1.2 to 3.7 degrees from Los Angeles (3.3 to 10.3 map units).
  const region = [spot("sb", 167.5, 154.3), spot("bk", 169.4, 151.7), spot("ps", 176.2, 156.0), spot("sd", 174.6, 159.6), spot("lv", 180.2, 149.5), spot("bs", 177.7, 153.1)];
  const max = 33.6;
  const zoom = zoomToSplit([...six, ...region], phone, 1.5, max);
  assert.ok(zoom !== undefined);
  const deepest = clusterPoints([...six, ...region], phone(max).radius, phone(max).reach).length;
  assert.equal(clusterPoints([...six, ...region], phone(zoom).radius, phone(zoom).reach).length, deepest, `one tap reaches the ${deepest} marks the deepest zoom shows`);
  assert.equal(zoomToSplit(six, phone, zoom, max), undefined, "then the six spread");
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

/* ----------------------------- view, spread, keys, arcs ----------------------------- */

test("the deepest zoom gives a phone the ground detail a desktop gets", () => {
  assert.equal(maxZoomFor(1392), 8.28);
  assert.equal(maxZoomFor(343), 33.59);
  // Never shallower than the old fixed limit, and a frame not measured yet keeps it.
  assert.equal(maxZoomFor(4000), MIN_MAX_ZOOM);
  assert.equal(maxZoomFor(0), MIN_MAX_ZOOM);
  // The same px per degree at both widths.
  const perDegree = (width: number) => (width / 360) * maxZoomFor(width);
  assert.ok(Math.abs(perDegree(1392) - perDegree(343)) < 0.05);
});

test("a zoom at the pointer keeps the map point under it in place", () => {
  const start: Viewport = { scale: 2, x: -300, y: -100 };
  const pointer = { x: 412, y: 233 };
  const under = { x: (pointer.x - start.x) / start.scale, y: (pointer.y - start.y) / start.scale };
  const next = zoomAround(start, 3, pointer, 8);
  assert.equal(next.scale, 3);
  assert.ok(Math.abs(next.x + under.x * next.scale - pointer.x) < 1e-9);
  assert.ok(Math.abs(next.y + under.y * next.scale - pointer.y) < 1e-9);
  // Past the limits it stops there, and back at x1 the world is whole and unpanned.
  assert.equal(zoomAround(start, 50, pointer, 8).scale, 8);
  assert.deepEqual(zoomAround(start, 0.5, pointer, 8), { scale: 1, x: 0, y: 0 });
  assert.deepEqual(clampViewport({ scale: 4, x: 900, y: -99_999 }, 8), { scale: 4, x: PAN_SLACK, y: MAP_HEIGHT * (1 - 4) - PAN_SLACK });
});

test("an animated zoom moves the centre in a straight line and the zoom by equal ratios", () => {
  const from: Viewport = { scale: 1, x: 0, y: 0 };
  const to = centreOn(171, 155, 8, 8);
  assert.deepEqual(viewportBetween(from, to, 0), from);
  assert.deepEqual(viewportBetween(from, to, 1), to);
  const half = viewportBetween(from, to, 0.5);
  assert.ok(Math.abs(half.scale - Math.sqrt(8)) < 1e-9);
  const centre = (v: Viewport) => ({ x: (MAP_WIDTH / 2 - v.x) / v.scale, y: (MAP_HEIGHT / 2 - v.y) / v.scale });
  const a = centre(from);
  const b = centre(to);
  const m = centre(half);
  assert.ok(Math.abs(m.x - (a.x + b.x) / 2) < 1e-9 && Math.abs(m.y - (a.y + b.y) / 2) < 1e-9);
});

test("fit fleet holds every node; one spot alone gets a close view", () => {
  const fleet = [project(-118.24, 34.05), project(139.69, 35.68), project(151.2, -33.87), project(24.94, 60.17)];
  const view = fitViewport(fleet, 8);
  assert.deepEqual(view, { scale: 1, x: 0, y: 0 }, "three continents are the whole world");
  for (const point of fleet) {
    const x = view.x + point.x * view.scale;
    const y = view.y + point.y * view.scale;
    assert.ok(x >= 0 && x <= MAP_WIDTH && y >= 0 && y <= MAP_HEIGHT, `${x},${y}`);
  }
  const europe = fitViewport([project(-0.12, 51.5), project(12.37, 50.48), project(24.94, 60.17)], 8);
  assert.ok(europe.scale > 4, String(europe.scale));
  assert.equal(fitViewport([project(103.82, 1.35), project(103.82, 1.35)], 8).scale, 4);
  assert.deepEqual(fitViewport([], 8), { scale: 1, x: 0, y: 0 });
});

function pairwiseClear(slots: readonly SpreadSlot[], spacing: number): boolean {
  for (let i = 0; i < slots.length; i += 1) {
    if (Math.hypot(slots[i]!.dx, slots[i]!.dy) < spacing - 0.02) return false;
    for (let j = i + 1; j < slots.length; j += 1) {
      if (Math.hypot(slots[i]!.dx - slots[j]!.dx, slots[i]!.dy - slots[j]!.dy) < spacing - 0.02) return false;
    }
  }
  return true;
}

test("six nodes on one spot spread into one ring, the first at twelve o'clock", () => {
  const slots = spreadSlots(6, { x: 500, y: 300 }, { width: 1392, height: 696 }, 26, 13)!;
  assert.equal(slots.length, 6);
  assert.deepEqual(slots[0], { dx: 0, dy: -26 });
  for (const slot of slots) assert.ok(Math.abs(Math.hypot(slot.dx, slot.dy) - 26) < 0.01);
  assert.ok(pairwiseClear(slots, 26));
  // Clockwise: the second is up and to the right.
  assert.ok(slots[1]!.dx > 0 && slots[1]!.dy < 0);
});

test("twelve on one spot take the next ring's nearest cells, between the first six", () => {
  const slots = spreadSlots(12, { x: 500, y: 300 }, { width: 1392, height: 696 }, 26, 13)!;
  assert.equal(slots.length, 12);
  assert.ok(pairwiseClear(slots, 26));
  const outer = slots.slice(6).map((slot) => Math.hypot(slot.dx, slot.dy));
  for (const distance of outer) assert.ok(Math.abs(distance - 26 * Math.sqrt(3)) < 0.01, String(distance));
});

test("on a 343 px phone a pile of twelve at the map's edge still fits with 44 px targets", () => {
  // Los Angeles on a 343 by 171.5 px map at x1, 44 px targets 46 px apart.
  const frame = { width: 343, height: 171.5 };
  const anchor = { x: (171 / 1000) * 343, y: (155 / 500) * 171.5 };
  const slots = spreadSlots(12, anchor, frame, 46, 22)!;
  assert.equal(slots.length, 12);
  assert.ok(pairwiseClear(slots, 46));
  for (const slot of slots) {
    const x = anchor.x + slot.dx;
    const y = anchor.y + slot.dy;
    assert.ok(x >= 22 && x <= frame.width - 22 && y >= 22 && y <= frame.height - 22, `${x},${y}`);
  }
  // More than the frame holds: undefined, and the page lists them.
  assert.equal(spreadSlots(40, anchor, frame, 46, 22), undefined);
  assert.deepEqual(spreadSlots(0, anchor, frame, 46, 22), []);
});

test("a spread's box holds its targets", () => {
  const box = spreadBox({ x: 100, y: 100 }, [{ dx: 0, dy: -26 }, { dx: 22.52, dy: 13 }], 11);
  assert.deepEqual({ ...box, right: Math.round(box.right * 100) / 100 }, { left: 89, top: 63, right: 133.52, bottom: 124 });
});

test("an arrow key moves to the nearest marker on that side", () => {
  const marks = [
    { key: "la", x: 237, y: 216 },
    { key: "hnl", x: 86, y: 302 },
    { key: "lon", x: 696, y: 196 },
    { key: "fsn", x: 744, y: 198 },
    { key: "hel", x: 793, y: 141 },
    { key: "syd", x: 1281, y: 574 },
  ];
  assert.equal(nearestInDirection({ x: 237, y: 216 }, marks, "right"), "lon");
  assert.equal(nearestInDirection({ x: 237, y: 216 }, marks, "left"), "hnl");
  assert.equal(nearestInDirection({ x: 744, y: 198 }, marks, "up"), "hel");
  assert.equal(nearestInDirection({ x: 744, y: 198 }, marks, "down"), "syd");
  assert.equal(nearestInDirection({ x: 86, y: 302 }, marks, "left"), undefined);
});

test("a probe arc goes the short way round, bowed north", () => {
  const shanghai = project(121.47, 31.23);
  const la = project(-118.24, 34.05);
  const sydney = project(151.2, -33.87);
  const pacific = arcPaths(shanghai, la);
  assert.equal(pacific.length, 2, "Shanghai to Los Angeles crosses the map's edge");
  // The first piece leaves east past the right edge; the second arrives from the left.
  assert.match(pacific[0]!, /^M837\.4 /);
  assert.ok(Number(pacific[0]!.split(" ").at(-2)) > MAP_WIDTH);
  assert.ok(Number(pacific[1]!.slice(1).split(" ")[0]) < 0);
  const south = arcPaths(shanghai, sydney);
  assert.equal(south.length, 1);
  const europe = arcPaths(shanghai, project(12.37, 50.48));
  assert.equal(europe.length, 1);
  // Bowed north: the control point sits above the chord's middle.
  const [, , , cy] = europe[0]!.replace(/[MQ]/g, "").split(" ").map(Number);
  assert.ok(cy! < (shanghai.y + project(12.37, 50.48).y) / 2);
  assert.deepEqual(arcPaths(la, la), []);
});

test("a cluster's arc is its worst member, and nothing heard is never a colour", () => {
  const measured = (band: ArcReading["band"], loss = 0): ArcReading => ({ kind: "measured", band, loss });
  assert.deepEqual(clusterArcTone([measured("success"), measured("warning"), measured("chart-2")], 0.2), { tone: "warning", lossy: false });
  assert.deepEqual(clusterArcTone([measured("success"), { kind: "failing" }], 0.2), { tone: "failing", lossy: false });
  assert.deepEqual(clusterArcTone([measured("success", 0.25)], 0.2), { tone: "success", lossy: true });
  assert.deepEqual(clusterArcTone([{ kind: "unknown" }], 0.2), { tone: "unknown", lossy: false });
  assert.equal(clusterArcTone([{ kind: "paused" }, { kind: "notProbeable" }, undefined], 0.2), undefined);
});

test("500 nodes: clustering at every zoom step, a spread, the arrow keys and the arcs stay inside a frame's budget", () => {
  let seed = 11;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  // Half on 40 city spots (GeoIP centroids), half scattered: the shape that piles nodes up.
  const spots = Array.from({ length: 40 }, () => ({ x: random() * 1000, y: 60 + random() * 360 }));
  const points: MapPoint[] = Array.from({ length: 500 }, (_, i) => {
    const spot = spots[i % spots.length]!;
    const piled = i % 2 === 0;
    return { id: `n${String(i).padStart(3, "0")}`, x: piled ? spot.x : random() * 1000, y: piled ? spot.y : 40 + random() * 420, status: i % 23 ? "online" : "offline" };
  });
  const width = 1392;
  const unitsPerPx = MAP_WIDTH / width;
  const reachAt = (scale: number) => (count: number) => [{ dx: 0, dy: 0, r: ((clusterRadius(count) + 4) * unitsPerPx) / scale }];
  const started = performance.now();
  const max = maxZoomFor(width);
  let clusters: ReturnType<typeof clusterPoints> = [];
  for (let scale = 1; scale <= max; scale *= 1.5) clusters = clusterPoints(points, (18 * unitsPerPx) / scale, reachAt(scale));
  const clusterMs = performance.now() - started;
  const spreadStarted = performance.now();
  const slots = spreadSlots(200, { x: width / 2, y: width / 4 }, { width, height: width / 2 }, 26, 13);
  const marks = points.map((point) => ({ key: point.id, x: point.x, y: point.y }));
  for (const point of points) nearestInDirection(point, marks, "right");
  for (const point of points) arcPaths(spots[0]!, point);
  const restMs = performance.now() - spreadStarted;
  assert.equal(slots?.length, 200);
  assert.ok(clusters.length > 1);
  // About 20 ms (six zoom steps) and 5 ms on a laptop; the budgets catch a return to a cubic pass or a quadratic spread.
  assert.ok(clusterMs < 600, `clustering ${clusterMs.toFixed(0)} ms`);
  assert.ok(restMs < 250, `spread, keys and arcs ${restMs.toFixed(0)} ms`);
});

test("a click's zoom keeps every member in the frame, and splits as far as that allows", () => {
  const phone = (scale: number) => ({ radius: 18 / 0.343 / scale, reach: () => [{ dx: 0, dy: 0, r: 22 / 0.343 / scale }] });
  const max = 33.6;
  const margin = 28 / 0.343;
  const six = Array.from({ length: 6 }, (_, i) => spot(`la${i}`, 171.6, 155.4));
  const region = [spot("sb", 167.5, 154.3), spot("bk", 169.4, 151.7), spot("ps", 176.2, 156.0), spot("sd", 174.6, 159.6), spot("lv", 180.2, 149.5), spot("bs", 177.7, 153.1)];
  const honolulu = [spot("h1", 61.5, 191.2), spot("h2", 61.5, 191.2), spot("h3", 61.5, 191.2)];
  const pile = [...six, ...region, ...honolulu];
  const view = splitView(pile, phone, 1, max, margin)!;
  assert.ok(view.scale > 1.25 && view.scale < max, String(view.scale));
  for (const member of pile) {
    const x = view.x + member.x * view.scale;
    const y = view.y + member.y * view.scale;
    assert.ok(x >= margin - 1e-6 && x <= MAP_WIDTH - margin + 1e-6 && y >= margin - 1e-6 && y <= MAP_HEIGHT - margin + 1e-6, `${member.id} at ${x.toFixed(0)},${y.toFixed(0)}`);
  }
  assert.ok(clusterPoints(pile, phone(view.scale).radius, phone(view.scale).reach).length > 1);
  // The region alone nearly fits at the deepest split: the next click goes about that deep, and then the six spread.
  const next = splitView([...six, ...region], phone, view.scale, max, margin)!;
  assert.ok(next.scale > 30, String(next.scale));
  assert.equal(splitView(six, phone, max, max, margin), undefined);
  // Members too far apart for the first split to hold: the view centres on the biggest mark (the pair at 450), not on
  // the members' middle (500, which would put x at -125), and the pan is not clamped here, so the centring shows.
  const wide = splitView(
    [spot("d", 10, 250), spot("a", 450, 250), spot("b", 450, 250), spot("c", 990, 250)],
    (s) => ({ radius: 300 / s, reach: () => [{ dx: 0, dy: 0, r: 1 / s }] }),
    1,
    8,
    20,
  )!;
  assert.deepEqual(wide, { scale: 1.25, x: -62.5, y: -62.5 });
});

/** How far a point is from the segment from the origin to (x, y). */
function offLeader(point: SpreadSlot, end: SpreadSlot): number {
  const length2 = end.dx * end.dx + end.dy * end.dy;
  const t = Math.max(0, Math.min(1, (point.dx * end.dx + point.dy * end.dy) / length2));
  return Math.hypot(point.dx - t * end.dx, point.dy - t * end.dy);
}

/** Leader lines that run within `clear` px of another leg's mark. */
function linesThroughMarks(slots: readonly SpreadSlot[], clear: number): number {
  return slots.filter((end, i) => slots.some((mark, j) => i !== j && offLeader(mark, end) < clear)).length;
}

test("near the frame's edge no leader line runs through another leg's mark", () => {
  // A leg's mark is 7 px across the radius with a 1.5 px stroke; the map asks for 8 px of clearance.
  const phone = { width: 343, height: 171.5 };
  const cases = [
    { name: "phone, Los Angeles at x1", anchor: { x: (171 / 1000) * 343, y: (155 / 500) * 171.5 }, frame: phone, spacing: 46, inset: 23 },
    { name: "phone, mid frame", anchor: { x: 171.5, y: 85.75 }, frame: phone, spacing: 46, inset: 23 },
    { name: "1440, left edge", anchor: { x: 40, y: 200 }, frame: { width: 1392, height: 696 }, spacing: 26, inset: 13 },
  ];
  for (const { name, anchor, frame, spacing, inset } of cases) {
    // Taking the nearest cells alone ran lines straight through inner marks.
    assert.ok(linesThroughMarks(spreadSlots(12, anchor, frame, spacing, inset)!, 8) > 0, `${name}: the nearest cells alone cross marks`);
    const slots = spreadSlots(12, anchor, frame, spacing, inset, 8)!;
    assert.equal(slots.length, 12, name);
    assert.equal(linesThroughMarks(slots, 8), 0, name);
    assert.ok(pairwiseClear(slots, spacing), name);
    for (const slot of slots) {
      const x = anchor.x + slot.dx;
      const y = anchor.y + slot.dy;
      assert.ok(x >= inset && x <= frame.width - inset && y >= inset && y <= frame.height - inset, `${name}: ${x},${y}`);
    }
    // Still inner first: no slot is nearer the spot than one before it.
    const distances = slots.map((slot) => Math.hypot(slot.dx, slot.dy));
    assert.ok(distances.every((distance, i) => i === 0 || distance >= distances[i - 1]! - 0.01), name);
  }
  // Open ground keeps the compact layout: one ring of six, then the six between them.
  assert.deepEqual(spreadSlots(12, { x: 500, y: 300 }, { width: 1392, height: 696 }, 26, 13, 8), spreadSlots(12, { x: 500, y: 300 }, { width: 1392, height: 696 }, 26, 13));
  // The map glides a spot toward the middle when its spread here would cross a leg: leadersClear says which.
  assert.equal(leadersClear(spreadSlots(12, { x: 500, y: 300 }, { width: 1392, height: 696 }, 26, 13)!, 8), true);
  assert.equal(leadersClear([{ dx: 0, dy: -26 }, { dx: 0, dy: -52 }], 8), false, "a leg straight behind another");
  assert.equal(leadersClear([{ dx: 0, dy: -26 }, { dx: 22.52, dy: -65 }], 8), true, "8.5 px clear of the inner mark");
  // When only blocked cells are left they are still taken: twelve still fit wherever they fitted before.
  const tight = { width: 120, height: 120 };
  assert.equal(spreadSlots(6, { x: 60, y: 60 }, tight, 26, 13, 8)?.length, 6);
  assert.equal(spreadSlots(12, { x: 60, y: 60 }, tight, 26, 13, 8)?.length, spreadSlots(12, { x: 60, y: 60 }, tight, 26, 13)?.length);
});

test("a spread's capacity is exactly how many legs spreadSlots can place there", () => {
  const phone = { width: 343, height: 171.5 };
  for (const anchor of [{ x: 58.6, y: 53.2 }, { x: 171.5, y: 85.75 }, { x: 330, y: 160 }]) {
    const capacity = spreadCapacity(anchor, phone, 46, 23);
    assert.ok(capacity > 0, JSON.stringify(anchor));
    assert.equal(spreadSlots(capacity, anchor, phone, 46, 23)?.length, capacity);
    assert.equal(spreadSlots(capacity + 1, anchor, phone, 46, 23), undefined);
  }
  assert.equal(spreadCapacity({ x: 10, y: 10 }, { width: 20, height: 20 }, 46, 23), 0);
});

test("a click opens one node, zooms while a zoom splits, spreads a pile, and lists one the frame cannot hold", () => {
  const desk = (scale: number) => ({ radius: 18 / 1.392 / scale, reach: () => [{ dx: 0, dy: 0, r: 11 / 1.392 / scale }] });
  const la = Array.from({ length: 12 }, (_, i) => spot(`la${String(i).padStart(2, "0")}`, 171.6, 155.4));
  const sanJose = spot("sj", 161.4, 146.3);
  const fits = () => true;
  assert.deepEqual(clusterAction([sanJose], desk, 1, 8.28, 12, fits), { action: "open" });
  const zoom = clusterAction([...la, sanJose], desk, 1, 8.28, 12, fits);
  assert.equal(zoom.action, "zoom");
  assert.ok(zoom.action === "zoom" && zoom.view.scale > 1);
  assert.deepEqual(clusterAction(la, desk, 8.28, 8.28, 12, fits), { action: "spread" });
  // The frame cannot hold twelve apart: the click lists them, and the card says so.
  const asked: number[] = [];
  assert.deepEqual(clusterAction(la, desk, 8.28, 8.28, 12, (count) => (asked.push(count), false)), { action: "list" });
  assert.deepEqual(asked, [12]);
});

test("the latency layer reads as loading until both the plan and the rollups have answered", () => {
  const read = (hasData: boolean, failed = false) => ({ hasData, failed });
  const state = (plan: ReturnType<typeof read>, rollups: ReturnType<typeof read>, hasSource = true, canRead = true) =>
    latencyLayerState({ canRead, plan, rollups, hasSource });
  // The plan is in and the rollups are on their way: reading, not "nothing heard" from every target.
  assert.equal(state(read(true), read(false)), "loading");
  assert.equal(state(read(true), read(true)), "ready");
  assert.equal(state(read(false), read(false)), "loading");
  assert.equal(state(read(false), read(true)), "loading");
  assert.equal(state(read(false, true), read(false)), "failed");
  assert.equal(state(read(true), read(false, true)), "failed");
  // A failed refresh over an answer still shows the answer.
  assert.equal(state(read(true, true), read(true, true)), "ready");
  // No source configured: nothing to wait for.
  assert.equal(state(read(true), read(false), false), "nosource");
  assert.equal(state(read(true), read(true), true, false), "denied");
});

test("a leg's card sits clear of the spread and of the page's list", () => {
  const card = { width: 256, height: 220 };
  const frame = { width: 1392, height: 696 };
  const meets = (place: { left: number; top?: number; bottom?: number }, box: { left: number; top: number; right: number; bottom: number }) => {
    const top = place.top ?? frame.height - place.bottom! - card.height;
    return place.left < box.right && place.left + card.width > box.left && top < box.bottom && top + card.height > box.top;
  };
  // Los Angeles after one click at 1440: the spread at the left edge and the list to its right. The left side does not
  // fit, and the right side used to put the card on the list.
  const spread = { left: 20, top: 150, right: 130, bottom: 260 };
  const list = { left: 146, top: 150, right: 466, bottom: 510 };
  const beside = cardBesideSpread(spread, { y: 180 }, list, frame, card);
  assert.equal(beside.left, 476, "past the list's far edge");
  assert.ok(!meets(beside, spread) && !meets(beside, list));
  // Room on the side away from the list: there.
  const middle = { left: 600, top: 150, right: 710, bottom: 260 };
  const away = cardBesideSpread(middle, { y: 180 }, { left: 726, top: 150, right: 1046, bottom: 510 }, frame, card);
  assert.equal(away.left, 600 - 10 - 256);
  // The list on the left: the right side, clear of both.
  const right = cardBesideSpread(middle, { y: 180 }, { left: 264, top: 150, right: 584, bottom: 510 }, frame, card);
  assert.equal(right.left, 720);
  // A frame too narrow for any side: above the spread when it is low enough, inside the frame.
  const low = { left: 20, top: 400, right: 130, bottom: 510 };
  const narrow = { width: 700, height: 696 };
  const above = cardBesideSpread(low, { y: 420 }, { left: 146, top: 400, right: 466, bottom: 560 }, narrow, card);
  assert.ok(above.bottom !== undefined && narrow.height - above.bottom! <= low.top - 10, JSON.stringify(above));
  assert.ok(!meets({ ...above }, low));
  // No list (a phone lists the members under the map): the right side first, as before.
  assert.equal(cardBesideSpread(middle, { y: 180 }, null, frame, card).left, 720);
  // In the frame's lower half the card ends just below the leg.
  assert.deepEqual(cardBesideSpread(middle, { y: 600 }, null, frame, card), { left: 720, bottom: 696 - 616 });
});

test("an arc from a western source to Asia also goes the short way, west across the edge", () => {
  const la = project(-118.24, 34.05);
  const tokyo = project(139.69, 35.68);
  const pieces = arcPaths(la, tokyo);
  assert.equal(pieces.length, 2);
  // The first piece leaves west past the left edge; the second arrives from beyond the right edge.
  assert.ok(Number(pieces[0]!.split(" ").at(-2)) < 0, pieces[0]);
  assert.ok(Number(pieces[1]!.slice(1).split(" ")[0]) > MAP_WIDTH, pieces[1]);
});

test("an arrow key falls back to the nearest mark on that side when none lies within the cone", () => {
  const from = { x: 100, y: 100 };
  // Only a mark far off to the side on the right: still reachable with the right arrow.
  assert.equal(nearestInDirection(from, [{ key: "off", x: 120, y: 300 }, { key: "behind", x: 40, y: 100 }], "right"), "off");
  // A mark in the cone wins over a nearer one off the cone.
  assert.equal(nearestInDirection(from, [{ key: "off", x: 110, y: 160 }, { key: "cone", x: 200, y: 110 }], "right"), "cone");
});
