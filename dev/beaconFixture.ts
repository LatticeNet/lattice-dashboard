/**
 * The beacon routes of the harness's M2b server (`?m2b=1`): the view a node
 * page reads, the node.beacon plan it files and the key rotation, worked out
 * from dev/beaconShapes.ts by the server's rules (lattice-server
 * beacon_plan.go): a plan approves the sources that use the beacon now,
 * carries a NetGuard companion when NetGuard guards the node, and is refused
 * with findings on a port sshd, a sing-box inbound or WireGuard holds.
 * Plans and rotations change the in-memory state, so the card's pending and
 * rotated states can be driven end to end.
 */
import type { ApprovalView, BeaconFinding, BeaconPlan, BeaconPlanRequest, BeaconPlanResponse, BeaconSettings, BeaconView, Node } from "@/lib/api/index";
import { sha256Hex } from "@/lib/crypto";
import { DEFAULT_BEACON_LIMITS, parseBeaconEndpoint, parseBeaconIPv4 } from "@/views/fleet/beaconModel";

import { DAY, HOUR, NOW, iso } from "./fleetFixture";
import { beaconEndpoint, beaconShape, type BeaconShape } from "./beaconShapes";

/** Nodes NetGuard does not manage beyond the shapes that say so: a plan for them is open to the internet. */
const UNGUARDED = new Set(["[cd]-DMIT-pro-malibu", "[cd]-bandwagon-dc6"]);

interface Held {
  epoch: number;
  rotatedAt: string;
  pendingApprovalId?: string;
  version: number;
  /** The port the first plan drew, kept as the server keeps SuggestedPort. */
  drawnPort?: number;
}
const held = new Map<string, Held>();

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

function heldFor(node: Node, shape: BeaconShape): Held {
  let h = held.get(node.id);
  if (!h) {
    h = {
      epoch: shape.epoch ?? 0,
      rotatedAt: iso(-(2 * DAY + (hash(node.id) % 20) * HOUR)),
      pendingApprovalId: shape.pendingApproval ? `approval_beacon_${node.id.slice(-6)}` : undefined,
      version: shape.enabled ? 3 : 0,
    };
    held.set(node.id, h);
  }
  return h;
}

/** The random port the server drew for the node's first plan, kept once drawn; a read never draws one. */
function suggestedPort(shape: BeaconShape): number | undefined {
  return shape.port ?? shape.drawnPort;
}

function drawPort(node: Node): number {
  return 40000 + (hash(node.id) % 20000);
}

function exposureOf(node: Node, shape: BeaconShape): "netguard" | "internet" {
  if (shape.exposure) return shape.exposure;
  return UNGUARDED.has(node.name) ? "internet" : "netguard";
}

function sourceId(id: string): number {
  return (hash(`source:${id}`) % 40) + 1;
}

/** The /32s a NetGuard companion admits for a source: its public and WireGuard addresses. */
function allowOf(n: Node | undefined): string[] {
  const wg = `10.88.0.${(hash(n?.id ?? "") % 200) + 2}/32`;
  return [n?.public_ip ? `${n.public_ip}/32` : undefined, wg].filter((v): v is string => !!v).sort();
}

function appliedOf(node: Node, shape: BeaconShape): BeaconSettings | undefined {
  if (!shape.enabled) return undefined;
  return { enabled: true, port: shape.port, bind: shape.bind ?? node.public_ip, endpoint: beaconEndpoint(shape, node.public_ip), limits: DEFAULT_BEACON_LIMITS };
}

/**
 * GET /api/nodes/beacon. `current` is the sources that use the beacon now
 * (the path set's beacon pairs and the beacon checks naming the node), by id;
 * the caller works it out from the plan and the checks it holds.
 */
