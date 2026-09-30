/**
 * The one query grammar (design 23, sections 2 and 3.9).
 *
 * A query field speaks in `key:value` tokens plus bare flags and free text.
 * Keys are declared per page in a grammar; each key maps to one URL parameter
 * and, by the same name, one HTTP parameter, so a URL is one API call and the
 * field is a rendering of the URL rather than a second copy of the filter.
 *
 * Lifted from the Evidence Explore field, whose rules this keeps:
 *
 * - Double quotes group a value with spaces (`dest:"a b"`); inside quotes
 *   `\"` and `\\` stand for a quote and a backslash; an unclosed quote runs
 *   to the end instead of failing.
 * - A word is a token only when the text before its first colon is a declared
 *   key and that colon was typed outside quotes, so `example.com:443`, an
 *   IPv6 address and `"node:x"` stay free text.
 * - A quoted word is never a flag: `"open"` searches for the word. `is:open`
 *   reads the same as `open`.
 * - Names in, identifiers out: a resolver turns `node:legend-sg` into the node
 *   id. A value no resolver knows is kept as typed (it may be an id) and
 *   reported, never dropped. Formatting names what it can, so parsing the
 *   field back with the same resolvers yields the same query.
 * - Enumerated values are lowercased, checked, and written in the grammar's
 *   order, so parse and format are idempotent.
 *
 * Kept free of Vue so `node --test` covers it directly.
 */

export type TokenKind =
  /** A comma list; each member goes through the resolver. */
  | "list"
  /** One value, kept whole (commas included); resolved when a resolver exists. */
  | "value"
  /** A comma list of known values, lowercased. */
  | "enum";

export interface TokenField {
  /** The key as typed before the colon. */
  key: string;
  kind: TokenKind;
  /** Known values, in canonical order, for `enum`. */
  values?: readonly string[];
  /** Which resolver turns names into identifiers and back. */
  resolve?: string;
  /** The URL and HTTP parameter this token writes; defaults to the key. */
  param?: string;
}

export interface TokenFlag {
  /** The bare word: `stalled`. */
  name: string;
  /** The URL and HTTP parameter the flag sets to "1"; defaults to the name. */
  param?: string;
}

export interface TokenGrammar {
  /** Fields in the order the field writes them back. */
  fields: readonly TokenField[];
  flags: readonly TokenFlag[];
  /** Parameter for free text; defaults to `q`. */
  textParam?: string;
}

export interface TokenResolver {
  /** Name or id in, id out; undefined when the value names nothing known. */
  toId?: (value: string) => string | undefined;
  /** Id in, the name an operator would type out. */
  label?: (id: string) => string;
}

export type TokenResolvers = Record<string, TokenResolver | undefined>;

export type TokenProblemKind = "empty-value" | "unknown-value" | "unresolved";

export interface TokenProblem {
  /** The word as typed. */
  token: string;
  kind: TokenProblemKind;
}

/** A parsed field: identifiers, not names. */
export interface TokenValues {
  /** `list` and `value` fields, lists joined with commas. Absent when unset. */
  values: Record<string, string>;
  /** `enum` fields in canonical order. Absent when unset. */
  enums: Record<string, string[]>;
  /** Flags that are on, in grammar order. */
  flags: string[];
  text: string;
}

export interface ParsedTokens extends TokenValues {
  problems: TokenProblem[];
}

export const EMPTY_TOKEN_VALUES: TokenValues = Object.freeze({ values: {}, enums: {}, flags: [], text: "" }) as TokenValues;

/* ------------------------------------------------------------------ */
/* Scanning                                                            */
/* ------------------------------------------------------------------ */

/** One word of the field, and how much of it was typed outside quotes. */
export interface QueryWord {
  word: string;
  /**
   * Characters of `word` before the first quoted segment; the whole length
   * when nothing was quoted. A key only counts when its colon falls in this
   * prefix, so `"node:x"` is text and `dest:"a b"` is a token.
   */
  bare: number;
}

/** Split the field into words, honouring quotes and escapes. */
export function scanQueryWords(input: string): QueryWord[] {
  const words: QueryWord[] = [];
  let current = "";
  let bare = -1;
  let quoted = false;
  let started = false;
  let escaped = false;
  const close = () => {
    if (started && current !== "") words.push({ word: current, bare: bare < 0 ? current.length : bare });
    current = "";
    bare = -1;
    started = false;
  };
  for (const ch of input) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (quoted && ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      if (!quoted && bare < 0) bare = current.length;
      quoted = !quoted;
      started = true;
      continue;
    }
    if (!quoted && /\s/.test(ch)) {
      close();
      continue;
    }
    current += ch;
    started = true;
  }
  close();
  return words;
}

