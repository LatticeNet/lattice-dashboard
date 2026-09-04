/**
 * A realistic SSH Guard fleet for the harness: 33 nodes, 12 confirmed, three
 * failed arms with the server's real failure shapes, two nodes sitting on a
 * revert timer a few minutes from expiry, one whose window closed a few
 * minutes ago with nobody confirming, one arm awaiting approval, and a
 * guard-reality snapshot per node except one that has never reported and one
 * that went stale.
 *
 * Everything is derived from `Date.now()` at load, so the countdowns and the
 * ages read as they would in production.
 */
import type {
  ApprovalView,
  GuardNodeReality,
  GuardRealitySummary,
  Node,
  NodeCapability,
} from "@/lib/api/index";

export interface FixtureNode {
  id: string;
  name: string;
  publicIp: string;
  stage: "idle" | "confirmed" | "armFailed" | "awaitingConfirm" | "armPending";
  scope: "enrolled" | "excluded" | "undecided";
  /** Ports sshd is bound to in the snapshot. Empty array means no sshd listener. */
  sshd: number[];
  /** Seconds since the snapshot was collected; undefined means never reported. */
  observedAgoSec?: number;
  failure?: string;
  /** An operator refused the arm: the server keeps the plan summary as the reason and records no approver. */
  refused?: boolean;
  /** Like `refused`, on a server that records who said no and when. */
  rejectedBy?: string;
  /**
   * The arm was approved and dispatched before apply results reached
   * approvals, then retired as superseded by a cleanup. The record is
   * dismissed with the server's stale code; the node still runs what it
   * wrote, and the confirm after it was retired the same way.
   */
  superseded?: boolean;
  /** Seconds left on the revert timer, for awaitingConfirm. Negative: the window closed that long ago. */
  revertInSec?: number;
  /** PasswordAuthentication as sshd -T prints it; undefined when the agent predates the sshd block. */
  password?: boolean;
}

const NOW = Date.now();

function iso(offsetMs: number): string {
  return new Date(NOW + offsetMs).toISOString();
}

let seq = 0;
function id(prefix: string): string {
  seq += 1;
  return `${prefix}_${(0x1f3a7c + seq * 7919).toString(16).padStart(8, "0")}`;
}

const NAMES: Array<[name: string, ip: string]> = [
  ["[cd]-Aaitr-ATT-VDS", "203.0.113.11"],
  ["[Metix]-DMIT-1", "198.51.100.21"],
  ["[cd]-homeserver", "203.0.113.5"],
  ["[cd]-gomami-hkg", "203.0.113.12"],
  ["[Metix]-Racknerd-LA-2", "198.51.100.22"],
  ["[cd]-BWH-DC9", "203.0.113.13"],
  ["[Metix]-Vultr-SG", "198.51.100.23"],
  ["[cd]-Hetzner-FSN-1", "203.0.113.14"],
  ["[cd]-GreenCloud-Tokyo", "203.0.113.15"],
  ["[Metix]-Oracle-KIX-arm", "198.51.100.24"],
  ["[cd]-Linode-OSA", "203.0.113.16"],
  ["[Metix]-Contabo-NUE", "198.51.100.25"],
  ["[cd]-HostHatch-HK", "203.0.113.17"],
  ["[cd]-DO-SFO3", "203.0.113.18"],
  ["[Metix]-Aeza-AMS", "198.51.100.26"],
  ["[cd]-Kuroit-LON", "203.0.113.19"],
  ["[Metix]-CloudCone-LA", "198.51.100.27"],
  ["[cd]-V.PS-TYO", "203.0.113.20"],
  ["[cd]-Netcup-VIE", "203.0.113.21"],
  ["[Metix]-OVH-GRA", "198.51.100.28"],
  ["[cd]-Zgovps-HK-BGP", "203.0.113.22"],
  ["[Metix]-DMIT-2", "198.51.100.29"],
  ["[cd]-Aaitr-LAX", "203.0.113.23"],
  ["[cd]-BWH-CN2GIA", "203.0.113.24"],
  ["[Metix]-Racknerd-NYC", "198.51.100.30"],
  ["[cd]-Hetzner-HEL-1", "203.0.113.25"],
  ["[Metix]-Vultr-NRT", "198.51.100.31"],
  ["[cd]-GreenCloud-SG", "203.0.113.26"],
  ["[cd]-Oracle-ICN-x86", "203.0.113.27"],
  ["[Metix]-Linode-SIN", "198.51.100.32"],
  ["[cd]-Contabo-SEA", "203.0.113.28"],
  ["[cd]-HostHatch-VIE", "203.0.113.29"],
  ["[Metix]-Aeza-SWE", "198.51.100.33"],
];

