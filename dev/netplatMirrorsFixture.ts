/**
 * Agent download mirrors (design 31 S5) for the netplat harness, on
 * dev/netplat-agents.html?view=mirrors.
 *
 *   open "http://127.0.0.1:5185/dev/netplat-agents.html?view=mirrors&fleet=40"
 *
 * Three registry entries, invented: r2, the global Cloudflare R2 mirror the
 * design describes; hk-cache, preferred for the mainland and NAT groups and
 * three named nodes, behind a long base URL, whose last downloads caught it
 * writing chunks that failed the manifest; and sg-backup, disabled. Two
 * plans wait for review: a create made against the current revision, and a
 * change made against the revision before it, which the server would refuse
 * as stale. Each node's order is computed by the server's rule
 * (agentUpdateSourceOrder): preferred mirrors by priority, the control
 * plane, global mirrors, upstream, at most four sources, so at most two
 * mirrors.
 *
 * Plans filed from the page are built here the way buildAgentMirrorPlan
 * builds them (diff lines, every node whose order changes) and join the
 * pending list; nothing changes the registry, as nothing does until an
 * approval is decided.
 *
 * Switches:
 *
 *   ?mirrors=empty    no entries and no plans
 *   ?mirrors=refuse   every plan answers 400 with the server's own-host refusal, a check only the server makes
 *   ?fail=mirrors     the registry read answers 502
 *   ?confined         the session is confined to six nodes: it reads their order and plans answer 403
 *   ?fleet=40         six more nodes (netplatFixture.ts), the fleet size the review renders
 */
import { ApiError } from "@/lib/api/client";
import type {
  AgentMirror,
  AgentMirrorOrderChange,
  AgentMirrorPlan,
  AgentMirrorPlanRequest,
  AgentMirrorPlanResponse,
  AgentMirrorsView,
  ApprovalView,
  GroupView,
} from "@/lib/api/index";

import { DAY, HOUR, MINUTE, NODES, flags, iso } from "./netplatFixture";

const byName = (name: string) => NODES.find((node) => node.name === name)?.id;
const present = (ids: Array<string | undefined>) => ids.filter((id): id is string => !!id);

/** Static groups: explicit members only count for prefer_for, as on the server. */
export const MIRROR_GROUPS: GroupView[] = [
  {
    id: "grp_mainland",
    name: "Mainland",
    slug: "mainland",
    color: "#c2410c",
    order: 1,
    members: present(["[cn]-aliyun-sh", "[cn]-tencent-gz", "[cn]-huawei-bj", "[cd]-hkbn-hub"].map(byName)),
    resolved_members: [],
    rollup: { total: 0, online: 0, offline: 0, disabled: 0 },
  },
  {
    id: "grp_nat",
    name: "NAT and home lines",
    slug: "nat",
    color: "#0f766e",
    order: 2,
    members: present(["[Metix]-Aaitr-jp-softbank-NAT", "[cd]-xuezhang-jp-NAT", "[cd]-mac-air", "[cd]-nas-home", "[lab]-pi-garage"].map(byName)),
    resolved_members: [],
    rollup: { total: 0, online: 0, offline: 0, disabled: 0 },
  },
  {
    id: "grp_openjobs",
    name: "OpenJobs data",
    slug: "openjobs",
    color: "#4338ca",
    order: 3,
    members: present(["[OpenJobs-Data]-TiDB-1", "[OpenJobs-Data]-scripts"].map(byName)),
    resolved_members: [],
    rollup: { total: 0, online: 0, offline: 0, disabled: 0 },
  },
];
for (const group of MIRROR_GROUPS) {
  group.resolved_members = [...(group.members ?? [])];
  group.rollup = { total: group.resolved_members.length, online: group.resolved_members.length, offline: 0, disabled: 0 };
}

