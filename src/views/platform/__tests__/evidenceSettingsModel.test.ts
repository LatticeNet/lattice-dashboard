import assert from "node:assert/strict";
import { test } from "node:test";

import type { EvidenceSettings } from "../../../lib/api/types.ts";
import {
  DAY,
  EVIDENCE_SETTINGS_BOUNDS,
  GIB,
  HOUR,
  MIB,
  displayAmount,
  effectiveBounds,
  fromFormValue,
  isFullAdministrator,
  parseSettingsDraft,
  rebaseSettingsDraft,
  settingsDraft,
  settingsRemovals,
  toFormValue,
} from "../evidenceSettingsModel.ts";

/** Today's values (design 26 R1): what an upgraded server answers before anyone saves. */
const TODAY: EvidenceSettings = {
  trace_db_max_bytes: 2 * GIB,
  record_ttl_seconds: 14 * DAY,
  line_ttl_seconds: 7 * DAY,
  rollup_5m_ttl_seconds: 90 * DAY,
  raw_source_max_bytes: 64 * MIB,
  version: 3,
};

const NOW = Date.parse("2026-10-05T10:00:00Z");

test("evidenceSettingsModel: GiB and days round-trip", () => {
  assert.equal(toFormValue("trace_db_max_bytes", 2 * GIB), "2");
  assert.equal(fromFormValue("trace_db_max_bytes", "2"), 2 * GIB);
  assert.equal(toFormValue("trace_db_max_bytes", 256 * MIB), "0.25");
  assert.equal(fromFormValue("trace_db_max_bytes", "0.25"), 256 * MIB);
  assert.equal(toFormValue("record_ttl_seconds", 14 * DAY), "14");
  assert.equal(fromFormValue("record_ttl_seconds", "14"), 14 * DAY);
  assert.equal(toFormValue("line_ttl_seconds", 7 * DAY), "168");
  assert.equal(fromFormValue("line_ttl_seconds", "168"), 7 * DAY);
  assert.equal(toFormValue("raw_source_max_bytes", 64 * MIB), "64");
  assert.equal(fromFormValue("raw_source_max_bytes", "64"), 64 * MIB);
  // Every field survives draft and parse unchanged.
  const parsed = parseSettingsDraft(settingsDraft(TODAY), TODAY);
  assert.deepEqual(parsed.settings, TODAY);
  assert.deepEqual(parsed.changed, []);
  assert.deepEqual(parsed.problems, {});
});

test("evidenceSettingsModel: an untouched value that does not round-trip is kept exactly", () => {
  const odd = { ...TODAY, trace_db_max_bytes: 1_000_000_000, line_ttl_seconds: 100_000 };
  const draft = settingsDraft(odd);
  assert.equal(draft.trace_db_max_bytes, "0.93");
  const parsed = parseSettingsDraft(draft, odd);
  assert.deepEqual(parsed.changed, [], "opening the form changes nothing");
  assert.equal(parsed.settings?.trace_db_max_bytes, 1_000_000_000);
  assert.equal(parsed.settings?.line_ttl_seconds, 100_000);
  // Typed over, it is parsed like any other entry.
  const edited = parseSettingsDraft({ ...draft, trace_db_max_bytes: "1" }, odd);
  assert.deepEqual(edited.changed, ["trace_db_max_bytes"]);
  assert.equal(edited.settings?.trace_db_max_bytes, GIB);
});

test("evidenceSettingsModel: values read in the unit that fits them", () => {
  assert.deepEqual(displayAmount("trace_db_max_bytes", 2 * GIB), { value: "2", unit: "GiB" });
  assert.deepEqual(displayAmount("trace_db_max_bytes", 1.5 * GIB), { value: "1.5", unit: "GiB" });
  assert.deepEqual(displayAmount("trace_db_max_bytes", 512 * MIB), { value: "512", unit: "MiB" });
  assert.deepEqual(displayAmount("raw_source_max_bytes", 64 * MIB), { value: "64", unit: "MiB" });
  assert.deepEqual(displayAmount("record_ttl_seconds", 14 * DAY), { value: "14", unit: "d" });
  assert.deepEqual(displayAmount("line_ttl_seconds", 36 * HOUR), { value: "36", unit: "h" });
  assert.deepEqual(displayAmount("line_ttl_seconds", 6 * HOUR), { value: "6", unit: "h" });
});

test("evidenceSettingsModel: rejects values outside the server bounds", () => {
  const draft = { ...settingsDraft(TODAY), trace_db_max_bytes: "0.1", record_ttl_seconds: "91", line_ttl_seconds: "abc" };
  const parsed = parseSettingsDraft(draft, TODAY);
  assert.equal(parsed.settings, undefined);
  assert.deepEqual(parsed.problems, {
    trace_db_max_bytes: "below",
    record_ttl_seconds: "above",
    line_ttl_seconds: "invalid",
  });
  // The edges themselves are allowed.
  const edges = {
    trace_db_max_bytes: "16",
    record_ttl_seconds: "1",
    line_ttl_seconds: "1",
    rollup_5m_ttl_seconds: "400",
    raw_source_max_bytes: "1024",
  };
  const ok = parseSettingsDraft(edges, TODAY);
  assert.deepEqual(ok.problems, {});
  assert.equal(ok.settings?.version, TODAY.version, "the body names the version it was read at");
  assert.equal(parseSettingsDraft({ ...edges, raw_source_max_bytes: "0" }, TODAY).problems.raw_source_max_bytes, "invalid");
  assert.equal(parseSettingsDraft({ ...edges, raw_source_max_bytes: "" }, TODAY).problems.raw_source_max_bytes, "invalid");
});