const FAILURES = [
  "sshd -t: /etc/ssh/sshd_config.d/50-lattice-guard.conf line 7: Bad configuration option: KbdInteractiveAuthentication",
  "nft -f /etc/nftables.d/lattice-sshguard.nft\nError: Could not process rule: Operation not supported\nkernel 4.19.0-25 has no ct timeout support; refusing to gate 22 without it",
  "apply: step 4/6 systemd-run --on-active=900 --unit lattice-sshguard-revert\nFailed to start transient timer unit: Unit lattice-sshguard-revert.timer already exists.",
];

export function buildFixtureNodes(): FixtureNode[] {
  const out: FixtureNode[] = [];
  NAMES.forEach(([name, ip], i) => {
    const node: FixtureNode = {
      id: id("node"),
      name,
      publicIp: ip,
      stage: "idle",
      scope: "enrolled",
      sshd: [22],
      observedAgoSec: 12 + ((i * 37) % 290),
      // Most of the fleet has password auth off; a few open boxes are the
      // finding the PASSWORD column exists to surface.
      password: i % 7 === 3,
    };
    out.push(node);
  });
  // 12 confirmed: sshd moved; a third of them kept 22 for the management sources.
  const confirmed = [3, 5, 7, 8, 10, 12, 13, 15, 17, 18, 20, 22];
  confirmed.forEach((i, k) => {
    const n = out[i] as FixtureNode;
    n.stage = "confirmed";
    n.sshd = k % 3 === 0 ? [22, 58394] : [58394];
  });
  // 3 failed arms, each with the server's actual failure text.
  [1, 4, 9].forEach((i, k) => {
    const n = out[i] as FixtureNode;
    n.stage = "armFailed";
    n.failure = FAILURES[k] as string;
    n.sshd = k === 1 ? [22, 58394] : [22];
  });
  // 1 arm an operator refused, as the two NAT nodes were in production: same
  // status as a failure on the wire, different story. This one predates the
  // server recording the actor, so the row says only that an operator did.
  (out[30] as FixtureNode).stage = "armFailed";
  (out[30] as FixtureNode).refused = true;
  // 1 refused on a server that writes who said no and when.
  (out[32] as FixtureNode).stage = "armFailed";
  (out[32] as FixtureNode).rejectedBy = "user_ops";
  // 1 armed before task results were recorded on approvals and retired as
  // superseded since: the record reads dismissed, the box is hardened and
  // knocking. sshd moved, and 22 stayed open for the management sources.
  (out[24] as FixtureNode).stage = "armFailed";
  (out[24] as FixtureNode).superseded = true;
  (out[24] as FixtureNode).sshd = [22, 58394];
  // 2 on a revert timer: sshd is already on the new port, 22 still open.
  const revert = out[0] as FixtureNode;
  revert.stage = "awaitingConfirm";
  revert.revertInSec = 7 * 60 + 41;
  revert.sshd = [22, 58394];
  const revert2 = out[6] as FixtureNode;
  revert2.stage = "awaitingConfirm";
  revert2.revertInSec = 3 * 60 + 12;
  revert2.sshd = [22, 58394];
  // 1 whose window closed 4m18s ago: the approvals still say "applied, no
  // confirm", the box has reverted, and sshd is back on 22 alone.
  const reverted = out[29] as FixtureNode;
  reverted.stage = "awaitingConfirm";
  reverted.revertInSec = -(4 * 60 + 18);
  reverted.sshd = [22];
  // 1 arm awaiting approval.
  (out[11] as FixtureNode).stage = "armPending";
  // The home server is the control-plane host: it reports the address the
  // harness is reached on, which is how the view identifies it.
  (out[2] as FixtureNode).publicIp = "127.0.0.1";
  // Scope: two excluded, three undecided.
  (out[28] as FixtureNode).scope = "excluded";
  (out[14] as FixtureNode).scope = "excluded";
  (out[16] as FixtureNode).scope = "undecided";
  (out[19] as FixtureNode).scope = "undecided";
  (out[21] as FixtureNode).scope = "undecided";
  // Two hosts run dropbear on 3434, as three machines in the real fleet do.
  (out[23] as FixtureNode).sshd = [3434];
  (out[31] as FixtureNode).sshd = [3434];
  // One never reported, one went stale, one reports no sshd at all, and one
  // runs an agent from before the sshd block existed.
  (out[25] as FixtureNode).observedAgoSec = undefined;
  (out[26] as FixtureNode).observedAgoSec = 40 * 3600;
  (out[27] as FixtureNode).sshd = [];
  (out[31] as FixtureNode).password = undefined;
  return out;
}

