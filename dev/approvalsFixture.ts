/**
 * A fleet's worth of approvals for the harnesses, and a fake of the listing
 * endpoint that answers them the way lattice-server does.
 *
 * Sized after production on 2026-09-04: 1,275 rows (1,084 applied, 190
 * rejected, 1 pending), 2.6 MB with plan text, 7.5 s to the operator's Mac.
 * The generated set keeps those proportions and adds the hand-written states
 * the Approvals page was rebuilt for (every way an approved change can be
 * stuck), so the harness shows both the scale and the edge cases at once.
 *
 * The fake honours the query the real handler honours, and refuses what it
 * refuses: status as a comma list matched literally against the status column,
 * plugin, node_id, since (inclusive on updated_at), limit and offset,
 * include=plan, include_dismissed, count=1, and id. A bare call answers an
 * array; any filter answers the envelope. Plans are omitted unless asked, as
 * the server does now. Staleness is reported as its own count and as the
 * row's `stale` flag, and is not selectable by status, so a page that needs
 * stale rows has to read them and filter, which is what the console does.
 *
 * Latency is proportional to bytes, so a harness that reads too much is slow
 * in the same way production was: BYTES_PER_MS is the measured link
 * (2.6 MB / 7.5 s), plus a floor for the round trip.
 */
import type { ApprovalCounts, ApprovalView } from "@/lib/api/types";
import { isStaleAgentUpdateApprovalView } from "@/lib/api/index";

export const NOW = Date.now();
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** 2.6 MB in 7.5 s, as measured. */
export const BYTES_PER_MS = 350;
/** Round-trip floor. */
export const LATENCY_FLOOR_MS = 60;

export function iso(offsetMs: number): string {
  return new Date(NOW + offsetMs).toISOString();
}

