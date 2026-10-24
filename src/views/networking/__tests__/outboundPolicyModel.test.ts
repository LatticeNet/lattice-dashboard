import assert from "node:assert/strict";
import { test } from "node:test";

import {
  emptyOutboundRule,
  isNodeRestricted,
  legacyPolicyQuery,
  outboundDraftToRule,
  remoteProblem,
  ruleToOutboundDraft,
} from "../outboundPolicyModel.ts";

test("an old Network Policy link lands on the layer it meant, query intact", () => {
  assert.deepEqual(legacyPolicyQuery({ view: "overview" }), { view: "matrix" });
  assert.deepEqual(legacyPolicyQuery({ view: "policies", open: "node-a", q: "edge" }), { view: "nodes", open: "node-a", q: "edge" });
  assert.deepEqual(legacyPolicyQuery({ tab: "graph", open: "node-a" }), { view: "nodes", open: "node-a" });
  assert.deepEqual(legacyPolicyQuery({ tab: "overview" }), { view: "matrix" });
});

test("a link with no layer, or one the page no longer has, lands on the policy list", () => {
  assert.deepEqual(legacyPolicyQuery({}), {});
  assert.deepEqual(legacyPolicyQuery({ view: "nonsense", open: "x" }), { open: "x" });
});

test("a rule round-trips through the draft, a remote group included", () => {
  const rule = {
    id: "rule_004",
    action: "allow" as const,
    direction: "egress" as const,
    protocol: "tcp" as const,
    ports: [5432, 6432],
    remote: { kind: "group" as const, group_id: "grp_db" },
    comment: "db",
  };
  assert.deepEqual(outboundDraftToRule(ruleToOutboundDraft(rule), "rule_004"), rule);
});

test("a remote kind the form does not edit is saved back as it was loaded", () => {
  const rule = { id: "z", action: "allow" as const, direction: "egress" as const, protocol: "any" as const, remote: { kind: "zone" as const, zone_id: "wireguard" } };
  const saved = outboundDraftToRule(ruleToOutboundDraft(rule), "z");
  assert.deepEqual(saved.remote, { kind: "zone", zone_id: "wireguard" });
  assert.deepEqual(saved.ports, []);
});

test("each remote kind says what it still needs", () => {
  const draft = emptyOutboundRule();
  assert.equal(remoteProblem(draft), undefined);
  assert.equal(remoteProblem({ ...draft, remoteKind: "group" }), "errSelectGroup");
  assert.equal(remoteProblem({ ...draft, remoteKind: "group", remoteGroupId: "grp_db" }), undefined);
  assert.equal(remoteProblem({ ...draft, remoteKind: "node" }), "errSelectNode");
  assert.equal(remoteProblem({ ...draft, remoteKind: "cidr", remoteCidr: "  " }), "errEnterCidr");
  assert.equal(remoteProblem({ ...draft, remoteKind: "domain" }), "errEnterDomain");
});

test("a session is confined when its allowlist names nodes and no wildcard", () => {
  assert.equal(isNodeRestricted([]), false);
  assert.equal(isNodeRestricted(undefined), false);
  assert.equal(isNodeRestricted(["*"]), false);
  assert.equal(isNodeRestricted(["node-a", "*"]), false);
  assert.equal(isNodeRestricted(["node-a"]), true);
});
