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
 * something else now than what was last applied, drift when the node's own
 * table differs from what was applied, nothing otherwise. Replan comes first:
 * a re-plan is what clears drift too.
 */
export function tableAttention(table: NodeNetworkTable): "replan" | "drift" | undefined {
  if (table.state !== "ok") return undefined;
  if (table.replan_pending) return "replan";
  if (table.drift_state === "drift") return "drift";
  return undefined;
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
  text: string;
  /** The other column has no such line, so this one differs. */
  changed: boolean;
}

export interface RulesCompare {
  now: RulesLine[];
  applied: RulesLine[];
  /** Lines marked in either column. */
  changed: number;
}

/**
 * The two Show rules columns, line by line, each line marked when the other
 * column lacks it. Lines compare by their trimmed text and count, so a
 * reordered or re-indented ruleset marks only what moved in meaning. This is
 * a reading aid, not a diff the operator approves: the plan's own diff in
 * Approvals stays the reviewed artefact.
 */
export function compareRulesets(now: string | undefined, applied: string | undefined): RulesCompare {
  const split = (text: string | undefined) => (text ? text.replace(/\n+$/, "").split("\n") : []);
  const nowLines = split(now);
  const appliedLines = split(applied);
  const counts = (lines: string[]) => {
    const out = new Map<string, number>();
    for (const line of lines) out.set(line.trim(), (out.get(line.trim()) ?? 0) + 1);
    return out;
  };
  const mark = (lines: string[], other: Map<string, number>): RulesLine[] => {
    const left = new Map(other);
    return lines.map((text) => {
      const key = text.trim();
      const n = left.get(key) ?? 0;
      if (n > 0) {
        left.set(key, n - 1);
        return { text, changed: false };
      }
      return { text, changed: key !== "" };
    });
  };
  const nowMarked = mark(nowLines, counts(appliedLines));
  const appliedMarked = mark(appliedLines, counts(nowLines));
  const changed = [...nowMarked, ...appliedMarked].filter((line) => line.changed).length;
  return { now: nowMarked, applied: appliedMarked, changed };
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
