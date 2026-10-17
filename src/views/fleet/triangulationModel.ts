/**
 * Triangulation (design 29 D6, contract D13): with more than one source, where
 * a bad path's cause most likely sits. The console works it out from the
 * matrix; the server adds nothing for it, and the verdict changes no state,
 * opens no incident and sends nothing. It is a label with its evidence, in
 * the Overview attention list and on the path sheet.
 *
 * Freshness is the server's: a path whose state is up, degraded or down has a
 * newest outcome recent enough from a source whose agent is online, because
 * the server reads every other path unknown. So a fresh path is one in one of
 * those three states, and nothing here judges freshness with its own clock.
 *
 * Two families run over every row of the matrix (node targets and operator
 * check rows alike):
 *
 *   reach    bad when down; good when up or degraded
 *   quality  bad when down or degraded; good when up
 *
 * and for a bad path from source S to row T, in this order:
 *
 *   1. the target          T has fresh paths from at least two sources and
 *                          every one of them is bad
 *   2. this source's       S has bad paths to at least three rows and to more
 *      network             than half of the rows it has fresh paths to, and at
 *                          least one of those rows has a good fresh path from
 *                          another source
 *   3. this path           anything else
 *
 * Rule 2's corroboration is what keeps D6 honest: with one source, rules 1
 * and 2 can never hold, and every verdict is "this path".
 *
 * Kept free of Vue so `node --test` covers it directly.
 */
import type { PathState } from "@/lib/api/types";
import type { PathColumn, PathItem, PathRow } from "@/views/fleet/pathsModel";

export type VerdictFamily = "reach" | "quality";
export type VerdictKind = "target" | "source" | "path";

/**
 * What the verdict rests on, as names and counts the console words:
 *
 *   target  "Down from all 3 sources that report on it: cd-hs-sh, hk-edge, fra-1"
 *   source  "cd-hs-sh fails 7 of the 9 targets it reports on; other sources reach 5 of them."
 *   path    "2 other sources reach tyo-3"
 *   alone   "Only cd-hs-sh reports on tyo-3, so the cause cannot be placed."
 */
export type VerdictEvidence =
  | { kind: "target"; target: string; sources: string[] }
  | { kind: "source"; source: string; bad: number; fresh: number; elsewhere: number }
  | { kind: "path"; target: string; others: number }
  | { kind: "alone"; source: string; target: string };

export interface Verdict {
  kind: VerdictKind;
  family: VerdictFamily;
  evidence: VerdictEvidence;
}

export interface Triangulation {
  /** Path key to its verdict in the reach family, for every fresh path that is down. */
  reach: Map<string, Verdict>;
  /** Path key to its verdict in the quality family, for every fresh path that is down or degraded. */
  quality: Map<string, Verdict>;
}

export const VERDICT_FAMILIES: readonly VerdictFamily[] = ["reach", "quality"];

/** The server's freshness: a state it only gives a path with a recent outcome from an online agent. */
export function isFresh(state: PathState): boolean {
  return state === "up" || state === "degraded" || state === "down";
}

export function isBad(state: PathState, family: VerdictFamily): boolean {
  return state === "down" || (family === "quality" && state === "degraded");
}

export function isGood(state: PathState, family: VerdictFamily): boolean {
  return state === "up" || (family === "reach" && state === "degraded");
}

/** Rule 2's floor: a source must fail at least this many rows before its network is named. */
export const SOURCE_MIN_BAD_ROWS = 3;

export interface TriangulationInput {
  paths: readonly PathItem[];
  /** One path per (row, source), the worse when two checks share it. */
  cells: ReadonlyMap<string, PathItem>;
  sources?: readonly PathColumn[];
  rows?: readonly PathRow[];
}

