/**
 * Pure model for the Nodes collection (design 23, section 4.2): the column
 * catalog, which columns hold one value on every node (they leave for the
 * head), grouping, search, and the address keys. Kept free of Vue so
 * `node --test` covers it directly (house *Model.ts pattern).
 */
import type { QueryRecord, QueryValue } from "@/components/common/tableUrlState";
import type { QueryParamCodec } from "@/composables/useQueryParam";
import type { Node } from "@/lib/api/types";
import { splitNamePrefix } from "@/lib/fleet";
import { agentConfigBadges } from "@/lib/nodeFilterExpressions";
import { ATTENTION_ORDER, isNodeStatus, nodeStatus, type NodeStatus } from "@/lib/nodeStatus";

/* ------------------------------------------------------------------ */
/* Identity                                                            */
/* ------------------------------------------------------------------ */

/**
 * Total order for rows that rank equal otherwise: visible name first, node id
 * last. Names are not unique (the console ships a duplicate-node report
 * because two machines can carry one name), ids are, so re-polling the same
 * fleet renders the same rows in the same places.
 */
export function compareNodeIdentity(a: Pick<Node, "id" | "name">, b: Pick<Node, "id" | "name">): number {
  return (a.name || a.id).localeCompare(b.name || b.id) || a.id.localeCompare(b.id);
}

/** The bracketed owner of a node's name ("cd" for "[cd]-hetzner-fsn"), or "". */
export function nodeOwner(node: Pick<Node, "id" | "name">): string {
  return splitNamePrefix(node).prefix;
}

/* ------------------------------------------------------------------ */
/* Columns                                                             */
/* ------------------------------------------------------------------ */

export interface NodeColumn {
  id: string;
  /** Full i18n key for the header and the column manager. */
  labelKey: string;
  /** Optional columns can be hidden through the column manager. */
  optional: boolean;
  /** Hidden until the operator asks for it. */
  defaultHidden?: boolean;
}

/**
 * The default set is what an operator scans the fleet for (design 23, 4.2):
 * the node, its address, its agent version, when it last reported, its CPU
 * and its tags. Status is not a column: "online" printed on 32 rows was a
 * column of one word, so the name cell carries a dot and names the state only
 * when it is not online, and the head counts the rest. The owner is the
 * default grouping, so its column starts hidden; what each agent is allowed
 * to do repeats one string on most rows and lives in the column manager.
 */
export const NODE_COLUMNS: readonly NodeColumn[] = [
  { id: "name", labelKey: "fleet.nodes.table.colName", optional: false },
  { id: "owner", labelKey: "fleet.nodes.table.colOwner", optional: true, defaultHidden: true },
  { id: "address", labelKey: "fleet.nodes.table.colPublicIp", optional: true },
  { id: "agent", labelKey: "fleet.nodes.table.colAgent", optional: true },
  { id: "lastSeen", labelKey: "fleet.nodes.table.colLastSeen", optional: true },
  { id: "cpu", labelKey: "fleet.nodes.metric.cpu", optional: true },
  { id: "tags", labelKey: "fleet.nodes.table.colTags", optional: true },
  { id: "hostname", labelKey: "fleet.nodes.table.colHostname", optional: true, defaultHidden: true },
  { id: "role", labelKey: "fleet.nodes.table.colRole", optional: true, defaultHidden: true },
  { id: "archOs", labelKey: "fleet.nodes.table.colArchOs", optional: true, defaultHidden: true },
  { id: "agentConfig", labelKey: "fleet.nodes.table.colAgentConfig", optional: true, defaultHidden: true },
  { id: "memory", labelKey: "fleet.nodes.metric.memory", optional: true, defaultHidden: true },
  { id: "disk", labelKey: "fleet.nodes.metric.disk", optional: true, defaultHidden: true },
];

/**
 * A new key, so the new default set reaches consoles that stored the old
 * table's choice (Last seen and CPU hidden) once instead of never.
 */
export const NODE_COLUMNS_STORAGE_KEY = "lattice.nodes.columns.v2";

const columnById = new Map(NODE_COLUMNS.map((column) => [column.id, column]));

