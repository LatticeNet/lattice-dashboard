/**
 * Small pure rules the chassis components share (design 23, sections 3.3,
 * 3.6, 3.7 and 3.8). Each is a sentence of the design turned into a function
 * so it has a test, and so a page cannot quietly do it another way.
 *
 * Kept free of Vue so `node --test` covers it directly.
 */

/* ------------------------------------------------------------------ */
/* MetricStrip (3.3)                                                   */
/* ------------------------------------------------------------------ */

/** A page head shows at most this many numbers. */
export const METRIC_CAP = 4;

/**
 * The development warning for a strip over the cap, or "" when it fits. It is
 * a warning, not a refusal: the pages that break the cap today move in wave 2,
 * and a console that stopped rendering their numbers would be worse.
 */
export function metricCapWarning(count: number, where = "MetricStrip"): string {
  if (count <= METRIC_CAP) return "";
  return `${where}: ${count} numbers in one strip; a page head shows at most ${METRIC_CAP} (design 23, 3.3).`;
}

/* ------------------------------------------------------------------ */
/* RowMenu (3.6)                                                       */
/* ------------------------------------------------------------------ */

export interface RowMenuEntry {
  key: string;
  danger?: boolean;
  hidden?: boolean;
}

/**
 * Items in menu order: the ordinary ones as given, then the dangerous ones
 * last, after a separator. Hidden items (no scope for them) are dropped
 * rather than shown disabled without a reason.
 */
export function rowMenuSections<T extends RowMenuEntry>(items: readonly T[]): { safe: T[]; danger: T[] } {
  const visible = items.filter((item) => !item.hidden);
  return {
    safe: visible.filter((item) => !item.danger),
    danger: visible.filter((item) => item.danger),
  };
}

/* ------------------------------------------------------------------ */
/* DataTable (3.7)                                                     */
/* ------------------------------------------------------------------ */

export interface ToolbarInput {
  /** Rows the table was given, before its own search. */
  rowCount: number;
  /** Whether the table's own search or expression field holds anything. */
  filterActive: boolean;
}

/**
 * Whether the table draws its toolbar. With no rows and no filter there is
 * nothing to search: the search box, the expression field and its help line
 * above "No resolvers registered" only pushed the empty state's own action
 * down. A filter that emptied the table keeps the toolbar, so it can be
 * cleared.
 */
export function tableToolbarVisible(input: ToolbarInput): boolean {
  return input.rowCount > 0 || input.filterActive;
}

/** Column keys that pin to the table's end in the scroll layout. */
export const PINNED_END_KEYS: readonly string[] = ["actions"];

/* ------------------------------------------------------------------ */
/* ConfirmDialog (3.8)                                                 */
/* ------------------------------------------------------------------ */

/**
 * Whether what the operator typed names the object. Exact after trimming the
 * ends: a name is an identifier, and "Docs" is not "docs".
 */
export function typedConfirmMatches(typed: string, expected: string | undefined): boolean {
  if (expected === undefined) return true;
  const want = expected.trim();
  return want !== "" && typed.trim() === want;
}

/** The destructive classes of section 3.8, by what breaks. */
export type DestructiveClass = "reversible" | "internal" | "outside" | "node-config";

/**
 * What a class requires of its dialog. `outside` and `node-config` both ask
 * for the typed name; every class but `reversible` is drawn destructive and
 * states its impact.
 */
export function destructiveTreatment(kind: DestructiveClass): { destructive: boolean; impact: boolean; typed: boolean } {
  switch (kind) {
    case "reversible":
      return { destructive: false, impact: false, typed: false };
    case "internal":
      return { destructive: true, impact: true, typed: false };
    case "outside":
    case "node-config":
      return { destructive: true, impact: true, typed: true };
  }
}

/* ------------------------------------------------------------------ */
/* NodeLabel (3.10)                                                    */
/* ------------------------------------------------------------------ */

export interface NodeRef {
  id: string;
  name?: string;
}

export interface NodeDisplay {
  text: string;
  /** False when the id is not in the node list the page read. */
  known: boolean;
}

/**
 * A node's name, or a shortened id marked unknown when the page does not
 * have it (a deleted node, a list that failed to load). Never the raw
 * `node_...` id in full where a name exists.
 */
export function nodeDisplay(id: string, nodes: readonly NodeRef[] | undefined): NodeDisplay {
  if (!id) return { text: "", known: false };
  const node = nodes?.find((entry) => entry.id === id);
  if (node?.name) return { text: node.name, known: true };
  return { text: id.length > 12 ? id.slice(0, 12) : id, known: !!node };
}
