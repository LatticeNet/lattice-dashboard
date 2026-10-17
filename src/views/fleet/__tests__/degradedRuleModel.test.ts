import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DEGRADED_BOUNDS,
  canonicalRule,
  defaultDegradedDraft,
  degradedDraftFrom,
  degradedEdit,
  degradedForSave,
  degradedProblems,
  fieldValue,
  isDefaultRule,
  type DegradedField,
} from "../degradedRuleModel.ts";

/*
 * The bounds and defaults are written out here as literals, copied from
 * lattice-sdk model/paths.go (MonitorDegraded*Default, *Min, *Max) and the
 * table in design 29 D13, and never read back from DEGRADED_BOUNDS: a test
 * that read the module's own constants would pass whatever they drifted to.
 */
const SDK: Record<DegradedField, { json: string; def: number; min: number; max: number; below: number; above: number }> = {
  lossPercent: { json: "loss_percent", def: 2, min: 0.5, max: 50, below: 0.4, above: 50.1 },
  lossFactor: { json: "loss_factor", def: 2, min: 1.2, max: 10, below: 1.1, above: 10.1 },
  latencyFactor: { json: "latency_factor", def: 2, min: 1.2, max: 10, below: 1.1, above: 10.1 },
  latencyMarginMs: { json: "latency_margin_ms", def: 30, min: 5, max: 1000, below: 4, above: 1001 },
};

const at = (field: DegradedField, value: number | string) => degradedProblems({ ...defaultDegradedDraft(), [field]: value });

test("the module's bounds and defaults are the SDK's", () => {
  for (const [field, sdk] of Object.entries(SDK) as [DegradedField, (typeof SDK)[DegradedField]][]) {
    const b = DEGRADED_BOUNDS[field];
    assert.deepEqual([b.json, b.default, b.min, b.max], [sdk.json, sdk.def, sdk.min, sdk.max], field);
  }
  assert.deepEqual(defaultDegradedDraft(), { lossPercent: 2, lossFactor: 2, latencyFactor: 2, latencyMarginMs: 30 });
});

test("each field: just below its minimum, the minimum, the maximum and just above it", () => {
  for (const [field, sdk] of Object.entries(SDK) as [DegradedField, (typeof SDK)[DegradedField]][]) {
    assert.deepEqual(at(field, sdk.below), [field], `${field} ${sdk.below} is under the minimum`);
    assert.deepEqual(at(field, sdk.min), [], `${field} ${sdk.min} is the minimum`);
    assert.deepEqual(at(field, sdk.max), [], `${field} ${sdk.max} is the maximum`);
    assert.deepEqual(at(field, sdk.above), [field], `${field} ${sdk.above} is over the maximum`);
  }
});

test("rounding comes first: the console sends the rounded value, so it checks the rounded value", () => {
  // 0.45 rounds to 0.5, which the server accepts, and 0.5 is what the console sends.
  assert.deepEqual(at("lossPercent", 0.45), []);
  assert.deepEqual(canonicalRule({ ...defaultDegradedDraft(), lossPercent: 0.45 }), { loss_percent: 0.5 });
  assert.deepEqual(at("lossPercent", 0.44), ["lossPercent"], "0.44 rounds to 0.4, under the minimum");
  assert.deepEqual(at("lossPercent", "50.04"), [], "typed 50.04 rounds to 50");
  assert.deepEqual(at("lossPercent", "50.05"), ["lossPercent"], "50.05 rounds to 50.1");
  assert.deepEqual(at("lossFactor", 1.15), [], "1.15 rounds to 1.2");
  assert.deepEqual(at("lossFactor", 1.14), ["lossFactor"]);
  // The margin keeps whole milliseconds.
  assert.deepEqual(at("latencyMarginMs", 4.5), [], "4.5 ms rounds to 5");
  assert.deepEqual(at("latencyMarginMs", 4.4), ["latencyMarginMs"]);
  assert.deepEqual(at("latencyMarginMs", 1000.4), []);
  assert.deepEqual(at("latencyMarginMs", 1000.5), ["latencyMarginMs"]);
  assert.deepEqual(canonicalRule({ ...defaultDegradedDraft(), latencyMarginMs: 44.6 }), { latency_margin_ms: 45 });
});

test("what the server refuses: NaN, infinities, negatives, text; an empty field is the default and a typed 0 is refused", () => {
  for (const field of Object.keys(SDK) as DegradedField[]) {
    assert.deepEqual(at(field, Number.NaN), [field], `${field} NaN`);
    assert.deepEqual(at(field, "NaN"), [field], `${field} "NaN" typed`);
    assert.deepEqual(at(field, Number.POSITIVE_INFINITY), [field], `${field} infinite`);
    assert.deepEqual(at(field, -1), [field], `${field} negative`);
    assert.deepEqual(at(field, "abc"), [field], `${field} text`);
    assert.deepEqual(at(field, ""), [], `${field} empty reads as the default`);
    assert.equal(fieldValue({ ...defaultDegradedDraft(), [field]: "" }, field), SDK[field].def);
    assert.deepEqual(at(field, 0), [field], `${field} 0 means none, which no threshold allows`);
  }
});

test("a stored rule: zero and an absent field read as the default; nil is every default", () => {
  assert.deepEqual(degradedDraftFrom(undefined), defaultDegradedDraft());
  assert.deepEqual(degradedDraftFrom(null), defaultDegradedDraft());
  assert.deepEqual(degradedDraftFrom({ loss_percent: 0, loss_factor: 0, latency_factor: 0, latency_margin_ms: 0 }), defaultDegradedDraft());
  assert.deepEqual(degradedDraftFrom({ latency_factor: 3 }), { lossPercent: 2, lossFactor: 2, latencyFactor: 3, latencyMarginMs: 30 });
  assert.equal(isDefaultRule(degradedDraftFrom({ loss_percent: 0 })), true);
});

test("the canonical form leaves defaults out, and a whole save stores nothing when every field is default", () => {
  assert.deepEqual(canonicalRule(defaultDegradedDraft()), {});
  assert.deepEqual(canonicalRule({ lossPercent: "2.0", lossFactor: 2, latencyFactor: "", latencyMarginMs: 30.2 }), {}, "typed defaults and rounding to the default");
  assert.equal(degradedForSave(defaultDegradedDraft()), undefined);
  assert.deepEqual(degradedForSave({ ...defaultDegradedDraft(), lossFactor: 3 }), { loss_factor: 3 });
});

test("an edit: undefined when unchanged, {} for a reset, the whole canonical rule otherwise", () => {
  const stored = { loss_percent: 5, latency_margin_ms: 50 };
  assert.equal(degradedEdit(stored, degradedDraftFrom(stored)), undefined, "unchanged");
  assert.equal(degradedEdit(undefined, defaultDegradedDraft()), undefined, "nothing stored, nothing changed");
  assert.equal(degradedEdit({ loss_percent: 2 }, defaultDegradedDraft()), undefined, "a stored default is the default");
  assert.deepEqual(degradedEdit(stored, defaultDegradedDraft()), {}, "a reset to the defaults");
  assert.deepEqual(degradedEdit(stored, { ...degradedDraftFrom(stored), lossFactor: 3 }), { loss_percent: 5, loss_factor: 3, latency_margin_ms: 50 }, "replaces the stored rule whole");
});
