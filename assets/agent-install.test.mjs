import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_AGENT_VERSION,
  agentRunCommand,
  agentSystemdInstallScript,
  normalizeAgentServerURL,
} from "./agent-install.js";

test("normalizeAgentServerURL trims trailing slashes", () => {
  assert.equal(normalizeAgentServerURL(" https://lattice.example.com/// "), "https://lattice.example.com");
  assert.equal(normalizeAgentServerURL(""), "http://127.0.0.1:8088");
});

test("agentRunCommand shell quotes fields", () => {
  const command = agentRunCommand({
    serverURL: "https://lattice.example.com/",
    nodeID: "node-a",
    token: "tok'en",
  });
  assert.match(command, /-server 'https:\/\/lattice\.example\.com'/);
  assert.match(command, /-node-id 'node-a'/);
  assert.match(command, /-token 'tok'"'"'en'/);
});

test("agentSystemdInstallScript installs release binary and service", () => {
  const script = agentSystemdInstallScript({
    serverURL: "https://lattice.example.com",
    nodeID: "node-a",
    token: "node-token",
  });
  for (const expected of [
    `VERSION='${DEFAULT_AGENT_VERSION}'`,
    "lattice-agent-linux-${ARCH}",
    "SHA256SUMS",
    "sha256sum -c -",
    "LATTICE_SERVER_URL=\"https://lattice.example.com\"",
    "LATTICE_NODE_ID=\"node-a\"",
    "LATTICE_NODE_TOKEN=\"node-token\"",
    "ExecStart=/usr/local/bin/lattice-agent \\",
    "systemctl enable --now lattice-agent.service",
  ]) {
    assert.ok(script.includes(expected), `script missing ${expected}`);
  }
});
