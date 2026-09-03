/**
 * An in-memory stand-in for `@/lib/api`, wired in by vite.harness.config.ts
 * through a resolve alias so the production config and bundle never see it.
 *
 *   LATTICE_HARNESS=status pnpm exec vite --config vite.harness.config.ts
 *   open http://127.0.0.1:5185/dev/status.html        (Overview)
 *   open http://127.0.0.1:5185/dev/status-nodes.html  (Nodes)
 *
 * Everything the real barrel exports is re-exported unchanged; only `api` is
 * replaced, and only the calls Overview and Nodes make are implemented.
 * Anything else throws, loudly, so a new call path is noticed rather than
 * silently fed nothing.
 *
 * The fleet is the production shape (33 nodes, the bracketed group prefixes,
 * five providers) with every status word present at least twice, plus the
 * production facts the ontology exists for: a Mac that used to read offline on
 * one page and degraded on another, a node offline since 2026-08-27, and one
 * that never reported. Each node carries `status`, `status_since` and
 * `status_reason` the way lattice-server sends them, and the legacy `online`
 * and `reachability` fields set to agree with the word.
 *
 * The task fixture below covers every task state the console can print, so the
 * badge colours can be compared side by side, plus the KI-20 shape itself: a
 * fan-out whose target on the offline node has been re-leased three times over
 * six days and carries a `stalled_reason` that ends in a full stop.
 */
import type { Node, NodeStatus, Principal, TaskResult, TaskView } from "@/lib/api/index";

export * from "@/lib/api/index";

const NOW = Date.now();
const LATENCY_MS = 60;

function iso(offsetMs: number): string {
  return new Date(NOW + offsetMs).toISOString();
}

function delay<T>(value: T, ms = LATENCY_MS): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

interface FleetEntry {
  name: string;
  ip: string;
  host: string;
  os: string;
  status: NodeStatus;
  country?: string;
  /** How long ago the state began. */
  sinceMs?: number;
  reason?: string;
  cpu?: number;
}

