import assert from "node:assert/strict";
import { test } from "node:test";

import type { CheckDefinitionPreview, CheckDefinitionView, MonitorView } from "@/lib/api/types";

import {
  addressesOf,
  applyDefinitionFix,
  buildDefinitionSave,
  checkRowGroup,
  checkRows,
  definitionDirty,
  definitionProblems,
  draftFromDefinition,
  emptyDefinitionDraft,
  missingParts,
  pathsHealth,
  suggestDefinitionName,
  skippedByReason,
  measureAgainSave,
  stopMeasuringSave,
  summarizePreview,
  takesAddresses,
  takesTargetNodes,
  withKind,
} from "../definitionsModel.ts";
import { rowsFromHeaders } from "../checkHeadersModel.ts";

const stored = (over: Partial<CheckDefinitionView> = {}): CheckDefinitionView => ({
  id: "chk_a",
  name: "edge tcp",
  type: "tcp",
  sources: { nodes: ["n-sh"] },
  targets: { groups: ["grp_edge"] },
  interval_sec: 60,
  timeout_sec: 5,
  alert: "down",
  enabled: true,
  version: 3,
  created_at: "2026-10-24T09:00:00Z",
  updated_at: "2026-10-24T09:00:00Z",
  summary: { monitors: 2, paths: 2, paused_targets: 1, paused_runs: 40 },
  ...over,
});

test("a new definition needs sources and a target, and says so as what is still needed", () => {
  const draft = emptyDefinitionDraft("tcp");
  const problems = definitionProblems(draft, { newDefinition: true });
  assert.deepEqual(missingParts(problems), ["sources", "target"]);
  const ready = { ...draft, sources: { all: true }, targets: { nodes: ["n-jp"] } };
  assert.deepEqual(definitionProblems(ready, { newDefinition: true }), []);
  // A tls check runs on the control plane: no sources needed, an address is.
  const tls = withKind(ready, "tls");
  assert.deepEqual(missingParts(definitionProblems(tls, { newDefinition: true })), ["target"]);
  assert.deepEqual(definitionProblems({ ...tls, addressText: "example.com:443" }, { newDefinition: true }), []);
  // The sets stay in the draft but a tls save sends none, and coming back finds them (design review: a method change wiped them).
  const tlsSave = buildDefinitionSave({ ...tls, addressText: "example.com:443" }, undefined, "certs");
  assert.deepEqual([tlsSave.sources, tlsSave.targets], [{}, {}]);
  assert.deepEqual(withKind(withKind(ready, "http"), "tcp").targets, ready.targets);
  assert.deepEqual(withKind(tls, "icmp").sources, ready.sources);
});

test("addresses are one per line or comma separated, checked by the method's rules", () => {
  assert.deepEqual(addressesOf(" https://a.example/x \n\nhttps://b.example, https://a.example/x"), ["https://a.example/x", "https://b.example"]);
  const http = { ...emptyDefinitionDraft("http"), sources: { nodes: ["n-sh"] } };
  assert.ok(definitionProblems({ ...http, addressText: "not a url" }, { newDefinition: true }).includes("address"));
  assert.ok(definitionProblems({ ...http, addressText: "http://10.0.0.1/" }, { newDefinition: true }).includes("destination"));
  // A beacon names nodes only: typed addresses stay in the draft and are not sent.
  const beacon = withKind({ ...http, addressText: "https://a.example", targets: { nodes: ["n-jp"] } }, "beacon");
  assert.equal(beacon.addressText, "https://a.example");
  assert.equal(buildDefinitionSave(beacon, undefined, "b").addresses, undefined);
});

test("secret headers refuse a group or whole-fleet source, as the server does", () => {
  const draft = { ...emptyDefinitionDraft("http"), sources: { groups: ["grp_dom"] }, addressText: "https://api.example.com/health" };
  draft.headers = [{ key: "h1", name: "X-Api-Key", value: "s3cret", secret: true, replacing: false }];
  assert.ok(definitionProblems(draft, { newDefinition: true }).includes("secretSources"));
  assert.ok(!definitionProblems({ ...draft, sources: { nodes: ["n-sh"] } }, { newDefinition: true }).includes("secretSources"));
});

