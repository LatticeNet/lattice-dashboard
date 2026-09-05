/**
 * Pure model for the Nodes list table: column catalog, sort-state machine,
 * node comparators, and column-visibility persistence. Kept free of Vue so
 * `node --test` covers it directly (house *Model.ts pattern).
 */
import type { Node } from "@/lib/api/types";
import { splitNamePrefix } from "@/lib/fleet";
import { NODE_STATUSES, nodeStatus } from "@/lib/nodeStatus";

export type NodeSortKey =
  | "name"
  | "owner"
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
   * The default set is budgeted to the card instead (see
   * DEFAULT_HIDDEN_COLUMNS); the rest stay one click away in the column
   * manager.
   */
  defaultHidden?: boolean;
  /** Set when the header toggles sorting. */
  sortKey?: NodeSortKey;
  /** First-click direction: asc reads naturally for identity columns, desc
   *  for load metrics and recency (biggest / newest first). */
  defaultDir?: SortDir;
}

export const NODE_TABLE_COLUMNS: readonly NodeTableColumn[] = [
  // The Node track is not this constant: gridTemplate() sizes it from the
  // longest name in the rows (nameTrackMin), so this is the floor. It is the
  // pinned column, so it is a fixed width rather than a flexible track: the
  // operator asked for "a little wider than the longest name", and a column
  // that grows with spare width pins more of the viewport than it has to.
  { id: "name", labelKey: "fleet.nodes.table.colName", width: "228px", optional: false, sortKey: "name", defaultDir: "asc" },
  // The bracketed prefix of the name ("[cd]-", "[OpenJobs-Data]-") used to sit
  // inside the Node cell as a badge before the name, so names started at a
  // different x on every row and the widest badge set the column. It is the
  // owner of the machine, a value of its own, so it gets a column. The track
  // is chip-sized: the widest owner in the fleet ("OpenJobs-Data") is a 99px
  // chip as Chrome on macOS draws it (85px of text at the chip's 11px medium,
  // 6px of padding a side and the border), so 104px holds it with a little
  // to spare, and a longer owner truncates inside the chip with the full
  // text in its title. It was 112px, matched to the Status track.
  { id: "owner", labelKey: "fleet.nodes.table.colOwner", width: "104px", optional: true, sortKey: "owner", defaultDir: "asc" },
  // 90px clipped the widest status pill ("never reported") to "never report...".
  // The track is sized to the longest word the column can hold, because a
  // status the operator has to guess at is the one thing this column exists for.
  { id: "status", labelKey: "fleet.nodes.table.colStatus", width: "112px", optional: false, sortKey: "status", defaultDir: "asc" },
  // The hostname used to ride under the name as the row's second line. It is
  // the machine's own answer to "which box is this", so it gets a column of
  // its own; the line under the name is the short id, the one value that
  // still separates two machines sharing a name. Truncates with a title.
  // The floor holds the fleet's longest hostnames (27 characters, the EC2
  // "ip-10-0-12-237.ec2.internal" form, 195px at the cell's 12px mono); it is
  // also what the table's min-width counts for the track, so it decides the
  // width the column renders at whenever the table overflows its card.
  { id: "hostname", labelKey: "fleet.nodes.table.colHostname", width: "minmax(200px,1fr)", optional: true, defaultHidden: true },
  { id: "role", labelKey: "fleet.nodes.table.colRole", width: "104px", optional: true, defaultHidden: true },
  { id: "tags", labelKey: "fleet.nodes.table.colTags", width: "minmax(120px,1fr)", optional: true },
  { id: "publicIp", labelKey: "fleet.nodes.table.colPublicIp", width: "150px", optional: true },
  { id: "archOs", labelKey: "fleet.nodes.table.colArchOs", width: "120px", optional: true, defaultHidden: true },
  { id: "agentConfig", labelKey: "fleet.nodes.table.colAgentConfig", width: "150px", optional: true },
  { id: "cpu", labelKey: "fleet.nodes.metric.cpu", width: "84px", optional: true, sortKey: "cpu", defaultDir: "desc", defaultHidden: true },
  { id: "memory", labelKey: "fleet.nodes.metric.memory", width: "160px", optional: true, sortKey: "memory", defaultDir: "desc", defaultHidden: true },
  { id: "disk", labelKey: "fleet.nodes.metric.disk", width: "160px", optional: true, sortKey: "disk", defaultDir: "desc", defaultHidden: true },
  { id: "network", labelKey: "fleet.nodes.table.colNetwork", width: "192px", optional: true, sortKey: "network", defaultDir: "desc", defaultHidden: true },
  { id: "lastSeen", labelKey: "fleet.nodes.table.colLastSeen", width: "112px", optional: true, sortKey: "lastSeen", defaultDir: "desc", defaultHidden: true },
  { id: "update", labelKey: "fleet.nodes.table.colUpdate", width: "116px", optional: true, defaultHidden: true },
  // The Actions track is pinned to the card's right edge, the mirror of the
  // Node track, so the row's buttons stay on screen however far the table
  // overflows. A pinned track is a fixed width for the same reason the Node
  // one is: a flexible track that absorbed the card's spare width would pin
  // a wide empty surface, hairline and all, in the middle of the card. 116px
  // is the three 32px icon buttons with their two 4px gaps (104px) plus the
  // row's 12px right padding, which the pinned cell carries inside itself so
  // no transparent strip is left at the edge for a column to scroll through.
  // The spare width goes to a flexible data track instead (see gridTemplate).
  { id: "actions", labelKey: "fleet.nodes.table.colActions", width: "116px", optional: false },
];

