/**
 * The node fields every node list shares (src/lib/query/engine.ts). A page
 * whose rows are nodes uses `nodeQuerySchema`; a page whose rows are about
 * nodes (an SSH Guard row, an update target) passes how to reach the node and
 * adds its own fields beside these.
 *
 * Metrics are read only from a node that is reporting. The Nodes table
 * prints a dash for the CPU of a node offline six days, so `cpu>80` must not
 * find it by a number the operator cannot see.
 */
import type { Node } from "@/lib/api/types";
import { nodeHasAgentCapability, singboxDrift } from "@/lib/nodeFilterExpressions";
import { ATTENTION_ORDER, NODE_STATUSES, isReporting, nodeStatus } from "@/lib/nodeStatus";
import type { QueryField, QuerySchema } from "@/lib/query/engine";

/** What an agent may do, as the cap: field and the bare word name it. */
export const NODE_CAPABILITIES = ["exec", "root", "terminal", "stream", "poll", "singbox", "singbox-drift", "no-source"] as const;

const CAPABILITY_ALIASES: Readonly<Record<string, string>> = {
  "sing-box": "singbox",
  "sing-box-drift": "singbox-drift",
  drift: "singbox-drift",
  nosource: "no-source",
};

/** Statuses in the order the attention sort puts them: never reported first, online last. */
const STATUS_ORDER = [...NODE_STATUSES].sort((a, b) => ATTENTION_ORDER[a] - ATTENTION_ORDER[b]);

/** The percent a cell prints, so a filter and a sort agree with what is on screen (nodesTableModel.shownPercent). */
function shown(value: number | undefined): number | undefined {
  if (value === undefined || Number.isNaN(value)) return undefined;
  return Math.round(Math.min(100, Math.max(0, value)));
}

function ratio(used?: number, total?: number): number | undefined {
  if (used === undefined || !total || total <= 0) return undefined;
  return shown((used / total) * 100);
}

function present<T>(values: readonly (T | undefined | null | "")[]): T[] {
  return values.filter((value): value is T => value !== undefined && value !== null && value !== "");
}

/** The words a bare search looks at: name, id, role, addresses, host facts and tags. */
export function nodeQueryText(node: Node | undefined): string[] {
  if (!node) return [];
  return present([
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
  ]);
}

function capabilityWord(word: string): string | undefined {
  const lower = word.trim().toLowerCase();
  const canonical = CAPABILITY_ALIASES[lower] ?? lower;
  return (NODE_CAPABILITIES as readonly string[]).includes(canonical) ? canonical : undefined;
}

/** The capabilities a node has, as cap: values. */
export function nodeCapabilities(node: Node): string[] {
  return NODE_CAPABILITIES.filter((cap) => nodeHasAgentCapability(node, cap));
}

export interface NodeFieldOptions<R> {
  /** Group names by id, for group:. Read when the query runs, so it may follow a list that loads later. */
  groupName?: (id: string) => string | undefined;
  /** The row's id and name when the row has no node (an SSH Guard row whose node left the fleet). */
  identity?: (row: R) => { id: string; name?: string };
}

const hint = (key: string) => `common.listQuery.fields.${key}`;

/**
 * The shared node fields over any row that leads to a node. A row with no
 * node matches no node term and sorts last on every node field, except name
 * and id when `identity` is given.
 */
