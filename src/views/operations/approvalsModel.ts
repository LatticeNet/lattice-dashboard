/**
 * Approvals event aggregation. Turns the flat approvals inbox into
 * operator-meaningful "events" that can be dispositioned in one batch.
 *
 * The server emits one approval row per (node, plugin, action), so a single
 * fleet-wide change lands as dozens of inbox entries (e.g. 20 nodes upgrading
 * 0.3.0 → 0.3.3). Reviewing those one by one forces the operator to re-verify
 * the same plan text N times. This module groups actionable approvals by the
 * identity of the underlying change. (writer, plugin, action prefix, version
 * transition). So one card represents one event.
 *
 * The grouping key is deliberately strict: no time-window fuzzy batching.
 * Two items belong to the same event iff they were written by the same actor,
 * for the same plugin, for the same action prefix (the part before ":"), and
 *. For agentupdate. The same current → target version transition parsed
 * from the plan text. Anything that differs in any of those dimensions is a
 * different event and gets its own card.
 *
 * Everything here is framework-free and side-effect-free except
 * `runWithConcurrency`, which only orchestrates the caller's worker.
 */

/** Minimal structural shape the grouping logic needs. Compatible with ApprovalView. */
export interface ApprovalEventItem {
  id: string;
  node_id: string;
  plugin: string;
  action: string;
  plan: string;
  status: string;
  actor_id?: string;
  created_at?: string;
}

/** Version transition parsed from an agentupdate plan text. */
export interface VersionTransition {
  current: string;
  target: string;
}

export type ApprovalEventTitleKind = "fleet-upgrade" | "linemeta-sync" | "generic";

export interface ApprovalEventGroup<T extends ApprovalEventItem = ApprovalEventItem> {
  /** Stable identity: writer | plugin | actionPrefix | transition. */
  key: string;
  /** Normalized writer. Never empty ("unknown" fallback). */
  writer: string;
  plugin: string;
  actionPrefix: string;
  transition?: VersionTransition;
  /** Which i18n/humanizer path produced the title. */
  titleKind: ApprovalEventTitleKind;
  /** English rendering, used directly for the generic (data-derived) kind. */
  title: string;
  /** Items sorted by node label then id for deterministic display. */
  items: T[];
  /** created_at of the newest item. Drives card sorting and the age label. */
  newestCreatedAt: string;
  /** writer === SYSTEM_WRITER. The server itself proposed this change. */
  isSystem: boolean;
}

/** Writer value used by the Lattice server when it proposes its own plans. */
export const SYSTEM_WRITER = "lattice-server";

/** Normalized key/display value for approvals that carry no actor identity. */
export const UNKNOWN_WRITER = "unknown";

export const EVENT_NODE_PREVIEW_LIMIT = 6;

/**
 * Only items an operator can still act on belong in event cards. "approved"
 * is included because approved-not-applied work is still an open disposition;
 * historical statuses (applied / rejected / dismissed / failed) are not.
 * Stale filtering stays in the view (it needs the stale heuristics from the
 * API layer). Stale plans must be re-planned individually, not batch-approved.
 */
export function isApprovalEventGroupable(item: Pick<ApprovalEventItem, "status">): boolean {
  return item.status === "pending" || item.status === "approved";
}

/** Action prefix. The part before the first ":" ("apply-metadata:abc…" → "apply-metadata"). */
export function approvalActionPrefix(action: string): string {
  const at = action.indexOf(":");
  return (at === -1 ? action : action.slice(0, at)).trim();
}

/**
 * Normalized writer identity. The API calls the plan author `actor_id`; empty
 * or missing identities collapse into UNKNOWN_WRITER so they group together
 * instead of fanning out into single-item cards.
 */
export function approvalWriter(item: Pick<ApprovalEventItem, "actor_id">): string {
  const writer = (item.actor_id ?? "").trim();
  return writer || UNKNOWN_WRITER;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) return trimmed;
  const quote = trimmed[0];
  if ((quote === '"' || quote === "'") && trimmed[trimmed.length - 1] === quote) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Parse the YAML-ish agentupdate plan text. The server renders plans as flat
 * `key: value` lines (current_version / target_version / node_name); this
 * reads exactly those three keys and ignores everything else, so extra lines
 * (artifact URLs, checksums) never break grouping.
 */
export function parseAgentUpdatePlan(plan: string): {
  transition?: VersionTransition;
  nodeName?: string;
} {
  let current = "";
  let target = "";
  let nodeName = "";
  for (const line of plan.split("\n")) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.+?)\s*$/.exec(line);
    const key = match?.[1];
    const rawValue = match?.[2];
    if (!key || rawValue === undefined) continue;
    const value = unquote(rawValue);
    if (key === "current_version") current = value;
    else if (key === "target_version") target = value;
    else if (key === "node_name") nodeName = value;
  }
  return {
    transition: current && target ? { current, target } : undefined,
    nodeName: nodeName || undefined,
  };
}

/** Human-friendly node label: the plan's node_name when present, else the id. */
export function approvalNodeLabel(item: ApprovalEventItem): string {
  if (item.plugin === "agentupdate") {
    const nodeName = parseAgentUpdatePlan(item.plan).nodeName;
    if (nodeName) return nodeName;
  }
  return item.node_id || "global";
}

/** Title-case a machine action prefix: "apply-metadata" → "Apply Metadata". */
export function humanizeActionPrefix(prefix: string): string {
  const words = prefix.split(/[-_:\s]+/).filter(Boolean);
  if (words.length === 0) return "Approval event";
  return words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}

