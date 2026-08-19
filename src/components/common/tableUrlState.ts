/**
 * Pure model for mirroring a DataTable's view state into the route query.
 *
 * A table's search, expression filter, sort and page were component-local, so
 * a filtered list could not be linked, survived neither a reload nor a
 * back-navigation, and had to be rebuilt by hand every time. AuditView already
 * proved the pattern by hand; this is the same idea made reusable so any table
 * can opt in with one `state-key` prop.
 *
 * Kept free of Vue so `node --test` covers it directly (house *Model.ts
 * pattern). The Vue side lives in DataTable.vue and does nothing but call
 * these functions.
 */

/** Query values as vue-router hands them over. */
export type QueryValue = string | null | (string | null)[];
export type QueryRecord = Record<string, QueryValue | undefined>;

export type TableSortDir = "asc" | "desc";

/** The whole of a table's linkable view state. */
export interface TableUrlState {
  /** Free-text search box. */
  q: string;
  /** Expression filter box. */
  expr: string;
  /** Sorted column key; "" when unsorted. */
  sort: string;
  /** Sort direction; null when unsorted. */
  dir: TableSortDir | null;
  /** 1-based page number. */
  page: number;
}

/** The state a table is in before the operator touches anything. */
export const DEFAULT_TABLE_URL_STATE: TableUrlState = { q: "", expr: "", sort: "", dir: null, page: 1 };

/**
 * Query parameter names for one table.
 *
 * Namespaced by the state key because a route can hold more than one table,
 * and because a view may already own bare `q` / `page` for its own
 * server-side filters (AuditView does). A dot separator survives
 * encodeURIComponent untouched, so the URL stays readable.
 */
export function tableStateParams(stateKey: string): Record<keyof TableUrlState, string> {
  const prefix = stateKey ? `${stateKey}.` : "";
  return { q: `${prefix}q`, expr: `${prefix}expr`, sort: `${prefix}sort`, dir: `${prefix}dir`, page: `${prefix}page` };
}

/** First usable string for a query key; vue-router may hand over an array. */
function readParam(query: QueryRecord, key: string): string {
  const raw = query[key];
  const value = Array.isArray(raw) ? raw.find((entry) => typeof entry === "string") : raw;
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Read a table's state out of a route query.
 *
 * Every field is validated rather than trusted: a sort key that is not a
 * sortable column, a direction that is not asc/desc, or a page that is not a
 * positive integer all fall back to the default. A hand-edited or stale URL
 * therefore renders a correct table rather than an empty or mis-sorted one.
 */
export function readTableUrlState(
  query: QueryRecord,
  stateKey: string,
  sortableKeys: readonly string[] = [],
): TableUrlState {
  const params = tableStateParams(stateKey);
  const state: TableUrlState = { ...DEFAULT_TABLE_URL_STATE };

  state.q = readParam(query, params.q);
  state.expr = readParam(query, params.expr);

  const sort = readParam(query, params.sort);
  if (sort && sortableKeys.includes(sort)) {
    state.sort = sort;
    const dir = readParam(query, params.dir).toLowerCase();
    state.dir = dir === "desc" ? "desc" : "asc";
  }

  const page = Number(readParam(query, params.page));
  if (Number.isInteger(page) && page >= 1) state.page = page;

  return state;
}

/**
 * Merge a table's state into an existing route query.
 *
 * Returns a new object: keys owned by this table are set when they differ
 * from the default and deleted when they do not, and every other key on the
 * query is carried through untouched so a table never clobbers a sibling
 * table or the view's own filters.
 */
export function writeTableUrlState(
  query: QueryRecord,
  stateKey: string,
  state: TableUrlState,
): Record<string, QueryValue> {
  const params = tableStateParams(stateKey);
  const owned = new Set(Object.values(params));
  const next: Record<string, QueryValue> = {};

  for (const [key, value] of Object.entries(query)) {
    if (owned.has(key) || value === undefined) continue;
    next[key] = value;
  }

  if (state.q) next[params.q] = state.q;
  if (state.expr) next[params.expr] = state.expr;
  if (state.sort && state.dir) {
    next[params.sort] = state.sort;
    next[params.dir] = state.dir;
  }
  if (state.page > 1) next[params.page] = String(state.page);

  return next;
}

/** True when two states would produce the same query. Guards redundant navigations. */
export function tableUrlStatesEqual(a: TableUrlState, b: TableUrlState): boolean {
  return a.q === b.q && a.expr === b.expr && a.sort === b.sort && a.dir === b.dir && a.page === b.page;
}

/** True when the operator has narrowed or moved the table away from its default view. */
export function isDefaultTableUrlState(state: TableUrlState): boolean {
  return tableUrlStatesEqual(state, DEFAULT_TABLE_URL_STATE);
}
