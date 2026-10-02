/**
 * Production-shaped data for the Operations harness (Approvals, Tasks, Audit).
 *
 * Counts follow production on 2026-09-30 (FACTS.md): 34 nodes (32 online),
 * 1,351 approvals (1,144 applied, 207 rejected, 0 pending), 1,771 tasks
 * (1,523 finished, 243 failed, 4 cancelled, 1 stalled) and an audit log past
 * the server's 200,000-record scan cap, with node online/offline flips at
 * about 44 a day. Everything else is invented and marked so: node names past
 * the approvals fixture's twelve, the last-24-hour split of tasks (31 runs, 5
 * failed), the origin mix, failure messages, and the audit action mix.
 *
 * Everything is deterministic (seeded), so two loads of the harness agree and
 * a screenshot can be compared with the next one.
 */
import type { AuditEvent, AuditQueryResponse, AuditVerifyResponse, Node, TaskCounts, TaskResult, TaskView } from "@/lib/api/types";

import {
  DAY,
  HAND_WRITTEN,
  HOUR,
  MINUTE,
  NODE_NAMES,
  NOW,
  generateHistory,
  iso,
  mulberry32,
  nodeIdFor,
  pendingWave,
} from "./approvalsFixture";
import type { ApprovalView } from "@/lib/api/types";

// ── Nodes ────────────────────────────────────────────────────────────────────

/** Invented names in the operator's naming style, after the approvals fixture's twelve. */
const MORE_NAMES = [
  "[cd]-DMIT-2",
  "[cd]-Aaitr-ATT-VDS",
  "[Metix]-Vultr-SG",
  "[Metix]-Racknerd-NYC",
  "[cd]-gomami-hkg",
  "[cd]-Linode-OSA",
  "[cd]-Hetzner-FSN-1",
  "[Metix]-DMIT-1",
  "[Metix]-Oracle-KIX",
  "[cd]-homeserver",
  "[Metix]-AWS-Tokyo",
  "[cd]-BWH-DC9",
  "[Metix]-CloudCone-LA",
  "[cd]-Netcup-VIE",
  "[Metix]-OVH-GRA",
  "[cd]-Contabo-SIN",
  "[cd]-Kuroit-LON",
  "[Metix]-Zgovps-HK-BGP",
  "[cd]-V.PS-TYO",
  "[Metix]-DMIT-4",
  "[cd]-DO-SFO3",
  "[cd]-GreenCloud-SG",
];

export const NODE_COUNT = 34;
const OFFLINE_NODES = new Set([9, 31]);

export function buildNodes(): Node[] {
  const names = [...NODE_NAMES, ...MORE_NAMES];
  return Array.from({ length: NODE_COUNT }, (_, i) => {
    const offline = OFFLINE_NODES.has(i);
    return {
      id: nodeIdFor(i),
      name: names[i] ?? `node-${i}`,
      online: !offline,
      reachability: offline ? "offline" : "online",
      status: offline ? "offline" : "online",
      status_since: iso(offline ? -(i === 9 ? 34 * DAY : 41 * MINUTE) : -3 * DAY),
      agent_version: i % 5 === 0 ? "0.3.8" : "0.3.9",
      last_seen: iso(offline ? -41 * MINUTE : -(2 + (i % 9)) * 1000),
      tags: i % 2 ? ["cd"] : ["Metix"],
    } as unknown as Node;
  });
}

export const NODES = buildNodes();
export const NODE_IDS = NODES.map((node) => node.id);

/**
 * The nodes the approvals fixture's hand-written rows name (stuck, stale and
 * pending states). Their ids are their own, so the pending fixture lists them
 * beside the 34 for names to resolve; names come from each row's waiting
 * block, so four repeat a name the 34 already use. Invented.
 */