test("a create sends every header as a set operation; an edit sends only what changed", () => {
  const draft = { ...emptyDefinitionDraft("http"), sources: { nodes: ["n-sh"] }, addressText: "https://api.example.com/health" };
  draft.headers = [{ key: "h1", name: "X-Api-Key", value: "s3cret", secret: true, replacing: false }];
  const create = buildDefinitionSave(draft, undefined, "HTTP api.example.com/health");
  assert.equal(create.id, undefined);
  assert.equal(create.name, "HTTP api.example.com/health");
  assert.deepEqual(create.headers, [{ name: "X-Api-Key", op: "set", value: "s3cret", secret: true }]);
  assert.deepEqual(create.addresses, ["https://api.example.com/health"]);

  const saved = stored({ type: "http", targets: {}, addresses: ["https://api.example.com/health"], headers: [{ name: "X-Api-Key", secret: true, set: true }] });
  const edit = draftFromDefinition(saved);
  assert.deepEqual(edit.headers, rowsFromHeaders(saved.headers));
  const body = buildDefinitionSave(edit, saved, saved.name);
  assert.equal(body.id, "chk_a");
  assert.equal(body.version, 3);
  assert.equal(body.headers, undefined, "a kept secret is never sent back");
  assert.equal(definitionDirty(saved, edit, saved.name), false);
  assert.equal(definitionDirty(saved, { ...edit, intervalSec: 120 }, saved.name), true);
  assert.equal(definitionDirty(saved, { ...edit, sources: { nodes: ["n-sh", "n-bj"] } }, saved.name), true);
});

test("an unchanged selector echoed in another order is not an edit", () => {
  const saved = stored({ sources: { nodes: ["n-a", "n-b"] } });
  const draft = { ...draftFromDefinition(saved), sources: { nodes: ["n-b", "n-a"], exclude: [] } };
  assert.equal(definitionDirty(saved, draft, saved.name), false);
});

test("the suggested name names the method and the first targets", () => {
  const draft = { ...emptyDefinitionDraft("tcp"), targets: { groups: ["grp_edge"], nodes: ["n-jp", "n-us"] } };
  assert.equal(suggestDefinitionName(draft, (id) => id.slice(2), () => "edge", "the whole fleet"), "TCP edge, jp +1");
  assert.equal(suggestDefinitionName(emptyDefinitionDraft("tcp"), (id) => id, (id) => id, "the whole fleet"), "");
  // Names are counted in bytes, as the server counts them: 41 Chinese characters are 123 bytes.
  const cjk = "节".repeat(41);
  assert.ok(definitionProblems({ ...draft, name: cjk }, { newDefinition: true }).includes("name"));
  assert.ok(!definitionProblems({ ...draft, name: "节".repeat(40) }, { newDefinition: true }).includes("name"));
  const long = suggestDefinitionName({ ...emptyDefinitionDraft("tcp"), targets: { nodes: ["n1"] } }, () => "节".repeat(60), () => "", "");
  assert.ok(new TextEncoder().encode(long).length <= 80 && long.startsWith("TCP 节"), "a suggestion is cut at a whole character");
});

test("the dry run reads as paths, dead targets and pairs by reason, without counting a dead target's pairs twice", () => {
  const preview: CheckDefinitionPreview = {
    sources: ["n-sh", "n-bj"],
    targets: [
      { monitor_id: "m1", target: "203.0.113.3:443", target_node: "n-jp" },
      { monitor_id: "m2", target: "", target_node: "n-hk", reason: "not_probeable", note: "udp_only" },
      { monitor_id: "m3", target: "", target_node: "n-kr", reason: "not_probeable", note: "udp_only" },
    ],
    pairs: [
      { source: "n-sh", monitor_id: "m1" },
      { source: "n-bj", monitor_id: "m1", reason: "packet_budget" },
      { source: "n-sh", monitor_id: "m2", reason: "not_probeable" },
      { source: "n-bj", monitor_id: "m2", reason: "not_probeable" },
      { source: "n-sh", monitor_id: "m3", reason: "not_probeable" },
      { source: "n-bj", monitor_id: "m3", reason: "not_probeable" },
    ],
    paths: 6,
    measured: 1,
    writes: { created: ["m1", "m2", "m3"], updated: [], paused: [], deleted: [] },
  };
  const s = summarizePreview(preview);
  assert.equal(s.paths, 6);
  assert.deepEqual(s.targets, [{ reason: "not_probeable", note: "udp_only", count: 2 }]);
  assert.deepEqual(s.pairs, [{ reason: "packet_budget", count: 1 }]);
  assert.equal(s.created, 3);
});