/** Comma list members, trimmed, empties dropped. */
export function splitTokenList(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function fieldFor(grammar: TokenGrammar, key: string): TokenField | undefined {
  return grammar.fields.find((field) => field.key === key);
}

/** The flag a bare word switches on, or "". */
export function tokenFlagOf(word: string, grammar: TokenGrammar): string {
  const lower = word.toLowerCase();
  const name = lower.startsWith("is:") ? lower.slice(3) : lower;
  return grammar.flags.some((flag) => flag.name === name) ? name : "";
}

/* ------------------------------------------------------------------ */
/* Parsing                                                             */
/* ------------------------------------------------------------------ */

/**
 * Read the field. Unknown enum values are reported and left out, because the
 * server would reject them and a filter nobody can satisfy reads as a quiet
 * system. A later token for the same key replaces an earlier one, except
 * enums, which add up.
 */
export function parseTokens(input: string, grammar: TokenGrammar, resolvers: TokenResolvers = {}): ParsedTokens {
  const values: Record<string, string> = {};
  const enumSets = new Map<string, Set<string>>();
  const flags = new Set<string>();
  const problems: TokenProblem[] = [];
  const text: string[] = [];

  for (const { word, bare } of scanQueryWords(input)) {
    const flag = bare === word.length ? tokenFlagOf(word, grammar) : "";
    if (flag) {
      flags.add(flag);
      continue;
    }
    const colon = word.indexOf(":");
    const key = colon > 0 && colon < bare ? word.slice(0, colon).toLowerCase() : "";
    const field = key ? fieldFor(grammar, key) : undefined;
    if (!field) {
      text.push(word);
      continue;
    }
    const value = word.slice(colon + 1).trim();
    if (!value) {
      problems.push({ token: word, kind: "empty-value" });
      continue;
    }
    const resolver = field.resolve ? resolvers[field.resolve] : undefined;
    const resolveOne = (part: string): string => {
      const id = resolver?.toId?.(part);
      if (resolver?.toId && id === undefined) problems.push({ token: word, kind: "unresolved" });
      return id ?? part;
    };
    switch (field.kind) {
      case "list":
        values[field.key] = splitTokenList(value).map(resolveOne).join(",");
        break;
      case "value":
        values[field.key] = resolveOne(value);
        break;
      case "enum": {
        const known = field.values ?? [];
        const set = enumSets.get(field.key) ?? new Set<string>();
        for (const part of splitTokenList(value.toLowerCase())) {
          if (known.includes(part)) set.add(part);
          else problems.push({ token: word, kind: "unknown-value" });
        }
        enumSets.set(field.key, set);
        break;
      }
    }
  }

  const enums: Record<string, string[]> = {};
  for (const field of grammar.fields) {
    const set = enumSets.get(field.key);
    if (field.kind === "enum" && set && set.size) enums[field.key] = (field.values ?? []).filter((v) => set.has(v));
  }
  return {
    values,
    enums,
    flags: grammar.flags.map((flag) => flag.name).filter((name) => flags.has(name)),
    text: text.join(" "),
    problems,
  };
}

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

/** A value in quotes, escaped so the scanner reads it back unchanged. */
export function wrapTokenValue(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Quote a value only when it needs it. */
export function quoteTokenValue(value: string): string {
  return value !== "" && !/[\s"\\]/.test(value) ? value : wrapTokenValue(value);
}

/**
 * Free text back into the field. A word that would read as a token or a flag
 * (`node:x`, `open`) is quoted, so text stays text on the next parse.
 */
export function formatTokenText(text: string, grammar: TokenGrammar): string {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => {
      const colon = word.indexOf(":");
      const keyLike = colon > 0 && !!fieldFor(grammar, word.slice(0, colon).toLowerCase());
      return keyLike || tokenFlagOf(word, grammar) || /["\\]/.test(word) ? wrapTokenValue(word) : word;
    })
    .join(" ");
}

/** Write the field, naming identifiers where a resolver can. */
export function formatTokens(parsed: TokenValues, grammar: TokenGrammar, resolvers: TokenResolvers = {}): string {
  const parts: string[] = [];
  for (const field of grammar.fields) {
    const label = field.resolve ? resolvers[field.resolve]?.label : undefined;
    if (field.kind === "enum") {
      const list = parsed.enums[field.key];
      if (list?.length) parts.push(`${field.key}:${list.join(",")}`);
      continue;
    }
    const value = parsed.values[field.key];
    if (!value) continue;
    const shown =
      field.kind === "list"
        ? splitTokenList(value)
            .map((id) => label?.(id) || id)
            .join(",")
        : label?.(value) || value;
    parts.push(`${field.key}:${quoteTokenValue(shown)}`);
  }
  for (const flag of grammar.flags) if (parsed.flags.includes(flag.name)) parts.push(flag.name);
  if (parsed.text) parts.push(formatTokenText(parsed.text, grammar));
  return parts.join(" ");
}

/* ------------------------------------------------------------------ */
/* The address bar                                                     */
/* ------------------------------------------------------------------ */

type QueryValue = string | null | (string | null)[];
type QueryRecord = Record<string, QueryValue | undefined>;

function readParam(query: QueryRecord, key: string): string {
  const raw = query[key];
  const value = Array.isArray(raw) ? raw.find((entry) => typeof entry === "string") : raw;
  return typeof value === "string" ? value.trim() : "";
}

function paramOf(field: TokenField): string {
  return field.param ?? field.key;
}

function flagParam(flag: TokenFlag): string {
  return flag.param ?? flag.name;
}

/** Every parameter a grammar owns, so a writer can clear them. */
export function tokenParams(grammar: TokenGrammar): string[] {
  return [
    ...grammar.fields.map(paramOf),
    ...grammar.flags.map(flagParam),
    grammar.textParam ?? "q",
  ];
}

/**
 * The field's state as the address bar holds it. Enum values the grammar does
 * not know are dropped here too, so a hand-edited URL cannot send the server
 * a value it would reject.
 */
export function readTokenQuery(query: QueryRecord, grammar: TokenGrammar): TokenValues {
  const values: Record<string, string> = {};
  const enums: Record<string, string[]> = {};
  for (const field of grammar.fields) {
    const raw = readParam(query, paramOf(field));
    if (!raw) continue;
    if (field.kind === "enum") {
      const set = new Set(splitTokenList(raw.toLowerCase()));
      const list = (field.values ?? []).filter((v) => set.has(v));
      if (list.length) enums[field.key] = list;
    } else if (field.kind === "list") {
      values[field.key] = splitTokenList(raw).join(",");
    } else {
      values[field.key] = raw;
    }
  }
  const flags = grammar.flags
    .filter((flag) => {
      const raw = readParam(query, flagParam(flag)).toLowerCase();
      return raw === "1" || raw === "true";
    })
    .map((flag) => flag.name);
  return { values, enums, flags, text: readParam(query, grammar.textParam ?? "q") };
}

/** Put the field's state into a query, keeping every key the grammar does not own. */
export function writeTokenQuery(
  query: QueryRecord,
  grammar: TokenGrammar,
  parsed: TokenValues,
): Record<string, QueryValue> {
  const owned = new Set(tokenParams(grammar));
  const next: Record<string, QueryValue> = {};
  for (const [key, value] of Object.entries(query)) {
    if (owned.has(key) || value === undefined) continue;
    next[key] = value;
  }
  for (const field of grammar.fields) {
    if (field.kind === "enum") {
      const list = parsed.enums[field.key];
      if (list?.length) next[paramOf(field)] = list.join(",");
    } else if (parsed.values[field.key]) {
      next[paramOf(field)] = parsed.values[field.key]!;
    }
  }
  for (const flag of grammar.flags) if (parsed.flags.includes(flag.name)) next[flagParam(flag)] = "1";
  if (parsed.text) next[grammar.textParam ?? "q"] = parsed.text;
  return next;
}

/** How many filters are set, for the Filters button's count. Free text is not a filter. */
export function tokenFilterCount(parsed: TokenValues, grammar: TokenGrammar, keys?: readonly string[]): number {
  let count = 0;
  for (const field of grammar.fields) {
    if (keys && !keys.includes(field.key)) continue;
    if (field.kind === "enum") count += parsed.enums[field.key]?.length ?? 0;
    else if (parsed.values[field.key]) count += 1;
  }
  for (const flag of grammar.flags) {
    if (keys && !keys.includes(flag.name)) continue;
    if (parsed.flags.includes(flag.name)) count += 1;
  }
  return count;
}