export const HAND_WRITTEN_NODES: Node[] = [
  ["node_ttp3p32iykd4an5w", "[OpenJobs-Data]-tmp", "offline"],
  ["node_9f2mq7wxbc4l0dhz", "hel-edge-04", "never_reported"],
  ["node_4kd82mwqxr9tzb1v", "sgp-edge-01", "online"],
  ["node_1pxv8wq4rm2tzkbd", "fra-edge-02", "online"],
  ["node_6tzr2wqk8xm1bd4v", "ams-gw-01", "online"],
  ["node_5wq2rtzk8xm1bd6v", "tyo-edge-03", "online"],
  ["node_8xm1bd4vzk6tqr2w", "[cd]-wg-hub", "online"],
  ["node_2wqrtzk85xm1bd6v", "[Metix]-bastion", "online"],
].map(([id, name, status]) => ({
  id,
  name,
  online: status === "online",
  reachability: status,
  status,
  status_since: iso(-3 * DAY),
  agent_version: "0.3.9",
  last_seen: iso(status === "online" ? -4000 : -34 * DAY),
  tags: ["cd"],
})) as unknown as Node[];

// ── Approvals ────────────────────────────────────────────────────────────────

/**
 * `prod` is production's shape: history only, nothing waiting. `pending`
 * adds the hand-written stuck states and a 14-node agent-update wave, so the
 * Needs you and Stuck layers have rows to render.
 */
export function buildApprovals(fixture: string): ApprovalView[] {
  if (fixture === "empty") return [];
  const rand = mulberry32(20260930);
  // The generator ages rows by status (every applied row older than every
  // rejected one). Production interleaves them, so the ages are dealt out
  // again in a seeded shuffle, keeping the 120-day spread. Invented.
  const generated = generateHistory(rand, 1144, 207, 0);
  const ages = generated.map((row) => [Date.parse(row.created_at ?? ""), Date.parse(row.updated_at ?? "")] as const);
  const shuffle = mulberry32(20261001);
  const order = generated.map((row, i) => ({ row, key: shuffle(), i })).sort((a, b) => a.key - b.key);
  order.forEach(({ row }, k) => {
    const [created, updated] = ages[k] as readonly [number, number];
    row.created_at = new Date(created).toISOString();
    row.updated_at = new Date(updated).toISOString();
    if (row.rejected_at) row.rejected_at = row.updated_at;
  });
  // Newest first, the order the server lists in.
  const history = [...generated].sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""));
  const rows = fixture === "pending" ? [...HAND_WRITTEN, ...pendingWave(14), ...history] : history;
  return rows.map((row) => ({ ...row }));
}

// ── Tasks and their results ──────────────────────────────────────────────────

/** Invented: why runs fail on this fleet. Exit code, first stderr line, agent error. */
const FAILURES: Array<{ exit?: number; stderr?: string; error?: string }> = [
  { exit: 127, stderr: "sh: 1: curl: not found" },
  { exit: 1, stderr: "Job for sing-box.service failed because the control process exited with error code." },
  { exit: 2, stderr: "/dev/stdin:4:1-4: Error: syntax error, unexpected newline" },
  { exit: 124, stderr: "", error: "task timed out after 300s" },
  { exit: 1, stderr: "E: Unable to locate package wireguard-tools" },
  { exit: 137, stderr: "Killed" },
  { exit: 1, stderr: "curl: (28) Connection timed out after 10001 milliseconds" },
];

const INTERPRETERS = ["sh", "sh", "sh", "bash", "python3"];

export interface TaskFixture {
  tasks: TaskView[];
  results: TaskResult[];
}

function hex(rand: () => number, length: number): string {
  let out = "";
  while (out.length < length) out += Math.floor(rand() * 16).toString(16);
  return out;
}

/** The task that stalled: a probe against the node offline since late August. */
export const STALLED_TASK_INDEX = 186;

/**
 * 1,771 tasks, newest first: 31 in the last 24 hours (5 failed, invented),
 * the rest spread over 120 days. Results are kept for the newest 2,000 only,
 * as the server's store does; an older task keeps only its own status.
 */