const ARM_PLAN_HEADER = "# Lattice SSH Guard plan\n\nstage: arm\n";

/** The server's stale code and reason on a record it retired as superseded. */
export const SUPERSEDED_CODE = "sshguard_approval_superseded";
const SUPERSEDED_REASON = "approval superseded: approved but never applied; the task ran before apply results were recorded on approvals";

/**
 * One host is hardened without port knocking, which is a legitimate profile
 * (the gate narrows SSH to the management sources instead). It exists in the
 * fixture so the page's "there is no sequence" state has somewhere to render:
 * that state and "there is one and we will not show you" must never look the
 * same, and only a fixture that contains both proves they do not.
 */
export const NO_KNOCK_NODE = "[cd]-BWH-DC9";

function armPlan(n: FixtureNode): string {
  const knock = n.name !== NO_KNOCK_NODE;
  return `${ARM_PLAN_HEADER}node_id: ${n.id}\nnode_name: ${n.name}\nssh_port: 58394\nkeep_legacy_port: true\nknock: ${knock}\ngated_ports: 22, 58394\nconfirm_window_sec: 900\n`;
}

export interface FixtureState {
  nodes: FixtureNode[];
  approvals: ApprovalView[];
  capabilities: NodeCapability[];
  summaries: GuardRealitySummary[];
  details: Map<string, GuardNodeReality>;
}