export const DEFAULT_HIDDEN_COLUMNS: ReadonlySet<string> = new Set(
  NODE_COLUMNS.filter((column) => column.defaultHidden).map((column) => column.id),
);

/**
 * Stored as the comma-joined ids of hidden optional columns. `null` (never
 * configured) gets the defaults; `""` (configured, every column on) is a
 * different answer and keeps every column.
 */
export function parseHiddenColumns(raw: string | null): Set<string> {
  if (raw === null) return new Set(DEFAULT_HIDDEN_COLUMNS);
  const hidden = new Set<string>();
  for (const part of raw.split(",")) {
    const id = part.trim();
    if (columnById.get(id)?.optional) hidden.add(id);
  }
  return hidden;
}

export function serializeHiddenColumns(hidden: ReadonlySet<string>): string {
  return NODE_COLUMNS.filter((column) => column.optional && hidden.has(column.id))
    .map((column) => column.id)
    .join(",");
}

/* ------------------------------------------------------------------ */
/* Values                                                              */
/* ------------------------------------------------------------------ */

/**
 * The percent a cell prints. Ranking on the raw float re-ranked rows that
 * read identical on screen every five-second poll (26 of 33 nodes moved
 * their CPU between two polls, 14 without the printed percent changing), so
 * the sort uses what the operator sees.
 */
export function shownPercent(value: number | undefined): number | undefined {
  if (value === undefined || Number.isNaN(value)) return undefined;
  return Number(Math.min(100, Math.max(0, value)).toFixed(0));
}

export function ratioPercent(used?: number, total?: number): number | undefined {
  if (used === undefined || !total || total <= 0) return undefined;
  return shownPercent((used / total) * 100);
}

export function lastSeenMillis(node: Pick<Node, "last_seen">): number {
  const at = node.last_seen ? Date.parse(node.last_seen) : NaN;
  return Number.isNaN(at) || new Date(at).getUTCFullYear() <= 1 ? 0 : at;
}

export function archOsText(node: Pick<Node, "host_facts">): string {
  const facts = node.host_facts;
  return [facts?.os, facts?.arch].filter(Boolean).join(" · ");
}

/** What a column prints for a node, for the columns that can hold one value everywhere. */
export function columnText(node: Node, id: string): string {
  switch (id) {
    case "owner":
      return nodeOwner(node);
    case "agent":
      return node.agent_version ?? "";
    case "archOs":
      return archOsText(node);
    case "agentConfig":
      return agentConfigBadges(node).join(" ");
    case "role":
      return node.role ?? "";
    default:
      return "";
  }
}

/** Columns that may turn out to hold one value on every node. */
export const UNIFORM_CANDIDATES = ["owner", "agent", "archOs", "agentConfig", "role"] as const;

/**
 * Columns whose printed value is the same, and not empty, on every node
 * (design 23, 4.2): the column leaves the table and the head says the value
 * once. Needs two nodes or more; one node is not a pattern.
 */
export function uniformColumns(nodes: readonly Node[], ids: readonly string[] = UNIFORM_CANDIDATES): { id: string; value: string }[] {
  if (nodes.length < 2) return [];
  const out: { id: string; value: string }[] = [];
  for (const id of ids) {
    const first = columnText(nodes[0]!, id);
    if (first && nodes.every((node) => columnText(node, id) === first)) out.push({ id, value: first });
  }
  return out;
}

function compareVersionsDesc(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(/[.-]/).map((part) => Number(part));
  const pb = b.replace(/^v/, "").split(/[.-]/).map((part) => Number(part));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (Number.isNaN(x) || Number.isNaN(y)) return b.localeCompare(a);
    if (x !== y) return y - x;
  }
  return 0;
}

/** The agent versions the fleet runs, newest first; nodes that never reported one are left out. */
export function agentVersions(nodes: readonly Pick<Node, "agent_version">[]): string[] {
  const set = new Set(nodes.map((node) => node.agent_version ?? "").filter(Boolean));
  return [...set].sort(compareVersionsDesc);
}

/* ------------------------------------------------------------------ */
/* Grouping                                                            */
/* ------------------------------------------------------------------ */