export function buildTasks(fixture: string, approvals: readonly ApprovalView[]): TaskFixture {
  if (fixture === "empty") return { tasks: [], results: [] };
  const rand = mulberry32(20260930 + 7);
  const applied = approvals.filter((row) => row.status === "applied");
  const TOTAL = 1771;
  const RECENT = 31;
  const recentFailed = new Set([2, 7, 12, 19, 26]);
  const cancelled = new Set([144, 610, 1022, 1450]);
  const tasks: TaskView[] = [];
  let failedLeft = 243 - recentFailed.size;
  const olderSlots = TOTAL - RECENT - cancelled.size - 1;
  for (let i = 0; i < TOTAL; i += 1) {
    const ageMs = i < RECENT ? (i + 0.5) * (DAY / RECENT) : DAY + (i - RECENT) * ((119 * DAY) / (TOTAL - RECENT));
    const created = NOW - ageMs;
    const roll = rand();
    const fan = roll < 0.8 ? 1 : roll < 0.95 ? 2 + Math.floor(rand() * 4) : 10 + Math.floor(rand() * 25);
    const start = Math.floor(rand() * NODE_COUNT);
    const targets = Array.from({ length: Math.min(fan, NODE_COUNT) }, (_, k) => NODE_IDS[(start + k * 7) % NODE_COUNT] as string);
    const originRoll = rand();
    const origin = originRoll < 0.55 ? "approval" : originRoll < 0.9 ? "direct" : "rerun";
    let status: TaskView["status"] = "finished";
    if (i === STALLED_TASK_INDEX) status = "stalled";
    else if (cancelled.has(i)) status = "cancelled";
    else if (i < RECENT) status = recentFailed.has(i) ? "failed" : "finished";
    else if (failedLeft > 0 && rand() < failedLeft / Math.max(1, olderSlots - (i - RECENT))) {
      status = "failed";
      failedLeft -= 1;
    }
    const task: TaskView = {
      id: `task_${(0x7a3 + (TOTAL - i) * 7919).toString(36).padStart(8, "0")}${hex(rand, 6)}`,
      actor_id: origin === "approval" ? "lattice-server" : "cdcd",
      targets: status === "stalled" ? [NODE_IDS[9] as string] : targets,
      interpreter: INTERPRETERS[i % INTERPRETERS.length] as string,
      script_sha256: hex(rand, 64),
      script_size_bytes: 60 + Math.floor(rand() * 2400),
      timeout_sec: 300,
      output_limit: 65536,
      status,
      created_at: new Date(created).toISOString(),
      started_at: new Date(created + 4_000).toISOString(),
      finished_at: status === "stalled" ? undefined : new Date(created + 9_000 + rand() * 60_000).toISOString(),
      origin,
    };
    if (origin === "approval" && applied.length) {
      task.approval_id = applied[Math.floor(rand() * applied.length)]?.id;
    }
    if (status === "stalled") {
      task.created_at = iso(-6 * DAY - 3 * HOUR);
      task.started_at = iso(-6 * DAY);
      task.attempts = 3;
      task.max_attempts = 3;
      task.lease_age_seconds = 6 * 24 * 3600;
      task.stalled_reason = "leased 3 times and never answered; the node has not reported since 2026-08-27";
      task.origin = "direct";
      task.actor_id = "cdcd";
      delete task.approval_id;
    }
    tasks.push(task);
  }
  // A rerun names the older task it repeats.
  for (let i = 0; i < tasks.length; i += 1) {
    const task = tasks[i] as TaskView;
    if (task.origin === "rerun") {
      const older = tasks[Math.min(tasks.length - 1, i + 3 + (i % 11))] as TaskView;
      task.rerun_of_task_id = older.id;
    }
  }
  // Results, newest task first, until the store's 2,000 are used.
  const results: TaskResult[] = [];
  for (const task of tasks) {
    if (results.length >= 2000) break;
    if (task.status === "stalled" || task.status === "cancelled") continue;
    const failure = FAILURES[Math.floor(rand() * FAILURES.length)] as (typeof FAILURES)[number];
    // A failed fan-out: most targets pass, some fail. A single target fails whole.
    const failingCount = task.status === "failed" ? Math.max(1, Math.round(task.targets.length * (0.2 + rand() * 0.3))) : 0;
    task.targets.forEach((nodeId, k) => {
      const fails = k < failingCount;
      const stdout = fails ? "" : ["ok", "sing-box 1.12.8 is running", "applied 14 rules", "agent 0.3.9 running"][k % 4] + "\n";
      const stderr = fails ? (failure.stderr ? `${failure.stderr}\n${failure.exit === 1 ? "See \"systemctl status sing-box.service\" for details.\n" : ""}` : "") : "";
      results.push({
        task_id: task.id,
        node_id: nodeId,
        exit_code: fails ? failure.exit : 0,
        stdout,
        stderr,
        error: fails ? failure.error : undefined,
        started_at: task.started_at,
        finished_at: task.finished_at,
      });
    });
  }
  return { tasks, results };
}