export function nodeQueryFields<R>(nodeOf: (row: R) => Node | undefined, options: NodeFieldOptions<R> = {}): QueryField<R>[] {
  const read =
    <V>(get: (node: Node) => V) =>
    (row: R): V | undefined => {
      const node = nodeOf(row);
      return node ? get(node) : undefined;
    };
  const live =
    <V>(get: (node: Node) => V) =>
    (row: R): V | undefined => {
      const node = nodeOf(row);
      return node && isReporting(node) ? get(node) : undefined;
    };
  const values =
    (get: (node: Node) => readonly (string | undefined | null)[]) =>
    (rows: readonly R[]): string[] =>
      rows.flatMap((row) => {
        const node = nodeOf(row);
        return node ? present(get(node)) : [];
      });
  const identity = (row: R) => {
    const node = nodeOf(row);
    if (node) return { id: node.id, name: node.name || node.id };
    const known = options.identity?.(row);
    return known ? { id: known.id, name: known.name || known.id } : undefined;
  };
  const status = (want: string) => read((node) => nodeStatus(node) === want);

  return [
    {
      key: "name",
      type: "string",
      hint: hint("name"),
      get: (row) => identity(row)?.name,
      suggest: (rows) => present(rows.map((row) => identity(row)?.name)),
      sort: (row) => {
        const id = identity(row);
        return id ? `${id.name.toLowerCase()}\u0000${id.id}` : undefined;
      },
    },
    { key: "id", type: "string", hint: hint("id"), get: (row) => identity(row)?.id },
    {
      key: "ip",
      aliases: ["address", "addr"],
      type: "list",
      hint: hint("ip"),
      get: read((node) => present([node.public_ip, node.public_ipv6, node.internal_ip, node.internal_ipv6])),
      sort: read((node) => node.public_ip || node.public_ipv6 || node.internal_ip || node.internal_ipv6),
    },
    {
      key: "tag",
      aliases: ["tags", "role"],
      type: "list",
      hint: hint("tag"),
      get: read((node) => present([node.role, ...(node.tags ?? [])])),
      suggest: values((node) => [node.role, ...(node.tags ?? [])]),
    },
    {
      key: "group",
      aliases: ["groups"],
      type: "list",
      hint: hint("group"),
      get: read((node) => (node.group_ids ?? []).map((id) => options.groupName?.(id) ?? id)),
      suggest: values((node) => (node.group_ids ?? []).map((id) => options.groupName?.(id) ?? id)),
    },
    {
      key: "provider",
      aliases: ["isp", "asn"],
      type: "list",
      hint: hint("provider"),
      get: read((node) => present([node.geo?.provider, node.geo?.as_org, node.geo?.asn ? `AS${node.geo.asn}` : undefined])),
      suggest: values((node) => [node.geo?.provider, node.geo?.as_org]),
    },
    {
      key: "country",
      aliases: ["cc"],
      type: "string",
      hint: hint("country"),
      get: read((node) => node.geo?.country),
      suggest: values((node) => [node.geo?.country]),
    },
    {
      key: "region",
      aliases: ["city", "geo"],
      type: "list",
      hint: hint("region"),
      get: read((node) => present([node.geo?.country, node.geo?.region, node.geo?.city])),
      suggest: values((node) => [node.geo?.region, node.geo?.city]),
    },
    {
      // os, platform, its version and the arch, as the old os: filter read them, so ?os=amd64 still works.
      key: "os",
      aliases: ["platform"],
      type: "list",
      hint: hint("os"),
      get: read((node) => present([node.host_facts?.os, node.host_facts?.platform, node.host_facts?.platform_version, node.host_facts?.arch])),
      suggest: values((node) => [node.host_facts?.os, node.host_facts?.platform]),
      sort: read((node) => node.host_facts?.os),
    },
    {
      key: "arch",
      type: "string",
      hint: hint("arch"),
      get: read((node) => node.host_facts?.arch),
      suggest: values((node) => [node.host_facts?.arch]),
    },
    {
      // agent:0.3.10 is a version; agent:exec is the capability, as it was before cap: existed.
      key: "agent",
      aliases: ["version"],
      type: "version",
      hint: hint("agent"),
      get: read((node) => node.agent_version),
      match: (row, value) => {
        const cap = capabilityWord(value);
        if (!cap) return undefined;
        const node = nodeOf(row);
        return node ? nodeHasAgentCapability(node, cap) : false;
      },
      suggest: values((node) => [node.agent_version]),
    },
    {
      key: "cap",
      aliases: ["caps", "capability", "config"],
      type: "enum",
      hint: hint("cap"),
      values: NODE_CAPABILITIES,
      valueAliases: CAPABILITY_ALIASES,
      get: read(nodeCapabilities),
      sort: read((node) => nodeCapabilities(node).length),
    },
    {
      key: "status",
      type: "enum",
      hint: hint("status"),
      values: STATUS_ORDER,
      valueAliases: { never: "never_reported", unreported: "never_reported", "never-reported": "never_reported" },
      get: read((node) => nodeStatus(node)),
    },
    { key: "online", type: "bool", flag: true, hint: hint("online"), get: status("online"), sort: false },
    { key: "offline", type: "bool", flag: true, hint: hint("offline"), get: status("offline"), sort: false },
    { key: "degraded", type: "bool", flag: true, hint: hint("degraded"), get: status("degraded"), sort: false },
    { key: "disabled", type: "bool", flag: true, hint: hint("disabled"), get: status("disabled"), sort: false },
    {
      key: "never",
      aliases: ["never_reported", "unreported"],
      type: "bool",
      flag: true,
      hint: hint("never"),
      get: status("never_reported"),
      sort: false,
    },
    { key: "reporting", type: "bool", flag: true, hint: hint("reporting"), get: read(isReporting), sort: false },
    { key: "drift", type: "bool", flag: true, hint: hint("drift"), get: read(singboxDrift), sort: false },
    { key: "cpu", type: "number", unit: "percent", hint: hint("cpu"), get: live((node) => shown(node.metrics?.cpu_percent)) },
    {
      key: "mem",
      aliases: ["memory"],
      type: "number",
      unit: "percent",
      hint: hint("mem"),
      get: live((node) => ratio(node.metrics?.memory_used, node.metrics?.memory_total)),
    },
    {
      key: "disk",
      type: "number",
      unit: "percent",
      hint: hint("disk"),
      get: live((node) => ratio(node.metrics?.disk_used, node.metrics?.disk_total)),
    },
    { key: "load", aliases: ["load1"], type: "number", hint: hint("load"), get: live((node) => node.metrics?.load1) },
    { key: "rx", type: "number", unit: "rate", hint: hint("rx"), get: live((node) => node.metrics?.net_rx_speed) },
    { key: "tx", type: "number", unit: "rate", hint: hint("tx"), get: live((node) => node.metrics?.net_tx_speed) },
    {
      key: "last_seen",
      aliases: ["seen", "lastseen"],
      type: "time",
      hint: hint("last_seen"),
      get: read((node) => node.last_seen),
    },
    { key: "uptime", type: "duration", hint: hint("uptime"), get: live((node) => node.metrics?.uptime_seconds) },
  ];
}

export interface NodeSchemaOptions {
  groupName?: (id: string) => string | undefined;
}

/** The schema for a list of nodes. Build it once per page; it reads groups through the callback. */
export function nodeQuerySchema(options: NodeSchemaOptions = {}): QuerySchema<Node> {
  return {
    fields: nodeQueryFields<Node>((node) => node, options),
    text: nodeQueryText,
    // A bare capability word finds the nodes that have it, as the task target filter always did.
    bare: (node, word) => {
      const cap = capabilityWord(word);
      return cap ? nodeHasAgentCapability(node, cap) : false;
    },
  };
}

/** The bare-word hook for rows that lead to a node. */
export function nodeBareMatch<R>(nodeOf: (row: R) => Node | undefined): (row: R, word: string) => boolean {
  return (row, word) => {
    const cap = capabilityWord(word);
    const node = nodeOf(row);
    return !!cap && !!node && nodeHasAgentCapability(node, cap);
  };
}
