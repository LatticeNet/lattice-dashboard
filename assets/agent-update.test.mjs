import assert from "node:assert/strict";
import test from "node:test";

import { agentUpdatePayload, agentUpdateStatus } from "./agent-update.js";

test("agentUpdatePayload normalizes optional fields", () => {
  assert.deepEqual(agentUpdatePayload({
    node_id: " node-a ",
    enabled: true,
    auto_plan: false,
    target_version: " 0.2.0 ",
    binary_url: " https://downloads.example.com/lattice-agent ",
    sha256: "ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789",
    install_path: "",
    service_name: " lattice-agent.service ",
  }), {
    node_id: "node-a",
    enabled: true,
    auto_plan: false,
    target_version: "0.2.0",
    binary_url: "https://downloads.example.com/lattice-agent",
    sha256: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    service_name: "lattice-agent.service",
  });
});

test("agentUpdateStatus summarizes policy against node version", () => {
  assert.equal(agentUpdateStatus(null, { agent_version: "0.1.0" }), "not configured");
  assert.equal(agentUpdateStatus({ enabled: false }, { agent_version: "0.1.0" }), "disabled");
  assert.equal(agentUpdateStatus({ enabled: true, target_version: "0.2.0" }, { agent_version: "0.1.0" }), "update available");
  assert.equal(agentUpdateStatus({ enabled: true, target_version: "0.2.0" }, { agent_version: "0.2.0" }), "current");
});
