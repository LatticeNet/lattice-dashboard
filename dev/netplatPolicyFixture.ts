/**
 * Network Policy fixtures for the netplat harness (dev/netplat-policy.html).
 *
 * Production on 2026-09-30: 3 groups, 0 group policies, 0 node policies. That
 * is the default here. The group names and colours are invented (FACTS gives
 * only the count). `?policy=dense` adds an invented working set: two group
 * policies, five node policies (one failing, one planned and never applied,
 * one disabled) and the node-to-node edges the server would draw for them.
 * `?groups=0` gives a fleet with no groups, so the matrix has nothing to draw.
 */
import type { GroupPolicyView, NetPolicyGraph, NetPolicyMatrix, NetPolicyView } from "@/lib/api/index";

import { DAY, HOUR, NODES, flags, iso, nodeByName } from "./netplatFixture";

const DENSE = flags.get("policy") === "dense";
const NO_GROUPS = flags.get("groups") === "0";

const GROUPS = NO_GROUPS
  ? []
  : [
      { id: "grp_cd", name: "cd", slug: "cd", color: "#2f7d6d" },
      { id: "grp_metix", name: "Metix", slug: "metix", color: "#7a5cc4" },
      { id: "grp_home", name: "HOME", slug: "home", color: "#b9772b" },
    ];

export function policyMatrix(direction: "egress" | "ingress"): NetPolicyMatrix {
  return {
    direction,
    groups: GROUPS,
    cells: DENSE
      ? [
          { from: "grp_home", to: "grp_cd", action: "allow", protocols: ["tcp"], ports: [22, 443], rule_count: 2, mixed: false },
          { from: "grp_metix", to: "grp_home", action: "deny", protocols: ["any"], rule_count: 1, mixed: false },
          { from: "grp_cd", to: "grp_metix", action: "allow", protocols: ["tcp", "udp"], ports: [443], rule_count: 3, mixed: true },
        ]
      : [],
    external: DENSE ? [{ from: "grp_cd", rule_count: 2 }] : [],
  };
}

export const GROUP_POLICIES: GroupPolicyView[] = DENSE
  ? ([
      { id: "gp_home", scope_group_id: "grp_home", scope_group_name: "HOME", enabled: true, priority: 100, rules: [], group_rule_count: 2 },
      { id: "gp_cd", scope_group_id: "grp_cd", scope_group_name: "cd", enabled: true, priority: 90, rules: [], group_rule_count: 3 },
    ] as unknown as GroupPolicyView[])
  : [];

function policy(name: string, extra: Partial<NetPolicyView>): NetPolicyView {
  const node = nodeByName(name);
  return {
    id: `np_${node.id}`,
    target_node_id: node.id,
    target_node_name: node.name,
    enabled: true,
    rules: [],
    updated_at: iso(-2 * DAY),
    last_applied_at: "0001-01-01T00:00:00Z",
    ...extra,
  };
}

const homeserver = nodeByName("[cd]-homeserver");
const malibu = nodeByName("[cd]-DMIT-pro-malibu");
const nas = nodeByName("[cd]-nas-home");

export const NODE_POLICIES: NetPolicyView[] = DENSE
  ? [
      policy("[cd]-hkbn-hub", {
        rules: [
          { id: "rule_001", action: "allow", direction: "ingress", protocol: "tcp", ports: [22], remote: { kind: "node", node_id: malibu.id }, comment: "ssh from the jump host" },
          { id: "rule_002", action: "allow", direction: "egress", protocol: "tcp", ports: [443], remote: { kind: "domain", domain: "api.cloudflare.com" } },
          { id: "rule_003", action: "deny", direction: "ingress", protocol: "any", remote: { kind: "any" } },
        ],
        last_plan_sha: "9b1f0c2e7d4a61f0b3c5",
        last_applied_at: iso(-3 * HOUR),
      }),
      policy("[cd]-nas-home", {
        rules: [
          { id: "rule_001", action: "allow", direction: "ingress", protocol: "tcp", ports: [445, 2049], remote: { kind: "cidr", cidr: "192.168.10.0/24" } },
          { id: "rule_002", action: "allow", direction: "ingress", protocol: "tcp", ports: [22], remote: { kind: "node", node_id: homeserver.id } },
        ],
        last_plan_sha: "4c0de1a99f2b7e6d0a11",
        last_error: "nft: Error: Could not process rule: No such file or directory\nadd rule inet lattice input tcp dport { 445, 2049 } accept",
      }),
      policy("[Metix]-Hetzner-FSN", {
        rules: [{ id: "rule_001", action: "allow", direction: "egress", protocol: "udp", ports: [51820], remote: { kind: "node", node_id: nodeByName("[Metix]-DMIT-1").id } }],
        last_plan_sha: "77aa0e1c5b3d9f20c4e8",
      }),
      policy("[cd]-homeserver", {
        rules: [{ id: "rule_001", action: "allow", direction: "egress", protocol: "tcp", ports: [22], remote: { kind: "node", node_id: nas.id }, disabled: true }],
        last_applied_at: iso(-9 * DAY),
        last_plan_sha: "1e2d3c4b5a6978877665",
      }),
      policy("[Metix]-Akko-UK", { enabled: false, rules: [], last_applied_at: iso(-30 * DAY) }),
    ]
  : [];

export function policyGraph(): NetPolicyGraph {
  return {
    nodes: NODES.map((node) => ({ id: node.id, name: node.name, online: node.online ?? true })),
    edges: DENSE
      ? [
          { from: malibu.id, to: nodeByName("[cd]-hkbn-hub").id, action: "allow", protocol: "tcp", ports: [22], direction: "ingress", rule_id: "rule_001" },
          { from: homeserver.id, to: nas.id, action: "allow", protocol: "tcp", ports: [22], direction: "ingress", rule_id: "rule_002" },
          { from: nodeByName("[Metix]-Hetzner-FSN").id, to: nodeByName("[Metix]-DMIT-1").id, action: "allow", protocol: "udp", ports: [51820], direction: "egress", rule_id: "rule_001" },
        ]
      : null,
    externals: null,
  };
}
