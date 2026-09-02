/**
 * One node status ontology for the console.
 *
 * The control plane derives `status` for every node (lattice-server,
 * node_status.go): `never_reported`, `online`, `degraded`, `offline` or
 * `disabled`, with `status_since` and a one-sentence `status_reason`. This
 * module is the only place that word turns into a label key, a tone, an
 * explanation key and a health for StatusDot, and the only place a fleet is
 * counted by status. Overview KPIs, the Nodes list and cards, node detail,
 * the Terminal picker, the Map, the nav signals and the fleet health bars all
 * read it from here, so the same machine cannot read offline on one page and
 * degraded on another.
 *
 * Pure TS: no Vue, no i18n import. Labels are returned as message keys.
 */
import type { NodeStatus } from "@/lib/api/types";
import type { NodeHealth } from "@/lib/status";

export type { NodeStatus };

/** Every status, in display order: the good state first, then by the work each wants. */
export const NODE_STATUSES: readonly NodeStatus[] = ["online", "degraded", "offline", "never_reported", "disabled"];

/**
 * Worst first: the order an operator triages in. A node that never came up is
 * unfinished setup, a quiet one may be an outage, a degraded one still answers,
 * a disabled one was switched off on purpose.
 */
export const ATTENTION_ORDER: Record<NodeStatus, number> = {
  never_reported: 0,
  offline: 1,
  degraded: 2,
  disabled: 3,
  online: 9,
};

/** The subset of a node the derivation reads. Structurally matches `Node` and `NodeGeoView`. */
export interface NodeStatusInput {
  status?: string;
  online?: boolean;
  disabled?: boolean;
  /** Older servers: "online" | "offline" | "never". */
  reachability?: string;
  last_seen?: string;
  status_since?: string;
  status_reason?: string;
}

export type NodeStatusTone = "success" | "warning" | "destructive" | "muted";

export interface NodeStatusInfo {
  status: NodeStatus;
  tone: NodeStatusTone;
  /** The health bucket StatusDot and `statusMeta` colour by. */
  health: NodeHealth;
  /** i18n key of the short label, under `common.nodeStatus`. */
  labelKey: string;
  /** i18n key of the one-line explanation, under `common.nodeStatusHint`. */
  hintKey: string;
  /** The agent is in contact: metrics are current, a terminal can open. */
  reporting: boolean;
  /** Anything an operator may have to act on, which is everything but online. */
  attention: boolean;
}

const INFO: Record<NodeStatus, NodeStatusInfo> = {
  online: {
    status: "online",
    tone: "success",
    health: "online",
    labelKey: "common.nodeStatus.online",
    hintKey: "common.nodeStatusHint.online",
    reporting: true,
    attention: false,
  },
  degraded: {
    status: "degraded",
    tone: "warning",
    health: "degraded",
    labelKey: "common.nodeStatus.degraded",
    hintKey: "common.nodeStatusHint.degraded",
    reporting: true,
    attention: true,
  },
  offline: {
    status: "offline",
    tone: "destructive",
    health: "offline",
    labelKey: "common.nodeStatus.offline",
    hintKey: "common.nodeStatusHint.offline",
    reporting: false,
    attention: true,
  },
  never_reported: {
    status: "never_reported",
    tone: "muted",
    health: "never",
    labelKey: "common.nodeStatus.neverReported",
    hintKey: "common.nodeStatusHint.neverReported",
    reporting: false,
    attention: true,
  },
  disabled: {
    status: "disabled",
    tone: "muted",
    health: "disabled",
    labelKey: "common.nodeStatus.disabled",
    hintKey: "common.nodeStatusHint.disabled",
    reporting: false,
    attention: true,
  },
};

const KNOWN = new Set<string>(NODE_STATUSES);

export function isNodeStatus(value: unknown): value is NodeStatus {
  return typeof value === "string" && KNOWN.has(value);
}

/**
 * The instant before which a timestamp cannot be a real contact time. The API
 * sends `last_seen` unconditionally, so a node that has never beaten arrives
 * carrying the Go zero time rather than omitting the field.
 */
const EARLIEST_PLAUSIBLE_MS = Date.UTC(2000, 0, 1);

function isZeroTime(value?: string): boolean {
  if (!value) return true;
  const ms = Date.parse(value);
  return Number.isNaN(ms) || ms < EARLIEST_PLAUSIBLE_MS;
}

/**
 * The node's status. The server's word wins whenever it is present. Against a
 * server that predates the field, the same precedence is rebuilt from what it
 * did send: disabled, then reachability, then the online boolean with the zero
 * last_seen as the never-reported tell. A payload with no signal at all reads
 * as offline: it cannot be shown as reporting, and the server never produces
 * one.
 */
export function nodeStatus(node: NodeStatusInput): NodeStatus {
  if (isNodeStatus(node.status)) return node.status;
  if (node.disabled) return "disabled";
  switch (node.reachability) {
    case "never":
      return "never_reported";
    case "offline":
      return "offline";
    case "online":
      return "online";
  }
  if (node.online) return "online";
  if (node.last_seen !== undefined && isZeroTime(node.last_seen)) return "never_reported";
  return "offline";
}

/** Label, tone, hint and health for a status, or for the node that carries one. */
export function describeNodeStatus(value: NodeStatus | NodeStatusInput): NodeStatusInfo {
  const status = typeof value === "string" ? value : nodeStatus(value);
  return { ...INFO[status] };
}

/** The agent is in contact right now: online or degraded. */
export function isReporting(node: NodeStatusInput): boolean {
  return INFO[nodeStatus(node)].reporting;
}

/** Anything but online. */
export function needsAttention(node: NodeStatusInput): boolean {
  return INFO[nodeStatus(node)].attention;
}

/** Worst first, then a caller-supplied tiebreak (usually name then id). */
export function compareByAttention(a: NodeStatusInput, b: NodeStatusInput): number {
  return ATTENTION_ORDER[nodeStatus(a)] - ATTENTION_ORDER[nodeStatus(b)];
}

/**
 * When the node entered its state. The server says so; against an older
 * server the last beat is the only instant that means anything, and only for
 * a node that went quiet.
 */
export function nodeStatusSince(node: NodeStatusInput): string | undefined {
  if (node.status_since && !isZeroTime(node.status_since)) return node.status_since;
  if (nodeStatus(node) === "offline" && node.last_seen && !isZeroTime(node.last_seen)) return node.last_seen;
  return undefined;
}

/** The server's one-sentence account, when it sent one. */
export function nodeStatusReason(node: NodeStatusInput): string {
  return node.status_reason?.trim() ?? "";
}

/** The six numbers every fleet surface prints, all from one pass over one array. */
export interface NodeStatusCounts {
  total: number;
  online: number;
  degraded: number;
  offline: number;
  never_reported: number;
  disabled: number;
  /** online + degraded: the nodes whose metrics are current. */
  reporting: number;
  /** total - online: the nodes an operator may have to act on. */
  attention: number;
}

export function countNodeStatuses(nodes: readonly NodeStatusInput[]): NodeStatusCounts {
  const counts: NodeStatusCounts = {
    total: nodes.length,
    online: 0,
    degraded: 0,
    offline: 0,
    never_reported: 0,
    disabled: 0,
    reporting: 0,
    attention: 0,
  };
  for (const node of nodes) {
    const status = nodeStatus(node);
    counts[status] += 1;
    if (INFO[status].reporting) counts.reporting += 1;
    if (INFO[status].attention) counts.attention += 1;
  }
  return counts;
}