export function buildFixture(): FixtureState {
  const nodes = buildFixtureNodes();
  const approvals: ApprovalView[] = [];
  for (const n of nodes) {
    const armId = id("apr");
    const base = { node_id: n.id, plugin: "sshguard", plan: armPlan(n) };
    switch (n.stage) {
      case "confirmed":
        approvals.push(
          { ...base, id: armId, action: "sshguard-arm:v1", status: "applied", created_at: iso(-3 * 86_400_000), updated_at: iso(-3 * 86_400_000 + 60_000) },
          { ...base, id: id("apr"), action: "sshguard-confirm:v1", status: "applied", plan: "stage: confirm\n", created_at: iso(-3 * 86_400_000 + 300_000), updated_at: iso(-3 * 86_400_000 + 360_000) },
        );
        break;
      case "armFailed":
        if (n.superseded) {
          approvals.push(
            { ...base, id: armId, action: "sshguard-arm:v1", status: "dismissed", stale_code: SUPERSEDED_CODE, reason: SUPERSEDED_REASON, created_at: iso(-21 * 86_400_000), updated_at: iso(-4 * 86_400_000) },
            { ...base, id: id("apr"), action: "sshguard-confirm:v1", status: "dismissed", stale_code: SUPERSEDED_CODE, reason: SUPERSEDED_REASON, plan: "stage: confirm\n", created_at: iso(-21 * 86_400_000 + 420_000), updated_at: iso(-4 * 86_400_000) },
          );
        } else if (n.rejectedBy) {
          approvals.push({ ...base, id: armId, action: "sshguard-arm:v1", status: "rejected", reason: "Move sshd to :58394, gate 22 and 58394, knock on (auto-revert in 900s)", rejected_by: n.rejectedBy, rejected_at: iso(-26 * 3_600_000), created_at: iso(-27 * 3_600_000), updated_at: iso(-26 * 3_600_000) });
        } else if (n.refused) {
          approvals.push({ ...base, id: armId, action: "sshguard-arm:v1", status: "rejected", reason: "Harden sshd only, no firewall (auto-revert in 3600s)", created_at: iso(-6 * 86_400_000), updated_at: iso(-5 * 86_400_000) });
        } else {
          approvals.push({ ...base, id: armId, action: "sshguard-arm:v1", status: "rejected", approved_by: "cdcd", reason: n.failure, created_at: iso(-2 * 3_600_000), updated_at: iso(-2 * 3_600_000 + 45_000) });
        }
        break;
      case "awaitingConfirm": {
        const startedAgo = 900 - (n.revertInSec ?? 0);
        approvals.push({ ...base, id: armId, action: "sshguard-arm:v1", status: "applied", created_at: iso(-(startedAgo + 120) * 1000), updated_at: iso(-startedAgo * 1000) });
        break;
      }
      case "armPending":
        approvals.push({ ...base, id: armId, action: "sshguard-arm:v1", status: "pending", created_at: iso(-600_000), updated_at: iso(-600_000) });
        break;
      default:
        break;
    }
  }
  const capabilities: NodeCapability[] = nodes
    .filter((n) => n.scope !== "undecided")
    .map((n) => ({
      node_id: n.id,
      capability: "sshguard",
      state: n.scope as "enrolled" | "excluded",
      reason: n.scope === "excluded" ? "NAT box behind CGNAT, no exposed port" : undefined,
      actor_id: "cdcd",
      updated_at: iso(-86_400_000),
      enforced: true,
    }));
  const summaries: GuardRealitySummary[] = [];
  const details = new Map<string, GuardNodeReality>();
  for (const n of nodes) {
    if (n.observedAgoSec === undefined) {
      summaries.push({ node_id: n.id, node_name: n.name, snapshot_status: "unknown", drift_state: "unknown", managed: false, has_binding: false });
      continue;
    }
    const collected = iso(-n.observedAgoSec * 1000);
    const stale = n.observedAgoSec > 30 * 3600;
    const listeners = [
      ...n.sshd.map((port) => ({ protocol: "tcp", port, address: "0.0.0.0", process: port === 3434 ? "dropbear" : "sshd" })),
      { protocol: "tcp", port: 443, address: "0.0.0.0", process: "sing-box" },
      { protocol: "udp", port: 51820, address: "0.0.0.0", process: "wireguard" },
      { protocol: "tcp", port: 2222, address: "127.0.0.1", process: "sshd" },
    ];
    summaries.push({
      node_id: n.id,
      node_name: n.name,
      snapshot_status: stale ? "stale" : "fresh",
      drift_state: "in_sync",
      managed: true,
      has_binding: true,
      collected_at: collected,
      received_at: collected,
      stale_after: iso((30 * 3600 - n.observedAgoSec) * 1000),
      listener_count: listeners.length,
      interface_count: 2,
      foreign_table_count: 0,
    });
    details.set(n.id, {
      node_id: n.id,
      collected_at: collected,
      listeners,
      interfaces: [{ name: "eth0", addresses: [`${n.publicIp}/24`] }],
      nft_version: "1.0.9",
      sshd:
        n.password === undefined || n.sshd.length === 0
          ? undefined
          : {
              password_authentication: n.password,
              pubkey_authentication: true,
              permit_root_login: n.password ? "yes" : "prohibit-password",
              max_auth_tries: 3,
              ports: n.sshd,
              observed_at: collected,
            },
      sshd_note: n.password === undefined ? "agent 0.3.8 predates sshd facts" : undefined,
    });
  }
  return { nodes, approvals, capabilities, summaries, details };
}

export function toApiNodes(nodes: FixtureNode[]): Node[] {
  return nodes.map((n) => ({
    id: n.id,
    name: n.name,
    public_ip: n.publicIp,
    online: n.observedAgoSec !== undefined && n.observedAgoSec < 30 * 3600,
    reachability: n.observedAgoSec === undefined ? "never" : "online",
    agent_version: "0.3.8",
    last_seen: n.observedAgoSec === undefined ? undefined : iso(-n.observedAgoSec * 1000),
  }));
}

export { id as fixtureId, iso as fixtureIso };
