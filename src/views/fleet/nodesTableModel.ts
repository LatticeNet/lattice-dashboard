/**
 * Pure model for the Nodes list table: column catalog, sort-state machine,
 * node comparators, and column-visibility persistence. Kept free of Vue so
 * `node --test` covers it directly (house *Model.ts pattern).
 */
import type { Node } from "@/lib/api/types";

export type NodeSortKey =
  | "name"
  | "status"
  | "cpu"
  | "memory"
  | "disk"
  | "network"
  | "lastSeen";

export type SortDir = "asc" | "desc";

export interface NodeSortState {
  key: NodeSortKey | "";
  dir: SortDir;
}

export interface NodeTableColumn {
  id: string;
  /** Full i18n key for the header / column-manager label. */
  labelKey: string;
  /** CSS grid track for the column. */
  width: string;
  /** Optional columns can be hidden via the column manager. */
  optional: boolean;
  /** Set when the header toggles sorting. */
  sortKey?: NodeSortKey;
  /** First-click direction: asc reads naturally for identity columns, desc
   *  for load metrics and recency (biggest / newest first). */
  defaultDir?: SortDir;
}

export const NODE_TABLE_COLUMNS: readonly NodeTableColumn[] = [
  { id: "name", labelKey: "fleet.nodes.table.colName", width: "minmax(180px,1.6fr)", optional: false, sortKey: "name", defaultDir: "asc" },
  { id: "status", labelKey: "fleet.nodes.table.colStatus", width: "90px", optional: false, sortKey: "status", defaultDir: "asc" },
  { id: "role", labelKey: "fleet.nodes.table.colRole", width: "104px", optional: true },
  { id: "tags", labelKey: "fleet.nodes.table.colTags", width: "minmax(120px,1fr)", optional: true },
  { id: "publicIp", labelKey: "fleet.nodes.table.colPublicIp", width: "150px", optional: true },
  { id: "archOs", labelKey: "fleet.nodes.table.colArchOs", width: "120px", optional: true },
  { id: "agentConfig", labelKey: "fleet.nodes.table.colAgentConfig", width: "150px", optional: true },
  { id: "cpu", labelKey: "fleet.nodes.metric.cpu", width: "84px", optional: true, sortKey: "cpu", defaultDir: "desc" },
  { id: "memory", labelKey: "fleet.nodes.metric.memory", width: "84px", optional: true, sortKey: "memory", defaultDir: "desc" },
  { id: "disk", labelKey: "fleet.nodes.metric.disk", width: "84px", optional: true, sortKey: "disk", defaultDir: "desc" },
  { id: "network", labelKey: "fleet.nodes.table.colNetwork", width: "170px", optional: true, sortKey: "network", defaultDir: "desc" },
  { id: "lastSeen", labelKey: "fleet.nodes.table.colLastSeen", width: "112px", optional: true, sortKey: "lastSeen", defaultDir: "desc" },
  { id: "update", labelKey: "fleet.nodes.table.colUpdate", width: "116px", optional: true },
  { id: "actions", labelKey: "fleet.nodes.table.colActions", width: "148px", optional: false },
];

const columnById = new Map(NODE_TABLE_COLUMNS.map((c) => [c.id, c]));

/** Header click cycle: none -> defaultDir -> flipped -> none. */
export function nextSortState(current: NodeSortState, columnId: string): NodeSortState {
  const column = columnById.get(columnId);
  if (!column?.sortKey) return current;
  const first = column.defaultDir ?? "asc";
  if (current.key !== column.sortKey) return { key: column.sortKey, dir: first };
  if (current.dir === first) return { key: column.sortKey, dir: first === "asc" ? "desc" : "asc" };
  return { key: "", dir: "asc" };
}

function statusRank(node: Node): number {
  if (node.disabled) return 2;
  return node.online ? 0 : 1;
}

function ratioOf(used?: number, total?: number): number {
  if (!used || !total || total <= 0) return 0;
  return used / total;
}

function lastSeenMillis(node: Node): number {
  const t = node.last_seen ? Date.parse(node.last_seen as unknown as string) : NaN;
  return Number.isNaN(t) ? 0 : t;
}

/** Ascending comparator for the given key; callers flip for desc. */
function compareAsc(a: Node, b: Node, key: NodeSortKey): number {
  switch (key) {
    case "name":
      return (a.name || a.id).localeCompare(b.name || b.id);
    case "status":
      return statusRank(a) - statusRank(b);
    case "cpu":
      return (a.metrics?.cpu_percent ?? 0) - (b.metrics?.cpu_percent ?? 0);
    case "memory":
      return (
        ratioOf(a.metrics?.memory_used, a.metrics?.memory_total) -
        ratioOf(b.metrics?.memory_used, b.metrics?.memory_total)
      );
    case "disk":
      return (
        ratioOf(a.metrics?.disk_used, a.metrics?.disk_total) -
        ratioOf(b.metrics?.disk_used, b.metrics?.disk_total)
      );
    case "network":
      return (a.metrics?.net_rx_speed ?? 0) - (b.metrics?.net_rx_speed ?? 0);
    case "lastSeen":
      return lastSeenMillis(a) - lastSeenMillis(b);
  }
}

/** Stable sort under the explicit user sort; name breaks ties. */
export function sortNodes(nodes: readonly Node[], state: NodeSortState): Node[] {
  if (!state.key) return [...nodes];
  const key = state.key;
  const sign = state.dir === "desc" ? -1 : 1;
  return [...nodes].sort((a, b) => {
    const primary = compareAsc(a, b, key) * sign;
    if (primary !== 0) return primary;
    return (a.name || a.id).localeCompare(b.name || b.id);
  });
}

/** Visibility persistence: stored as a comma-joined list of HIDDEN optional
 *  column ids, so newly shipped columns default to visible. */
export function parseHiddenColumns(raw: string | null): Set<string> {
  const hidden = new Set<string>();
  if (!raw) return hidden;
  for (const part of raw.split(",")) {
    const id = part.trim();
    const column = columnById.get(id);
    if (column?.optional) hidden.add(id);
  }
  return hidden;
}

export function serializeHiddenColumns(hidden: ReadonlySet<string>): string {
  return NODE_TABLE_COLUMNS.filter((c) => c.optional && hidden.has(c.id))
    .map((c) => c.id)
    .join(",");
}

export function visibleColumns(hidden: ReadonlySet<string>): NodeTableColumn[] {
  return NODE_TABLE_COLUMNS.filter((c) => !c.optional || !hidden.has(c.id));
}

/** CSS grid-template-columns for the currently visible column set. */
export function gridTemplate(hidden: ReadonlySet<string>): string {
  return visibleColumns(hidden)
    .map((c) => c.width)
    .join(" ");
}

export function parseSortState(raw: string | null): NodeSortState {
  if (!raw) return { key: "", dir: "asc" };
  const [key, dir] = raw.split(":");
  const column = NODE_TABLE_COLUMNS.find((c) => c.sortKey === key);
  if (!column) return { key: "", dir: "asc" };
  return { key: column.sortKey as NodeSortKey, dir: dir === "desc" ? "desc" : "asc" };
}

export function serializeSortState(state: NodeSortState): string {
  return state.key ? `${state.key}:${state.dir}` : "";
}
