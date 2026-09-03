/**
 * An in-memory stand-in for `@/lib/api` for the approvals page, wired in by
 * vite.harness.config.ts through a resolve alias so the production config and
 * bundle never see it.
 *
 *   LATTICE_HARNESS=approvals pnpm exec vite --config vite.harness.config.ts
 *   open http://127.0.0.1:5185/dev/approvals.html
 *   open http://127.0.0.1:5185/dev/approvals.html?state=empty
 *   open http://127.0.0.1:5185/dev/approvals.html?scope=read
 *
 * The fixture exists because production has exactly one of the state this page
 * was rebuilt for. The whole point is an approved change that cannot proceed,
 * and there are seven ways for that to happen; the console has to be looked at
 * in all of them before it can be called finished, so they are all here.
 *
 * Everything the real barrel exports is re-exported unchanged; only `api` is
 * replaced, and only the calls ApprovalsView makes are implemented. Anything
 * else rejects, loudly, so a new call path is noticed rather than silently fed
 * nothing.
 */
import type { ApprovalView, Principal } from "@/lib/api/index";

export * from "@/lib/api/index";

const NOW = Date.now();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const LATENCY_MS = 60;

function iso(offsetMs: number): string {
  return new Date(NOW + offsetMs).toISOString();
}

function delay<T>(value: T, ms = LATENCY_MS): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

function query(key: string): string {
  return new URLSearchParams(window.location.search).get(key) ?? "";
}

function agentPlan(node: string, current: string, target: string): string {
  return [
    "plugin: agentupdate",
    "mode: auto",
    `node_name: ${node}`,
    `current_version: ${current}`,
    `target_version: ${target}`,
    "binary_url: https://downloads.lattice.example/lattice-agent-linux-amd64",
    "sha256: 4f1d9c2ab7e35608d1f0c4a29b6e7d3350aa91cc27b4de08f6a1b23c5d9e0071",
    "install_path: /opt/lattice/node-agent/lattice-agent",
    "service_name: lattice-agent.service",
    "",
    "Safety:",
    "- download is HTTPS-only and verified against the pinned SHA-256 digest",
    "- the running unit is stopped, replaced and restarted in one step",
  ].join("\n");
}

// The one that started this: approved on 22 August against a machine that
// stopped reporting on the 27th, and it has sat in the inbox ever since.
const OFFLINE: ApprovalView = {
  id: "approval_icmzlxybqtdilyu5",
  node_id: "node_ttp3p32iykd4an5w",
  plugin: "agentupdate",
  action: "update-agent",
  plan: agentPlan("[OpenJobs-Data]-tmp", "0.3.6", "0.3.9-alpha.7"),
  status: "approved",
  actor_id: "lattice-server",
  approved_by: "cdcd",
  created_at: iso(-9 * DAY),
  updated_at: iso(-8 * DAY),
  waiting: {
    code: "node_offline",
    reason:
      "Waiting for [OpenJobs-Data]-tmp, offline since 2026-08-27T17:22:53Z. The change is dispatched when the agent reports again.",
    blocked: true,
    node_id: "node_ttp3p32iykd4an5w",
    node_name: "[OpenJobs-Data]-tmp",
    node_status: "offline",
    node_status_since: iso(-7 * DAY),
    node_status_reason:
      "No report since 2026-08-27T17:22:53Z; the control plane stops trusting a node after 1m30s of silence.",
    dismissible: true,
  },
};

const NEVER_REPORTED: ApprovalView = {
  id: "approval_2b9k4qmvxr1t7wsc",
  node_id: "node_9f2mq7wxbc4l0dhz",
  plugin: "agentupdate",
  action: "update-agent",
  plan: agentPlan("hel-edge-04", "0.0.0", "0.3.9-alpha.7"),
  status: "approved",
  actor_id: "lattice-server",
  approved_by: "cdcd",
  created_at: iso(-3 * DAY),
  updated_at: iso(-3 * DAY),
  waiting: {
    code: "node_never_reported",
    reason:
      "Waiting for hel-edge-04, which has never reported since it was enrolled at 2026-08-30T09:14:02Z. No agent has ever contacted the control plane from that node.",
    blocked: true,
    node_id: "node_9f2mq7wxbc4l0dhz",
    node_name: "hel-edge-04",
    node_status: "never_reported",
    node_status_since: iso(-4 * DAY),
    node_status_reason: "No report has arrived since enrollment at 2026-08-30T09:14:02Z.",
    dismissible: true,
  },
};

