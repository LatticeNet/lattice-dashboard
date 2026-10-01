import assert from "node:assert/strict";
import { test } from "node:test";

import { clusterPoints, clusterRadius, clusterTone, project, ringPath, zoomToSplit, type MapPoint } from "../fleetMapModel.ts";

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
});

test("marks grow with their count and stop growing", () => {
  assert.equal(clusterRadius(1), 7);
  assert.ok(clusterRadius(13) > clusterRadius(4));
  assert.equal(clusterRadius(10_000), 7 * 2.6);
});

test("a cluster on one spot cannot be split by zooming; a spread one gets a zoom", () => {
  assert.equal(zoomToSplit([{ x: 1, y: 1 }, { x: 1.1, y: 1 }], 12, 1), undefined);
  const zoom = zoomToSplit([{ x: 100, y: 100 }, { x: 106, y: 100 }], 12, 1);
  assert.ok(zoom !== undefined && zoom >= 2 && zoom <= 5);
  assert.equal(zoomToSplit([{ x: 100, y: 100 }, { x: 106, y: 100 }], 12, 5), undefined);
});