test("evidenceSettingsModel: the server's bounds win where it sent them", () => {
  const bounds = effectiveBounds({ record_ttl_seconds: [2 * DAY, 30 * DAY] });
  assert.deepEqual(bounds.record_ttl_seconds, [2 * DAY, 30 * DAY]);
  assert.deepEqual(bounds.trace_db_max_bytes, EVIDENCE_SETTINGS_BOUNDS.trace_db_max_bytes);
  assert.deepEqual(effectiveBounds(undefined), EVIDENCE_SETTINGS_BOUNDS);
  // A malformed pair is ignored rather than trusted.
  assert.deepEqual(
    effectiveBounds({ line_ttl_seconds: [1] as unknown as [number, number] }).line_ttl_seconds,
    EVIDENCE_SETTINGS_BOUNDS.line_ttl_seconds,
  );
  const draft = { ...settingsDraft(TODAY), record_ttl_seconds: "1" };
  assert.equal(parseSettingsDraft(draft, TODAY, bounds).problems.record_ttl_seconds, "below");
});

test("evidenceSettingsModel: lowering a cap states how much it removes", () => {
  const next = { ...TODAY, trace_db_max_bytes: 1 * GIB };
  assert.deepEqual(settingsRemovals(TODAY, next, { traceDbBytes: 1.8 * GIB, nowMs: NOW }), [
    { field: "trace_db_max_bytes", kind: "bytes", bytes: 0.8 * GIB },
  ]);
  // Under the new cap already: nothing to remove, nothing to say.
  assert.deepEqual(settingsRemovals(TODAY, next, { traceDbBytes: 0.5 * GIB, nowMs: NOW }), []);
  // Unknown size: the removal is stated without an amount.
  assert.deepEqual(settingsRemovals(TODAY, next, { nowMs: NOW }), [{ field: "trace_db_max_bytes", kind: "bytes" }]);
  // Raising a cap removes nothing.
  assert.deepEqual(settingsRemovals(TODAY, { ...TODAY, trace_db_max_bytes: 4 * GIB }, { nowMs: NOW }), []);
});

test("evidenceSettingsModel: lowering a TTL states the age it removes", () => {
  const shorter = { ...TODAY, record_ttl_seconds: 3 * DAY, line_ttl_seconds: 1 * DAY, rollup_5m_ttl_seconds: 30 * DAY };
  assert.deepEqual(settingsRemovals(TODAY, shorter, { oldestRecordAt: "2026-09-25T10:00:00Z", nowMs: NOW }), [
    { field: "record_ttl_seconds", kind: "age", olderThanSeconds: 3 * DAY },
    { field: "line_ttl_seconds", kind: "age", olderThanSeconds: DAY },
    { field: "rollup_5m_ttl_seconds", kind: "age", olderThanSeconds: 30 * DAY },
  ]);
  // The oldest record is younger than the new TTL: no record goes.
  assert.deepEqual(
    settingsRemovals(TODAY, { ...TODAY, record_ttl_seconds: 3 * DAY }, { oldestRecordAt: "2026-10-04T10:00:00Z", nowMs: NOW }),
    [],
  );
});

test("evidenceSettingsModel: a lower raw cap counts what each source holds over it", () => {
  const next = { ...TODAY, raw_source_max_bytes: 16 * MIB };
  assert.deepEqual(settingsRemovals(TODAY, next, { rawSourceBytes: [40 * MIB, 2 * MIB, 20 * MIB], nowMs: NOW }), [
    { field: "raw_source_max_bytes", kind: "bytes", bytes: 28 * MIB },
  ]);
  assert.deepEqual(settingsRemovals(TODAY, next, { rawSourceBytes: [2 * MIB], nowMs: NOW }), []);
});

test("evidenceSettingsModel: only a full administrator without a node restriction may save", () => {
  assert.equal(isFullAdministrator(["*"], []), true);
  assert.equal(isFullAdministrator(["*"], ["*"]), true);
  assert.equal(isFullAdministrator(["*"], ["node_a"]), false);
  assert.equal(isFullAdministrator(["log:admin", "log:read"], []), false);
});

test("evidenceSettingsModel: after a 409 the operator's edits ride on the other save", () => {
  const theirs = { ...TODAY, record_ttl_seconds: 21 * DAY, rollup_5m_ttl_seconds: 60 * DAY, version: TODAY.version + 1 };
  const mine = { ...settingsDraft(TODAY), rollup_5m_ttl_seconds: "120", raw_source_max_bytes: "128" };
  const rebased = rebaseSettingsDraft(mine, TODAY, theirs);
  assert.equal(rebased.draft.record_ttl_seconds, "21", "a field I left alone takes their value");
  assert.equal(rebased.draft.rollup_5m_ttl_seconds, "120", "my edit stands");
  assert.equal(rebased.draft.raw_source_max_bytes, "128");
  assert.deepEqual(rebased.theirs, ["record_ttl_seconds", "rollup_5m_ttl_seconds"]);
  assert.deepEqual(rebased.clashes, ["rollup_5m_ttl_seconds"]);
  // Saving it now changes only what I edited, at their version.
  const parsed = parseSettingsDraft(rebased.draft, theirs);
  assert.deepEqual(parsed.changed, ["rollup_5m_ttl_seconds", "raw_source_max_bytes"]);
  assert.equal(parsed.settings?.version, theirs.version);
  assert.equal(parsed.settings?.record_ttl_seconds, 21 * DAY);
});