const FAILED_TASK: ApprovalView = {
  id: "approval_7x3ndkq82wme5rtb",
  node_id: "node_4kd82mwqxr9tzb1v",
  plugin: "proxycore",
  action: "apply-config",
  plan: [
    "# Lattice proxycore review plan",
    "",
    "node_id: node_4kd82mwqxr9tzb1v",
    "profile_id: prof_sgp_edge",
    "core: sing-box",
    "config_path: /etc/sing-box/config.json",
    "artifact_sha256: 9d02fb31c7a5e46082b1c9d47ae35f10",
    "inbound_count: 12",
  ].join("\n"),
  status: "approved",
  actor_id: "cdcd",
  approved_by: "cdcd",
  created_at: iso(-6 * HOUR),
  updated_at: iso(-5 * HOUR),
  waiting: {
    code: "task_failed",
    reason: "The apply task task_qm38xd7w on sgp-edge-01 ended failed; the change was never made.",
    blocked: true,
    node_id: "node_4kd82mwqxr9tzb1v",
    node_name: "sgp-edge-01",
    node_status: "online",
    node_status_since: iso(-11 * DAY),
    node_status_reason: "Reporting; last report at 2026-09-03T08:41:07Z.",
    task_id: "task_qm38xd7w",
    task_status: "failed",
    dismissible: false,
  },
};

const SUPERSEDED: ApprovalView = {
  id: "approval_5mq7wzk1x8dnbt3r",
  node_id: "node_1pxv8wq4rm2tzkbd",
  plugin: "agentupdate",
  action: "update-agent:0.3.6",
  plan: agentPlan("fra-edge-02", "0.3.2", "0.3.6"),
  status: "approved",
  actor_id: "lattice-server",
  approved_by: "cdcd",
  created_at: iso(-16 * DAY),
  updated_at: iso(-16 * DAY),
  waiting: {
    code: "plan_superseded",
    reason:
      "A newer plan for the same change on fra-edge-02 replaced this one (approval_nd82kqw5x7rtmzb1); this approval will not be dispatched.",
    blocked: true,
    node_id: "node_1pxv8wq4rm2tzkbd",
    node_name: "fra-edge-02",
    node_status: "online",
    node_status_since: iso(-20 * DAY),
    node_status_reason: "Reporting; last report at 2026-09-03T08:41:11Z.",
    superseded_by: "approval_nd82kqw5x7rtmzb1",
    dismissible: true,
  },
};

const SUPERSEDING: ApprovalView = {
  id: "approval_nd82kqw5x7rtmzb1",
  node_id: "node_1pxv8wq4rm2tzkbd",
  plugin: "agentupdate",
  action: "update-agent:0.3.9-alpha.7",
  plan: agentPlan("fra-edge-02", "0.3.2", "0.3.9-alpha.7"),
  status: "pending",
  actor_id: "lattice-server",
  created_at: iso(-40 * MINUTE),
  updated_at: iso(-40 * MINUTE),
};

