/**
 * URL persistence for a table's own view state.
 *
 * A list that keeps its search, filter, sort and page in component memory is a
 * list you cannot send to anyone and cannot get back after a reload. The names
 * are prefixed per table so two tables on one page do not overwrite each other,
 * and only non-default values are written so an untouched table leaves the URL
 * exactly as it found it.
 *
 * Pure and DOM-free on purpose: this is the part worth pinning with tests.
 */

export type SortDirection = "asc" | "desc" | null;

export interface TableViewState {
  search: string;
  expression: string;
  sortKey: string | null;
  sortDir: SortDirection;
  page: number;
}

export const EMPTY_TABLE_STATE: TableViewState = {
  search: "",
  expression: "",
  sortKey: null,
  sortDir: null,
  page: 1,
};

/** Query parameter names this table owns, all prefixed by its key. */
export function tableStateParams(stateKey: string) {
  return {
    search: `${stateKey}_q`,
    expression: `${stateKey}_f`,
    sortKey: `${stateKey}_sort`,
    sortDir: `${stateKey}_dir`,
    page: `${stateKey}_page`,
  } as const;
}

function firstString(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return "";
}

/**
 * Read this table's state out of a query bag.
 *
 * Everything is validated rather than trusted: a URL is user input, and a sort
 * on a column that no longer exists, or a page of "-3", must degrade to the
 * default instead of rendering an empty table the operator cannot explain.
 */
export function readTableState(
  query: Record<string, unknown>,
  stateKey: string,
  sortableKeys: readonly string[],
): TableViewState {
  const names = tableStateParams(stateKey);
  const sortKeyRaw = firstString(query[names.sortKey]);
  const sortDirRaw = firstString(query[names.sortDir]);
  const sortKey = sortableKeys.includes(sortKeyRaw) ? sortKeyRaw : null;
  const sortDir: SortDirection =
    sortKey && (sortDirRaw === "asc" || sortDirRaw === "desc") ? sortDirRaw : null;

  const pageRaw = Number(firstString(query[names.page]));
  const page = Number.isFinite(pageRaw) && pageRaw >= 1 ? Math.floor(pageRaw) : 1;

  return {
    search: firstString(query[names.search]),
    expression: firstString(query[names.expression]),
    // A key without a usable direction is not a sort.
    sortKey: sortDir ? sortKey : null,
    sortDir,
    page,
  };
}

/**
 * Merge this table's state back into a query bag, dropping defaults.
 *
 * Returns a new object; the caller decides whether the result differs enough to
 * be worth a navigation.
 */
export function writeTableState(
  query: Record<string, unknown>,
  stateKey: string,
  state: TableViewState,
): Record<string, unknown> {
  const names = tableStateParams(stateKey);
  const next: Record<string, unknown> = { ...query };

  const set = (name: string, value: string) => {
    if (value) next[name] = value;
    else delete next[name];
  };

  set(names.search, state.search.trim());
  set(names.expression, state.expression.trim());
  set(names.sortKey, state.sortDir && state.sortKey ? state.sortKey : "");
  set(names.sortDir, state.sortDir ?? "");
  set(names.page, state.page > 1 ? String(state.page) : "");

  return next;
}

/** Whether two query bags differ, so an unchanged table never navigates. */
export function queryChanged(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (firstString(a[key]) !== firstString(b[key])) return true;
  }
  return false;
}
