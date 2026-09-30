/**
 * Pure model for a table whose rows fall into groups (design 23, section 3.7;
 * design 22, section 2, rule 3).
 *
 * A group row spans the table and carries what spans the group (a count, how
 * many are online, what the group costs a month). The member rows keep their
 * own columns; nothing about the group is printed on them.
 *
 * The table sorts first and groups second, so a column sort orders the rows
 * inside each group and never scatters a group across the table. Groups keep
 * the order the page asks for, then the order their first row appears in.
 *
 * Kept free of Vue so `node --test` covers it directly.
 */

export interface RowGroup<T> {
  key: string;
  rows: T[];
}

/**
 * Bucket rows by key. Rows keep their order inside a group. Keys named in
 * `order` come first, in that order; every other key follows in the order its
 * first row appears. A key in `order` with no rows is left out.
 */
export function groupRows<T>(rows: readonly T[], keyOf: (row: T) => string, order: readonly string[] = []): RowGroup<T>[] {
  const byKey = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const bucket = byKey.get(key);
    if (bucket) bucket.push(row);
    else byKey.set(key, [row]);
  }
  const out: RowGroup<T>[] = [];
  const placed = new Set<string>();
  for (const key of order) {
    const bucket = byKey.get(key);
    if (!bucket || placed.has(key)) continue;
    out.push({ key, rows: bucket });
    placed.add(key);
  }
  for (const [key, bucket] of byKey) {
    if (!placed.has(key)) out.push({ key, rows: bucket });
  }
  return out;
}

export type GroupedEntry<T> =
  | { kind: "group"; key: string; group: RowGroup<T>; collapsed: boolean }
  | { kind: "row"; key: string; row: T };

/**
 * What the table body renders for one page of rows: a group row before the
 * first row of each group on the page, then the rows of groups that are not
 * collapsed. The group row carries the whole group (every row the filter
 * kept, not only this page's), so its totals do not change with the page.
 *
 * `rowKeyOf` keys the entries; group rows are keyed apart from rows so a
 * group named like a row id cannot collide with it.
 */
export function groupedEntries<T>(
  pageRows: readonly T[],
  groups: readonly RowGroup<T>[],
  keyOf: (row: T) => string,
  rowKeyOf: (row: T) => string,
  collapsed: ReadonlySet<string>,
): GroupedEntry<T>[] {
  const byKey = new Map(groups.map((group) => [group.key, group]));
  const out: GroupedEntry<T>[] = [];
  let current: string | undefined;
  for (const row of pageRows) {
    const key = keyOf(row);
    if (key !== current) {
      current = key;
      const group = byKey.get(key) ?? { key, rows: [row] };
      out.push({ kind: "group", key: `group:${key}`, group, collapsed: collapsed.has(key) });
    }
    if (!collapsed.has(key)) out.push({ kind: "row", key: `row:${rowKeyOf(row)}`, row });
  }
  return out;
}

/** Flip one group between collapsed and open. */
export function toggleGroup(collapsed: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(collapsed);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}