const FLEET: FleetEntry[] = [
  { name: "[cd]-DMIT-pro-malibu", ip: "203.0.113.11", host: "dmit-proxy-us", os: "Debian 12", status: "degraded", country: "US", sinceMs: 35 * 60_000, reason: "Reporting, but sing-box has been restarting since 2026-09-02T11:25:00Z (unit activating/auto-restart, 221904 restarts).", cpu: 41 },
  { name: "[Metix]-DMIT-1", ip: "198.51.100.21", host: "metix-dmit-1", os: "Ubuntu 22.04", status: "online", country: "US", sinceMs: 9 * DAY, cpu: 12 },
  { name: "[Metix]-DMIT-2", ip: "198.51.100.22", host: "metix-dmit-2", os: "Ubuntu 22.04", status: "online", country: "US", sinceMs: 9 * DAY, cpu: 18 },
  { name: "[Metix]-DMIT-3", ip: "198.51.100.23", host: "metix-dmit-3", os: "Ubuntu 22.04", status: "online", country: "US", sinceMs: 3 * DAY, cpu: 7 },
  { name: "[Metix]-DMIT-4", ip: "198.51.100.24", host: "metix-dmit-4", os: "Ubuntu 22.04", status: "offline", country: "US", sinceMs: 6 * DAY + 3 * HOUR, reason: "No report since 2026-08-27T08:51:00Z; the control plane stops trusting a node after 1m30s of silence." },
  { name: "[cd]-mac-air", ip: "203.0.113.90", host: "mac-air.local", os: "macOS 15.6", status: "degraded", country: "CN", sinceMs: 31 * HOUR, reason: "Reporting, but the guard reality snapshot was collected at 2026-08-31T04:12:00Z and is older than 30h0m0s while the agent keeps reporting.", cpu: 96 },
  { name: "gomami-hk-turin-mini", ip: "203.0.113.12", host: "hk-turin", os: "Debian 12", status: "online", country: "HK", sinceMs: 14 * DAY, cpu: 22 },
  { name: "gomami-jp-pulse-mini", ip: "203.0.113.13", host: "jp-pulse", os: "Debian 12", status: "online", country: "JP", sinceMs: 14 * DAY, cpu: 9 },
  { name: "qqpw-cd2-VDS", ip: "203.0.113.14", host: "cd2", os: "Ubuntu 24.04", status: "online", country: "CN", sinceMs: 2 * DAY, cpu: 31 },
  { name: "qqpw-cd3-VDS", ip: "203.0.113.15", host: "cd3", os: "Ubuntu 24.04", status: "online", country: "CN", sinceMs: 2 * DAY, cpu: 28 },
  { name: "Aaitr-ATT-VDS", ip: "203.0.113.16", host: "att-vds", os: "Debian 12", status: "online", country: "US", sinceMs: 21 * DAY, cpu: 4 },
  { name: "Aaitr-Frontier-VDS", ip: "203.0.113.17", host: "frontier-vds", os: "Debian 12", status: "online", country: "US", sinceMs: 21 * DAY, cpu: 6 },
  { name: "VIRCS-ATT-VDS", ip: "203.0.113.18", host: "vircs-att", os: "Debian 12", status: "online", country: "US", sinceMs: 5 * DAY, cpu: 11 },
  { name: "Aaitr-Frontier-NAT", ip: "203.0.113.19", host: "frontier-nat", os: "Alpine 3.20", status: "online", country: "US", sinceMs: 5 * DAY, cpu: 3 },
  { name: "Aaitr-jp-softbank-NAT", ip: "203.0.113.20", host: "jp-softbank", os: "Alpine 3.20", status: "online", country: "JP", sinceMs: 8 * DAY, cpu: 2 },
  { name: "mkcloud-hr-iplc", ip: "203.0.113.21", host: "hr-iplc", os: "Debian 12", status: "online", country: "HR", sinceMs: 30 * DAY, cpu: 15 },
  { name: "DMIT-eb-wee", ip: "203.0.113.22", host: "eb-wee", os: "Debian 12", status: "online", country: "US", sinceMs: 30 * DAY, cpu: 8 },
  { name: "[OpenJobs-Data]-tmp", ip: "203.0.113.23", host: "oj-tmp", os: "Ubuntu 22.04", status: "offline", country: "SG", sinceMs: 19 * DAY, reason: "No report since 2026-08-14T02:03:00Z; the control plane stops trusting a node after 1m30s of silence." },
  { name: "[OpenJobs-Data]-crawler-1", ip: "203.0.113.24", host: "oj-crawler-1", os: "Ubuntu 22.04", status: "online", country: "SG", sinceMs: 12 * DAY, cpu: 63 },
  { name: "[OpenJobs-Data]-crawler-2", ip: "203.0.113.25", host: "oj-crawler-2", os: "Ubuntu 22.04", status: "online", country: "SG", sinceMs: 12 * DAY, cpu: 58 },
  { name: "xuezhang-jp", ip: "203.0.113.26", host: "xuezhang-jp", os: "Debian 11", status: "online", country: "JP", sinceMs: 40 * DAY, cpu: 19 },
  { name: "[cd]-Oracle-KIX-arm", ip: "203.0.113.27", host: "kix-arm", os: "Ubuntu 22.04", status: "online", country: "JP", sinceMs: 60 * DAY, cpu: 5 },
  { name: "[Metix]-Oracle-KIX-arm", ip: "203.0.113.28", host: "metix-kix", os: "Ubuntu 22.04", status: "disabled", country: "JP", sinceMs: 2 * DAY, reason: "Disabled by an operator at 2026-08-31T10:00:00Z; the agent token is refused until the node is enabled again." },
  { name: "[cd]-hetzner-fsn", ip: "203.0.113.29", host: "fsn1", os: "Debian 12", status: "online", country: "DE", sinceMs: 90 * DAY, cpu: 14 },
  { name: "[cd]-hetzner-hel", ip: "203.0.113.30", host: "hel1", os: "Debian 12", status: "online", country: "FI", sinceMs: 90 * DAY, cpu: 10 },
  { name: "[cd]-racknerd-la", ip: "203.0.113.31", host: "la-rn", os: "AlmaLinux 9", status: "online", country: "US", sinceMs: 45 * DAY, cpu: 21 },
  { name: "[cd]-bandwagon-dc6", ip: "203.0.113.32", host: "dc6", os: "Debian 12", status: "online", country: "US", sinceMs: 45 * DAY, cpu: 33 },
  { name: "[cd]-vultr-syd", ip: "203.0.113.33", host: "syd", os: "Debian 12", status: "online", country: "AU", sinceMs: 7 * DAY, cpu: 12 },
  { name: "[cd]-linode-sgp", ip: "203.0.113.34", host: "sgp", os: "Debian 12", status: "online", country: "SG", sinceMs: 7 * DAY, cpu: 17 },
  { name: "[cd]-contabo-lon", ip: "203.0.113.35", host: "lon", os: "Ubuntu 24.04", status: "online", country: "GB", sinceMs: 25 * DAY, cpu: 26 },
  { name: "[cd]-new-hkbn-hub", ip: "", host: "", os: "", status: "never_reported", sinceMs: 5 * DAY, reason: "No report has arrived since enrollment at 2026-08-28T09:40:00Z." },
  { name: "[OpenJobs-Data]-gpu-box", ip: "", host: "", os: "", status: "never_reported", sinceMs: 11 * HOUR, reason: "No report has arrived since enrollment at 2026-09-02T01:00:00Z." },
  { name: "[cd]-retired-2023", ip: "203.0.113.40", host: "old", os: "Debian 10", status: "disabled", country: "US", sinceMs: 200 * DAY, reason: "Disabled by an operator at 2026-02-14T00:00:00Z; the agent token is refused until the node is enabled again." },
];

