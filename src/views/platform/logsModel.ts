/**
 * Pure model for the Raw log lens of Evidence: what an empty viewer should
 * say. Kept free of Vue so `node --test` covers it directly (house *Model.ts
 * pattern).
 *
 * The viewer had one empty sentence, "no log lines match the current filter
 * for this source", and printed it whether a source existed, whether the
 * source was enabled, and whether it had ever shipped a line. Each of those is
 * a different operator problem with a different next step, so the cases are
 * kept apart here.
 */
import type { LogSource, LogSourceStatsView } from "@/lib/api/types";

export type LogViewerEmptyState =
  /** No source is registered at all, so no node ships lines here. */
  | { kind: "no-sources" }
  /** Sources exist and none is selected. Should not last: the view picks one. */
  | { kind: "no-selection" }
  /** The selected source is disabled, so its node's agent does not tail it. */
  | { kind: "source-disabled" }
  /** The source is enabled and the store holds no line for it. */
  | { kind: "source-empty" }
  /** The store holds lines for this source and the filter selected none. */
  | { kind: "nothing-matched" }
  /** The store holds lines and nothing narrowed them; the query came back empty anyway. */
  | { kind: "unknown" };

export interface LogViewerEmptyInput {
  /** The source list was read; false while loading or after a failed request. */
  sourcesKnown: boolean;
  sourceCount: number;
  selected?: Pick<LogSource, "enabled">;
  /** Lines the store holds for the selected source; undefined when stats were not read. */
  heldLines?: number;
  /** True when a substring filter narrows the query. */
  filterActive: boolean;
}

/**
 * Which empty state the viewer is in. Only meaningful while the viewer shows
 * no line; the caller checks that first.
 *
 * An unread stats answer is "unknown", not "empty": the store may hold lines
 * the console has not counted yet, and telling an operator nothing was ever
 * shipped on that basis would be a confident wrong answer.
 */
export function logViewerEmptyState(input: LogViewerEmptyInput): LogViewerEmptyState {
  if (input.sourcesKnown && input.sourceCount === 0) return { kind: "no-sources" };
  if (!input.selected) return { kind: "no-selection" };
  if (input.heldLines === undefined) return { kind: "unknown" };
  if (input.heldLines === 0) {
    return input.selected.enabled ? { kind: "source-empty" } : { kind: "source-disabled" };
  }
  return input.filterActive ? { kind: "nothing-matched" } : { kind: "unknown" };
}

/** One source as the empty state lists it: what exists, which node feeds it, and what it holds. */
export interface LogSourceFeed {
  id: string;
  name: string;
  nodeId: string;
  enabled: boolean;
  /** Lines held, or undefined when stats were not read for this source. */
  heldLines?: number;
}

/** Enabled sources first, then by name. The one order the source list and the empty state share. */
export function sortLogSources(sources: readonly LogSource[]): LogSource[] {
  return [...sources].sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    return (a.name || a.id).localeCompare(b.name || b.id);
  });
}

/**
 * The sources that exist and the nodes feeding them, for the empty state.
 *
 * Same order as the source list, so the two never disagree about which source
 * is "first". Stats are joined by id and left undefined where the server sent
 * none; a missing count is not zero.
 */
export function logSourceFeeds(
  sources: readonly LogSource[],
  stats: readonly LogSourceStatsView[] = [],
): LogSourceFeed[] {
  const held = new Map<string, number>();
  for (const entry of stats) held.set(entry.source_id, entry.lines);
  return sortLogSources(sources)
    .map((source) => ({
      id: source.id,
      name: source.name || source.id,
      nodeId: source.node_id,
      enabled: source.enabled,
      heldLines: held.get(source.id),
    }));
}