export function countTasks(tasks: readonly TaskView[]): TaskCounts {
  const since = NOW - DAY;
  const changed = (task: TaskView) => Date.parse(task.finished_at ?? task.started_at ?? task.created_at ?? "") >= since;
  return {
    pending: tasks.filter((task) => task.status === "pending").length,
    queued: tasks.filter((task) => task.status === "queued").length,
    running: tasks.filter((task) => task.status === "leased").length,
    stalled: tasks.filter((task) => task.status === "stalled").length,
    failed_24h: tasks.filter((task) => task.status === "failed" && task.origin !== "rerun" && changed(task)).length,
    finished_24h: tasks.filter((task) => (task.status === "finished" || task.status === "failed") && task.origin !== "rerun" && changed(task)).length,
    total: tasks.length,
    generated_at: new Date().toISOString(),
  };
}

// ── Audit: a log past the scan cap, generated on demand ──────────────────────

export const AUDIT_TOTAL = 230_000;
export const AUDIT_SCAN_CAP = 200_000;
/** 230,000 events over 40 days. */
const AUDIT_SPACING_MS = (40 * DAY) / AUDIT_TOTAL;

function mix(i: number): number {
  let x = (i + 0x9e3779b9) >>> 0;
  x = Math.imul(x ^ (x >>> 16), 0x85ebca6b) >>> 0;
  x = Math.imul(x ^ (x >>> 13), 0xc2b2ae35) >>> 0;
  return (x ^ (x >>> 16)) >>> 0;
}

/** Invented action mix; the flip rate is production's (about 44 a day). */
const OBSERVE_ACTIONS = ["ssh.session.open", "agent.event", "singbox.state", "auth.login.prompt"];
const CHANGE_ACTIONS: Array<[string, string]> = [
  ["task.create", "task:run"],
  ["task.result", "task:read"],
  ["approval.create", "network:plan"],
  ["approval.approve", "network:apply"],
  ["network.apply", "network:apply"],
  ["node.update", "node:admin"],
  ["auth.login", ""],
  ["plugin.call", "plugin:call"],
  ["kv.put", "kv:write"],
  ["ddns.update", "ddns:admin"],
];

/** Events per day is 5,750; a flip every 131 events is about 44 a day. */
const FLIP_EVERY = 131;

export interface AuditShape {
  action: string;
  decision: string;
  nodeIndex: number;
  actor: string;
  scope: string;
}

/**
 * Real ids for the traces: an approve, the task it queued and that task's
 * result share a correlation id and point at an applied approval and a task
 * whose results the fake still holds. Set by the fake once it has built them.
 */
let LINK_APPROVALS: string[] = [];
let LINK_TASKS: string[] = [];

export function linkAudit(approvalIds: string[], taskIds: string[]): void {
  LINK_APPROVALS = approvalIds;
  LINK_TASKS = taskIds;
}

