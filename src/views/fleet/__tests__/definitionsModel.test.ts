import assert from "node:assert/strict";
import { test } from "node:test";

import type { CheckDefinitionPreview, CheckDefinitionView, MonitorView } from "@/lib/api/types";

import {
  addressesOf,
  buildDefinitionSave,
  checkRowGroup,
  checkRows,
  definitionDirty,
  definitionMonitorIds,
  definitionProblems,
  draftFromDefinition,
  emptyDefinitionDraft,
  missingParts,
  pathsHealth,
  suggestDefinitionName,
  summarizePreview,
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
  assert.deepEqual(tls.sources, {});
  assert.deepEqual(tls.targets, {});
  assert.deepEqual(missingParts(definitionProblems(tls, { newDefinition: true })), ["target"]);
  assert.deepEqual(definitionProblems({ ...tls, addressText: "example.com:443" }, { newDefinition: true }), []);
});

test("addresses are one per line or comma separated, checked by the method's rules", () => {
  assert.deepEqual(addressesOf(" https://a.example/x \n\nhttps://b.example, https://a.example/x"), ["https://a.example/x", "https://b.example"]);
  const http = { ...emptyDefinitionDraft("http"), sources: { nodes: ["n-sh"] } };
  assert.ok(definitionProblems({ ...http, addressText: "not a url" }, { newDefinition: true }).includes("address"));
  assert.ok(definitionProblems({ ...http, addressText: "http://10.0.0.1/" }, { newDefinition: true }).includes("destination"));
  // A beacon names nodes only: typed addresses are cleared with the method.
  assert.equal(withKind({ ...http, addressText: "https://a.example" }, "beacon").addressText, "");
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
  assert.equal(suggestDefinitionName(draft, (id) => id.slice(2), () => "edge"), "TCP edge, jp +1");
  assert.equal(suggestDefinitionName(emptyDefinitionDraft("tcp"), (id) => id, (id) => id), "");
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
  // A pause is a choice, not a reason the check measures nothing.
  assert.deepEqual(pathsHealth([{ state: "unknown", reason: "source_paused" }], true, now), { kind: "none" });
});

test("the list holds definitions, single checks and Fleet mesh, never the monitors they generated", () => {
  const monitors = [
    { id: "mon_1", name: "web", type: "http", target: "https://x", interval_sec: 60, timeout_sec: 5, enabled: true },
    { id: "mon_lat_n-jp", name: "Latency to jp", type: "tcp", target: "x", interval_sec: 60, timeout_sec: 5, enabled: true, managed_by: "latency" },
    { id: "mon_chk_a_1", name: "edge tcp to jp", type: "tcp", target: "x", interval_sec: 60, timeout_sec: 5, enabled: true, managed_by: "check:chk_a", check_definition_id: "chk_a" },
  ] as MonitorView[];
  const mesh = { name: "Fleet mesh", enabled: true, stored: true, version: 2, method: "auto", sources: 1, targets: 3, paths: 3, paused_targets: 0 };
  const rows = checkRows(monitors, [stored()], mesh);
  assert.deepEqual(rows.map((r) => [r.kind, checkRowGroup(r)]), [["definition", "checks"], ["check", "checks"], ["fleet", "builtin"]]);
  assert.deepEqual([...definitionMonitorIds("chk_a", monitors)], ["mon_chk_a_1"]);
});