const MIRRORS: AgentMirror[] =
  flags.get("mirrors") === "empty"
    ? []
    : [
        {
          id: "r2",
          name: "Cloudflare R2",
          base_url: "https://dl.lattice-mirror.example/agent",
          global: true,
          priority: 50,
          enabled: true,
          created_at: iso(-12 * DAY),
          updated_at: iso(-12 * DAY),
        },
        {
          id: "hk-cache",
          name: "Hong Kong edge cache for mainland and NAT lines",
          base_url: "https://hkg-edge-cache-01.objects.storage.lattice-mirror.example/lattice-node-agent/releases/linux-binaries",
          prefer_for: ["grp_mainland", "grp_nat", ...present(["[cd]-homeserver", "[Metix]-Oracle-KIX-arm", "[cd]-Oracle-KIX-arm"].map(byName))].sort(),
          priority: 10,
          enabled: true,
          created_at: iso(-9 * DAY),
          updated_at: iso(-2 * DAY),
        },
        {
          id: "sg-backup",
          name: "Singapore backup",
          base_url: "https://sg-agent-mirror.example.net",
          prefer_for: present(["[cd]-linode-sgp", "[Metix]-GreenCloud-SG"].map(byName)).sort(),
          priority: 20,
          enabled: false,
          created_at: iso(-30 * DAY),
          updated_at: iso(-5 * DAY),
        },
      ];

const revision = MIRRORS.length ? 7 : 0;

/** The node's order under a registry, as agentUpdateSourceOrder makes it for a version the control plane holds. */
function orderFor(nodeId: string, mirrors: readonly AgentMirror[]): string[] {
  const groups = new Set(MIRROR_GROUPS.filter((group) => (group.members ?? []).includes(nodeId)).map((group) => group.id));
  const rank = (a: AgentMirror, b: AgentMirror) => a.priority - b.priority || a.id.localeCompare(b.id);
  const live = mirrors.filter((mirror) => mirror.enabled);
  const preferred = live.filter((mirror) => (mirror.prefer_for ?? []).some((ref) => ref === nodeId || groups.has(ref))).sort(rank);
  const global = live.filter((mirror) => mirror.global && !preferred.includes(mirror)).sort(rank);
  let room = 4 - 2;
  const first = preferred.slice(0, Math.max(room, 0));
  room -= first.length;
  const after = global.slice(0, Math.max(room, 0));
  return [...first.map((mirror) => `mirror:${mirror.id}`), "control-plane", ...after.map((mirror) => `mirror:${mirror.id}`), "upstream"];
}

/** ?confined: the session may read six nodes. */
export const CONFINED_TO: string[] = flags.has("confined") ? NODES.slice(0, 6).map((node) => node.id) : [];

function readableNodes() {
  const nodes = [...NODES].sort((a, b) => a.id.localeCompare(b.id));
  return CONFINED_TO.length ? nodes.filter((node) => CONFINED_TO.includes(node.id)) : nodes;
}

// ── plans ────────────────────────────────────────────────────────────────────

function field(mirror: AgentMirror | undefined, name: string): string {
  if (!mirror) return "-";
  switch (name) {
    case "name":
      return mirror.name || "-";
    case "base_url":
      return mirror.base_url;
    case "prefer_for":
      return (mirror.prefer_for ?? []).length ? (mirror.prefer_for ?? []).join(",") : "-";
    case "global":
      return String(!!mirror.global);
    case "priority":
      return String(mirror.priority);
    default:
      return String(!!mirror.enabled);
  }
}

/** The entry as a plan document holds it: no times, keys in model.AgentMirror's order, omitempty fields left out. */
function stripTimes(mirror: AgentMirror): AgentMirror {
  return {
    id: mirror.id,
    ...(mirror.name ? { name: mirror.name } : {}),
    base_url: mirror.base_url,
    ...(mirror.prefer_for?.length ? { prefer_for: [...mirror.prefer_for].sort() } : {}),
    ...(mirror.global ? { global: true } : {}),
    priority: mirror.priority,
    enabled: mirror.enabled,
  };
}

function buildPlan(action: AgentMirrorPlan["action"], mirror: AgentMirror, baseRevision: number): AgentMirrorPlan {
  const at = MIRRORS.findIndex((entry) => entry.id === mirror.id);
  const previous = at >= 0 ? stripTimes(MIRRORS[at]!) : undefined;
  const next = MIRRORS.map(stripTimes);
  let after: AgentMirror | undefined;
  if (action === "delete") next.splice(at, 1);
  else {
    after = stripTimes(mirror);
    if (at >= 0) next[at] = after;
    else next.push(after);
  }
  const diff = ["name", "base_url", "prefer_for", "global", "priority", "enabled"]
    .map((name) => [name, field(previous, name), field(after, name)] as const)
    .filter(([, before, now]) => before !== now)
    .map(([name, before, now]) => `${name}: ${before} -> ${now}`);
  const changes: AgentMirrorOrderChange[] = [];
  for (const node of [...NODES].sort((a, b) => a.id.localeCompare(b.id))) {
    const before = orderFor(node.id, MIRRORS);
    const now = orderFor(node.id, next);
    if (before.join(" ") !== now.join(" ")) changes.push({ node_id: node.id, name: node.name, before, after: now });
  }
  return { kind: "agent.mirrors", action, mirror: action === "delete" ? previous! : after!, ...(previous ? { previous } : {}), diff, base_revision: baseRevision, changes };
}