function reasonFor(e: FleetEntry): string {
  if (e.reason) return e.reason;
  return `Reporting; last report at ${iso(-3000).replace(/\.\d{3}Z$/, "Z")}.`;
}

function toNode(e: FleetEntry, index: number): Node {
  const id = `node_${String(index + 1).padStart(3, "0")}`;
  const reporting = e.status === "online" || e.status === "degraded";
  const lastSeen =
    e.status === "never_reported" ? "0001-01-01T00:00:00Z" : e.status === "offline" ? iso(-(e.sinceMs ?? HOUR)) : iso(-3000);
  const reachability = e.status === "never_reported" ? "never" : reporting || e.status === "disabled" ? "online" : "offline";
  const memTotal = 8 * 1024 ** 3;
  const diskTotal = 80 * 1024 ** 3;
  return {
    id,
    name: e.name,
    tags: e.name.includes("hub") ? ["hub"] : [],
    role: "",
    public_ip: e.ip || undefined,
    agent_version: e.status === "never_reported" ? "" : "0.3.8",
    online: reporting || e.status === "disabled",
    reachability,
    status: e.status,
    status_since: e.sinceMs === undefined ? undefined : iso(-e.sinceMs),
    status_reason: reasonFor(e),
    disabled: e.status === "disabled" || undefined,
    last_seen: lastSeen,
    metrics:
      e.status === "never_reported"
        ? undefined
        : {
            cpu_percent: e.cpu ?? 10,
            memory_used: Math.round(memTotal * ((e.cpu ?? 10) / 100 + 0.2)),
            memory_total: memTotal,
            disk_used: Math.round(diskTotal * 0.4),
            disk_total: diskTotal,
            net_rx_speed: reporting ? 120_000 * ((e.cpu ?? 10) + 1) : 0,
            net_tx_speed: reporting ? 90_000 * ((e.cpu ?? 10) + 1) : 0,
            net_rx_bytes: 4_000_000_000_000,
            net_tx_bytes: 2_500_000_000_000,
            uptime_seconds: 86_400 * 12,
          },
    host_facts: e.host ? { hostname: e.host, os: e.os, arch: e.name.includes("arm") ? "arm64" : "amd64" } : undefined,
    geo: e.country ? { country: e.country, source: "auto" } : undefined,
    agent_runtime: reporting ? { allow_exec: true, allow_root_exec: false, no_exec: false, allow_terminal: true, ssh_alerts: true, singbox_discover: true, reported_at: iso(-3000) } : null,
  } as Node;
}

const nodes: Node[] = FLEET.map(toNode);

/**
 * One task per state, so the Tasks page and the node page's queue can be read
 * against each other. Node ids follow FLEET's order: 002/003 are online,
 * 005 is the node offline since 2026-08-27, 031 never reported.
 */