export function beaconViewFor(node: Node, nodes: readonly Node[], current: readonly string[]): BeaconView {
  const shape = beaconShape(node.name);
  const h = heldFor(node, shape);
  const facts = node.beacon ?? undefined;
  const byName = (name: string) => nodes.find((n) => n.name === name);
  const approvedIds = shape.enabled ? (shape.approved ?? []).map((name) => byName(name)?.id ?? name) : [];
  const view: BeaconView = {
    node_id: node.id,
    state: "off",
    agent: facts,
    sources: [],
    suggested_port: suggestedPort(shape) ?? h.drawnPort,
    version: h.version,
    pending_approval_id: h.pendingApprovalId,
  };
  if (shape.enabled) {
    view.applied = appliedOf(node, shape);
    view.applied_approval_id = `approval_beacon_applied_${node.id.slice(-4)}`;
    view.applied_at = iso(-(3 * DAY));
    view.epoch = h.epoch;
    view.rotated_at = h.rotatedAt;
    view.last_auth_at = facts?.last_auth_at;
    view.exposure = exposureOf(node, shape);
    if (facts?.refusal) [view.state, view.reason] = ["refused_by_node", "refused_by_node"];
    else if (!facts?.responder) [view.state, view.reason] = ["agent_too_old", "agent_too_old"];
    else if (facts.state === "listening") view.state = "listening";
    else if (facts.state === "bind_failed" || facts.state === "circuit_open") [view.state, view.reason] = ["not_listening", "beacon_not_listening"];
    else view.state = "pending";
    const source = shape.approved?.length ? (byName(shape.approved[0]!)?.id ?? "node_sh") : undefined;
    if (shape.reach) view.reachability = { state: shape.reach, source, monitor_id: `mon_beaconr_${node.id}`, checked_at: shape.reach === "pending" ? undefined : iso(-2 * HOUR - 7 * 60_000) };
    else view.reachability = {};
  }
  // Approved sources only while enabled; the current ones always, as the server lists them.
  const ids = [...new Set([...approvedIds, ...current])].sort();
  view.sources = ids.map((id) => {
    const n = nodes.find((x) => x.id === id);
    const approved = approvedIds.includes(id);
    const isCurrent = current.includes(id);
    return {
      node_id: id,
      name: n?.name ?? id,
      source_id: sourceId(id),
      approved,
      current: isCurrent,
      ...(isCurrent && !approved && shape.enabled ? { reason: view.exposure === "netguard" ? "firewall_pending" : "beacon_source_pending" } : {}),
    };
  });
  if (shape.enabled && view.exposure === "netguard") view.firewall_pending = !!shape.companionPending || view.sources!.some((s) => s.current !== s.approved);
  return view;
}

export type PlanOutcome =
  | { ok: true; response: BeaconPlanResponse }
  | { ok: false; status: number; message: string; findings?: BeaconFinding[] };

/** POST /api/nodes/beacon/plan, by the server's rules; the plan is filed as a pending approval. */
export async function planBeacon(input: BeaconPlanRequest, node: Node, nodes: readonly Node[], current: readonly string[]): Promise<PlanOutcome> {
  const shape = beaconShape(node.name);
  const h = heldFor(node, shape);
  const before = appliedOf(node, shape);
  if (input.action === "disable" && !before) return { ok: false, status: 409, message: "the node has no enabled beacon" };
  if (input.action === "change" && !before) return { ok: false, status: 409, message: "the node has no enabled beacon to change; enable it first" };
  if (input.action === "enable" && before) return { ok: false, status: 409, message: "the node's beacon is already enabled; plan a change instead" };

  let settings: BeaconSettings;
  if (input.action === "disable") {
    settings = { ...before!, enabled: false };
  } else {
    const port = input.port || before?.port || suggestedPort(shape) || h.drawnPort || drawPort(node);
    // The first plan draws the port and the view suggests it from then on (beaconSuggestedPort).
    if (!suggestedPort(shape) && !h.drawnPort) h.drawnPort = port;
    const bind = input.bind?.trim() || before?.bind || shape.bind || node.internal_ip || node.public_ip || "";
    if (input.bind && !parseBeaconIPv4(input.bind.trim()).ok) return { ok: false, status: 400, message: `bind: beacon: not an IPv4 literal: "${input.bind}"` };
    const followed = before && port !== before.port && before.endpoint === `${node.public_ip}:${before.port}`;
    let endpoint = input.endpoint?.trim() || (followed ? "" : before?.endpoint) || "";
    if (input.endpoint && !parseBeaconEndpoint(input.endpoint).ok) return { ok: false, status: 400, message: `endpoint: beacon: not an IPv4 literal: "${input.endpoint}"` };
    if (!endpoint) endpoint = `${node.public_ip ?? "203.0.113.1"}:${port}`;
    // The server's beaconEndpointCurrent: the endpoint is one of the node's own addresses.
    const host = endpoint.slice(0, endpoint.lastIndexOf(":"));
    if (host !== node.public_ip && host !== node.internal_ip) {
      return { ok: false, status: 400, message: `endpoint ${endpoint} is not one of the node's addresses (its public IPv4, its primary interface address or a provider edge its lines declare)` };
    }
    settings = { enabled: true, port, bind, endpoint, limits: DEFAULT_BEACON_LIMITS };
  }

  const exposure = exposureOf(node, shape);
  const sources = settings.enabled
    ? [...current]
        .sort()
        .map((id) => {
          const n = nodes.find((x) => x.id === id);
          return { node_id: id, name: n?.name ?? id, source_id: sourceId(id), ...(exposure === "netguard" ? { allow: allowOf(n) } : {}) };
        })
    : [];
  const findings: BeaconFinding[] = [];
  if (settings.enabled) {
    const port = settings.port!;
    if (port === 22) findings.push({ code: "port_sshd", severity: "block", message: "sshd listens on port 22" });
    if (port === 443 || port === 8443) findings.push({ code: "port_singbox_inbound", severity: "block", message: `sing-box inbound "vless-reality-${port}" listens on port ${port}` });
    if (port === 51820) findings.push({ code: "port_wireguard", severity: "block", message: "WireGuard listens on port 51820" });
    if (findings.some((f) => f.severity === "block")) return { ok: false, status: 409, message: "plan blocked by lint findings", findings };
    if (settings.bind !== (node.internal_ip ?? "") && settings.bind !== (node.public_ip ?? "") && settings.bind !== shape.bind) {
      findings.push({ code: "bind_not_local", severity: "warn", message: "the bind address is neither the node's primary interface address nor its public IPv4; the agent reports a bind failure if it is not on the host" });
    }
    if (settings.endpoint !== `${node.public_ip}:${port}`) {
      findings.push({ code: "endpoint_mapped", severity: "warn", message: "the endpoint differs from the node's public IPv4 and listen port; sources will send to the mapping named here" });
    }
    if (!sources.length) findings.push({ code: "no_sources", severity: "warn", message: "no source uses this node's beacon yet; sources added later need a change plan" });
    if (exposure === "internet") findings.push({ code: "open_to_internet", severity: "warn", message: "NetGuard does not manage this node: the port is open to the internet and protected only by the beacon's authentication" });
  }

  let netguard: BeaconPlan["netguard"];
  if (exposure === "netguard" && settings.enabled) {
    const allow = [...new Set(sources.flatMap((s) => s.allow ?? []))].sort();
    const ruleset = [
      "table inet lattice_guard {",
      "  chain input {",
      "    type filter hook input priority 0; policy drop;",
      "    ct state established,related accept",
      "    iif lo accept",
      "    meta l4proto icmp accept",
      ...allow.map((a) => `    ip saddr ${a.replace("/32", "")} udp dport ${settings.port} accept comment "beacon"`),
      "  }",
      "  chain raw_pre { type filter hook prerouting priority raw;",
      `    udp dport ${settings.port} notrack`,
      "  }",
      "  chain raw_out { type filter hook output priority raw;",
      `    udp sport ${settings.port} notrack`,
      "  }",
      "}",
    ].join("\n");
    netguard = { port: settings.port!, allow, notrack: true, binding_version: 12, ruleset, ruleset_sha256: await sha256Hex(ruleset) };
  }
  const plan: BeaconPlan = {
    kind: "node.beacon",
    node_id: node.id,
    node_name: node.name,
    action: input.action,
    beacon: settings,
    ...(before ? { previous: before } : {}),
    sources,
    exposure,
    ...(netguard ? { netguard } : {}),
    base_version: h.version,
  };
  const text = JSON.stringify(plan, null, 2);
  const approval: ApprovalView = {
    id: `approval_${(hash(`${node.id}:${Date.now()}`) >>> 0).toString(16).padStart(8, "0")}`,
    node_id: node.id,
    plugin: "beacon",
    action: "node.beacon",
    plan: text,
    plan_sha256: await sha256Hex(text),
    status: "pending",
    actor_id: "cdcd",
    created_at: new Date(NOW).toISOString(),
  };
  h.pendingApprovalId = approval.id;
  return { ok: true, response: { approval, plan, findings } };
}

