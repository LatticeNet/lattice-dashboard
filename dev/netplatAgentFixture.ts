/**
 * Agent Updates fixtures for the netplat harness (dev/netplat-agents.html).
 *
 * Production on 2026-09-30: 34 nodes on 4 agent versions and 33 update
 * policies, so one node has none. Here the node without a policy is
 * [cd]-GreenCloud-SG, as in the audit; the version numbers, which nodes are
 * behind, the release, the stored binaries and the two stale approvals are
 * invented to those counts. `?agents=error` fails one policy's last plan;
 * `?release=fail` makes the release read answer 502.
 */
import type { AgentArtifactListing, AgentReleaseInfo, AgentUpdatePolicy, ApprovalView } from "@/lib/api/index";

import { DAY, HOUR, LATEST_AGENT, NODES, flags, iso, nodeByName } from "./netplatFixture";

const withoutPolicy = nodeByName("[cd]-GreenCloud-SG").id;
const failing = flags.get("agents") === "error" ? nodeByName("[OpenJobs-Data]-scripts").id : "";

export const AGENT_POLICIES: AgentUpdatePolicy[] = NODES.filter((node) => node.id !== withoutPolicy).map((node, index) => ({
  node_id: node.id,
  enabled: true,
  auto_plan: index % 5 === 0,
  target_version: "latest",
  binary_url: "",
  sha256: "",
  install_path: "",
  service_name: "",
  last_planned_version: node.agent_version === LATEST_AGENT ? LATEST_AGENT : undefined,
  last_planned_at: node.agent_version === LATEST_AGENT ? iso(-(3 + (index % 9)) * DAY) : undefined,
  last_applied_version: node.agent_version === LATEST_AGENT ? LATEST_AGENT : undefined,
  last_applied_at: node.agent_version === LATEST_AGENT ? iso(-(3 + (index % 9)) * DAY + HOUR) : undefined,
  last_error: node.id === failing ? "plan: download https://github.com/LatticeNet/lattice-node-agent/releases/download/v0.3.9/lattice-agent-linux-amd64: dial tcp: i/o timeout" : undefined,
  created_at: iso(-60 * DAY),
  updated_at: iso(-3 * DAY),
}));

export const AGENT_RELEASE: AgentReleaseInfo = {
  repo: "LatticeNet/lattice-node-agent",
  channel: "stable",
  latest_tag: `v${LATEST_AGENT}`,
  latest_version: LATEST_AGENT,
  release_url: `https://github.com/LatticeNet/lattice-node-agent/releases/tag/v${LATEST_AGENT}`,
  artifacts: ["lattice-agent-linux-amd64", "lattice-agent-linux-arm64", "SHA256SUMS"],
  sha256: {},
  candidates: [
    { tag_name: "v0.4.0-alpha.2", version: "0.4.0-alpha.2", channel: "alpha", prerelease: true, latest_for_channel: true, release_url: "https://github.com/LatticeNet/lattice-node-agent/releases/tag/v0.4.0-alpha.2" },
  ],
  fetched_at: iso(-2 * 60_000),
};

export const AGENT_ARTIFACTS: AgentArtifactListing = {
  artifacts: [
    { version: LATEST_AGENT, os: "linux", arch: "amd64", sha256: "9a3c1f0e2b4d6a8c0e1f2a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f", size_bytes: 14_680_064, stored_bytes: 14_680_064, updated_at: iso(-5 * DAY) },
    { version: LATEST_AGENT, os: "linux", arch: "arm64", sha256: "1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90a", size_bytes: 13_631_488, stored_bytes: 13_631_488, updated_at: iso(-5 * DAY) },
  ],
  stored_bytes: 28_311_552,
  limit_bytes: 536_870_912,
  serving_enabled: true,
} as AgentArtifactListing;

export const AGENT_APPROVALS: ApprovalView[] = [nodeByName("[Metix]-DMIT-4"), nodeByName("[cd]-mac-air")].map(
  (node, index) =>
    ({
      id: `appr_stale_${index}`,
      plugin: "agentupdate",
      action: "agent.update",
      node_id: node.id,
      status: "pending",
      stale: true,
      reason: "policy changed since this plan; re-plan before approving",
      created_at: iso(-(4 + index) * DAY),
      updated_at: iso(-(2 + index) * DAY),
    }) as unknown as ApprovalView,
);