/** One group in five of three consecutive events is an approve, run, result chain. */
function chainOf(i: number): number | null {
  const group = Math.floor(i / 3);
  return mix(group * 7 + 1) % 5 === 0 ? group : null;
}

const CHAIN: Array<[string, string, string]> = [
  ["task.result", "task:read", "lattice-server"],
  ["task.create", "task:run", "lattice-server"],
  ["approval.approve", "network:apply", "cdcd"],
];

export function auditShape(i: number): AuditShape {
  const h = mix(i);
  const chain = chainOf(i);
  if (chain !== null) {
    const [action, scope, actor] = CHAIN[i % 3] as [string, string, string];
    return { action, decision: "allow", nodeIndex: mix(chain) % NODE_COUNT, actor, scope };
  }
  const nodeIndex = h % NODE_COUNT;
  if (h % FLIP_EVERY === 0) {
    return { action: (h >>> 8) % 2 ? "node.offline" : "node.online", decision: "allow", nodeIndex, actor: "lattice-server", scope: "" };
  }
  const bucket = (h >>> 4) % 100;
  if (bucket < 58) {
    return { action: OBSERVE_ACTIONS[(h >>> 12) % OBSERVE_ACTIONS.length] as string, decision: "observe", nodeIndex, actor: "lattice-agent", scope: "" };
  }
  const [action, scope] = CHANGE_ACTIONS[(h >>> 12) % CHANGE_ACTIONS.length] as [string, string];
  const decision = bucket < 60 ? "deny" : "allow";
  const actor = action === "task.result" || action === "network.apply" ? "lattice-server" : (h >>> 20) % 9 === 0 ? "token_ci7f3a" : "cdcd";
  return { action, decision, nodeIndex, actor, scope };
}

export function auditAt(i: number): number {
  return NOW - i * AUDIT_SPACING_MS - (mix(i + 7) % 9000);
}

export function auditEvent(i: number): AuditEvent {
  const shape = auditShape(i);
  const node = NODES[shape.nodeIndex] as Node;
  const event: AuditEvent = {
    id: `audit_${(AUDIT_TOTAL - i).toString(36).padStart(6, "0")}${(mix(i) % 46656).toString(36)}`,
    at: new Date(auditAt(i)).toISOString(),
    actor_id: shape.actor,
    node_id: shape.action === "auth.login" ? undefined : node.id,
    action: shape.action,
    scope: shape.scope || undefined,
    decision: shape.decision,
  };
  if (shape.action === "node.offline" || shape.action === "node.online") {
    event.reason = shape.action === "node.offline" ? "no heartbeat for 90s" : "heartbeat resumed";
  }
  if (shape.decision === "deny") {
    event.reason = shape.action === "auth.login" ? "second factor rejected" : `missing scope ${shape.scope || "task:run"}`;
  }
  const chain = chainOf(i);
  if (chain !== null) {
    event.correlation_id = `req_${(mix(chain) % 0xffffffff).toString(36)}`;
    const approvalId = LINK_APPROVALS.length ? (LINK_APPROVALS[mix(chain) % LINK_APPROVALS.length] as string) : `approval_${(mix(chain) % 0xffffff).toString(36)}`;
    const taskId = LINK_TASKS.length ? (LINK_TASKS[mix(chain + 3) % LINK_TASKS.length] as string) : `task_${(mix(chain) % 0xffffff).toString(36)}`;
    event.metadata = shape.action.startsWith("task.") ? { task_id: taskId, approval_id: approvalId } : { approval_id: approvalId };
  } else if (shape.action.startsWith("task.") || shape.action.startsWith("approval.") || shape.action === "network.apply") {
    event.correlation_id = `req_${(mix(i) % 0xffffffff).toString(36)}x`;
    event.metadata = shape.action.startsWith("task.")
      ? { targets: String(1 + (mix(i) % 3)) }
      : { plugin: ["vpn-core", "netguard", "agentupdate", "sub-store"][mix(i) % 4] as string };
  }
  if (shape.action === "auth.login" && shape.decision === "allow") event.metadata = { method: "passkey" };
  return event;
}

