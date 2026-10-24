import assert from "node:assert/strict";
import { test } from "node:test";

import type { NodeNetworkTable, NodeNetworkView } from "../../../lib/api/types.ts";
import { returnRefreshDue } from "../../../lib/referenceChanges.ts";
import { activeOwners, applyingPolicies, attentionTables, compareRulesets, guardAttention, orderedOwners, portLabel, refusedSections, tableAttention, tableInSync } from "../nodeNetworkModel.ts";

const table = (over: Partial<NodeNetworkTable>): NodeNetworkTable => ({ state: "ok", table: "inet lattice_guard", ...over });

test("only policies that apply are listed as putting rules on the node, in merge order", () => {
  const policies = applyingPolicies({
    state: "ok",
    policies: [
      { id: "d", label: "d", priority: 1, enabled: false, reach: "named", state: "disabled", rules: 1, allow: 1, deny: 0 },
      { id: "b", label: "b", priority: 5, enabled: true, reach: "named", state: "applies", rules: 1, allow: 1, deny: 0 },
      { id: "a", label: "a", priority: 10, enabled: true, reach: "group", state: "applies", rules: 2, allow: 2, deny: 0 },
      { id: "c", label: "c", priority: 20, enabled: true, reach: "excluded", state: "excluded", rules: 1, allow: 1, deny: 0 },
    ],
  });
  assert.deepEqual(policies.map((p) => p.id), ["b", "a"]);
});

test("a pending re-plan outranks an orphan and drift, and a refused table asks nothing", () => {
  assert.equal(tableAttention(table({ replan_pending: true, drift_state: "drift" })), "replan");
  assert.equal(tableAttention(table({ drift_state: "drift" })), "drift");
  assert.equal(tableAttention(table({ drift_state: "in_sync" })), undefined);
  assert.equal(tableAttention(table({ state: "refused", replan_pending: true })), undefined);
  // Nothing composes the table, yet what was applied is still on the node.
  const orphan = table({ table: "inet lattice_policy", compile_now: { state: "none" }, last_applied: { state: "ok", sha256: "a" } });
  assert.equal(tableAttention(orphan), "orphan");
  assert.equal(tableInSync(orphan), false);
  assert.equal(tableAttention(table({ compile_now: { state: "none" }, last_applied: { state: "none" } })), undefined);
  assert.equal(tableInSync(table({ compile_now: { state: "ok", sha256: "a" }, last_applied: { state: "ok", sha256: "a" } })), true);
  assert.equal(tableInSync(table({ compile_now: { state: "ok", sha256: "a" }, last_applied: { state: "refused" } })), false);
});

test("the Inbound row learns when another composer rebuilt lattice_guard", () => {
  const view = (guard: Partial<NodeNetworkTable>, inbound: NodeNetworkView["inbound"] = { state: "ok" }): NodeNetworkView => ({
    node_id: "n1",
    generated_at: "2026-10-24T00:00:00Z",
    inbound,
    outbound: { state: "ok" },
    access: { state: "ok" },
    mesh: { state: "ok" },
    groups: { state: "ok" },
    tables: [table(guard)],
  });
  const legacy = { replan_pending: true, last_writer: { kind: "legacy_firewall", applied_at: "2026-10-24T00:00:00Z" }, compile_now: { state: "ok" as const, composer: "netguard" } };
  assert.equal(guardAttention(view(legacy))?.kind, "overridden");
  assert.equal(guardAttention(view({ ...legacy, last_writer: { kind: "netguard", applied_at: "2026-10-24T00:00:00Z" } }))?.kind, "replan");
  assert.equal(guardAttention(view({ drift_state: "drift" }))?.kind, "drift");
  assert.equal(guardAttention(view({})), undefined);
  assert.equal(guardAttention(view(legacy, { state: "refused", scope: "netguard:read" })), undefined);
});

test("owners read writer first, then contributors, observers, refused and idle", () => {
  const owners = orderedOwners([
    { kind: "legacy_firewall", state: "refused" },
    { kind: "beacon", state: "contributes" },
    { kind: "selfdns", state: "idle" },
    { kind: "netguard", state: "writes" },
  ]);
  assert.deepEqual(owners.map((o) => o.kind), ["netguard", "beacon", "legacy_firewall", "selfdns"]);
  assert.deepEqual(activeOwners(owners).map((o) => o.kind), ["netguard", "beacon", "legacy_firewall"]);
  assert.deepEqual(orderedOwners(undefined), []);
});

