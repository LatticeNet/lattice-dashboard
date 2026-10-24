/**
 * What a reachability matrix row leaves out (design 32 S3b): the members of
 * the row's group, or of the fleet, that an outbound policy excludes. A row
 * used to read a cell as the whole group's even when a policy left members
 * out; the row header now says who.
 *
 * Pure TS, so `node --test` covers it directly.
 */
import type { MatrixExclusion } from "@/lib/api/types";

export interface RowExclusions {
  /** Excluded nodes by name, each once, in the order the policies list them. */
  names: string[];
  /** Excluded nodes this session may not read. */
  hidden: number;
  /** Per policy, for the full sentence. */
  byPolicy: { label: string; names: string[]; hidden: number }[];
}

/** The exclusions of one row: a group's (`from` set) or the fleet row's (`from` absent). */
export function rowExclusions(exclusions: readonly MatrixExclusion[] | undefined, from?: string): RowExclusions {
  const out: RowExclusions = { names: [], hidden: 0, byPolicy: [] };
  const seen = new Set<string>();
  for (const ex of exclusions ?? []) {
    if ((ex.from ?? "") !== (from ?? "")) continue;
    const names = ex.nodes.map((n) => n.name || n.id);
    out.byPolicy.push({ label: ex.label, names, hidden: ex.hidden ?? 0 });
    out.hidden += ex.hidden ?? 0;
    for (const node of ex.nodes) {
      if (seen.has(node.id)) continue;
      seen.add(node.id);
      out.names.push(node.name || node.id);
    }
  }
  return out;
}

/** The names a narrow row header shows before "+n". */
export function shownNames(row: RowExclusions, max = 2): { names: string[]; more: number } {
  return { names: row.names.slice(0, max), more: Math.max(0, row.names.length - max) + row.hidden };
}