const NOT_QUEUED: ApprovalView = {
  id: "approval_3wq8zkxm1rt5db7n",
  node_id: "node_6tzr2wqk8xm1bd4v",
  plugin: "nftpolicy",
  action: "apply-policy",
  plan: [
    "table inet lattice_policy {",
    "  chain ingress {",
    "    type filter hook input priority 0; policy drop;",
    "    ct state established,related accept",
    "    tcp dport { 22, 443 } accept",
    "  }",
    "}",
  ].join("\n"),
  status: "approved",
  actor_id: "cdcd",
  approved_by: "cdcd",
  created_at: iso(-2 * DAY),
  updated_at: iso(-2 * DAY),
  waiting: {
    code: "not_queued",
    reason:
      "Approved without queueing an apply, and nothing has queued one since. ams-gw-01 will not receive this change on its own.",
    blocked: true,
    node_id: "node_6tzr2wqk8xm1bd4v",
    node_name: "ams-gw-01",
    node_status: "online",
    node_status_since: iso(-30 * DAY),
    node_status_reason: "Reporting; last report at 2026-09-03T08:41:04Z.",
    dismissible: false,
  },
};

const QUEUED: ApprovalView = {
  id: "approval_8kzm3wq1xrt7db2n",
  node_id: "node_5wq2rtzk8xm1bd6v",
  plugin: "agentupdate",
  action: "update-agent",
  plan: agentPlan("tyo-edge-03", "0.3.6", "0.3.9-alpha.7"),
  status: "approved",
  actor_id: "lattice-server",
  approved_by: "cdcd",
  created_at: iso(-3 * MINUTE),
  updated_at: iso(-2 * MINUTE),
  waiting: {
    code: "task_queued",
    reason: "Queued as task task_7wz2kq83; tyo-edge-03 picks it up on its next poll.",
    blocked: false,
    node_id: "node_5wq2rtzk8xm1bd6v",
    node_name: "tyo-edge-03",
    node_status: "online",
    node_status_since: iso(-12 * DAY),
    node_status_reason: "Reporting; last report at 2026-09-03T08:41:19Z.",
    task_id: "task_7wz2kq83",
    task_status: "queued",
    dismissible: false,
  },
};

// A control plane older than the waiting field. The page has to say it does
// not know, rather than let the row read as ordinary.
const UNEXPLAINED: ApprovalView = {
  id: "approval_1rt7dbzk8xm3wq2n",
  node_id: "node_8xm1bd4vzk6tqr2w",
  plugin: "wireguard",
  action: "apply-config",
  plan: "[Interface]\nAddress = 10.72.0.4/24\nListenPort = 51820\n\n[Peer]\nAllowedIPs = 10.72.0.0/24\n",
  status: "approved",
  actor_id: "cdcd",
  approved_by: "cdcd",
  created_at: iso(-5 * DAY),
  updated_at: iso(-5 * DAY),
};

const PENDING_SSH: ApprovalView = {
  id: "approval_9zk2wq8xrt1mdb3n",
  node_id: "node_2wqrtzk85xm1bd6v",
  plugin: "sshguard",
  action: "arm",
  plan: [
    "# Lattice SSH Guard arm plan",
    "",
    "node_id: node_2wqrtzk85xm1bd6v",
    "ssh_port: 2202",
    "gated_ports: 22, 2202",
    "confirm_window_sec: 600",
    "knock: enabled",
  ].join("\n"),
  status: "pending",
  actor_id: "cdcd",
  created_at: iso(-25 * MINUTE),
  updated_at: iso(-25 * MINUTE),
};

const APPLIED: ApprovalView = {
  id: "approval_4db2n8xrtzk1wq9m",
  node_id: "node_5wq2rtzk8xm1bd6v",
  plugin: "agentupdate",
  action: "update-agent",
  plan: agentPlan("tyo-edge-03", "0.3.2", "0.3.6"),
  status: "applied",
  actor_id: "lattice-server",
  approved_by: "cdcd",
  created_at: iso(-21 * DAY),
  updated_at: iso(-21 * DAY),
};

const STALE: ApprovalView = {
  id: "approval_6xm1bd4vzk8tqr2w",
  node_id: "node_4kd82mwqxr9tzb1v",
  plugin: "agentupdate",
  action: "update-agent",
  plan: agentPlan("sgp-edge-01", "0.3.6", "0.3.8"),
  status: "pending",
  reason:
    "agent update approval is stale; target_version planned=0.3.8 current=0.3.9-alpha.7; re-plan before approving",
  stale: true,
  stale_code: "agent_update_policy_changed",
  actor_id: "lattice-server",
  created_at: iso(-13 * DAY),
  updated_at: iso(-13 * DAY),
};