export interface AuditQuery {
  action?: string;
  decision?: string;
  node_id?: string;
  actor_id?: string;
  scope?: string;
  correlation_id?: string;
  q?: string;
  at_from?: string;
  at_to?: string;
  exclude_action?: string;
  exclude_decision?: string;
  limit?: number;
  offset?: number;
}

/** auditFieldMatches: exact, or a prefix when the wanted value ends in "*". */
function fieldMatches(value: string, want: string): boolean {
  const trimmed = want.trim();
  if (!trimmed) return true;
  return trimmed.endsWith("*") ? value.startsWith(trimmed.slice(0, -1)) : value === trimmed;
}

/** GET /api/audit as collectAuditPage answers it, over the generated log. */
export function queryAudit(params: AuditQuery): AuditQueryResponse {
  const limit = Math.min(500, Math.max(1, Number(params.limit ?? 100)));
  const offset = Math.max(0, Number(params.offset ?? 0));
  const atFrom = params.at_from ? Date.parse(params.at_from) : Number.NaN;
  const atTo = params.at_to ? Date.parse(params.at_to) : Number.NaN;
  const excludes = (params.exclude_action ?? "").split(",").map((s) => s.trim().replace(/\*$/, "")).filter(Boolean);
  const skipDecisions = new Set((params.exclude_decision ?? "").split(",").map((s) => s.trim()).filter(Boolean));
  const nodeIndex = params.node_id ? NODE_IDS.indexOf(params.node_id) : -1;
  const q = (params.q ?? "").trim().toLowerCase();
  const events: AuditEvent[] = [];
  let total = 0;
  let scanned = 0;
  let complete = true;
  for (let i = 0; i < AUDIT_TOTAL; i += 1) {
    const at = auditAt(i);
    if (!Number.isNaN(atFrom) && at < atFrom) break;
    scanned += 1;
    const shape = auditShape(i);
    let match = true;
    if (!Number.isNaN(atTo) && at > atTo) match = false;
    else if (params.action && !fieldMatches(shape.action, params.action)) match = false;
    else if (params.decision && shape.decision !== params.decision) match = false;
    else if (params.node_id && (nodeIndex < 0 || shape.nodeIndex !== nodeIndex || shape.action === "auth.login")) match = false;
    else if (params.actor_id && shape.actor !== params.actor_id) match = false;
    else if (params.scope && shape.scope !== params.scope) match = false;
    else if (excludes.some((prefix) => shape.action.startsWith(prefix))) match = false;
    else if (skipDecisions.has(shape.decision)) match = false;
    else if (params.correlation_id || q) {
      const event = auditEvent(i);
      if (params.correlation_id && event.correlation_id !== params.correlation_id) match = false;
      else if (q && !JSON.stringify(event).toLowerCase().includes(q)) match = false;
    }
    if (match) {
      if (total >= offset && events.length < limit) events.push(auditEvent(i));
      total += 1;
    }
    if (scanned >= AUDIT_SCAN_CAP) {
      complete = false;
      break;
    }
  }
  return { events, total, limit, offset, scanned, complete };
}

export const AUDIT_VERIFY: AuditVerifyResponse = {
  enabled: true,
  ok: true,
  count: AUDIT_TOTAL,
  head: "b1946ac92492d2347c6235b4d2611184d8a6f9a3c1e2f40a7c5d6e8f90a1b2c3",
  anchored: true,
  anchor_count: AUDIT_TOTAL - 412,
  anchor_head: "5eb63bbbe01eeed093cb22bb8f5acdc3a9f1e2d4c6b8a0f2e4d6c8b0a2f4e6d8",
};

export { DAY, HOUR, MINUTE, NOW };