test("a port reads as the firewall writes it", () => {
  assert.equal(portLabel({ source: "selfdns", port: 53, protocols: ["udp", "tcp"] }), "53 udp/tcp");
  assert.equal(portLabel({ source: "beacon", port: 47000, protocols: [] }), "47000");
});

test("the rules compare marks, in order, what a re-plan adds and removes", () => {
  const now = "table inet lattice_guard {\n  tcp dport { 22 } accept\n  tcp dport { 443 } accept\n  counter drop\n}\n";
  const applied = "table inet lattice_guard {\n    tcp dport { 22 } accept\n  counter drop\n  counter drop\n}\n";
  const result = compareRulesets(now, applied);
  assert.deepEqual(result.now.filter((l) => l.changed).map((l) => l.text.trim()), ["tcp dport { 443 } accept"]);
  // The second "counter drop" has no partner on the left; re-indenting marks nothing.
  assert.deepEqual(result.applied.filter((l) => l.changed).map((l) => l.text.trim()), ["counter drop"]);
  assert.deepEqual([result.added, result.removed, result.changed, result.reordered], [1, 1, 2, false]);
  assert.equal(compareRulesets(now, now).changed, 0);
  const empty = compareRulesets(undefined, "x");
  assert.equal(empty.now.length, 0);
  assert.deepEqual(empty.applied, [{ text: "x", indent: 0, changed: true }]);
  // The nesting is kept apart from the text, so a wrapped rule stays under its chain.
  assert.deepEqual(compareRulesets("table t {\n\tchain c {\n    counter drop", undefined).now.map((l) => [l.indent, l.text]), [
    [0, "table t {"],
    [4, "chain c {"],
    [4, "counter drop"],
  ]);
});

test("a closing brace is matched to its own block, not the table's", () => {
  const now = "table t {\n  set peers {\n    type ipv4_addr\n  }\n  chain input {\n    counter drop\n  }\n}";
  const applied = "table t {\n  chain input {\n    counter drop\n  }\n}";
  const result = compareRulesets(now, applied);
  // Lines 1 to 3 (index) are the set, the brace closing it included.
  assert.deepEqual(result.now.map((l, i) => (l.changed ? i : -1)).filter((i) => i >= 0), [1, 2, 3]);
  assert.deepEqual([result.added, result.removed], [3, 0]);
});

test("rules that only moved are marked, since nftables applies them in order", () => {
  const now = "chain c {\n  ip saddr 192.0.2.0/24 drop\n  tcp dport 22 accept\n}";
  const applied = "chain c {\n  tcp dport 22 accept\n  ip saddr 192.0.2.0/24 drop\n}";
  const result = compareRulesets(now, applied);
  assert.equal(result.changed > 0, true);
  assert.equal(result.reordered, true);
  assert.equal(compareRulesets(now, now).reordered, false);
});

test("refused sections name their scope, and attention lists only tables that ask for it", () => {
  const view: NodeNetworkView = {
    node_id: "n1",
    generated_at: "2026-10-24T00:00:00Z",
    inbound: { state: "ok" },
    outbound: { state: "refused", scope: "netpolicy:read" },
    access: { state: "refused", scope: "sshguard:read" },
    mesh: { state: "ok" },
    groups: { state: "ok" },
    tables: [table({ replan_pending: true }), table({ table: "inet lattice_policy" })],
  };
  assert.deepEqual(refusedSections(view), [
    { section: "outbound", scope: "netpolicy:read" },
    { section: "access", scope: "sshguard:read" },
  ]);
  assert.deepEqual(attentionTables(view).map((t) => t.table), ["inet lattice_guard"]);
});

test("one return to the page reads once although focus and visibility both fire", () => {
  assert.equal(returnRefreshDue(undefined, 1_000), true);
  assert.equal(returnRefreshDue(1_000, 1_400), false);
  assert.equal(returnRefreshDue(1_000, 2_000), true);
});
