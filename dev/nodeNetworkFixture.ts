/**
 * The node's effective network (design 32 D4) as /api/nodes/network answers
 * it, for the fleet harness's node page and node sheet.
 *
 *   ?network=drift      lattice_guard was last rebuilt by the legacy firewall
 *                       route on a node NetGuard manages: re-plan pending,
 *                       with the differing lines in Show rules
 *   ?network=confined   a token confined to the node with node:read and
 *                       netpolicy:read only: the other sections are refused,
 *                       and the outbound compile is refused because a rule
 *                       names a node it cannot read
 *   ?network=orphan     no policy reaches the node; the group-derived rules
 *                       applied earlier are still in force
 *   ?network=missing    a server before the route: 404
 *
 * The default is a node NetGuard manages, in sync, with three outbound
 * policies in merge order (one excluded) and the mesh facts.
 */
import type { GroupView, Node, NodeNetworkTable, NodeNetworkView } from "@/lib/api/index";

const GUARD_NOW = `add table inet lattice_guard
delete table inet lattice_guard
table inet lattice_guard {
  set wg_peers4 {
    type ipv4_addr
    flags interval
    elements = { 10.66.0.0/24 }
  }

  chain input {
    type filter hook input priority 0; policy drop;
    ct state established,related accept
    iif lo accept
    meta l4proto icmp icmp type { echo-request, destination-unreachable, time-exceeded, parameter-problem } accept comment "icmp control"
    ip saddr 192.0.2.0/24 drop comment "drop documentation net"
    iifname "eth0" tcp dport { 22 } accept comment "web ssh"
    iifname "eth0" tcp dport { 443 } accept comment "web https"
    iifname "eth0" udp dport { 53 } accept comment "self-host dns"
    iifname "eth0" tcp dport { 53 } accept comment "self-host dns"
    iifname "eth0" udp dport { 47000 } ip saddr { 203.0.113.21, 203.0.113.22, 198.51.100.40 } notrack accept comment "beacon"
    counter drop
  }
}
`;

const GUARD_LEGACY = `add table inet lattice_guard
delete table inet lattice_guard
table inet lattice_guard {
  chain input {
    type filter hook input priority 0; policy drop;
    ct state established,related accept
    iif lo accept
    iifname "eth0" tcp dport { 22 } accept comment "legacy public tcp"
    iifname "eth0" tcp dport { 8080 } accept comment "legacy public tcp"
    counter drop
  }
}
`;

const POLICY_NOW = `add table inet lattice_policy
delete table inet lattice_policy
table inet lattice_policy {
  chain output {
    type filter hook output priority 0; policy drop;
    ct state established,related accept
    oif lo accept
    udp dport 53 accept comment "dns"
    tcp dport 53 accept comment "dns"
    ip daddr @lattice_control4 tcp dport 443 accept comment "control plane"
    ip daddr 10.66.0.2 tcp dport { 22 } accept comment "gnp_ops:ssh"
    tcp dport { 443 } accept comment "https"
    counter drop
  }
}
`;

function sha(text: string): string {
  // Not a real digest: the harness needs stable, distinct hex for equal and unequal text.
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0;
  return (h.toString(16).padStart(8, "0") + "c0ffee5eed").repeat(4).slice(0, 64);
}

function column(composer: string, text: string, rules: boolean) {
  return { state: "ok" as const, composer, sha256: sha(text.trim()), ...(rules ? { ruleset: text } : {}) };
}

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

