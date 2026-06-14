import assert from "node:assert/strict";
import test from "node:test";

import {
  POLICY_GRAPH_HEIGHT,
  POLICY_GRAPH_WIDTH,
  compactPolicyNodeLabel,
  normalizePolicyGraph,
  policyEdgeLabel,
  policyExternalGroups,
  policyExternalLabel,
  policyGraphView,
} from "./policygraph.js";

const sampleGraph = {
  nodes: [
    { id: "node-b", name: "B", online: false },
    { id: "node-a", name: "A", online: true },
  ],
  edges: [
    { from: "node-a", to: "node-b", action: "deny", direction: "egress", protocol: "tcp", ports: [1234], rule_id: "deny-db" },
    { from: "node-a", to: "missing", action: "allow", direction: "egress", protocol: "tcp", ports: [22] },
    { from: "node-a", to: "node-a", action: "deny", direction: "egress", protocol: "tcp", ports: [1] },
  ],
  externals: [
    { target_node_id: "node-a", action: "allow", direction: "egress", remote: "1.1.1.1", protocol: "udp", ports: [53] },
    { target_node_id: "missing", action: "deny", direction: "egress", remote: "any", protocol: "any" },
  ],
};

test("normalizePolicyGraph filters malformed edges and preserves visible nodes", () => {
  const graph = normalizePolicyGraph(sampleGraph);
  assert.deepEqual(graph.nodes.map((node) => node.id), ["node-b", "node-a"]);
  assert.equal(graph.edges.length, 1);
  assert.equal(graph.edges[0].from, "node-a");
  assert.equal(graph.edges[0].to, "node-b");
  assert.equal(graph.externals.length, 1);
});

test("policyGraphView creates deterministic SVG-ready layout", () => {
  const view = policyGraphView(sampleGraph);
  assert.equal(view.width, POLICY_GRAPH_WIDTH);
  assert.equal(view.height, POLICY_GRAPH_HEIGHT);
  assert.equal(view.nodes.length, 2);
  assert.equal(view.edges.length, 1);
  assert.match(view.edges[0].path, /^M\d+\.\d \d+\.\d Q/);
  assert.match(view.edges[0].arrow, /^\d+\.\d,\d+\.\d /);
  assert.equal(view.edges[0].className, "deny");
});

test("policyExternalGroups groups visible external refs by target", () => {
  const groups = policyExternalGroups(sampleGraph);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].targetNodeID, "node-a");
  assert.equal(groups[0].edges[0].remote, "1.1.1.1");
});

test("policy labels are compact operator text", () => {
  assert.equal(policyEdgeLabel(sampleGraph.edges[0]), "deny egress node-a -> node-b tcp:1234");
  assert.equal(policyExternalLabel(sampleGraph.externals[0]), "allow egress node-a <-> 1.1.1.1 udp:53");
});

test("unknown actions degrade to deny class in graph view", () => {
  const view = policyGraphView({
    nodes: [{ id: "a" }, { id: "b" }],
    edges: [{ from: "a", to: "b", action: "surprise", protocol: "tcp" }],
  });
  assert.equal(view.edges[0].className, "deny");
});

test("compactPolicyNodeLabel bounds SVG label length", () => {
  assert.equal(compactPolicyNodeLabel("short"), "short");
  assert.equal(compactPolicyNodeLabel("averyverylongnodename", 10), "averyve...");
});