const FULL: ApprovalView[] = [
  OFFLINE,
  NEVER_REPORTED,
  FAILED_TASK,
  SUPERSEDED,
  SUPERSEDING,
  NOT_QUEUED,
  QUEUED,
  UNEXPLAINED,
  PENDING_SSH,
  APPLIED,
  STALE,
];

const approvals: ApprovalView[] = query("state") === "empty" ? [] : FULL.map((a) => ({ ...a }));

function find(id: string): ApprovalView | undefined {
  return approvals.find((approval) => approval.id === id);
}

// A read-only operator must be able to see the explanation and be told plainly
// that the exits are not theirs to take.
const READ_ONLY_SCOPES = ["node:read", "approval:read", "task:read", "audit:read"];
const FULL_SCOPES = [...READ_ONLY_SCOPES, "network:apply", "network:plan", "node:admin", "netpolicy:admin", "proxy:admin", "sshguard:admin"];

const principal: Principal = {
  actor_id: "cdcd",
  username: "cdcd",
  scopes: query("scope") === "read" ? READ_ONLY_SCOPES : FULL_SCOPES,
  server_allowlist: [],
  csrf_token: "harness",
  totp_enabled: true,
};

const unimplemented = new Proxy(
  {},
  {
    get(_target, prop) {
      return () => Promise.reject(new Error(`fake api: ${String(prop)} is not implemented in the approvals harness`));
    },
  },
);

export const api = {
  auth: { me: () => delay(principal) },
  approvals: {
    list: (options?: { include_dismissed?: boolean }) =>
      delay({
        approvals: approvals
          .filter((approval) => options?.include_dismissed || approval.status !== "dismissed")
          .map((approval) => ({ ...approval })),
      }),
    approve: (approval_id: string, queue_apply: boolean) => {
      const approval = find(approval_id);
      if (!approval) return Promise.reject(new Error("approval not found"));
      approval.status = "approved";
      approval.approved_by = "cdcd";
      approval.updated_at = new Date().toISOString();
      approval.waiting = queue_apply
        ? {
            code: "task_queued",
            reason: `Queued as task task_${approval_id.slice(-8)}; the node picks it up on its next poll.`,
            blocked: false,
            node_id: approval.node_id,
            node_status: "online",
            dismissible: false,
          }
        : {
            code: "not_queued",
            reason: "Approved without queueing an apply, and nothing has queued one since.",
            blocked: true,
            node_id: approval.node_id,
            node_status: "online",
            dismissible: false,
          };
      return delay(undefined);
    },
    reject: (approval_id: string) => {
      const approval = find(approval_id);
      if (approval && approval.status === "pending") {
        approval.status = "rejected";
        approval.updated_at = new Date().toISOString();
        approval.waiting = undefined;
      }
      return delay(approval);
    },
    dismiss: (approval_id: string) => {
      const approval = find(approval_id);
      if (!approval?.waiting?.dismissible) {
        return Promise.reject(new Error("approval is not stale; reject or approve it explicitly"));
      }
      approval.status = "dismissed";
      approval.reason = `Approved but never applied, dismissed by an operator. ${approval.waiting.reason} Re-plan if this change is still wanted.`;
      approval.updated_at = new Date().toISOString();
      approval.waiting = undefined;
      return delay(approval);
    },
  },
  agentUpdates: {
    plan: () => Promise.reject(new Error("fake api: re-planning is not implemented in the approvals harness")),
  },
  nodes: { list: () => delay({ nodes: [] }) },
  tasks: unimplemented,
  audit: unimplemented,
  capabilities: unimplemented,
  plugins: unimplemented,
} as unknown as typeof import("@/lib/api/index").api;
