import assert from "node:assert/strict";
import test from "node:test";

import type { Node } from "../api/types.ts";
import { agentConfigBadges, nodeHasAgentCapability, singboxDrift } from "../nodeFilterExpressions.ts";

const node = (over: Partial<Node>): Node => ({ id: "n", name: "n", online: true, ...over } as Node);

/**
 * The fleet has 25 nodes whose agent reports sing-box discovery on, and the
 * runtime report is what the filter sorts by: an enrolment flag says what
 * was asked for, the runtime says what the agent is doing.
 */
test("singbox matches the runtime report, not the launch record", () => {
  assert.equal(nodeHasAgentCapability(node({ agent_runtime: { singbox_discover: true } }), "singbox"), true);
  assert.equal(nodeHasAgentCapability(node({ agent_runtime: { singbox_discover: true } }), "sing-box"), true);
  assert.equal(nodeHasAgentCapability(node({ agent_launch: { singbox_discover: true }, agent_runtime: { singbox_discover: false } }), "singbox"), false);
  assert.equal(nodeHasAgentCapability(node({ agent_launch: { singbox_discover: true } }), "singbox"), false);
  assert.equal(nodeHasAgentCapability(node({}), "singbox"), false);
});

/**
 * [cd]-xuezhang-ca-NAT on 2026-09-02: launch says off, runtime says on. That
 * is a fact worth filtering for. A side that never reported is not drift.
 */
test("singbox-drift is launch and runtime disagreeing, never a missing side", () => {
  const drifted = node({ agent_launch: { singbox_discover: false }, agent_runtime: { singbox_discover: true } });
  assert.equal(singboxDrift(drifted), true);
  assert.equal(nodeHasAgentCapability(drifted, "singbox-drift"), true);
  assert.equal(singboxDrift(node({ agent_launch: { singbox_discover: true }, agent_runtime: { singbox_discover: true } })), false);
  assert.equal(singboxDrift(node({ agent_runtime: { singbox_discover: true } })), false);
  assert.equal(singboxDrift(node({ agent_launch: {}, agent_runtime: { singbox_discover: true } })), false);
});

test("the badge names sing-box and marks drift", () => {
  assert.deepEqual(agentConfigBadges(node({ agent_runtime: { singbox_discover: true } })), ["sing-box"]);
  assert.deepEqual(agentConfigBadges(node({ agent_launch: { singbox_discover: false }, agent_runtime: { singbox_discover: true } })), ["sing-box:drift"]);
  assert.deepEqual(agentConfigBadges(node({ agent_runtime: { allow_exec: true, singbox_discover: false } })), ["exec"]);
});
