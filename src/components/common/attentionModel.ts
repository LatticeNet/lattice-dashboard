/**
 * Pure model for the attention list (design 23, section 3.2).
 *
 * Each item is a claim, the row that proves it, and the action that clears
 * it. Danger comes before warning before information, and inside a tone the
 * page's own order holds (it knows what is worst). Information items are
 * listed but never counted in a badge or a headline number (design 22, as
 * built): "no line is managed" is worth reading and not worth an alarm.
 *
 * Kept free of Vue so `node --test` covers it directly.
 */

export type AttentionTone = "danger" | "warning" | "info";

export interface AttentionAction {
  label: string;
  /** A route to open. The action is a link. */
  to?: unknown;
  /** Something to run in place. The action is a button. */
  run?: () => void;
}

export interface AttentionItem {
  key: string;
  tone: AttentionTone;
  /** What is wrong, as one sentence. */
  claim: string;
  /** The row that proves it: a node name, an error, a date. */
  proof?: string;
  action?: AttentionAction;
}

/** How many items show before "Show all N". */
export const ATTENTION_DEFAULT_MAX = 5;

const TONE_ORDER: Record<AttentionTone, number> = { danger: 0, warning: 1, info: 2 };

/** Worst first, stable inside a tone. */
export function sortAttention<T extends Pick<AttentionItem, "tone">>(items: readonly T[]): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => TONE_ORDER[a.item.tone] - TONE_ORDER[b.item.tone] || a.index - b.index)
    .map((entry) => entry.item);
}

/** Items that count toward a badge or a headline number. */
export function attentionCount(items: readonly Pick<AttentionItem, "tone">[]): number {
  return items.filter((item) => item.tone !== "info").length;
}

export interface AttentionView<T> {
  shown: T[];
  /** Items folded behind "Show all N"; 0 when expanded or when all fit. */
  hidden: number;
  total: number;
}

/**
 * What the list renders. At most `max` rows until expanded. A fold that would
 * hide a single row shows it instead: "Show all 6" to reveal one more line
 * costs the operator a click for nothing.
 */
export function attentionView<T extends Pick<AttentionItem, "tone">>(
  items: readonly T[],
  max: number = ATTENTION_DEFAULT_MAX,
  expanded = false,
): AttentionView<T> {
  const sorted = sortAttention(items);
  const limit = Math.max(1, Math.floor(max));
  if (expanded || sorted.length <= limit + 1) return { shown: sorted, hidden: 0, total: sorted.length };
  return { shown: sorted.slice(0, limit), hidden: sorted.length - limit, total: sorted.length };
}
