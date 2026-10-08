/**
 * Monitoring's query fields (src/lib/query) over the monitor list. The rows
 * are monitors, not nodes, so the node is one field among the monitor's own:
 * `node:` matches the names of the nodes a monitor runs on, and a monitor
 * assigned to every node matches any node name.
 *
 *   status:failing type:http sort:name
 *
 * Pure, like the sibling models: no Vue, no i18n.
 */
import type { MonitorView } from "@/lib/api/types";
import type { QueryField, QuerySchema } from "@/lib/query/engine";
import type { MonitorHealth } from "@/views/fleet/monitorHealthModel";

/** Failing first, as the status column sorts. */
export const MONITOR_HEALTH_KINDS = ["failing", "stale", "none", "unread", "up", "disabled"] as const;
export const MONITOR_TYPES = ["tcp", "http", "tls"] as const;

/** Queries the help offers on this page; each key names the sentence that says what it finds. */
export const MONITORING_QUERY_EXAMPLES = [
  { key: "failing", query: "status:failing,stale sort:name" },
  { key: "http", query: "type:http target:*:443" },
  { key: "slow", query: "interval>5m -is:managed" },
  { key: "node", query: "node:hetzner" },
] as const;

const hint = (key: string) => `fleet.monitoring.query.fields.${key}`;

export interface MonitoringQueryOptions {
  health: (monitor: MonitorView) => MonitorHealth;
  /** Every node name the console knows, for a monitor assigned to all of them. */
  allNodeNames: () => readonly string[];
  nodeName: (id: string) => string;
  /** A tls monitor runs on the control plane, not on a node. */
  serverEvaluated: (monitor: MonitorView) => boolean;
}

export function monitoringQuerySchema(options: MonitoringQueryOptions): QuerySchema<MonitorView> {
  const nodeNames = (m: MonitorView): string[] => {
    if (options.serverEvaluated(m)) return [];
    if (m.assign_all) return [...options.allNodeNames()];
    return (m.node_ids ?? []).map((id) => options.nodeName(id));
  };
  const fields: QueryField<MonitorView>[] = [
    { key: "name", type: "string", hint: hint("name"), get: (m) => m.name || m.id, suggest: (rows) => rows.map((m) => m.name || m.id) },
    { key: "id", type: "string", hint: hint("id"), get: (m) => m.id },
    { key: "type", type: "enum", hint: hint("type"), values: MONITOR_TYPES, get: (m) => m.type },
    { key: "target", type: "string", hint: hint("target"), get: (m) => m.target },
    {
      key: "status",
      aliases: ["health"],
      type: "enum",
      hint: hint("status"),
      values: MONITOR_HEALTH_KINDS,
      valueAliases: { down: "failing", ok: "up" },
      get: (m) => options.health(m).kind,
    },
    { key: "node", aliases: ["nodes"], type: "list", hint: hint("node"), get: nodeNames, suggest: (rows) => rows.flatMap(nodeNames), sort: false },
    { key: "checks", type: "number", hint: hint("checks"), get: (m) => (options.serverEvaluated(m) ? undefined : nodeNames(m).length) },
    { key: "interval", aliases: ["every"], type: "duration", hint: hint("interval"), get: (m) => m.interval_sec },
    { key: "timeout", type: "duration", hint: hint("timeout"), get: (m) => m.timeout_sec },
    { key: "enabled", type: "bool", flag: true, hint: hint("enabled"), get: (m) => m.enabled, sort: false },
    { key: "managed", type: "bool", flag: true, hint: hint("managed"), get: (m) => !!m.managed_by, sort: false },
    { key: "all", aliases: ["everywhere"], type: "bool", flag: true, hint: hint("all"), get: (m) => !!m.assign_all, sort: false },
  ];
  return {
    fields,
    text: (m) => [m.name, m.id, m.type, m.target, ...(m.assign_all ? [] : nodeNames(m))],
  };
}
