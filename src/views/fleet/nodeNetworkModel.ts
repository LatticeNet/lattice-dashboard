/**
 * The node's effective network (design 32 D4), shaped for the node page's
 * Network section, the node sheet's summary and Show rules. The server
 * composes and scopes it; this module only orders and compares what it sent.
 *
 * Pure TS, so `node --test` covers it directly.
 */
import type {
  NodeNetworkOwner,
  NodeNetworkOutbound,
  NodeNetworkPolicy,
  NodeNetworkPort,
  NodeNetworkTable,
  NodeNetworkView,
} from "@/lib/api/types";

/** The policies that put rules on the node now, in the order they merge. */
export function applyingPolicies(outbound: NodeNetworkOutbound): NodeNetworkPolicy[] {
  return (outbound.policies ?? []).filter((policy) => policy.state === "applies");
}

/**
 * What a table asks of the operator: replan when its writer would compile
 * something else now than what was last applied; orphan when nothing
 * composes it any more yet the rules last applied are still in force; drift
 * when the node's own table differs from what was applied; nothing
 * otherwise. Replan comes first: a re-plan is what clears drift too.
 */
export function tableAttention(table: NodeNetworkTable): "replan" | "orphan" | "drift" | undefined {
  if (table.state !== "ok") return undefined;
  if (table.replan_pending) return "replan";
  if (table.compile_now?.state === "none" && table.last_applied?.state === "ok") return "orphan";
  if (table.drift_state === "drift") return "drift";
  return undefined;
}

/** Both columns read and hold the same ruleset. */
export function tableInSync(table: NodeNetworkTable): boolean {
  const now = table.compile_now;
  const applied = table.last_applied;
  return table.state === "ok" && now?.state === "ok" && applied?.state === "ok" && !!now.sha256 && now.sha256 === applied.sha256;
}

/**
 * Why the Inbound row's head is not the whole truth: lattice_guard on the
 * node is not what its writer would compile now. "overridden" when another
 * composer wrote it last (the legacy firewall route rebuilt a table NetGuard
 * manages), "replan" when its own writer would compile something else, and
 * "drift" when the node changed it.
 */
export function guardAttention(view: NodeNetworkView): { kind: "overridden" | "replan" | "drift"; table: NodeNetworkTable } | undefined {
  if (view.inbound.state !== "ok") return undefined;
  const table = view.tables.find((entry) => entry.table === "inet lattice_guard");
  if (!table) return undefined;
  const attention = tableAttention(table);
  if (attention === "drift") return { kind: "drift", table };
  if (attention !== "replan") return undefined;
  const writer = table.last_writer?.kind;
  const composer = table.compile_now?.composer;
  return { kind: writer && composer && writer !== composer ? "overridden" : "replan", table };
}

/** Tables that need a re-plan or show drift, for a one-line summary. */
export function attentionTables(view: NodeNetworkView): NodeNetworkTable[] {
  return view.tables.filter((table) => tableAttention(table) !== undefined);
}

const OWNER_ORDER: Record<NodeNetworkOwner["state"], number> = {
  writes: 0,
  orphan: 0,
  contributes: 1,
  observes: 2,
  refused: 3,
  idle: 4,
};

/** Owners in reading order: who writes the table, then who feeds it, then who is kept out. */
export function orderedOwners(owners: readonly NodeNetworkOwner[] | undefined): NodeNetworkOwner[] {
  return [...(owners ?? [])].sort((a, b) => OWNER_ORDER[a.state] - OWNER_ORDER[b.state]);
}

/** The owners worth a word in a summary: everything except idle ones. */
export function activeOwners(owners: readonly NodeNetworkOwner[] | undefined): NodeNetworkOwner[] {
  return orderedOwners(owners).filter((owner) => owner.state !== "idle");
}

/** "53 udp/tcp": a port another feature opens, as the firewall reads it. */
export function portLabel(port: NodeNetworkPort): string {
  const protocols = port.protocols.length ? ` ${port.protocols.join("/")}` : "";
  return `${port.port}${protocols}`;
}