/**
 * English card title. Known fleet events get a purpose-built name; everything
 * else falls back to the title-cased action prefix. The view renders the two
 * known kinds through i18n keys keyed by `titleKind`; this string is the
 * fallback and the testable reference rendering.
 */
export function approvalEventTitle(
  plugin: string,
  actionPrefix: string,
  transition?: VersionTransition,
): { titleKind: ApprovalEventTitleKind; title: string } {
  if (plugin === "agentupdate") {
    return {
      titleKind: "fleet-upgrade",
      title: transition ? `Fleet upgrade ${transition.current} → ${transition.target}` : "Fleet upgrade",
    };
  }
  if (plugin === "singbox-linemeta" && actionPrefix === "apply-metadata") {
    return { titleKind: "linemeta-sync", title: "Line metadata sync" };
  }
  return { titleKind: "generic", title: humanizeActionPrefix(actionPrefix) };
}

function groupKey(writer: string, plugin: string, actionPrefix: string, transition?: VersionTransition): string {
  return [writer, plugin, actionPrefix, transition ? `${transition.current}→${transition.target}` : ""].join("|");
}

/**
 * Group actionable approvals into event cards, sorted newest first. Items
 * inside a card are sorted by node label for a scannable target list.
 */
export function groupApprovalsIntoEvents<T extends ApprovalEventItem>(items: readonly T[]): ApprovalEventGroup<T>[] {
  const groups = new Map<string, ApprovalEventGroup<T>>();
  for (const item of items) {
    if (!isApprovalEventGroupable(item)) continue;
    const writer = approvalWriter(item);
    const prefix = approvalActionPrefix(item.action);
    const transition = item.plugin === "agentupdate" ? parseAgentUpdatePlan(item.plan).transition : undefined;
    const key = groupKey(writer, item.plugin, prefix, transition);
    let group = groups.get(key);
    if (!group) {
      const { titleKind, title } = approvalEventTitle(item.plugin, prefix, transition);
      group = {
        key,
        writer,
        plugin: item.plugin,
        actionPrefix: prefix,
        transition,
        titleKind,
        title,
        items: [],
        newestCreatedAt: "",
        isSystem: writer === SYSTEM_WRITER,
      };
      groups.set(key, group);
    }
    group.items.push(item);
    const created = item.created_at ?? "";
    if (created > group.newestCreatedAt) group.newestCreatedAt = created;
  }
  const out = [...groups.values()];
  for (const group of out) {
    group.items.sort((a, b) => {
      const byNode = approvalNodeLabel(a).localeCompare(approvalNodeLabel(b));
      return byNode !== 0 ? byNode : a.id.localeCompare(b.id);
    });
  }
  out.sort((a, b) => {
    const byAge = b.newestCreatedAt.localeCompare(a.newestCreatedAt);
    return byAge !== 0 ? byAge : a.key.localeCompare(b.key);
  });
  return out;
}

/**
 * First `limit` distinct node labels of the group plus the count of the
 * remainder ("+N more"). Duplicate nodes (re-planned approvals) show once.
 */
export function groupNodePreview(
  group: ApprovalEventGroup,
  limit = EVENT_NODE_PREVIEW_LIMIT,
): { nodes: string[]; extra: number } {
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const item of group.items) {
    const id = item.node_id || "global";
    if (seen.has(id)) continue;
    seen.add(id);
    labels.push(approvalNodeLabel(item));
  }
  return { nodes: labels.slice(0, limit), extra: Math.max(0, labels.length - limit) };
}

export interface BatchPartition<T> {
  succeeded: T[];
  failed: Array<{ item: T; error: string }>;
}

/**
 * Split an order-aligned PromiseSettledResult list (as returned by
 * runWithConcurrency) back into the items that succeeded and the items that
 * failed with a human-readable message. Failures keep their original item so
 * the caller can leave exactly those pending in the UI.
 */
export function partitionBatchResults<T>(
  items: readonly T[],
  results: readonly PromiseSettledResult<unknown>[],
): BatchPartition<T> {
  const succeeded: T[] = [];
  const failed: Array<{ item: T; error: string }> = [];
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i] as T;
    const result = results[i];
    if (!result || result.status === "rejected") {
      const reason = result?.status === "rejected" ? result.reason : undefined;
      failed.push({ item, error: reason instanceof Error ? reason.message : String(reason ?? "failed") });
    } else {
      succeeded.push(item);
    }
  }
  return { succeeded, failed };
}

/**
 * Run `worker` over `items` with at most `limit` in flight, preserving input
 * order in the settled-results array. Individual rejections are captured, not
 * thrown. A batch disposition must always run to completion so the operator
 * sees the full success/failure split instead of a halt at the first error.
 */
export async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<unknown>,
  onProgress?: (done: number, total: number) => void,
): Promise<PromiseSettledResult<unknown>[]> {
  const results: PromiseSettledResult<unknown>[] = new Array(items.length);
  let cursor = 0;
  let done = 0;
  const lanes = Math.max(1, Math.min(limit, items.length));

  async function lane(): Promise<void> {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      const item = items[index] as T;
      try {
        results[index] = { status: "fulfilled", value: await worker(item, index) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
      done += 1;
      onProgress?.(done, items.length);
    }
  }

  await Promise.all(Array.from({ length: lanes }, () => lane()));
  return results;
}