/**
 * Columns hidden on a console that has never been told otherwise.
 *
 * The default set is budgeted to the card: it has to fit a 1440px display
 * with the sidebar collapsed (a 1276px scroller) without a horizontal scroll,
 * because a first view that scrolls is the complaint this table was rebuilt
 * over. What fits is identity and where to reach it: the node, its owner,
 * its tags, its public address, its status, what the agent is configured to
 * do, and the row actions. Hostname, role, the load metrics, last seen, arch
 * and update policy are one click away in the column manager, and the node
 * page holds all of them. The width test over this set is the budget's
 * guard; the metric tracks alone are 404px, which is why they are not here.
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

/**
 * The status column sorts in the ontology's display order: online first, then
 * degraded, offline, never reported, disabled. Descending puts the states that
 * want work at the top.
 */
function statusRank(node: Node): number {
  return NODE_STATUSES.indexOf(nodeStatus(node));
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

/**
 * Owners sort by the bracketed prefix; nodes without one go last in either
 * direction, so the unowned rows read as one block at the bottom rather than
 * as the alphabetically first owner. `sign` is the caller's direction: the
 * "last" answer is pre-multiplied by it so the flip the caller applies
 * afterwards cancels out.
 */
function compareOwner(a: Node, b: Node, sign: 1 | -1): number {
  const pa = splitNamePrefix(a).prefix;
  const pb = splitNamePrefix(b).prefix;
  if (!pa && !pb) return 0;
  if (!pa) return sign;
  if (!pb) return -sign;
  return pa.localeCompare(pb);
}

function lastSeenMillis(node: Node): number {
  const t = node.last_seen ? Date.parse(node.last_seen as unknown as string) : NaN;
  return Number.isNaN(t) ? 0 : t;
}

/** Ascending comparator for the given key; callers flip for desc, and pass
 *  the flip in so a key can keep its empty values last either way. */
function compareAsc(a: Node, b: Node, key: NodeSortKey, sign: 1 | -1): number {
  switch (key) {
    case "name":
      return (a.name || a.id).localeCompare(b.name || b.id);
    case "owner":
      return compareOwner(a, b, sign);
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
  const sign: 1 | -1 = state.dir === "desc" ? -1 : 1;
  return [...nodes].sort((a, b) => {
    const primary = compareAsc(a, b, key, sign) * sign;
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

/**
 * The Node column's width, from the longest name body in the rows.
 *
 * The name is how an operator tells two nodes apart, so it never truncates,
 * and the column is pinned while the rest of the row scrolls under it, so its
 * width has to be known rather than left to the grid. It follows the content:
 * the fixed chrome of the cell (the row's 12px left padding, the 8px status
 * dot, the 8px gap, the 12px right padding and the 1px hairline that ends the
 * pinned column) plus the widest name body on the page. The owner prefix is
 * not part of it any more; it has its own column.
 *
 * `measure` is the text measurer: the width of one name body at the cell's
 * font, 14px medium in the console's system face. The browser supplies a
 * canvas measurement (see `@/lib/textWidth`); without one, or under a CSP
 * that refuses a canvas context, the per-character estimate stands in
 * (Chrome on macOS draws "Akkocloud-UK-London-KVM" at 187px, 8.1px a
 * character; 8.3 leaves a little to spare).
 *
 * The band keeps a single absurd name from turning the whole table into a
 * scroll; past the cap the cell truncates (NodeTable's name class list), the
 * last resort rather than the mechanism.
 *
 * Pass every node on the page, not one group's rows: a grouped Nodes view
 * renders one table per group, and a width taken per group makes the Node
 * column jump between adjacent sections.
 */
export const NAME_TRACK_MIN_PX = 180;
export const NAME_TRACK_MAX_PX = 440;
const NAME_CHAR_PX = 8.3;
/** CJK and other full-width glyphs are square: one em at 14px. */
const WIDE_CHAR_PX = 14;
/** The row's left padding, carried inside the pinned cell so nothing scrolls
 *  through a transparent strip to its left. */
const CELL_PAD_LEFT_PX = 12;
/** Status dot, then the gap between it and the name. */
const DOT_PX = 8;
const GAP_PX = 8;
/** Room between the name and the hairline, and the hairline itself. */
const CELL_PAD_RIGHT_PX = 12;
const HAIRLINE_PX = 1;
/** Everything in the cell that is not the name. */
export const NAME_CELL_CHROME_PX = CELL_PAD_LEFT_PX + DOT_PX + GAP_PX + CELL_PAD_RIGHT_PX + HAIRLINE_PX;
/** The selection checkbox (16px) and its gap, inside the same pinned cell. */
export const SELECT_CELL_PX = 16 + 12;

export type NameMeasure = (body: string) => number;

/** The fallback measurer: a per-character estimate at 14px medium. */
export function estimateNameWidth(body: string): number {
  let px = 0;
  for (const ch of body) px += (ch.codePointAt(0) ?? 0) > 0x2e7f ? WIDE_CHAR_PX : NAME_CHAR_PX;
  return px;
}

export function nameTrackMin(
  nodes: readonly Pick<Node, "id" | "name">[],
  measure: NameMeasure = estimateNameWidth,
): number {
  let widest = 0;
  for (const node of nodes) {
    const px = measure(splitNamePrefix(node).body);
    if (px > widest) widest = px;
  }
  const track = widest > 0 ? Math.ceil(widest + NAME_CELL_CHROME_PX) : 0;
  return Math.min(NAME_TRACK_MAX_PX, Math.max(NAME_TRACK_MIN_PX, track));
}

/**
 * CSS grid-template-columns for the currently visible column set. The Node
 * track takes its width from the rows (see nameTrackMin) rather than the
 * catalog constant; with `selectable` the checkbox lives inside the same
 * pinned cell, so the track grows by the checkbox and its gap rather than
 * gaining a track of its own that the pinned surface would have to bridge.
 *
 * One track is always flexible. Both pinned tracks are fixed, so a visible
 * set with no `1fr` column of its own (hide Tags and Hostname and every
 * remaining track is a px value) would paint the table in the left part of
 * the card and leave the pinned Actions cell floating at the end of the
 * tracks rather than at the card's edge: sticky only ever pulls a cell back
 * inside the scroller, never out to its edge. The last data track before
 * Actions is promoted to `minmax(floor, 1fr)` in that case, so the spare
 * width lands between the last value and the buttons, where an empty stretch
 * reads as the end of the row, and the row spans the card whatever is hidden.
 */
export function gridTemplate(hidden: ReadonlySet<string>, nameMinPx = NAME_TRACK_MIN_PX, selectable = false): string {
  const namePx = nameMinPx + (selectable ? SELECT_CELL_PX : 0);
  const columns = visibleColumns(hidden);
  const flexible = columns.some((c) => c.width.includes("1fr"));
  const absorb = flexible ? -1 : columns.length - 2;
  return columns
    .map((c, i) => {
      if (c.id === "name") return `${namePx}px`;
      if (i === absorb && i > 0) return `minmax(${trackMinPx(c.width)}px,1fr)`;
      return c.width;
    })
    .join(" ");
}

/**
 * The px floor of a catalog track: the value of a fixed track, the minimum of
 * a `minmax(Npx, ...)` one. 0 for anything else, which the catalog does not
 * contain (the test over NODE_TABLE_COLUMNS keeps it that way).
 */
export function trackMinPx(width: string): number {
  const m = /^(?:minmax\(\s*)?(\d+(?:\.\d+)?)px/.exec(width);
  return m ? Number(m[1]) : 0;
}

/** The gap between tracks (Tailwind `gap-3`). */
const TRACK_GAP_PX = 12;

/**
 * The min-width of the grid for the visible column set: the sum of the track
 * floors and the gaps. The row has no padding of its own: the left padding
 * rides inside the pinned Node cell and the right padding inside the pinned
 * Actions cell, so both are already in the tracks. The grid element is as
 * wide as its scroller unless told otherwise, and then the tracks overflow
 * the grid box while the row's background and border stop at the scroller's
 * edge; the min-width makes the box follow the tracks, so the table scrolls
 * exactly when the tracks need more than the card offers and not before.
 */
export function tableMinWidthPx(hidden: ReadonlySet<string>, nameMinPx = NAME_TRACK_MIN_PX, selectable = false): number {
  const columns = visibleColumns(hidden);
  let px = 0;
  for (const column of columns) {
    px += column.id === "name" ? nameMinPx + (selectable ? SELECT_CELL_PX : 0) : trackMinPx(column.width);
  }
  return px + (columns.length - 1) * TRACK_GAP_PX;
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
