/**
 * Agent Updates fixtures for the netplat harness (dev/netplat-agents.html).
 *
 * Production on 2026-09-30: 34 nodes on 4 agent versions and 33 update
 * policies, so one node has none. Here the node without a policy is
 * [cd]-GreenCloud-SG, as in the audit; the version numbers, which nodes are
 * behind, the release, the stored binaries and the two stale approvals are
 * invented to those counts. `?agents=error` fails one policy's last plan;
 * `?release=fail` makes the release read answer 502.
 *
 * Last fetches (design 31) use the sizes lattice-server #205 measured on
 * the 0.3.10-alpha.6 linux/amd64 asset, 14,037,154 bytes plain and
 * 5,552,813 gzip, for this fixture's latest release. Each record is a summary
 * line the walk can print: the cutoff is 32 KiB/s for 30 s inside a 480 s
 * budget, and the second pass goes to the source with the largest share of
 * its own file. Nodes past the list carry none, as most of a fleet does
 * before its first walk. `?fetch=none` drops them all.
 */
import type { AgentArtifactListing, AgentReleaseInfo, AgentUpdateFetch, AgentUpdatePolicy, ApprovalView } from "@/lib/api/index";

import { DAY, HOUR, LATEST_AGENT, NODES, flags, iso, nodeByName } from "./netplatFixture";

const withoutPolicy = nodeByName("[cd]-GreenCloud-SG").id;
const failing = flags.get("agents") === "error" ? nodeByName("[OpenJobs-Data]-scripts").id : "";

const PLAIN = 14_037_154;
const PACKED = 5_552_813;

type FetchLine = Omit<AgentUpdateFetch, "approval_id" | "target_version" | "at">;

/** One record per policy, by index; each is a line the walk can print. */
const FETCH_LINES: Array<[ageHours: number, FetchLine]> = [
  // A slow path: both sources are cut at the 30 s window, and the second pass
  // gives the rest of the budget to the gzip download, the larger share.
  [2, {
    fetches: [
      { source: 1, kind: "cp.gz", exit_code: 28, bytes: 983_040, seconds: 30 },
      { source: 2, kind: "up", exit_code: 28, bytes: 737_280, seconds: 30 },
      { second_pass: true, kind: "cp.gz", exit_code: 0, bytes: PACKED - 983_040, seconds: 371 },
    ],
    exit_code: 0,
    stage: "done",
  }],
  // A good path: the gzip download in one go.
  [3, { fetches: [{ source: 1, kind: "cp.gz", exit_code: 0, bytes: PACKED, seconds: 6 }], exit_code: 0, stage: "done" }],
  // The control plane unreachable from the task (connect refused), the
  // upstream fallback finishes.
  [5, {
    fetches: [
      { source: 1, kind: "cp.gz", exit_code: 7, bytes: 0, seconds: 0 },
      { source: 2, kind: "up", exit_code: 0, bytes: PLAIN, seconds: 97 },
    ],
    exit_code: 0,
    stage: "done",
  }],
  // Out of budget: both cut, the second pass runs out of time; the next
  // attempt continues the kept partials.
  [1, {
    fetches: [
      { source: 1, kind: "cp.gz", exit_code: 28, bytes: 524_288, seconds: 30 },
      { source: 2, kind: "up", exit_code: 28, bytes: 589_824, seconds: 30 },
      { second_pass: true, kind: "cp.gz", exit_code: 28, bytes: 2_097_152, seconds: 420 },
    ],
    exit_code: 28,
    stage: "fetch",
  }],
  // A raw plan whose download finished and failed its digest.
  [26, { fetches: [{ source: 1, kind: "cp", exit_code: 0, bytes: PLAIN, seconds: 41 }], exit_code: 1, stage: "verify" }],
  // A wget node whose date gives no epoch seconds, on a raw plan: the
  // control plane drops the connection (wget exit 4), the fallback continues
  // the same file. wget makes no second pass.
  [8, {
    fetches: [
      { source: 1, kind: "cp", exit_code: 4, bytes: 3_145_728 },
      { source: 2, kind: "up", exit_code: 0, bytes: PLAIN - 3_145_728 },
    ],
    exit_code: 0,
    stage: "done",
  }],
  // A file the last attempt kept already held the pinned bytes.
  [30, { exit_code: 0, stage: "done" }],
  // No systemd: the script stops before any fetch.
  [50, { exit_code: 1, stage: "prepare" }],
];

function lastFetch(index: number): AgentUpdateFetch | undefined {
  if (flags.get("fetch") === "none") return undefined;
  const entry = FETCH_LINES[index];
  if (!entry) return undefined;
  const [ageHours, line] = entry;
  return { ...line, approval_id: `approval_${"qrstuvwx"[index]}3v7q2mzx5c4b6na`, target_version: LATEST_AGENT, at: iso(-ageHours * HOUR) };
}

export const AGENT_POLICIES: AgentUpdatePolicy[] = NODES.filter((node) => node.id !== withoutPolicy).map((node, index) => {
  const fetch = lastFetch(index);
  // A node with a fetch record was planned for it, a quarter hour before the
  // result landed.
  const plannedAt = fetch?.at ? new Date(Date.parse(fetch.at) - 15 * 60_000).toISOString() : undefined;
  return {
    node_id: node.id,
    enabled: true,
    auto_plan: index % 5 === 0,
    target_version: "latest",
    binary_url: "",
    sha256: "",
    install_path: "",
    service_name: "",
    last_planned_version: fetch || node.agent_version === LATEST_AGENT ? LATEST_AGENT : undefined,
    last_planned_at: plannedAt ?? (node.agent_version === LATEST_AGENT ? iso(-(3 + (index % 9)) * DAY) : undefined),
    last_applied_version: node.agent_version === LATEST_AGENT ? LATEST_AGENT : undefined,
    last_applied_at: node.agent_version === LATEST_AGENT ? iso(-(3 + (index % 9)) * DAY + HOUR) : undefined,
    last_error: node.id === failing ? "plan: download https://github.com/LatticeNet/lattice-node-agent/releases/download/v0.3.9/lattice-agent-linux-amd64: dial tcp: i/o timeout" : undefined,
    last_fetch: fetch,
    created_at: iso(-60 * DAY),
    updated_at: iso(-3 * DAY),
  };
});

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
