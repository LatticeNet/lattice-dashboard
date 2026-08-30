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
  /**
   * Hidden until the operator asks for it.
   *
   * Every optional column used to start visible, which made the default table
   * ~1940px wide. On a 1440px display with the sidebar open that puts the
   * metric columns, last-seen and the row actions off the right edge: the
   * operator's first view of the fleet was name, status, role, tags and an IP,
   * and everything worth scanning for needed a horizontal scroll to reach.
   * The default set is now the columns you triage by; the rest stay one click
   * away in the column manager.
   */
  defaultHidden?: boolean;
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
  { id: "tags", labelKey: "fleet.nodes.table.colTags", width: "minmax(120px,1fr)", optional: true, defaultHidden: true },
  { id: "publicIp", labelKey: "fleet.nodes.table.colPublicIp", width: "150px", optional: true, defaultHidden: true },
  { id: "archOs", labelKey: "fleet.nodes.table.colArchOs", width: "120px", optional: true, defaultHidden: true },
  { id: "agentConfig", labelKey: "fleet.nodes.table.colAgentConfig", width: "150px", optional: true, defaultHidden: true },
  { id: "cpu", labelKey: "fleet.nodes.metric.cpu", width: "84px", optional: true, sortKey: "cpu", defaultDir: "desc" },
  { id: "memory", labelKey: "fleet.nodes.metric.memory", width: "84px", optional: true, sortKey: "memory", defaultDir: "desc" },
  { id: "disk", labelKey: "fleet.nodes.metric.disk", width: "84px", optional: true, sortKey: "disk", defaultDir: "desc" },
  { id: "network", labelKey: "fleet.nodes.table.colNetwork", width: "170px", optional: true, sortKey: "network", defaultDir: "desc", defaultHidden: true },
  { id: "lastSeen", labelKey: "fleet.nodes.table.colLastSeen", width: "112px", optional: true, sortKey: "lastSeen", defaultDir: "desc" },
  { id: "update", labelKey: "fleet.nodes.table.colUpdate", width: "116px", optional: true, defaultHidden: true },
  { id: "actions", labelKey: "fleet.nodes.table.colActions", width: "116px", optional: false },
];

/**
 * Columns hidden on a console that has never been told otherwise.
 *
 * What survives is what a fleet is triaged by: which node, is it healthy, what
 * is it for, is it loaded, when did it last check in. Tags, addresses, arch and
 * update policy are lookup data - you go to them once you know which node you
 * care about, and the node page holds all of them. Keeping the default set
 * inside one screen width is what makes the metric columns visible at all;
 * before this they were 460px past the right edge.
 */
export const DEFAULT_HIDDEN_COLUMNS: ReadonlySet<string> = new Set(
  NODE_TABLE_COLUMNS.filter((c) => c.defaultHidden).map((c) => c.id),
);

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

/**
 * The percent a metric cell actually prints.
 *
 * `MetricBar` clamps to 0..100 and `formatPercent` prints `toFixed(0)`, so an
 * operator reads "8%" and never sees 7.51 vs 7.92. Ranking on the raw float
 * therefore re-ranks rows that are identical on screen, and the fleet repolls
 * every five seconds: measured against the live 33-node fleet, 26 nodes moved
 * their cpu value between two polls and 14 of those moved it without the
 * printed percent changing at all. That is the list "shuffling for no reason".
 * Rank on the printed number instead - a row still moves the instant its
 * visible percent moves, it just stops trading places over invisible noise.
 */
function shownPercent(value: number): number {
  return Number(Math.min(100, Math.max(0, value)).toFixed(0));
}

/** Same, for the used/total pairs the memory and disk cells render. */
function shownRatioPercent(used?: number, total?: number): number {
  if (!used || !total || total <= 0) return 0;
  return shownPercent((used / total) * 100);
}

/**
 * Total order for rows the primary key ranks equal: visible name first, node
 * id last. The id is the tiebreak that makes the result independent of the
 * order the poll happened to deliver - names are not unique (the console ships
 * a duplicate-node report precisely because two machines can carry one name),
 * ids are.
 */
export function compareNodeIdentity(a: Node, b: Node): number {
  return (a.name || a.id).localeCompare(b.name || b.id) || a.id.localeCompare(b.id);
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
      return shownPercent(a.metrics?.cpu_percent ?? 0) - shownPercent(b.metrics?.cpu_percent ?? 0);
    case "memory":
      return (
        shownRatioPercent(a.metrics?.memory_used, a.metrics?.memory_total) -
        shownRatioPercent(b.metrics?.memory_used, b.metrics?.memory_total)
      );
    case "disk":
      return (
        shownRatioPercent(a.metrics?.disk_used, a.metrics?.disk_total) -
        shownRatioPercent(b.metrics?.disk_used, b.metrics?.disk_total)
      );
    case "network":
      return (a.metrics?.net_rx_speed ?? 0) - (b.metrics?.net_rx_speed ?? 0);
    case "lastSeen":
      return lastSeenMillis(a) - lastSeenMillis(b);
  }
}

/**
 * Sort under the explicit user sort. The result depends only on the values,
 * never on the order the poll delivered them: equal keys fall through to
 * name-then-id, so re-polling the same fleet re-renders the same rows in the
 * same places.
 */
export function sortNodes(nodes: readonly Node[], state: NodeSortState): Node[] {
  if (!state.key) return [...nodes];
  const key = state.key;
  const sign = state.dir === "desc" ? -1 : 1;
  return [...nodes].sort((a, b) => {
    const primary = compareAsc(a, b, key) * sign;
    if (primary !== 0) return primary;
    return compareNodeIdentity(a, b);
  });
}

/**
 * Visibility persistence: stored as a comma-joined list of HIDDEN optional
 * column ids, so newly shipped columns default to visible.
 *
 * `null` (never configured) and `""` (configured, and the operator wants every
 * column) are deliberately different answers. Treating both as "nothing hidden"
 * would mean an operator who has explicitly turned every column on gets the
 * built-in defaults pushed back at them on the next release.
 */
export function parseHiddenColumns(raw: string | null): Set<string> {
  if (raw === null) return new Set(DEFAULT_HIDDEN_COLUMNS);
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
