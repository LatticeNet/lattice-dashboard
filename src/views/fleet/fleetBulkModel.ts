/**
 * Pure model for selecting nodes and acting on the whole selection.
 *
 * Disabling six nodes meant six trips through a per-row menu, so the fleet
 * needed selection. The interesting part is not the checkbox, it is being
 * honest about what a batch actually did: a run that half worked must not
 * look like a run that worked.
 *
 * Kept free of Vue so `node --test` covers it directly (house *Model.ts
 * pattern).
 */

/** The little a node has to expose for a bulk enable/disable to reason about it. */
export interface BulkNode {
  id: string;
  name?: string;
  disabled?: boolean;
}

export interface BulkDisablePlan<T extends BulkNode> {
  /** Selected nodes that need the call, in fleet order. */
  targets: T[];
  /** Selected nodes already in the requested state; calling them would be a lie about work done. */
  unchanged: T[];
  /** Selected ids no longer in the fleet, e.g. deleted while the selection sat there. */
  missing: string[];
}

/**
 * Work out what a bulk enable/disable would really do.
 *
 * Selecting six and disabling when two are already disabled is four calls, not
 * six, and the result has to say four. Ids that vanished from the fleet since
 * the operator picked them are reported rather than silently dropped.
 */
export function planBulkDisable<T extends BulkNode>(
  nodes: readonly T[],
  selected: ReadonlySet<string>,
  disabled: boolean,
): BulkDisablePlan<T> {
  const targets: T[] = [];
  const unchanged: T[] = [];
  const seen = new Set<string>();

  for (const node of nodes) {
    if (!selected.has(node.id)) continue;
    seen.add(node.id);
    if (!!node.disabled === disabled) unchanged.push(node);
    else targets.push(node);
  }

  const missing = [...selected].filter((id) => !seen.has(id)).sort();
  return { targets, unchanged, missing };
}

/** Drop ids that are no longer on screen, so a stale selection cannot act on a ghost. */
export function pruneSelection(selected: ReadonlySet<string>, presentIds: readonly string[]): Set<string> {
  const present = new Set(presentIds);
  const next = new Set<string>();
  for (const id of selected) if (present.has(id)) next.add(id);
  return next;
}

/** Add or drop one id. Returns a new set so Vue sees the change. */
export function toggleSelected(selected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selected);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

/** Add or drop a whole run of ids, leaving everything else in the selection alone. */
export function setSelected(selected: ReadonlySet<string>, ids: readonly string[], on: boolean): Set<string> {
  const next = new Set(selected);
  for (const id of ids) {
    if (on) next.add(id);
    else next.delete(id);
  }
  return next;
}

/**
 * Header checkbox state for a run of ids: all, none, or some.
 *
 * An empty run is unchecked rather than indeterminate; there is nothing to be
 * partway through.
 */
export function selectionHeaderState(
  selected: ReadonlySet<string>,
  ids: readonly string[],
): boolean | "indeterminate" {
  if (ids.length === 0) return false;
  let hit = 0;
  for (const id of ids) if (selected.has(id)) hit += 1;
  if (hit === 0) return false;
  if (hit === ids.length) return true;
  return "indeterminate";
}

export type BulkOutcomeKind = "none" | "all" | "partial" | "failed";

export interface BulkOutcome<T> {
  kind: BulkOutcomeKind;
  succeeded: T[];
  failed: Array<{ item: T; error: string }>;
  /** Ids to leave selected: what failed, so a retry is one click. */
  retryIds: string[];
}

/**
 * Classify a finished batch.
 *
 * "all" is only claimed when something ran and every call came back clean.
 * A batch with nothing to do is "none", never a success, because the operator
 * asked for a change and no change happened.
 */
export function summarizeBulk<T extends { id: string }>(
  succeeded: readonly T[],
  failed: ReadonlyArray<{ item: T; error: string }>,
): BulkOutcome<T> {
  const retryIds = failed.map((entry) => entry.item.id);
  if (failed.length === 0) {
    return { kind: succeeded.length ? "all" : "none", succeeded: [...succeeded], failed: [], retryIds };
  }
  return {
    kind: succeeded.length ? "partial" : "failed",
    succeeded: [...succeeded],
    failed: [...failed],
    retryIds,
  };
}

/** Node names for a message, capped so a fleet-wide failure does not become a wall of text. */
export function nameList<T extends BulkNode>(items: readonly T[], limit = 3): { names: string; extra: number } {
  const shown = items.slice(0, limit).map((item) => item.name || item.id);
  return { names: shown.join(", "), extra: Math.max(0, items.length - shown.length) };
}