export function triangulate(matrix: TriangulationInput): Triangulation {
  // Per row, the state each source's cell holds; per source, the state of each row it reaches.
  const byRow = new Map<string, Map<string, PathState>>();
  const bySource = new Map<string, Map<string, PathState>>();
  const sourceName = new Map<string, string>((matrix.sources ?? []).map((s) => [s.nodeId, s.name]));
  const order = new Map<string, number>((matrix.sources ?? []).map((s, i) => [s.nodeId, i]));
  for (const cell of matrix.cells.values()) {
    const row = byRow.get(cell.rowKey) ?? new Map<string, PathState>();
    row.set(cell.source, cell.state);
    byRow.set(cell.rowKey, row);
    const source = bySource.get(cell.source) ?? new Map<string, PathState>();
    source.set(cell.rowKey, cell.state);
    bySource.set(cell.source, source);
    if (!sourceName.has(cell.source)) sourceName.set(cell.source, cell.sourceName || cell.source);
  }
  const nameOf = (source: string) => sourceName.get(source) ?? source;
  const rank = (source: string) => order.get(source) ?? Number.MAX_SAFE_INTEGER;

  const out: Triangulation = { reach: new Map(), quality: new Map() };
  for (const family of VERDICT_FAMILIES) {
    // Rule 2 depends on the source only: worked out once per source and family.
    const sourceVerdicts = new Map<string, VerdictEvidence | null>();
    const sourceVerdict = (source: string): VerdictEvidence | null => {
      if (sourceVerdicts.has(source)) return sourceVerdicts.get(source)!;
      const rows = [...(bySource.get(source) ?? new Map<string, PathState>())].filter(([, state]) => isFresh(state));
      const badRows = rows.filter(([, state]) => isBad(state, family)).map(([row]) => row);
      const elsewhere = badRows.filter((row) => [...(byRow.get(row) ?? new Map<string, PathState>())].some(([other, state]) => other !== source && isFresh(state) && isGood(state, family))).length;
      const holds = badRows.length >= SOURCE_MIN_BAD_ROWS && badRows.length * 2 > rows.length && elsewhere >= 1;
      const verdict: VerdictEvidence | null = holds ? { kind: "source", source: nameOf(source), bad: badRows.length, fresh: rows.length, elsewhere } : null;
      sourceVerdicts.set(source, verdict);
      return verdict;
    };
    for (const path of matrix.paths) {
      if (!isFresh(path.state) || !isBad(path.state, family)) continue;
      const row = [...(byRow.get(path.rowKey) ?? new Map<string, PathState>())].filter(([, state]) => isFresh(state));
      if (row.length >= 2 && row.every(([, state]) => isBad(state, family))) {
        const sources = row.map(([source]) => source).sort((a, b) => rank(a) - rank(b) || nameOf(a).localeCompare(nameOf(b))).map(nameOf);
        out[family].set(path.key, { kind: "target", family, evidence: { kind: "target", target: path.targetName, sources } });
        continue;
      }
      const placed = sourceVerdict(path.source);
      if (placed) {
        out[family].set(path.key, { kind: "source", family, evidence: placed });
        continue;
      }
      const others = row.filter(([source]) => source !== path.source);
      const reaching = others.filter(([, state]) => isGood(state, family)).length;
      const evidence: VerdictEvidence = others.length === 0 ? { kind: "alone", source: path.sourceName || nameOf(path.source), target: path.targetName } : { kind: "path", target: path.targetName, others: reaching };
      out[family].set(path.key, { kind: "path", family, evidence });
    }
  }
  return out;
}

/** The family a path's verdict comes from: reach for a down path, quality for a degraded one. */
export function familyOf(state: PathState): VerdictFamily | undefined {
  if (state === "down") return "reach";
  if (state === "degraded") return "quality";
  return undefined;
}

/**
 * The one source every verdict rests on when none of them can be placed:
 * each is "this path" because only that source reports on its target, as it
 * is on every item while the path set has a single source. The Overview then
 * says so once above the list instead of on every line. Undefined when there
 * is no verdict, when any verdict is placed or has other sources beside it,
 * or when the lone sources differ.
 */
export function soleReporter(verdicts: readonly (Verdict | undefined)[]): string | undefined {
  let source: string | undefined;
  for (const v of verdicts) {
    if (!v) continue;
    if (v.evidence.kind !== "alone") return undefined;
    if (source !== undefined && source !== v.evidence.source) return undefined;
    source = v.evidence.source;
  }
  return source;
}

/** A down or degraded path's verdict, from the family that names its state; undefined for any other path. */
export function verdictFor(triangulation: Triangulation, path: Pick<PathItem, "key" | "state">): Verdict | undefined {
  const family = familyOf(path.state);
  return family ? triangulation[family].get(path.key) : undefined;
}