/**
 * Owner first: the bracketed prefix is how the operator splits the fleet
 * (cd 16, Metix 13). Tags are not offered because a node carries several and
 * a row sits in one group; status, country and agent version each have one
 * value per node.
 */
export const NODE_GROUP_BYS = ["owner", "status", "country", "agent", "none"] as const;
export type NodeGroupBy = (typeof NODE_GROUP_BYS)[number];
export const NODE_GROUP_PARAM = "group";

export function isNodeGroupBy(value: unknown): value is NodeGroupBy {
  return typeof value === "string" && (NODE_GROUP_BYS as readonly string[]).includes(value);
}

/** `?group=`: owner is the bare URL, anything else is spelled. */
export const nodeGroupByCodec: QueryParamCodec<NodeGroupBy> = {
  parse: (raw) => (isNodeGroupBy(raw) ? raw : "owner"),
  format: (value) => (value === "owner" ? undefined : value),
};

export function nodeGroupKey(node: Node, by: NodeGroupBy): string {
  switch (by) {
    case "owner":
      return nodeOwner(node);
    case "status":
      return nodeStatus(node);
    case "country":
      return node.geo?.country ?? "";
    case "agent":
      return node.agent_version ?? "";
    case "none":
      return "";
  }
}

/**
 * Group order: owners and countries by size (the biggest first, the empty
 * key last), statuses worst first, agent versions newest first.
 */
