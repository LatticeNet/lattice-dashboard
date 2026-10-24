import assert from "node:assert/strict";
import { test } from "node:test";

import type { NodeNetworkTable, NodeNetworkView } from "../../../lib/api/types.ts";
import { returnRefreshDue } from "../../../lib/referenceChanges.ts";
import { activeOwners, applyingPolicies, attentionTables, compareRulesets, orderedOwners, portLabel, refusedSections, tableAttention } from "../nodeNetworkModel.ts";

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

test("a pending re-plan outranks drift, and a refused table asks nothing", () => {
  assert.equal(tableAttention(table({ replan_pending: true, drift_state: "drift" })), "replan");
  assert.equal(tableAttention(table({ drift_state: "drift" })), "drift");
  assert.equal(tableAttention(table({ drift_state: "in_sync" })), undefined);
  assert.equal(tableAttention(table({ state: "refused", replan_pending: true })), undefined);
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

test("the rules compare marks lines the other column lacks, by count and trimmed text", () => {
  const now = "table inet lattice_guard {\n  tcp dport { 22 } accept\n  tcp dport { 443 } accept\n  counter drop\n}\n";
  const applied = "table inet lattice_guard {\n    tcp dport { 22 } accept\n  counter drop\n  counter drop\n}\n";
  const result = compareRulesets(now, applied);
  assert.deepEqual(result.now.filter((l) => l.changed).map((l) => l.text.trim()), ["tcp dport { 443 } accept"]);
  // The second "counter drop" has no partner on the left.
  assert.deepEqual(result.applied.filter((l) => l.changed).map((l) => l.text.trim()), ["counter drop"]);
  assert.equal(result.changed, 2);
  assert.equal(compareRulesets(now, now).changed, 0);
  const empty = compareRulesets(undefined, "x");
  assert.equal(empty.now.length, 0);
  assert.deepEqual(empty.applied, [{ text: "x", changed: true }]);
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