const tasks: TaskView[] = [
  // KI-20: leased at fan-out level, stalled on the offline node. The reason is
  // a finished sentence, which is what used to collide with the comma before
  // "attempt 3 of 3".
  {
    id: "tsk_stalled_fanout",
    targets: ["node_002", "node_005"],
    interpreter: "sh",
    status: "leased",
    script_size_bytes: 412,
    timeout_sec: 300,
    created_at: iso(-(6 * DAY + 3 * HOUR)),
    started_at: iso(-(6 * DAY + 3 * HOUR)),
    target_states: {
      node_002: { status: "leased", attempts: 1, max_attempts: 3, lease_age_seconds: 41 * 60 },
      node_005: {
        status: "stalled",
        attempts: 3,
        max_attempts: 3,
        lease_age_seconds: 6 * 86400 + 3 * 3600,
        stalled_reason:
          "The store stopped re-leasing after 3 attempts (last lease expired 2026-08-27T08:51:00Z).",
      },
    },
  },
  // Single target, running now.
  {
    id: "tsk_running",
    targets: ["node_003"],
    interpreter: "bash",
    status: "leased",
    script_size_bytes: 96,
    created_at: iso(-42 * 60_000),
    started_at: iso(-41 * 60_000),
    attempts: 1,
    max_attempts: 3,
    lease_age_seconds: 41 * 60,
  },
  // Waiting for an agent that is not there to take it.
  {
    id: "tsk_queued",
    targets: ["node_031"],
    interpreter: "sh",
    status: "queued",
    script_size_bytes: 64,
    created_at: iso(-11 * HOUR),
  },
  { id: "tsk_failed", targets: ["node_004"], interpreter: "sh", status: "failed", script_size_bytes: 210, created_at: iso(-2 * HOUR), finished_at: iso(-2 * HOUR + 4000) },
  { id: "tsk_finished", targets: ["node_007"], interpreter: "sh", status: "finished", script_size_bytes: 88, created_at: iso(-3 * HOUR), finished_at: iso(-3 * HOUR + 2200) },
  { id: "tsk_cancelled", targets: ["node_009"], interpreter: "sh", status: "cancelled", script_size_bytes: 120, created_at: iso(-5 * HOUR) },
  { id: "tsk_expired", targets: ["node_018"], interpreter: "sh", status: "expired", script_size_bytes: 150, created_at: iso(-4 * DAY) },
  // Stalled at the task level too, so the sidebar count and the Tasks filter
  // both have something to find.
  {
    id: "tsk_stalled_single",
    targets: ["node_005"],
    interpreter: "sh",
    status: "stalled",
    script_size_bytes: 300,
    created_at: iso(-(6 * DAY)),
    attempts: 3,
    max_attempts: 3,
    stalled_reason: "Superseded by v0.3.9-alpha.5.",
  },
];

const results: TaskResult[] = [
  { task_id: "tsk_failed", node_id: "node_004", exit_code: 1, error: "sing-box: exit status 1", stdout: "", stderr: "FATAL: config parse error at line 12\n", started_at: iso(-2 * HOUR), finished_at: iso(-2 * HOUR + 4000) },
  { task_id: "tsk_finished", node_id: "node_007", exit_code: 0, stdout: "ok\n", started_at: iso(-3 * HOUR), finished_at: iso(-3 * HOUR + 2200) },
];

const principal: Principal = {
  actor_id: "cdcd",
  username: "cdcd",
  scopes: ["node:read", "node:admin", "approval:read", "task:read", "audit:read", "terminal:open", "group:read"],
  server_allowlist: [],
  csrf_token: "harness",
  totp_enabled: true,
};

const unimplemented = new Proxy(
  {},
  {
    get(_target, prop) {
      return () => Promise.reject(new Error(`fake api: ${String(prop)} is not implemented in the status harness`));
    },
  },
);

export const api = {
  auth: {
    me: () => delay(principal),
  },
  nodes: {
    list: () => delay({ nodes: nodes.map((n) => ({ ...n })) }),
    duplicates: () => delay({ groups: [] }),
  },
  approvals: {
    list: () => delay({ approvals: [] }),
  },
  tasks: {
    list: () => delay({ tasks: tasks.map((t) => ({ ...t })) }),
    listForNode: (nodeId: string) =>
      delay({ tasks: tasks.filter((t) => t.targets.includes(nodeId)).map((t) => ({ ...t })) }),
    results: (query?: { node_id?: string }) =>
      delay({
        results: results
          .filter((r) => !query?.node_id || r.node_id === query.node_id)
          .map((r) => ({ ...r })),
      }),
  },
  audit: {
    query: () => delay({ events: [] }),
  },
  agentUpdates: {
    list: () => delay({ policies: [] }),
  },
  groups: {
    list: () => delay({ groups: [] }),
  },
  // Read-only extras the node page pulls on mount. Empty is a legitimate
  // answer for each; the page renders its own empty states for them.
  ddns: {
    list: () => delay([]),
  },
  capabilities: {
    list: () => delay({ capabilities: [] }),
  },
} as unknown as typeof import("@/lib/api/index").api;

void unimplemented;