test("a definition's health comes from its paths, in the list's vocabulary", () => {
  const now = Date.parse("2026-10-24T09:00:00Z");
  assert.deepEqual(pathsHealth([], true, now), { kind: "none" });
  assert.deepEqual(pathsHealth([{ state: "up" }], false, now), { kind: "disabled" });
  assert.equal(pathsHealth([{ state: "down" }, { state: "up" }], true, now).kind, "failing");
  const degraded = pathsHealth([{ state: "degraded" }, { state: "up" }, { state: "unknown", reason: "agent_offline" }], true, now);
  assert.deepEqual(degraded, { kind: "degraded", degraded: 1, total: 2, lastAt: now });
  assert.deepEqual(pathsHealth([{ state: "unknown", reason: "not_probeable" }], true, now), { kind: "unmeasured", total: 1, reason: "not_probeable", lastAt: now });
  // Up on how many of all its paths, and no latency: the p50s of different pairs make no one figure.
  const up = pathsHealth([{ state: "up", p50Ms: 40 }, { state: "up", p50Ms: 120 }, { state: "unknown", reason: "agent_offline" }], true, now);
  assert.deepEqual(up, { kind: "up", total: 2, of: 3, lastAt: now });
  // A pause is a choice, not a reason the check measures nothing.
  assert.deepEqual(pathsHealth([{ state: "unknown", reason: "source_paused" }], true, now), { kind: "none" });
});

test("the list holds definitions, single checks and an unmigrated Fleet mesh, never the monitors they generated", () => {
  const monitors = [
    { id: "mon_1", name: "web", type: "http", target: "https://x", interval_sec: 60, timeout_sec: 5, enabled: true },
    { id: "mon_lat_n-jp", name: "Latency to jp", type: "tcp", target: "x", interval_sec: 60, timeout_sec: 5, enabled: true, managed_by: "latency" },
    { id: "mon_chk_a_1", name: "edge tcp to jp", type: "tcp", target: "x", interval_sec: 60, timeout_sec: 5, enabled: true, managed_by: "check:chk_a", check_definition_id: "chk_a" },
  ] as MonitorView[];
  const mesh = { name: "Fleet mesh", enabled: true, stored: true, version: 2, method: "auto", sources: 1, targets: 3, paths: 3, paused_targets: 0 };
  const rows = checkRows(monitors, [stored()], mesh);
  assert.deepEqual(rows.map((r) => [r.kind, checkRowGroup(r)]), [["definition", "checks"], ["check", "checks"], ["fleet", "builtin"]]);
});

/* ---- Design 32 R1, R2 and R3 ---- */

test("R1: a migrated Fleet mesh is an ordinary definition; the list has no built-in group", () => {
  const monitors = [
    // An adopted path set monitor keeps managed_by "latency" and names its definition: the definition stands for it.
    { id: "mon_lat_n-jp", name: "Fleet mesh to jp", type: "tcp", target: "x", interval_sec: 60, timeout_sec: 5, enabled: true, managed_by: "latency", check_definition_id: "chk_fleet_mesh" },
  ] as MonitorView[];
  const mesh = { name: "Fleet mesh", enabled: true, stored: true, version: 5, method: "tcp", sources: 0, targets: 0, paths: 0, paused_targets: 0, migrated: true, definitions: ["chk_fleet_mesh"] };
  const rows = checkRows(monitors, [stored({ id: "chk_fleet_mesh", name: "Fleet mesh" })], mesh);
  assert.deepEqual(rows.map((r) => [r.kind, r.key, checkRowGroup(r)]), [["definition", "def:chk_fleet_mesh", "checks"]]);
});

test("R1: auto takes target nodes only, sends packets for its icmp and beacon pairs, and keeps its excluded pairs through an edit", () => {
  assert.equal(takesTargetNodes("auto"), true);
  assert.equal(takesAddresses("auto"), false);
  const def = stored({ id: "chk_fleet_mesh", type: "auto", packets: 3, targets: { all: true, exclude: ["n-sh"] }, excluded_pairs: [{ source: "n-sh", target: "n-us" }] });
  const draft = draftFromDefinition(def);
  assert.equal(draft.type, "auto");
  assert.deepEqual(definitionProblems(draft, { newDefinition: false }), []);
  const save = buildDefinitionSave(draft, def, def.name);
  assert.equal(save.type, "auto");
  assert.equal(save.packets, 3);
  assert.equal(save.addresses, undefined);
  assert.deepEqual(save.excluded_pairs, [{ source: "n-sh", target: "n-us" }], "an edit never drops the pairs the operator stopped measuring");
  assert.equal(definitionDirty(def, draft, def.name), false);
  // A method that takes no nodes has no pairs to exclude, so a save leaves them out rather than be refused.
  assert.equal(buildDefinitionSave(withKind(draft, "http"), def, def.name).excluded_pairs, undefined);
  assert.equal(suggestDefinitionName({ ...emptyDefinitionDraft("auto"), targets: { all: true } }, (id) => id, (id) => id, "whole fleet"), "AUTO whole fleet");
});