export function agentPlan(node: string, current: string, target: string): string {
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

// ── Deterministic pseudo-random, so two loads of the harness agree ────────────

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NODE_NAMES = [
  "sgp-edge-01",
  "tyo-edge-03",
  "fra-edge-02",
  "hel-edge-04",
  "ams-gw-01",
  "lax-edge-05",
  "sin-relay-02",
  "hkg-edge-01",
  "[OpenJobs-Data]-tmp",
  "nrt-relay-01",
  "dxb-edge-02",
  "syd-edge-01",
];

function nodeIdFor(index: number): string {
  return `node_${(0x2f1a3b + index * 7919).toString(36).padEnd(16, "x").slice(0, 16)}`;
}

/** A plan of the size production plans have: a few hundred bytes to 4 KB. */
function planFor(rand: () => number, plugin: string, node: string, i: number): string {
  switch (plugin) {
    case "agentupdate": {
      const from = ["0.3.2", "0.3.6", "0.3.8"][i % 3] ?? "0.3.6";
      return agentPlan(node, from, "0.3.9-alpha.7");
    }
    case "nftpolicy": {
      const ports = Array.from({ length: 4 + Math.floor(rand() * 40) }, (_, k) => 1000 + k * 37 + (i % 50)).join(", ");
      return [
        "table inet lattice_policy {",
        "  chain ingress {",
        "    type filter hook input priority 0; policy drop;",
        "    ct state established,related accept",
        `    tcp dport { 22, 443, ${ports} } accept`,
        "    ip saddr { 10.0.0.0/8, 100.64.0.0/10 } accept",
        "  }",
        "}",
      ].join("\n");
    }
    case "proxycore": {
      const inbounds = Array.from({ length: 6 + Math.floor(rand() * 30) }, (_, k) => `  - tag: in-${k}\n    listen: 0.0.0.0\n    listen_port: ${20000 + k}\n    type: ${k % 2 ? "vless" : "hysteria2"}`);
      return ["# Lattice proxycore review plan", "", `node_id: ${node}`, "core: sing-box", "config_path: /etc/sing-box/config.json", "inbounds:", ...inbounds].join("\n");
    }
    case "sshguard":
      return ["# Lattice SSH Guard arm plan", "", `node_id: ${node}`, "ssh_port: 2202", "gated_ports: 22, 2202", "confirm_window_sec: 600", "knock: enabled", "knock_sequence: 4 tcp ports, redacted"].join("\n");
    case "wireguard":
      return `[Interface]\nAddress = 10.72.0.${(i % 200) + 2}/24\nListenPort = 51820\n\n[Peer]\nAllowedIPs = 10.72.0.0/24\nPersistentKeepalive = 25\n`;
    default:
      return `plugin: ${plugin}\nnode: ${node}\nrevision: ${i}\n`;
  }
}

const HISTORY_PLUGINS: Array<[string, string]> = [
  ["agentupdate", "update-agent"],
  ["singbox-linemeta", "apply-metadata"],
  ["nftpolicy", "apply-policy"],
  ["proxycore", "apply-config"],
  ["sshguard", "arm"],
  ["wireguard", "apply-config"],
];

/**
 * Generated history: `applied` applied rows and `rejected` rejected rows, plus
 * a few dismissed, spread over the last four months, newest last so ids sort
 * the way the store returns them.
 */
export function generateHistory(rand: () => number, applied: number, rejected: number, dismissed: number): ApprovalView[] {
  const out: ApprovalView[] = [];
  const total = applied + rejected + dismissed;
  for (let i = 0; i < total; i += 1) {
    const [plugin, action] = HISTORY_PLUGINS[i % HISTORY_PLUGINS.length] as [string, string];
    const nodeIndex = Math.floor(rand() * NODE_NAMES.length);
    const node = NODE_NAMES[nodeIndex] as string;
    const nodeId = nodeIdFor(nodeIndex);
    const ageMs = (total - i) * ((120 * DAY) / total) + rand() * HOUR;
    const status: ApprovalView["status"] = i < applied ? "applied" : i < applied + rejected ? "rejected" : "dismissed";
    const row: ApprovalView = {
      id: `approval_h${i.toString(36).padStart(4, "0")}${(0x9ab + i * 31).toString(36)}`,
      node_id: nodeId,
      plugin,
      action: plugin === "agentupdate" ? `${action}:0.3.9-alpha.7` : action,
      plan: planFor(rand, plugin, node, i),
      status,
      actor_id: i % 3 === 0 ? "lattice-server" : "cdcd",
      approved_by: status === "applied" ? "cdcd" : undefined,
      created_at: iso(-ageMs),
      updated_at: iso(-ageMs + 20 * MINUTE),
    };
    if (status === "rejected") {
      if (i % 4 === 0) {
        row.reason = "agent update approval is stale; target_version planned=0.3.8 current=0.3.9-alpha.7; re-plan before approving";
        row.plugin = "agentupdate";
        row.action = "update-agent";
        row.stale = true;
        row.stale_code = "agent_update_policy_changed";
      } else {
        row.rejected_by = "cdcd";
        row.rejected_at = row.updated_at;
        row.reason = "Rejected by an operator: the change was no longer wanted.";
      }
    }
    if (status === "dismissed") {
      row.reason = "Approved but never applied, dismissed by an operator. Re-plan if this change is still wanted.";
    }
    out.push(row);
  }
  return out;
}

// ── The hand-written states the page exists for ──────────────────────────────

export const OFFLINE: ApprovalView = {
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

export const NEVER_REPORTED: ApprovalView = {
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

export const FAILED_TASK: ApprovalView = {
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

export const SUPERSEDED: ApprovalView = {
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

export const SUPERSEDING: ApprovalView = {
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

export const NOT_QUEUED: ApprovalView = {
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

export const QUEUED: ApprovalView = {
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
export const UNEXPLAINED: ApprovalView = {
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

export const PENDING_SSH: ApprovalView = {
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

export const APPLIED: ApprovalView = {
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

export const STALE: ApprovalView = {
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

/** A fleet-wide agent update wave: many pending rows from the same writer. */
export function pendingWave(count: number): ApprovalView[] {
  return Array.from({ length: count }, (_, i) => {
    const nodeIndex = i % NODE_NAMES.length;
    return {
      id: `approval_wave${i.toString(36).padStart(3, "0")}xk${(0x41 + i).toString(36)}`,
      node_id: nodeIdFor(nodeIndex),
      plugin: "agentupdate",
      action: "update-agent:0.3.9-alpha.7",
      plan: agentPlan(NODE_NAMES[nodeIndex] as string, "0.3.6", "0.3.9-alpha.7"),
      status: "pending" as const,
      actor_id: "lattice-server",
      created_at: iso(-(50 + i) * MINUTE),
      updated_at: iso(-(50 + i) * MINUTE),
    };
  });
}

export const HAND_WRITTEN: ApprovalView[] = [
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

/**
 * The full fleet fixture: production's proportions plus every hand-written
 * state and a pending wave. Copies, so a harness may mutate them.
 */
export function buildApprovalsFixture(options: { applied?: number; rejected?: number; dismissed?: number; wave?: number } = {}): ApprovalView[] {
  const rand = mulberry32(20260904);
  const history = generateHistory(rand, options.applied ?? 1084, options.rejected ?? 190, options.dismissed ?? 12);
  return [...HAND_WRITTEN, ...pendingWave(options.wave ?? 14), ...history].map((row) => ({ ...row }));
}

// ── A fake of the listing endpoint ───────────────────────────────────────────

/** One request the fake answered, for the harness to report bytes and time. */
export interface FakeRequest {
  url: string;
  bytes: number;
  ms: number;
  startedAt: number;
}

export interface FakeApprovalsOptions {
  /** Where answered requests are recorded. */
  log?: FakeRequest[];
  /** Answer every listing the way the server did before plan text was omitted. */
  legacyAlwaysPlan?: boolean;
}

function sha256HexSync(text: string): string {
  // FNV-1a folded into 64 hex chars: not SHA-256, but stable and distinct per
  // plan, which is all the console needs from plan_sha256 in a harness. The
  // real digest is asynchronous (WebCrypto) and the fake answers synchronously
  // to keep the latency model honest.
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x811c9dc5) >>> 0;
  }
  const a = h1.toString(16).padStart(8, "0");
  const b = h2.toString(16).padStart(8, "0");
  return (a + b).repeat(4);
}

function toView(row: ApprovalView, withPlan: boolean): ApprovalView {
  const { plan, ...rest } = row;
  const view: ApprovalView = { ...rest, plan_sha256: sha256HexSync(plan ?? "") };
  if (withPlan) view.plan = plan ?? "";
  return view;
}

// The status column, compared literally, exactly as the server compares it.
// "stale" is a derived flag with its own bucket in the counts and no row ever
// carries it here, so naming it selects nothing: a fake that resolved it would
// let a console query that answers an empty list in production look healthy.
function statusMatches(row: ApprovalView, statuses: string[]): boolean {
  return statuses.length === 0 || statuses.includes(row.status);
}

export function countApprovals(rows: readonly ApprovalView[]): ApprovalCounts {
  const counts: ApprovalCounts = { pending: 0, approved: 0, stale: 0, applied: 0, rejected: 0, dismissed: 0, total: rows.length };
  for (const row of rows) {
    counts[row.status] = (counts[row.status] ?? 0) + 1;
    if (isStaleAgentUpdateApprovalView(row)) counts.stale += 1;
  }
  return counts;
}

function bool(value: unknown): boolean {
  return value === true || value === "true" || value === "1" || value === 1;
}

/**
 * The listing as the server answers it, over an in-memory store. Returns what
 * `api.approvals.list` would resolve with; `get` and `counts` are the id and
 * count=1 shapes. Latency is proportional to the bytes of the JSON answered.
 */
export function fakeApprovalsApi(store: ApprovalView[], options: FakeApprovalsOptions = {}) {
  const log = options.log ?? [];

  function answer<T>(url: string, value: T): Promise<T> {
    const bytes = new TextEncoder().encode(JSON.stringify(value)).length;
    const ms = LATENCY_FLOOR_MS + bytes / BYTES_PER_MS;
    const startedAt = performance.now();
    log.push({ url, bytes, ms, startedAt });
    return new Promise((resolve) => setTimeout(() => resolve(value), ms));
  }

  function query(params: Record<string, unknown> | undefined): string {
    const search = new URLSearchParams();
    for (const [k, v] of Object.entries(params ?? {})) {
      if (v === undefined || v === null || v === "") continue;
      search.set(k, String(v));
    }
    const qs = search.toString();
    return `/api/network/approvals${qs ? `?${qs}` : ""}`;
  }

  function visible(params: Record<string, unknown> | undefined): ApprovalView[] {
    const includeDismissed = bool(params?.include_dismissed);
    return store.filter((row) => row.status !== "dismissed" || includeDismissed);
  }

  // Counts include dismissed tombstones (the server counts every row it can
  // see under "total" and "dismissed"); listings hide them unless asked.
  function filtered(params: Record<string, unknown> | undefined, source: ApprovalView[] = visible(params)): ApprovalView[] {
    const statusRaw = params?.status;
    const statuses = (Array.isArray(statusRaw) ? statusRaw.join(",") : String(statusRaw ?? ""))
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const plugin = String(params?.plugin ?? "").trim();
    const nodeId = String(params?.node_id ?? "").trim();
    const since = String(params?.since ?? "").trim();
    const sinceMs = since ? Date.parse(since) : Number.NaN;
    return source.filter((row) => {
      if (!statusMatches(row, statuses)) return false;
      if (plugin && row.plugin !== plugin) return false;
      if (nodeId && row.node_id !== nodeId) return false;
      if (since && !(Date.parse(row.updated_at ?? row.created_at ?? "") >= sinceMs)) return false;
      return true;
    });
  }

  return {
    list(params?: Record<string, unknown>) {
      const url = query(params);
      const withPlan = options.legacyAlwaysPlan === true || params?.include === "plan";
      if (params && bool(params.count)) {
        return answer(url, { counts: countApprovals(filtered({ ...params, status: undefined }, store)) });
      }
      if (params && typeof params.id === "string") {
        const row = store.find((r) => r.id === params.id);
        if (!row) return Promise.reject(new Error("approval not found"));
        return answer(url, { approval: toView(row, true) });
      }
      const queried = params && ["status", "node_id", "plugin", "limit", "offset", "since"].some((k) => params[k] !== undefined && params[k] !== "");
      if (!queried) {
        return answer(url, visible(params).map((row) => toView(row, withPlan)));
      }
      const rows = filtered(params);
      const limit = Math.min(500, Math.max(1, Number(params?.limit ?? 100)));
      const offset = Math.max(0, Number(params?.offset ?? 0));
      const page = rows.slice(offset, offset + limit).map((row) => toView(row, withPlan));
      return answer(url, { approvals: page, total: rows.length, limit, offset });
    },
    counts(params?: Record<string, unknown>) {
      const rows = filtered({ ...params, status: undefined }, store);
      return answer(query({ ...params, count: 1 }), countApprovals(rows));
    },
    get(id: string) {
      const row = store.find((r) => r.id === id);
      if (!row) return Promise.reject(new Error("approval not found"));
      return answer(query({ id }), toView(row, true));
    },
    log,
  };
}
