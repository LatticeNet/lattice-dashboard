import type { Node } from "@/lib/api/types";
import { normalizeExprToken } from "@/lib/filterExpressions";
export { evalFilterExpression, normalizeExprToken, type ExprResult } from "@/lib/filterExpressions";

export function nodeAgentProfile(node: Node) {
  return node.agent_runtime ?? undefined;
}

export function nodeHasAgentCapability(node: Node, token: string): boolean {
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
    // sing-box management is what the agent reports it is doing, not what the
    // enrolment asked for: the runtime flag is the truth the fleet filter
    // sorts by, and drift between the two is its own, filterable, fact.
    case "singbox":
    case "sing-box":
      return !!profile?.singbox_discover;
    case "singbox-drift":
    case "sing-box-drift":
      return singboxDrift(node);
    default:
      return false;
  }
}

/**
 * True when the launch record and the runtime report disagree about sing-box
 * discovery. Either side missing is not drift: an agent that predates the
 * flag reports nothing, and a node enrolled before the flag existed has no
 * launch record for it.
 */
export function singboxDrift(node: Node): boolean {
  const launch = node.agent_launch ?? undefined;
  const runtime = node.agent_runtime ?? undefined;
  if (!launch || !runtime) return false;
  if (launch.singbox_discover === undefined || runtime.singbox_discover === undefined) return false;
  return !!launch.singbox_discover !== !!runtime.singbox_discover;
}

export function agentConfigBadges(node: Node): string[] {
  const badges: string[] = [];
  if (nodeHasAgentCapability(node, "exec")) badges.push("exec");
  if (nodeHasAgentCapability(node, "root")) badges.push("root");
  if (nodeHasAgentCapability(node, "terminal")) {
    badges.push(nodeHasAgentCapability(node, "stream") ? "terminal:stream" : "terminal:poll");
  }
  if (nodeHasAgentCapability(node, "singbox")) {
    badges.push(singboxDrift(node) ? "sing-box:drift" : "sing-box");
  }
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

export function nodeMatchesTargetToken(node: Node, rawToken: string): boolean {
  const token = rawToken.trim();
  const lower = token.toLowerCase();
  const prefixed = lower.match(/^([a-z-]+):(.*)$/);
  if (prefixed) {
    const [, namespace, value] = prefixed;
    if (!value) return false;
    if (namespace === "agent" || namespace === "config") return nodeHasAgentCapability(node, value);
    if (namespace === "os" || namespace === "arch") return nodeHasArchOsToken(node, value);
    if (namespace === "tag" || namespace === "role") return nodeHasTagToken(node, value);
    if (namespace === "region") return nodeRegionHaystack(node).includes(normalizeExprToken(value));
    if (namespace === "name") return (node.name || node.id).toLowerCase().includes(value.toLowerCase());
  }

  const wanted = normalizeExprToken(token);
  if (nodeHasAgentCapability(node, wanted)) return true;
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