export interface RulesLine {
  /** The line without its leading whitespace. */
  text: string;
  /** The leading whitespace in character widths (a tab counts four), so a wrapped rule keeps its nesting. */
  indent: number;
  /** Outside the longest run of lines both columns share, in order. */
  changed: boolean;
}

export interface RulesCompare {
  now: RulesLine[];
  applied: RulesLine[];
  /** Lines only what would compile now has: a re-plan adds them. */
  added: number;
  /** Lines only what was last applied has: a re-plan removes them. */
  removed: number;
  /** added + removed. */
  changed: number;
  /** Both columns hold the same lines, in a different order. */
  reordered: boolean;
}

// Beyond this many line pairs the ordered compare costs more than a reading
// aid is worth, and lines are matched by count alone.
// yagni: a ruleset of a few hundred lines is the norm; a Myers diff replaces this cap if tables grow past ~2000 lines.
const ORDERED_LIMIT = 4_000_000;

/**
 * The two Show rules columns, line by line, each line marked when it is not
 * part of the longest sequence of lines the columns share in order. Lines
 * compare by their trimmed text, so re-indenting marks nothing, while a rule
 * that moved is marked: nftables evaluates rules in order, so a move changes
 * what the table does. This is a reading aid, not a diff the operator
 * approves: the plan's own diff in Approvals stays the reviewed artefact.
 */
export function compareRulesets(now: string | undefined, applied: string | undefined): RulesCompare {
  const split = (text: string | undefined) => (text ? text.replace(/\n+$/, "").split("\n") : []);
  const nowLines = split(now);
  const appliedLines = split(applied);
  const a = nowLines.map((line) => line.trim());
  const b = appliedLines.map((line) => line.trim());
  const keptA = new Array<boolean>(a.length).fill(false);
  const keptB = new Array<boolean>(b.length).fill(false);
  if (a.length * b.length <= ORDERED_LIMIT) {
    // lcs[i][j]: the longest common run of a[i:] and b[j:].
    const lcs = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
    for (let i = a.length - 1; i >= 0; i--) {
      for (let j = b.length - 1; j >= 0; j--) {
        lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) {
        keptA[i++] = true;
        keptB[j++] = true;
      } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) i++;
      else j++;
    }
  } else {
    const left = new Map<string, number>();
    for (const line of b) left.set(line, (left.get(line) ?? 0) + 1);
    a.forEach((line, i) => {
      const n = left.get(line) ?? 0;
      if (n > 0) {
        left.set(line, n - 1);
        keptA[i] = true;
      }
    });
    const right = new Map<string, number>();
    for (const line of a) right.set(line, (right.get(line) ?? 0) + 1);
    b.forEach((line, j) => {
      const n = right.get(line) ?? 0;
      if (n > 0) {
        right.set(line, n - 1);
        keptB[j] = true;
      }
    });
  }
  const indentOf = (line: string) => {
    let width = 0;
    for (const char of line) {
      if (char === " ") width += 1;
      else if (char === "\t") width += 4;
      else break;
    }
    return width;
  };
  const marked = (lines: string[], keys: string[], kept: boolean[]): RulesLine[] =>
    lines.map((line, i) => ({ text: line.trimStart(), indent: indentOf(line), changed: !kept[i] && keys[i] !== "" }));
  const nowMarked = marked(nowLines, a, keptA);
  const appliedMarked = marked(appliedLines, b, keptB);
  const added = nowMarked.filter((line) => line.changed).length;
  const removed = appliedMarked.filter((line) => line.changed).length;
  const sorted = (keys: string[]) => keys.filter((key) => key !== "").sort().join("\n");
  return { now: nowMarked, applied: appliedMarked, added, removed, changed: added + removed, reordered: added + removed > 0 && sorted(a) === sorted(b) };
}

/** The sections this session was refused, with the scope each names. */
export function refusedSections(view: NodeNetworkView): { section: string; scope: string }[] {
  const out: { section: string; scope: string }[] = [];
  for (const section of ["inbound", "outbound", "access", "mesh", "groups"] as const) {
    const part = view[section];
    if (part.state === "refused") out.push({ section, scope: part.scope ?? "" });
  }
  return out;
}
