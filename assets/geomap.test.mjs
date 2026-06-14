import assert from "node:assert/strict";
import test from "node:test";

import {
  GEO_MAP_HEIGHT,
  GEO_MAP_WIDTH,
  geoClearPayload,
  geoLabel,
  geoPayload,
  nodesWithGeo,
  projectGeoPoint,
} from "./geomap.js";

test("projectGeoPoint uses equirectangular projection", () => {
  assert.deepEqual(projectGeoPoint(0, 0), { x: GEO_MAP_WIDTH / 2, y: GEO_MAP_HEIGHT / 2 });
  assert.deepEqual(projectGeoPoint(90, -180), { x: 0, y: 0 });
  assert.deepEqual(projectGeoPoint(-90, 180), { x: GEO_MAP_WIDTH, y: GEO_MAP_HEIGHT });
});

test("projectGeoPoint rejects invalid coordinates", () => {
  assert.throws(() => projectGeoPoint(91, 0), /lat/);
  assert.throws(() => projectGeoPoint(0, 181), /lon/);
  assert.throws(() => projectGeoPoint("nope", 0), /lat/);
});

test("geoPayload normalizes operator input", () => {
  assert.deepEqual(geoPayload({
    node_id: " node-a ",
    country: " jp ",
    city: " Tokyo ",
    lat: "35.6762",
    lon: "139.6503",
    asn: "2516",
    as_org: " KDDI ",
    provider: " oracle ",
  }), {
    node_id: "node-a",
    geo: {
      country: "JP",
      city: "Tokyo",
      lat: 35.6762,
      lon: 139.6503,
      asn: 2516,
      as_org: "KDDI",
      provider: "oracle",
    },
  });
});

test("geoPayload rejects missing or malformed fields", () => {
  assert.throws(() => geoPayload({ lat: 1, lon: 2 }), /node id/);
  assert.throws(() => geoPayload({ node_id: "n", lon: 2 }), /lat is required/);
  assert.throws(() => geoPayload({ node_id: "n", lat: 1, lon: 2, country: "JPN" }), /country/);
  assert.throws(() => geoPayload({ node_id: "n", lat: 1, lon: 2, asn: "-1" }), /asn/);
});

test("geoPayload preserves zero ASN when explicitly supplied", () => {
  assert.deepEqual(geoPayload({ node_id: "n", lat: 1, lon: 2, asn: 0 }), {
    node_id: "n",
    geo: {
      country: "",
      city: "",
      lat: 1,
      lon: 2,
      as_org: "",
      provider: "",
      asn: 0,
    },
  });
});

test("geoClearPayload trims node id", () => {
  assert.deepEqual(geoClearPayload(" node-a "), { node_id: "node-a", clear: true });
  assert.throws(() => geoClearPayload(""), /node id/);
});

test("nodesWithGeo keeps only valid coordinates", () => {
  const nodes = nodesWithGeo([
    { id: "ok", geo: { lat: 1, lon: 2 } },
    { id: "none" },
    { id: "badlat", geo: { lat: 200, lon: 2 } },
    { id: "badlon", geo: { lat: 1, lon: "x" } },
  ]);
  assert.deepEqual(nodes.map((n) => n.id), ["ok"]);
});

test("geoLabel builds compact tooltip text", () => {
  assert.equal(geoLabel({
    id: "node-a",
    name: "Tokyo",
    geo: { city: "Tokyo", country: "JP", asn: 2516, as_org: "KDDI", provider: "oracle" },
  }), "Tokyo · Tokyo, JP · AS2516 · KDDI · oracle");
});
