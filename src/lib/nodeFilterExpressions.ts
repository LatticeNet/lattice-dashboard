import type { LineGroup, Node } from "@/lib/api/types";
import { normalizeExprToken } from "@/lib/filterExpressions";
export { evalFilterExpression, normalizeExprToken, type ExprResult } from "@/lib/filterExpressions";

export function vpnLineNodeIds(groups: LineGroup[] | undefined): Set<string> {
  const ids = new Set<string>();
  for (const group of groups ?? []) {
    if ((group.lines ?? []).length > 0) ids.add(group.node_id);
  }
  return ids;
}

export function nodeAgentProfile(node: Node) {
  return node.agent_runtime ?? undefined;
}

export function nodeHasAgentCapability(node: Node, token: string, vpnRecorded = false): boolean {
  const cap = normalizeExprToken(token);
  const profile = nodeAgentProfile(node);
  switch (cap) {
    case "exec":
      return !!profile?.allow_exec && !profile.no_exec;
    case "root":
      return !!profile?.allow_exec && !!profile.allow_root_exec && !profile.no_exec;
    case "terminal":
      return !!profile?.allow_terminal && !profile.no_exec;
    case "stream":
      return !!profile?.allow_terminal && profile.terminal_transport === "stream" && !profile.no_exec;
    case "poll":
      return !!profile?.allow_terminal && profile.terminal_transport !== "stream" && !profile.no_exec;
    case "sing-box":
      return !!profile?.singbox_discover;
    case "vpn-lines":
      return vpnRecorded;
    default:
      return false;
  }
}

export function agentConfigBadges(node: Node, vpnRecorded = false): string[] {
  const badges: string[] = [];
  if (nodeHasAgentCapability(node, "exec", vpnRecorded)) badges.push("exec");
  if (nodeHasAgentCapability(node, "root", vpnRecorded)) badges.push("root");
  if (nodeHasAgentCapability(node, "terminal", vpnRecorded)) {
    badges.push(nodeHasAgentCapability(node, "stream", vpnRecorded) ? "terminal:stream" : "terminal:poll");
  }
  if (nodeHasAgentCapability(node, "sing-box", vpnRecorded)) badges.push("sing-box:on");
  if (vpnRecorded) badges.push("vpn-lines");
  return badges;
}

export function nodeHasArchOsToken(node: Node, token: string): boolean {
  const wanted = normalizeExprToken(token);
  const hay = [
    node.host_facts?.os,
    node.host_facts?.platform,
    node.host_facts?.platform_version,
    node.host_facts?.arch,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return hay.includes(wanted);
}

export function nodeHasTagToken(node: Node, token: string): boolean {
  const wanted = normalizeExprToken(token);
  return [node.role, ...(node.tags ?? [])]
    .filter(Boolean)
    .map((v) => String(v).toLowerCase())
    .includes(wanted);
}

export function nodeMatchesTargetToken(node: Node, rawToken: string, vpnRecorded = false): boolean {
  const token = rawToken.trim();
  const lower = token.toLowerCase();
  const prefixed = lower.match(/^([a-z-]+):(.*)$/);
  if (prefixed) {
    const [, namespace, value] = prefixed;
    if (!value) return false;
    if (namespace === "agent" || namespace === "config") return nodeHasAgentCapability(node, value, vpnRecorded);
    if (namespace === "os" || namespace === "arch") return nodeHasArchOsToken(node, value);
    if (namespace === "tag" || namespace === "role") return nodeHasTagToken(node, value);
    if (namespace === "vpn") return nodeHasAgentCapability(node, value === "recorded" ? "vpn-lines" : value, vpnRecorded);
    if (namespace === "region") return nodeRegionHaystack(node).includes(normalizeExprToken(value));
    if (namespace === "name") return (node.name || node.id).toLowerCase().includes(value.toLowerCase());
  }

  const wanted = normalizeExprToken(token);
  if (nodeHasAgentCapability(node, wanted, vpnRecorded)) return true;
  if (nodeHasArchOsToken(node, wanted)) return true;
  if (nodeHasTagToken(node, wanted)) return true;
  return [
    node.id,
    node.name,
    node.role,
    node.geo?.country,
    node.geo?.region,
    node.geo?.city,
    node.host_facts?.hostname,
    ...(node.tags ?? []),
  ]
    .filter(Boolean)
    .some((v) => String(v).toLowerCase().includes(wanted));
}

function nodeRegionHaystack(node: Node): string {
  return [node.geo?.country, node.geo?.region, node.geo?.city].filter(Boolean).join(" / ").toLowerCase();
}