export function nodeGroupOrder(nodes: readonly Node[], by: NodeGroupBy): string[] {
  if (by === "none") return [];
  const counts = new Map<string, number>();
  for (const node of nodes) {
    const key = nodeGroupKey(node, by);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const keys = [...counts.keys()];
  if (by === "status") {
    return keys.sort((a, b) => ATTENTION_ORDER[a as NodeStatus] - ATTENTION_ORDER[b as NodeStatus]);
  }
  if (by === "agent") {
    return keys.sort((a, b) => (!a ? 1 : !b ? -1 : compareVersionsDesc(a, b)));
  }
  return keys.sort((a, b) => {
    if (!a !== !b) return a ? -1 : 1;
    return (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || a.localeCompare(b);
  });
}

export interface NodeGroupSummary {
  total: number;
  online: number;
  degraded: number;
  disabled: number;
  /** Names of the members not reporting (offline or never reported), worst first. */
  down: string[];
}

/** What a group row says about its members (design 22, rule 3): how many, how many online, who is down. */
export function nodeGroupSummary(rows: readonly Node[]): NodeGroupSummary {
  const summary: NodeGroupSummary = { total: rows.length, online: 0, degraded: 0, disabled: 0, down: [] };
  const down: Node[] = [];
  for (const node of rows) {
    const status = nodeStatus(node);
    if (status === "online") summary.online += 1;
    else if (status === "degraded") summary.degraded += 1;
    else if (status === "disabled") summary.disabled += 1;
    else down.push(node);
  }
  summary.down = down
    .sort((a, b) => ATTENTION_ORDER[nodeStatus(a)] - ATTENTION_ORDER[nodeStatus(b)] || compareNodeIdentity(a, b))
    .map((node) => splitNamePrefix(node).body);
  return summary;
}

/* ------------------------------------------------------------------ */
/* Search                                                              */
/* ------------------------------------------------------------------ */

/** Subsequence match: every character of the needle, in order ("gmhk" finds "gomami-hkg"). */
export function fuzzyMatch(haystack: string, needle: string): boolean {
  if (!needle) return true;
  let i = 0;
  for (let j = 0; j < haystack.length && i < needle.length; j++) {
    if (haystack[j] === needle[i]) i++;
  }
  return i === needle.length;
}

/** Every text a search looks at, lowercased: name, id, role, addresses, host facts and tags. */
export function searchFields(node: Node): string[] {
  return [
    node.name,
    node.id,
    node.role,
    node.public_ip,
    node.public_ipv6,
    node.internal_ip,
    node.internal_ipv6,
    node.host_facts?.hostname,
    node.host_facts?.arch,
    node.host_facts?.os,
    node.host_facts?.platform,
    ...(node.tags ?? []),
  ]
    .filter((value): value is string => !!value)
    .map((value) => value.toLowerCase());
}

/** "mac" finds macOS, whose agent reports "darwin". */
function macAlias(node: Node, q: string): boolean {
  if (!q.includes("mac")) return false;
  return `${node.host_facts?.os ?? ""} ${node.host_facts?.platform ?? ""}`.toLowerCase().includes("darwin");
}

/** Relevance: exact 100, prefix 70, the mac alias 60, substring 50, subsequence 20, no match 0. */
export function searchScore(node: Node, query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  let best = 0;
  for (const field of searchFields(node)) {
    if (field === q) best = Math.max(best, 100);
    else if (field.startsWith(q)) best = Math.max(best, 70);
    else if (field.includes(q)) best = Math.max(best, 50);
    else if (fuzzyMatch(field, q)) best = Math.max(best, 20);
  }
  if (macAlias(node, q)) best = Math.max(best, 60);
  return best;
}

/* ------------------------------------------------------------------ */
/* Address keys                                                        */
/* ------------------------------------------------------------------ */

export type NodeStatusFilter = "all" | NodeStatus;

/** `?status=` holds one status word; all is the bare URL. */
export const NODE_STATUS_PARAM = "status";
export const nodeStatusFilterCodec: QueryParamCodec<NodeStatusFilter> = {
  parse: (raw) => (isNodeStatus(raw) ? raw : "all"),
  format: (value) => (value === "all" ? undefined : value),
};

/** `?q=`: the search as typed, trimmed of nothing but the ends. */
export const nodeSearchCodec: QueryParamCodec<string> = {
  parse: (raw) => (typeof raw === "string" ? raw : ""),
  format: (value) => (value.trim() ? value : undefined),
};

/** A comma list in one key (`?agent=root,terminal`), in the order given, without repeats. */
export const nodeListCodec: QueryParamCodec<string[]> = {
  parse: (raw) => {
    if (typeof raw !== "string") return [];
    return [...new Set(raw.split(",").map((part) => part.trim()).filter(Boolean))];
  },
  format: (value) => (value.length ? value.join(",") : undefined),
};

export type NodesLayout = "card" | "list";

/**
 * The card/list switch is a layout, not a layer, so it lives in `?layout=`
 * (design 23, section 3.4). `?view=` is the layer key on every page; Nodes
 * wrote its layout there before, and old links are read once and rewritten.
 */
export const NODES_LAYOUT_PARAM = "layout";
const LEGACY_LAYOUT_PARAM = "view";

export function isNodesLayout(value: unknown): value is NodesLayout {
  return value === "card" || value === "list";
}

/**
 * An old link's `?view=card|list` moved to `?layout=`, or null when the query
 * has nothing to move. A `?layout=` already present wins over the old key.
 */
export function canonicalLayoutQuery(query: QueryRecord): { layout: NodesLayout; query: Record<string, QueryValue> } | null {
  const legacy = query[LEGACY_LAYOUT_PARAM];
  if (!isNodesLayout(legacy)) return null;
  const current = query[NODES_LAYOUT_PARAM];
  const layout = isNodesLayout(current) ? current : legacy;
  const next: Record<string, QueryValue> = {};
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || key === LEGACY_LAYOUT_PARAM) continue;
    next[key] = value;
  }
  next[NODES_LAYOUT_PARAM] = layout;
  return { layout, query: next };
}

/**
 * A long name split so a narrow cell cuts it in the middle: the head
 * truncates and the tail stays. Cut at the end, Aaitr-Frontier-NAT and
 * Aaitr-Frontier-VDS both read "Aaitr-Frontier…" at 375. The tail is the
 * last part after a hyphen, underscore or space when that part is 2 to 8
 * characters, otherwise the last 4; a short name is not split.
 */
export function nameParts(name: string): [head: string, tail: string] {
  if (name.length <= 12) return [name, ""];
  const cut = Math.max(name.lastIndexOf("-"), name.lastIndexOf("_"), name.lastIndexOf(" "));
  const part = cut >= 0 ? name.length - cut - 1 : 0;
  const tailLength = part >= 2 && part <= 8 ? part + 1 : 4;
  return [name.slice(0, name.length - tailLength), name.slice(name.length - tailLength)];
}
