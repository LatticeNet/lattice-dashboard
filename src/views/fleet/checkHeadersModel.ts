/**
 * An http check's request headers in the editor (design 29 D1, D11).
 *
 * The server never returns a secret's value: a read carries
 * `{name, secret: true, set: true}`. So the editor never sends a read back.
 * It compares what the operator left in the rows with what was read and
 * sends one operation per name that changed: `set` for a new or changed
 * header, `delete` for a removed one, and nothing for a header left alone,
 * so an untouched secret is kept by the server as it is. A saved header's
 * name is fixed; renaming one is removing it and adding another, because a
 * secret has no value the console could carry to the new name.
 *
 * A new check (a replacement after the method, target or node changed)
 * starts without secrets: the console cannot carry what it never held, so a
 * saved secret must be entered again or removed before that save.
 *
 * Kept free of Vue so `node --test` covers it directly.
 */
import type { MonitorHeader, MonitorHeaderEdit } from "@/lib/api/types";

import {
  HEADERS_MAX,
  canonicalHeaderName,
  headerNameProblem,
  headerValueProblem,
  type HeaderNameProblem,
  type HeaderValueProblem,
} from "@/views/fleet/checkRulesModel";

export interface SavedHeader {
  name: string;
  /** A plain header's value; a secret's is never read. */
  value?: string;
  secret: boolean;
  /** The server holds a value for this secret. */
  set: boolean;
}

export interface HeaderRow {
  /** Stable within one editor session, for the list's keys and the fields' ids. */
  key: string;
  name: string;
  /** What the operator typed; empty for a saved secret that is not being replaced. */
  value: string;
  secret: boolean;
  /** The header as read, for a row that came from the check. */
  saved?: SavedHeader;
  /** A saved secret whose value the operator is replacing. */
  replacing: boolean;
}

export function rowsFromHeaders(headers: readonly MonitorHeader[] | undefined): HeaderRow[] {
  return (headers ?? []).map((h, i) => {
    const secret = !!h.secret;
    const saved: SavedHeader = { name: h.name, value: secret ? undefined : (h.value ?? ""), secret, set: secret ? h.set !== false : true };
    return { key: `saved-${i}`, name: h.name, value: secret ? "" : (h.value ?? ""), secret, saved, replacing: false };
  });
}

export function newHeaderRow(key: string): HeaderRow {
  return { key, name: "", value: "", secret: false, replacing: false };
}

/** A saved secret left as it is: the server keeps its value and nothing is sent for it. */
export function keptSecret(row: HeaderRow): boolean {
  return !!row.saved?.secret && row.saved.set && row.secret && !row.replacing;
}

/** Start replacing a saved secret's value: the field opens empty. */
export function startReplace(row: HeaderRow): HeaderRow {
  return { ...row, replacing: true, value: "" };
}

/** Keep the saved secret after all. */
export function keepCurrent(row: HeaderRow): HeaderRow {
  return row.saved?.secret ? { ...row, replacing: false, value: "", secret: true } : row;
}

/**
 * Turn the secret switch. A plain header's value moves with it. A saved
 * secret turned plain needs its value typed again, since the console never
 * held it, so the row opens for a new value.
 */
export function setSecret(row: HeaderRow, secret: boolean): HeaderRow {
  if (secret === row.secret) return row;
  if (!secret && row.saved?.secret && !row.replacing) return { ...row, secret, replacing: true, value: "" };
  return { ...row, secret };
}

export type HeaderRowProblem = HeaderNameProblem | HeaderValueProblem | "nameDuplicate" | "valueRequired" | "secretNotCarried";
export type HeadersProblem = "tooMany" | "secretsNeedHttps";

export interface HeaderProblems {
  rows: Record<string, HeaderRowProblem[]>;
  list: HeadersProblem[];
  /** Whether anything blocks a save. */
  any: boolean;
}

/**
 * What blocks a save, per row and for the list: the server's name and value
 * rules, names unique without regard to case, at most eight, and secrets only
 * over https. With `newCheck`, a kept secret cannot be carried and must be
 * entered again.
 */
export function headerProblems(rows: readonly HeaderRow[], options: { https: boolean; newCheck: boolean }): HeaderProblems {
  const out: HeaderProblems = { rows: {}, list: [], any: false };
  const seen = new Map<string, number>();
  for (const row of rows) {
    const c = canonicalHeaderName(row.name).toLowerCase();
    if (c) seen.set(c, (seen.get(c) ?? 0) + 1);
  }
  for (const row of rows) {
    const problems: HeaderRowProblem[] = [];
    const name = headerNameProblem(row.name);
    if (name) problems.push(name);
    else if ((seen.get(canonicalHeaderName(row.name).toLowerCase()) ?? 0) > 1) problems.push("nameDuplicate");
    if (keptSecret(row)) {
      // Over http no secret can be sent at all; the list's secretsNeedHttps is the one instruction then.
      if (options.newCheck && options.https) problems.push("secretNotCarried");
    } else if (!row.value) {
      problems.push("valueRequired");
    } else {
      const value = headerValueProblem(row.value);
      if (value) problems.push(value);
    }
    if (problems.length) {
      out.rows[row.key] = problems;
      out.any = true;
    }
  }
  if (rows.length > HEADERS_MAX) out.list.push("tooMany");
  if (!options.https && rows.some((r) => r.secret)) out.list.push("secretsNeedHttps");
  if (out.list.length) out.any = true;
  return out;
}

/**
 * The operations an edit sends: one per name that changed, none for a header
 * left alone. Undefined when nothing changed, so the edit leaves the headers
 * as they are.
 */
export function buildHeaderEdits(saved: readonly MonitorHeader[] | undefined, rows: readonly HeaderRow[]): MonitorHeaderEdit[] | undefined {
  const before = new Map<string, MonitorHeader>();
  for (const h of saved ?? []) before.set(canonicalHeaderName(h.name).toLowerCase(), h);
  const after = new Set(rows.map((r) => canonicalHeaderName(r.name).toLowerCase()));
  const ops: MonitorHeaderEdit[] = [];
  for (const [key, h] of before) if (!after.has(key)) ops.push({ name: h.name, op: "delete" });
  for (const row of rows) {
    const prev = before.get(canonicalHeaderName(row.name).toLowerCase());
    if (prev && keptSecret(row) && prev.secret) continue;
    if (prev && !prev.secret && !row.secret && (prev.value ?? "") === row.value) continue;
    const op: MonitorHeaderEdit = { name: row.name.trim(), op: "set", value: row.value };
    if (row.secret) op.secret = true;
    ops.push(op);
  }
  return ops.length ? ops : undefined;
}

/** The headers a new check is created with: every row with its typed value. */
export function headersForCreate(rows: readonly HeaderRow[]): MonitorHeader[] | undefined {
  const out = rows.map((r) => (r.secret ? { name: r.name.trim(), value: r.value, secret: true } : { name: r.name.trim(), value: r.value }));
  return out.length ? out : undefined;
}

/** What the check sheet shows for a header: a plain value, or that a secret is set. */
export function headerShown(h: MonitorHeader): { name: string; value?: string; secret: boolean } {
  return h.secret ? { name: h.name, secret: true } : { name: h.name, value: h.value ?? "", secret: false };
}