test("R2: a definition's skipped pairs group by reason, each with its fix", () => {
  const pair = (target: string, reason: string, targetName = target) => ({ key: `sh~${target}`, source: "sh", sourceName: "cd-hs-sh", targetNode: target, targetName, reason, measure: "skipped" as const });
  const groups = skippedByReason(
    [pair("bare1", "not_probeable"), pair("bare2", "not_probeable"), pair("jp", "beacon_source_pending"), pair("de", "packet_budget"), pair("old", "agent_too_old"), { ...pair("x", "source_paused"), measure: "paused" as const }],
    "tcp",
  );
  assert.deepEqual(
    groups.map((g) => [g.reason, g.paths.map((p) => p.targetNode), g.fixes]),
    [
      ["not_probeable", ["bare1", "bare2"], ["auto", "exclude"]],
      // A source that cannot run the method or is over its budget: only those pairs stop, never the
      // target for every source, whose other pairs may be measured and healthy.
      ["agent_too_old", ["old"], ["auto", "pairs"]],
      ["beacon_source_pending", ["jp"], ["approve"]],
      ["packet_budget", ["de"], ["pairs"]],
    ],
  );
  // An auto check already chooses per pair: excluding is the only fix left for a target it cannot reach.
  assert.deepEqual(skippedByReason([pair("bare1", "not_probeable")], "auto")[0]!.fixes, ["exclude"]);
  assert.deepEqual(skippedByReason([pair("old", "icmp_not_permitted")], "auto")[0]!.fixes, ["pairs"]);
  // A reason the console does not know stops only its pairs.
  assert.deepEqual(skippedByReason([pair("odd", "something_new")], "tcp")[0]!.fixes, ["pairs"]);
});

test("R2: a fix opens the editor with the change made: auto as the method, or the targets left out of the set", () => {
  const def = stored({ type: "tcp", targets: { all: true, exclude: ["n-sh"] } });
  const auto = applyDefinitionFix(draftFromDefinition(def), { kind: "auto" });
  assert.equal(auto.type, "auto");
  const out = applyDefinitionFix(draftFromDefinition(def), { kind: "exclude", targets: ["bare2", "bare1", "n-sh"] });
  assert.deepEqual(out.targets, { all: true, exclude: ["bare1", "bare2", "n-sh"] });
  // Named nodes leave the list rather than sit both named and excluded (the picker never shows both).
  const named = applyDefinitionFix(draftFromDefinition(stored({ targets: { nodes: ["a", "bare1"] } })), { kind: "exclude", targets: ["bare1"] });
  assert.deepEqual(named.targets, { nodes: ["a"] });
  assert.equal(definitionDirty(def, out, def.name), true);
  // Pairs: added to the excluded pairs once each, the targets untouched.
  const withPair = stored({ type: "icmp", targets: { all: true }, excluded_pairs: [{ source: "n-sh", target: "n-us" }] });
  const stopped = applyDefinitionFix(draftFromDefinition(withPair), { kind: "pairs", pairs: [{ source: "n-sh", target: "n-us" }, { source: "n-bj", target: "n-jp" }] });
  assert.deepEqual(stopped.excludedPairs, [{ source: "n-sh", target: "n-us" }, { source: "n-bj", target: "n-jp" }]);
  assert.deepEqual(stopped.targets, { all: true });
});

test("R3: Stop measuring this pair is the check's normal save with the pair excluded, at the version read", () => {
  const def = stored({ type: "auto", packets: 3, targets: { all: true }, excluded_pairs: [{ source: "n-sh", target: "n-us" }] });
  const save = stopMeasuringSave(def, "n-sh", "n-jp")!;
  assert.equal(save.id, def.id);
  assert.equal(save.version, def.version, "a save that lost a race answers version_conflict rather than overwrite");
  assert.deepEqual(save.excluded_pairs, [{ source: "n-sh", target: "n-us" }, { source: "n-sh", target: "n-jp" }]);
  // Everything else is the stored spec, unchanged.
  const { excluded_pairs: _a, ...rest } = save;
  const { excluded_pairs: _b, ...same } = buildDefinitionSave(draftFromDefinition(def), def, def.name);
  assert.deepEqual(rest, same);
  assert.equal(stopMeasuringSave(def, "n-sh", "n-us"), undefined, "a pair already excluded needs no save");
  // Measuring it again is the same save the other way, and the undo of a stop.
  const again = measureAgainSave(def, "n-sh", "n-us")!;
  assert.deepEqual(again.excluded_pairs ?? [], [], "an empty list is left out, which the server reads as none");
  assert.equal(again.version, def.version);
  assert.equal(measureAgainSave(def, "n-sh", "n-jp"), undefined, "a pair that is measured needs no save");
});
