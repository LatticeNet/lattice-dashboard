import assert from "node:assert/strict";
import { test } from "node:test";

import { LAYER_PARAM, canonicalLayerQuery, resolveLayer, writeLayer } from "../layerModel.ts";

const LAYERS = ["overview", "routes", "tokens"] as const;

test("view names the layer, and an unknown or missing one falls back", () => {
  assert.equal(LAYER_PARAM, "view");
  assert.equal(resolveLayer({ view: "routes" }, LAYERS, "overview"), "routes");
  assert.equal(resolveLayer({ view: "nope" }, LAYERS, "overview"), "overview");
  assert.equal(resolveLayer({}, LAYERS, "overview"), "overview");
});

test("an old ?tab= link is read when view says nothing it can use", () => {
  assert.equal(resolveLayer({ tab: "tokens" }, LAYERS, "overview"), "tokens");
  assert.equal(resolveLayer({ view: "nope", tab: "tokens" }, LAYERS, "overview"), "tokens");
  assert.equal(resolveLayer({ view: "routes", tab: "tokens" }, LAYERS, "overview"), "routes");
});

test("writing a layer keeps other keys, drops the old tab key, and leaves the default bare", () => {
  assert.deepEqual(writeLayer({ q: "x", tab: "tokens" }, "routes", "overview"), { q: "x", view: "routes" });
  assert.deepEqual(writeLayer({ q: "x", view: "routes" }, "overview", "overview"), { q: "x" });
});

test("an old link is rewritten once to its canonical spelling, and a canonical one is left alone", () => {
  assert.deepEqual(canonicalLayerQuery({ tab: "tokens", open: "t1" }, LAYERS, "overview"), { open: "t1", view: "tokens" });
  assert.deepEqual(canonicalLayerQuery({ tab: "graph" }, LAYERS, "overview"), {});
  assert.equal(canonicalLayerQuery({ view: "tokens" }, LAYERS, "overview"), null);
  assert.equal(canonicalLayerQuery({}, LAYERS, "overview"), null);
});
