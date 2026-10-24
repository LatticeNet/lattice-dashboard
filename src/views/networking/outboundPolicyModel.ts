/**
 * Outbound policy page (design 32 D3), the parts that are logic rather than
 * markup.
 *
 * The page has three layers on `?view=`: policies (the default, every
 * outbound policy and what it targets), nodes (what each node's document
 * holds: built from policies, or a manual one with a convert action), and
 * matrix (the group-pair view of the policies that target node groups). An
 * outbound policy opens in a sheet on `?policy=<id>`; a node's document on
 * `?open=<node id>`, as before.
 *
 * Pure TS, so `node --test` covers it directly.
 */
import type { QueryRecord, QueryValue } from "@/components/common/tableUrlState";
import type { GroupNetRule, NetEndpoint, NetEndpointKind } from "@/lib/api/types";

import { draftPorts, type PolicyRuleDraft } from "./policyRuleModel.ts";

export const OUTBOUND_LAYERS = ["policies", "nodes", "matrix"] as const;
export type OutboundLayer = (typeof OUTBOUND_LAYERS)[number];

/** The query key of the outbound policy sheet. */
export const POLICY_PARAM = "policy";

/**
 * The old Network Policy page's layers, by the name they had: Overview was
 * the matrix and Policies was the per-node list. An older `?tab=graph` meant
 * the per-node edges, which the node sheet shows now.
 */
const LEGACY_LAYER: Readonly<Record<string, OutboundLayer>> = {
  overview: "matrix",
  matrix: "matrix",
  policies: "nodes",
  graph: "nodes",
};

function first(raw: QueryValue | undefined): string | undefined {
  const value = Array.isArray(raw) ? raw.find((entry) => typeof entry === "string") : raw;
  return typeof value === "string" ? value.trim() : undefined;
}

/**
 * The query an old /network/policy link lands with on /network/outbound: its
 * layer translated (`view`, or the older `tab`), everything else kept, so
 * `?view=policies&open=<node>` still opens that node's document. A link with
 * no layer lands on the page's front, the policy list.
 */
export function legacyPolicyQuery(query: QueryRecord): Record<string, QueryValue> {
  const next: Record<string, QueryValue> = {};
  for (const [key, value] of Object.entries(query)) {
    if (key !== "view" && key !== "tab" && value !== undefined) next[key] = value;
  }
  const named = first(query.view) || first(query.tab);
  const layer = named ? LEGACY_LAYER[named] : undefined;
  if (layer && layer !== "policies") next.view = layer;
  return next;
}

/* ------------------------------------------------------------------ */
/* Rules                                                               */
/* ------------------------------------------------------------------ */

/** The remotes an outbound rule can name in the form; a group expands to its members' addresses at compile time. */
export const OUTBOUND_REMOTE_KINDS: readonly NetEndpointKind[] = ["node", "group", "cidr", "domain", "any"];

export interface OutboundRuleDraft extends PolicyRuleDraft {
  remoteKind: NetEndpointKind;
  remoteNodeId: string;
  remoteGroupId: string;
  remoteCidr: string;
  remoteDomain: string;
  /** The remote as loaded, saved back unchanged for a kind this form does not edit (a zone). */
  remoteLoaded?: NetEndpoint;
}

export function emptyOutboundRule(): OutboundRuleDraft {
  return {
    action: "allow",
    protocol: "tcp",
    ports: "",
    comment: "",
    disabled: false,
    remoteKind: "any",
    remoteNodeId: "",
    remoteGroupId: "",
    remoteCidr: "",
    remoteDomain: "",
  };
}

export function ruleToOutboundDraft(rule: GroupNetRule): OutboundRuleDraft {
  return {
    id: rule.id,
    action: rule.action,
    protocol: rule.protocol,
    ports: (rule.ports ?? []).join(", "),
    comment: rule.comment ?? "",
    disabled: !!rule.disabled,
    remoteKind: rule.remote.kind,
    remoteNodeId: rule.remote.node_id ?? "",
    remoteGroupId: rule.remote.group_id ?? "",
    remoteCidr: rule.remote.cidr ?? "",
    remoteDomain: rule.remote.domain ?? "",
    remoteLoaded: rule.remote,
  };
}

export function editsRemoteKind(kind: NetEndpointKind): boolean {
  return OUTBOUND_REMOTE_KINDS.includes(kind);
}

/** A rule to save; only call it on a draft without a ports or remote problem. */
export function outboundDraftToRule(draft: OutboundRuleDraft, id: string): GroupNetRule {
  let remote: NetEndpoint;
  if (!editsRemoteKind(draft.remoteKind) && draft.remoteLoaded) remote = { ...draft.remoteLoaded };
  else if (draft.remoteKind === "node") remote = { kind: "node", node_id: draft.remoteNodeId };
  else if (draft.remoteKind === "group") remote = { kind: "group", group_id: draft.remoteGroupId };
  else if (draft.remoteKind === "cidr") remote = { kind: "cidr", cidr: draft.remoteCidr.trim() };
  else if (draft.remoteKind === "domain") remote = { kind: "domain", domain: draft.remoteDomain.trim() };
  else remote = { kind: "any" };
  return {
    id,
    action: draft.action,
    direction: "egress",
    protocol: draft.protocol,
    ports: draftPorts(draft),
    remote,
    ...(draft.comment.trim() ? { comment: draft.comment.trim() } : {}),
    ...(draft.disabled ? { disabled: true } : {}),
  };
}

export type RemoteProblem = "errSelectNode" | "errSelectGroup" | "errEnterCidr" | "errEnterDomain";

/** What the draft's remote still needs, as a `networking.policy` key. */
export function remoteProblem(draft: OutboundRuleDraft): RemoteProblem | undefined {
  if (draft.remoteKind === "node" && !draft.remoteNodeId) return "errSelectNode";
  if (draft.remoteKind === "group" && !draft.remoteGroupId) return "errSelectGroup";
  if (draft.remoteKind === "cidr" && !draft.remoteCidr.trim()) return "errEnterCidr";
  if (draft.remoteKind === "domain" && !draft.remoteDomain.trim()) return "errEnterDomain";
  return undefined;
}

/**
 * A session confined to some nodes, the server's principalHasNodeRestriction:
 * an allowlist that is not empty and has no "*". Such a session may target
 * only nodes it administers; groups, the whole fleet and remote groups need
 * an unrestricted one (design 32 D1, applied to outbound policy).
 */
export function isNodeRestricted(allowlist: readonly string[] | undefined): boolean {
  return !!allowlist && allowlist.length > 0 && !allowlist.includes("*");
}
