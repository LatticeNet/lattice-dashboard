/**
 * Pure model for the object a collection has open in its side sheet
 * (design 23, section 3.5; design 22, section 2, rule 5).
 *
 * The open object lives in the address (`?open=<id>` by default), so a
 * reload, a pasted link and the back button all land on the same object.
 * Opening and closing replace the history entry rather than pushing one: a
 * sheet is a look at a row, and Back should leave the page, not step through
 * every row the operator peeked at.
 *
 * Kept free of Vue so `node --test` covers it directly.
 */
import type { QueryRecord, QueryValue } from "@/components/common/tableUrlState";

export const OPEN_PARAM = "open";

/** The id a query has open, or null. Whitespace and empty values mean closed. */
export function readOpenId(query: QueryRecord, param: string = OPEN_PARAM): string | null {
  const raw = query[param];
  const value = Array.isArray(raw) ? raw.find((entry) => typeof entry === "string") : raw;
  const id = typeof value === "string" ? value.trim() : "";
  return id === "" ? null : id;
}

/** Put an id in the query, or take it out with null. Every other key is kept. */
export function writeOpenId(query: QueryRecord, param: string, id: string | null): Record<string, QueryValue> {
  const next: Record<string, QueryValue> = {};
  for (const [key, value] of Object.entries(query)) {
    if (key === param || value === undefined) continue;
    next[key] = value;
  }
  const trimmed = id?.trim() ?? "";
  if (trimmed) next[param] = trimmed;
  return next;
}

/**
 * A selector for the row a sheet was opened from, so focus can go back to it
 * after a reload (when the element that was clicked no longer exists). Rows
 * carry `data-row-key`; the id is escaped for an attribute selector.
 */
export function rowSelector(id: string): string {
  return `[data-row-key="${id.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]`;
}