function approvalFor(plan: AgentMirrorPlan, id: string, ageMs: number, actor: string): ApprovalView {
  return {
    id,
    node_id: "",
    plugin: "agent.mirrors",
    action: "agent.mirrors",
    plan: JSON.stringify(plan, null, 2),
    status: "pending",
    actor_id: actor,
    created_at: iso(-ageMs),
    updated_at: iso(-ageMs),
  };
}

export const MIRROR_APPROVALS: ApprovalView[] = MIRRORS.length
  ? [
      approvalFor(
        buildPlan(
          "create",
          {
            id: "cn-oss",
            name: "Aliyun OSS Shanghai",
            base_url: "https://lattice-agent.oss-cn-shanghai.aliyuncs.example/releases",
            prefer_for: ["grp_mainland"],
            priority: 5,
            enabled: true,
          },
          revision,
        ),
        "approval_m1cnossq7d2k4x9v",
        40 * MINUTE,
        "cdcd",
      ),
      approvalFor(buildPlan("change", { ...stripTimes(MIRRORS[0]!), priority: 30 }, revision - 1), "approval_m0r2prio5h8c1z3w", 2 * HOUR + 12 * MINUTE, "ops-bot"),
    ]
  : [];

let seq = 1;

export function mirrorsView(): AgentMirrorsView {
  const nodes = readableNodes();
  const order = nodes.map((node) => ({ node_id: node.id, name: node.name, sources: orderFor(node.id, MIRRORS) }));
  const health = MIRRORS.map((mirror) => ({
    mirror: mirror.id,
    fetches: mirror.id === "r2" ? 27 : mirror.id === "hk-cache" ? 9 : 0,
    chunk_failures: mirror.id === "hk-cache" ? 2 : 0,
  }));
  return {
    mirrors: MIRRORS.map((mirror) => ({ ...mirror, prefer_for: mirror.prefer_for ? [...mirror.prefer_for] : undefined })),
    revision,
    order,
    pending: MIRROR_APPROVALS.filter((approval) => approval.status === "pending").map((approval) => approval.id),
    health,
  };
}

export function planMirror(request: AgentMirrorPlanRequest): AgentMirrorPlanResponse {
  if (CONFINED_TO.length) throw new ApiError(403, "capability_denied", "agent release artifacts are fleet-wide; this token is restricted to specific nodes");
  const id = request.mirror.id.trim();
  const existing = MIRRORS.find((mirror) => mirror.id === id);
  if (flags.get("mirrors") === "refuse") {
    throw new ApiError(400, "bad_request", "base_url must not be on the control plane's own host: the control plane is a source of its own, and only it is sent the task lease");
  }
  if (request.action === "create" && existing) throw new ApiError(409, "conflict", `mirror ${id} already exists; plan a change instead`);
  if (request.action !== "create" && !existing) throw new ApiError(404, "not_found", `mirror ${id} is not in the registry`);
  if (request.action === "create" && MIRRORS.length >= 16) throw new ApiError(409, "conflict", "the registry holds at most 16 mirrors");
  const mirror = request.action === "delete" ? existing! : ({ priority: 0, enabled: true, ...request.mirror, id } as AgentMirror);
  const plan = buildPlan(request.action, mirror, revision);
  if (request.action === "change" && !plan.diff.length) throw new ApiError(409, "conflict", `mirror ${id} already reads exactly this`);
  const approval = approvalFor(plan, `approval_mfiled${String(seq++).padStart(3, "0")}k2q8`, 0, "cdcd");
  MIRROR_APPROVALS.unshift(approval);
  return { approval: { ...approval }, plan };
}

/** The approvals the Mirrors layer reads: plugin agent.mirrors, by status. */
export function mirrorApprovals(params?: { plugin?: string; status?: string | string[] }): ApprovalView[] | undefined {
  if (params?.plugin !== "agent.mirrors") return undefined;
  const statuses = params.status === undefined ? undefined : Array.isArray(params.status) ? params.status : params.status.split(",");
  return MIRROR_APPROVALS.filter((approval) => !statuses || statuses.includes(approval.status)).map((approval) => ({ ...approval }));
}