/** POST /api/nodes/beacon/rotate: the node's key moves to the next epoch. */
export function rotateBeacon(node: Node): { ok: true; epoch: number } | { ok: false; message: string } {
  const shape = beaconShape(node.name);
  if (!shape.enabled) return { ok: false, message: "the node has no enabled beacon" };
  const h = heldFor(node, shape);
  h.epoch += 1;
  h.rotatedAt = new Date().toISOString();
  return { ok: true, epoch: h.epoch };
}

/**
 * GET /api/network/approvals?id= for an applied beacon plan, which the
 * Beacon card reads for its NetGuard task: still running, failed in the
 * task's words, or applied. Undefined for any other id.
 */
export function appliedBeaconApproval(id: string, nodes: readonly Node[]): ApprovalView | undefined {
  const node = nodes.find((n) => `approval_beacon_applied_${n.id.slice(-4)}` === id);
  const shape = beaconShape(node?.name);
  if (!node || !shape.enabled) return undefined;
  const base: ApprovalView = {
    id,
    node_id: node.id,
    plugin: "beacon",
    action: "node.beacon",
    plan: "{}",
    status: "applied",
    actor_id: "cdcd",
    approved_by: "cdcd",
    created_at: iso(-(3 * DAY) - 6 * 60_000),
    updated_at: iso(-(3 * DAY)),
  };
  if (shape.companionTask === "running") {
    return {
      ...base,
      status: "approved",
      waiting: {
        code: "task_running",
        reason: `Task task_7f3a1c applies the NetGuard rule on ${node.name}; it has been running for 40 seconds.`,
        blocked: false,
        node_id: node.id,
        node_name: node.name,
        task_id: "task_7f3a1c",
        task_status: "running",
      },
    };
  }
  if (shape.companionTask === "failed") {
    return { ...base, status: "rejected", reason: "netguard apply: nft: Error: Could not process rule: Device or resource busy (table inet lattice_guard, chain raw_pre)" };
  }
  return base;
}
