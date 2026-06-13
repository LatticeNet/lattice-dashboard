import assert from "node:assert/strict";
import test from "node:test";

import { describeNetRule, netPolicyPayload, parseNetPolicyPorts } from "./netpolicy.js";

test("netPolicyPayload appends a normalized node rule", () => {
  const body = netPolicyPayload({ rules: [{ id: "existing" }] }, {
    target_node_id: " node-a ",
    comment: " deny db ",
    action: "deny",
    direction: "egress",
    protocol: "tcp",
    ports: "1234,22,1234",
    remote_kind: "node",
    remote_node_id: " node-b ",
    enabled: true,
  });
  assert.equal(body.target_node_id, "node-a");
  assert.equal(body.enabled, true);
  assert.equal(body.rules.length, 2);
  assert.deepEqual(body.rules[1], {
    comment: "deny db",
    action: "deny",
    direction: "egress",
    protocol: "tcp",
    ports: [22, 1234],
    remote: { kind: "node", node_id: "node-b" },
  });
});

test("netPolicyPayload handles cidr and any remotes", () => {
  assert.deepEqual(netPolicyPayload(null, {
    target_node_id: "n1",
    remote_kind: "cidr",
    remote_cidr: " 192.0.2.0/24 ",
  }).rules[0].remote, { kind: "cidr", cidr: "192.0.2.0/24" });
  assert.deepEqual(netPolicyPayload(null, {
    target_node_id: "n1",
    remote_kind: "any",
  }).rules[0].remote, { kind: "any" });
});

test("describeNetRule returns compact operator text", () => {
  assert.equal(describeNetRule({
    action: "deny",
    direction: "egress",
    protocol: "tcp",
    ports: [1234],
    remote: { kind: "node", node_id: "node-b" },
  }), "deny egress node:node-b tcp:1234");
});

test("parseNetPolicyPorts rejects invalid ports instead of silently widening", () => {
  assert.deepEqual(parseNetPolicyPorts("443, 22 443"), [22, 443]);
  assert.throws(() => parseNetPolicyPorts("abc"), /invalid port/);
  assert.throws(() => parseNetPolicyPorts("1e3"), /invalid port/);
  assert.throws(() => parseNetPolicyPorts("0"), /invalid port/);
  assert.throws(() => parseNetPolicyPorts("65536"), /invalid port/);
});