export function nodeNetworkFor(node: Node, groups: readonly GroupView[], mode: string | null, rules: boolean): NodeNetworkView {
  const memberOf = groups.filter((g) => g.members?.includes(node.id)).slice(0, 3);
  const web = memberOf[0] ?? groups[0];
  const refused = (scope: string) => ({ state: "refused" as const, scope, reason: `reading this needs ${scope} on this node` });
  const confined = mode === "confined";
  const orphan = mode === "orphan";
  const drift = mode === "drift";

  const guard: NodeNetworkTable = confined
    ? { table: "inet lattice_guard", ...refused("netguard:read") }
    : {
        state: "ok",
        table: "inet lattice_guard",
        owners: [
          { kind: "netguard", state: "writes" },
          { kind: "beacon", state: "contributes" },
          { kind: "selfdns", state: "refused" },
          { kind: "legacy_firewall", state: "refused" },
        ],
        last_writer: drift ? { kind: "legacy_firewall", approval_id: "approval_legacy_late", applied_at: ago(95) } : { kind: "netguard", approval_id: "approval_ng_7", applied_at: ago(60 * 26) },
        compile_now: column("netguard", GUARD_NOW, rules),
        last_applied: drift ? column("legacy_firewall", GUARD_LEGACY, rules) : column("netguard", GUARD_NOW, rules),
        replan_pending: drift,
        drift_state: drift ? "drift" : "in_sync",
      };
  const policyTable: NodeNetworkTable = orphan
    ? {
        state: "ok",
        table: "inet lattice_policy",
        owners: [{ kind: "outbound_policy", state: "orphan" }],
        last_writer: { kind: "outbound_policy", approval_id: "approval_pol_3", applied_at: ago(60 * 24 * 6) },
        compile_now: { state: "none", composer: "outbound_policy" },
        last_applied: column("outbound_policy", POLICY_NOW, rules),
        replan_pending: false,
      }
    : {
        state: "ok",
        table: "inet lattice_policy",
        owners: [{ kind: "outbound_policy", state: "writes" }],
        last_writer: { kind: "outbound_policy", approval_id: "approval_pol_4", applied_at: ago(60 * 5) },
        compile_now: confined
          ? { state: "refused", composer: "outbound_policy", scope: "netpolicy:read", reason: "forbidden: this node's outbound policy names 1 node outside this token's netpolicy:read scope" }
          : column("outbound_policy", POLICY_NOW, rules),
        last_applied: confined ? { state: "refused", composer: "outbound_policy", scope: "netpolicy:admin", reason: "reading this plan needs the scope its approval is read under" } : column("outbound_policy", POLICY_NOW, rules),
        replan_pending: false,
      };
  const knock: NodeNetworkTable = confined
    ? { table: "inet lattice_knock", ...refused("sshguard:read"), rules_withheld: "knock" }
    : {
        state: "ok",
        table: "inet lattice_knock",
        owners: [{ kind: "sshguard", state: "writes" }],
        last_writer: { kind: "sshguard", approval_id: "approval_knock_2", applied_at: ago(60 * 24 * 12) },
        compile_now: { state: "none", composer: "sshguard" },
        last_applied: { state: "refused", composer: "sshguard", reason: "the knock table's rules are the knock sequence" },
        replan_pending: false,
        rules_withheld: "knock",
      };

  return {
    node_id: node.id,
    node_name: node.name,
    generated_at: new Date().toISOString(),
    inbound: confined
      ? refused("netguard:read")
      : {
          state: "ok",
          firewall: "netguard",
          binding: "managed",
          binding_version: 7,
          zones: [
            { id: "public", name: "public" },
            { id: "wireguard", name: "wireguard" },
          ],
          security_groups: [
            { id: "sg-web", name: "web", rules: 3 },
            { id: "sg-ops-ssh", name: "ops-ssh", rules: 1 },
          ],
          derived_security_groups: [],
          extra_ports: [
            { source: "selfdns", label: "mesh resolver", protocols: ["udp", "tcp"], port: 53, exposure: "mesh" },
            { source: "beacon", protocols: ["udp"], port: 47000, exposure: "netguard", sources: 3 },
          ],
          drift_state: drift ? "drift" : "in_sync",
        },
    outbound: orphan
      ? {
          state: "ok",
          source: "orphan",
          default_drop: true,
          policies: [{ id: "gnp_fleet_dns", label: "fleet-dns", priority: 20, enabled: true, reach: "excluded", state: "excluded", rules: 2, allow: 2, deny: 0 }],
          orphan: { enabled: true, rules: 4, last_applied_at: ago(60 * 24 * 6) },
        }
      : {
          state: "ok",
          source: "policies",
          default_drop: true,
          policies: [
            { id: "gnp_ops", name: "ops-ssh", label: "ops-ssh", priority: 5, enabled: true, reach: "named", state: "applies", rules: 1, allow: 1, deny: 0 },
            {
              id: "gnp_web",
              name: "egress-web",
              label: "egress-web",
              priority: 10,
              enabled: true,
              reach: "group",
              via_groups: web ? [{ id: web.id, name: web.name }] : [],
              state: "applies",
              rules: 3,
              allow: 2,
              deny: 1,
            },
            { id: "gnp_fleet_dns", label: "fleet-dns", priority: 20, enabled: true, reach: "excluded", state: "excluded", rules: 2, allow: 2, deny: 0, hidden_target_nodes: confined ? 2 : 0 },
            { id: "gnp_trial", name: "trial-cdn-egress-for-the-asia-edge-nodes", label: "trial-cdn-egress-for-the-asia-edge-nodes", priority: 40, enabled: false, reach: "fleet", state: "disabled", rules: 4, allow: 4, deny: 0 },
          ],
        },
    access: confined
      ? refused("sshguard:read")
      : { state: "ok", enrolled: true, posture: "secured", knock_required: true, stage: "confirmed", stage_is_history: false, revert_armed: false },
    mesh: confined
      ? refused("wireguard:read")
      : {
          state: "ok",
          address: "10.66.0.12",
          listen_port: 51820,
          endpoint: node.public_ip ? `${node.public_ip}:51820` : undefined,
          public_key: true,
          ready: true,
          missing: [],
          peers: 31,
          last_applied: { approval_id: "approval_wg_5", applied_at: ago(60 * 24 * 2) },
          not_reported: ["handshakes", "transfer", "live_peers"],
        },
    groups: confined ? refused("group:read") : { state: "ok", items: memberOf.map((g) => ({ id: g.id, name: g.name, slug: g.slug, color: g.color })) },
    tables: [guard, policyTable, knock],
  };
}
