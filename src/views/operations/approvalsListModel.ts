/**
 * How the console reads the approvals listing without downloading it.
 *
 * Measured on a production control plane on 2026-09-04: GET /api/network/approvals
 * answered 1,275 rows, 2.6 MB, in 7.5 s, and the console asked for all of it
 * on the Overview, in the sidebar, on the SSH Guard board and on the Approvals
 * page itself; the plan text on every row was most of the bytes. The same
 * request narrowed to status=pending was 5 KB in 0.2 s.
 *
 * The listing now omits plan text unless asked and answers filtered slices,
 * so each reader asks for the narrowest thing that keeps its behaviour:
 *
 *   - the Approvals page reads the active set (pending, approved, stale)
 *     first and paints it, then loads history (applied, rejected, dismissed)
 *     one status at a time, HISTORY_PAGE_SIZE rows per page, only when the
 *     operator opens that slice;
 *   - the stale agent updates the control plane has already rejected are read
 *     as their own narrow slice, because the active set cannot reach them at
 *     all (see staleSliceParams);
 *   - the plan for one approval is read by id when it is selected;
 *   - counters read the status counts and no rows at all.
 *
 * Everything here is framework-free so the rules can be checked on bare node.
 */

import type { ApprovalCounts, ApprovalListParams, ApprovalView } from "@/lib/api";

/**
 * Statuses an operator can still act on, or that are still going somewhere.
 *
 * "stale" is named here but is not a status column value: the control plane
 * derives it from the plan no longer matching policy and reports it as its own
 * bucket in the counts, while the list filter compares the status column
 * literally. So status=stale selects nothing on its own, and it costs nothing
 * to send: a stale row is also pending, approved or rejected, and the first
 * two are already in this list. Rows are marked stale for the UI by
 * isStaleAgentUpdateApprovalView, never by asking the server for the status.
 */
export const ACTIVE_STATUSES = ["pending", "approved", "stale"] as const;

/** Decided and closed. Loaded only when asked for. */
export const HISTORY_STATUSES = ["applied", "rejected", "dismissed"] as const;
export type HistoryStatus = (typeof HISTORY_STATUSES)[number];

/**
 * Rows per history page. Two hundred applied rows without plan text is about
 * 80 KB, well under a second on the link the 7.5 s was measured on, and more
 * than a screen of table; the operator asks for the next page by name.
 */
export const HISTORY_PAGE_SIZE = 200;

export function isHistoryStatus(value: string): value is HistoryStatus {
  return (HISTORY_STATUSES as readonly string[]).includes(value);
}

/** The first read of the Approvals page: everything open, no plan text. */
export function activeListParams(): ApprovalListParams {
  return { status: ACTIVE_STATUSES.join(",") };
}

/**
 * One page of one history status. Dismissed rows are tombstones the server
 * hides unless include_dismissed asks, even when status names them, so that
 * flag rides along for exactly that status.
 */
export function historyPageParams(status: HistoryStatus, offset = 0): ApprovalListParams {
  return {
    status,
    limit: HISTORY_PAGE_SIZE,
    offset,
    include_dismissed: status === "dismissed" ? true : undefined,
  };
}

/**
 * The stale slice: the agent updates the control plane has already rejected
 * for going stale.
 *
 * Staleness is derived rather than a status column value, and asking for it by
 * status answers nothing, so the active set names it and relies on a stale row
 * also being pending or approved. That holds for about a minute. Every GET of
 * the listing runs rejectLocallyStaleAgentUpdateApprovals first, which walks
 * the store and writes status=rejected on every agent-update approval whose
 * plan no longer matches policy, before the same request filters the rows it
 * answers. So the poll that would have surfaced a newly stale row is the poll
 * that takes it out of pending, and the active set never sees it again: the
 * Stale bucket went quiet on exactly the rows an operator has to re-plan.
 *
 * Reading it back costs one narrow request, not the listing: the only plugin
 * that goes stale, and the one status the active set does not already ask for.
 * Paged like history, because rejected agent updates accumulate for as long as
 * nobody dismisses them, and the store answers newest first.
 */
export const STALE_SLICE = "stale";

/** A slice of the listing the page holds beside the active set. */
export type ApprovalSlice = HistoryStatus | typeof STALE_SLICE;

export const APPROVAL_SLICES: readonly ApprovalSlice[] = [...HISTORY_STATUSES, STALE_SLICE];

export function staleSliceParams(offset = 0): ApprovalListParams {
  return { status: "rejected", plugin: "agentupdate", limit: HISTORY_PAGE_SIZE, offset };
}

/** One page of one slice, whichever kind it is. */
export function slicePageParams(slice: ApprovalSlice, offset = 0): ApprovalListParams {
  return slice === STALE_SLICE ? staleSliceParams(offset) : historyPageParams(slice, offset);
}

/**
 * Whether a poll may re-read a slice's first page over what is held.
 *
 * The stale slice rides the active poll, and a first page replaces the run so
 * a row that left the slice leaves the page. That is right while the operator
 * holds one page and wrong the moment they have asked for more: an eight
 * second timer would throw their pages away. Past the first page the poll
 * leaves the run alone and the Refresh button is what re-reads it.
 */
export function pollReplacesSlice(page: HistoryPage | undefined): boolean {
  return !page || page.rows.length <= HISTORY_PAGE_SIZE;
}

/**
 * Which slices a bucket of the inbox draws on. Empty for the buckets that are
 * served by the active set alone.
 *
 * The Stale bucket names the stale slice: its rows are half in the active set
 * and half in the rejected agent updates, and saying so is what makes the note
 * under the buttons print for it.
 */
export function slicesForBucket(bucket: string): ApprovalSlice[] {
  if (bucket === "all") return [...HISTORY_STATUSES];
  if (bucket === STALE_SLICE) return [STALE_SLICE];
  return isHistoryStatus(bucket) ? [bucket] : [];
}

/** What the page holds for one history status. */
export interface HistoryPage {
  rows: ApprovalView[];
  /** The server's count for this status, once a page has answered. */
  total: number | undefined;
  loading: boolean;
  error: string;
}

export function emptyHistoryPage(): HistoryPage {
  return { rows: [], total: undefined, loading: false, error: "" };
}

/** A page has answered at least once, whatever it held. */
export function isHistoryLoaded(page: HistoryPage | undefined): boolean {
  return page !== undefined && page.total !== undefined;
}

export function hasMoreHistory(page: HistoryPage | undefined): boolean {
  return page !== undefined && page.total !== undefined && page.rows.length < page.total;
}

/**
 * Fold a page into what is already held. Rows are keyed by id: a poll that
 * re-reads the first page must not duplicate what the operator already has,
 * and a refresh of the first page (offset 0) replaces the run rather than
 * appending to it.
 */
export function appendHistoryPage(
  prev: HistoryPage | undefined,
  page: { rows: readonly ApprovalView[]; total: number; offset: number },
): HistoryPage {
  const base = prev && page.offset > 0 ? prev.rows : [];
  const seen = new Set(base.map((row) => row.id));
  const rows = [...base];
  for (const row of page.rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    rows.push(row);
  }
  return { rows, total: page.total, loading: false, error: "" };
}

/** A plan body the console has read, with the hash of exactly those bytes. */
export interface CachedPlan {
  plan: string;
  sha256: string;
}

/**
 * The one list every computed on the page reads. Active rows win over history
 * rows with the same id (a decision can move a row between the two between
 * polls), pinned rows fill in anything reached by deep link that is in
 * neither, and a plan the console has read is put back on its row so grouping,
 * diffing and hashing see the same object shape they always did. A cached plan
 * is used only while its hash still matches the row's plan_sha256: the server
 * rewrites a pending plan in place, and a stale body under a fresh hash would
 * make the diff lie and the approve call fail.
 */
export function mergeApprovalRows(input: {
  active: readonly ApprovalView[];
  history: readonly (readonly ApprovalView[])[];
  pinned?: readonly ApprovalView[];
  plans?: Readonly<Record<string, CachedPlan>>;
}): ApprovalView[] {
  const byId = new Map<string, ApprovalView>();
  for (const row of input.active) byId.set(row.id, row);
  for (const rows of input.history) {
    for (const row of rows) if (!byId.has(row.id)) byId.set(row.id, row);
  }
  for (const row of input.pinned ?? []) if (!byId.has(row.id)) byId.set(row.id, row);
  const plans = input.plans ?? {};
  const out: ApprovalView[] = [];
  for (const row of byId.values()) {
    if (row.plan) {
      out.push(row);
      continue;
    }
    const cached = plans[row.id];
    if (cached && (!row.plan_sha256 || cached.sha256 === row.plan_sha256)) {
      out.push({ ...row, plan: cached.plan });
    } else {
      out.push(row);
    }
  }
  return out;
}

/** True when the row's cached plan (if any) no longer describes the row. */
export function planCacheIsStale(row: Pick<ApprovalView, "plan_sha256">, cached: CachedPlan | undefined): boolean {
  if (!cached) return false;
  return !!row.plan_sha256 && cached.sha256 !== row.plan_sha256;
}

/**
 * The count each bucket button prints.
 *
 * Active buckets are counted from the rows on the page, because "stuck" and
 * "stale" need the same heuristics the rows are filtered by. History buckets
 * print the server's count, which is known before a single history row is
 * loaded; before the counts arrive they fall back to what is loaded, which is
 * zero, and the button says so rather than guessing.
 *
 * Stale stays a row count, and the stale slice is what makes that number right
 * again: the button used to print the one or two stale rows that were still
 * pending because the rest were never read. The server's stale count is a
 * different population and cannot replace it. It is computed from the reason
 * prefix over every status the caller can see, tombstones included, and a
 * dismissed stale agent update keeps its stale reason, so that count carries
 * rows this bucket never lists. Printing it would leave an operator who has
 * cleared every stale plan looking at a badge that never reaches zero.
 */
export function bucketCount(
  bucket: string,
  rows: readonly ApprovalView[],
  counts: ApprovalCounts | undefined,
  matches: (row: ApprovalView, bucket: string) => boolean,
): number {
  if (bucket === "all") {
    if (counts) return counts.total;
    return rows.length;
  }
  if (isHistoryStatus(bucket) && counts) return counts[bucket] ?? 0;
  let n = 0;
  for (const row of rows) if (matches(row, bucket)) n += 1;
  return n;
}

/**
 * What the page must say about a bucket that draws on history: which statuses
 * are not loaded at all, and for those that are, how many of the server's rows
 * the page holds. Empty when the bucket is active-only, so the caller prints
 * nothing.
 */
export interface HistoryLoadNote {
  /** Slices this bucket needs that have never answered. */
  notLoaded: ApprovalSlice[];
  /** Slices that answered, with what the page holds against the server's total. */
  partial: Array<{ status: ApprovalSlice; loaded: number; total: number }>;
  /** Everything the bucket draws on is held in full. */
  complete: boolean;
}

export function historyLoadNote(
  bucket: string,
  pages: Readonly<Partial<Record<ApprovalSlice, HistoryPage>>>,
): HistoryLoadNote {
  const needed = slicesForBucket(bucket);
  const notLoaded: ApprovalSlice[] = [];
  const partial: HistoryLoadNote["partial"] = [];
  for (const status of needed) {
    const page = pages[status];
    if (!isHistoryLoaded(page)) {
      notLoaded.push(status);
    } else if (hasMoreHistory(page)) {
      partial.push({ status, loaded: page!.rows.length, total: page!.total ?? 0 });
    }
  }
  return { notLoaded, partial, complete: needed.length > 0 && notLoaded.length === 0 && partial.length === 0 };
}

/**
 * The digest an approve call binds to.
 *
 * The rule is: hash the bytes the operator saw when there are any, and only
 * fall back to the server's hash when the console never downloaded the plan.
 * A row with plan text is hashed locally, exactly as before this change, so
 * a plan the panel showed is the plan the decision names. A row without plan
 * text but with plan_sha256 sends that hash: the server checks it against
 * the stored plan the same way, and the console never had other bytes to
 * bind. A row with neither (a control plane older than plan_sha256 answering
 * a plan-less row, which should not happen) reads the full record first.
 */
export function approvalDigest(
  item: Pick<ApprovalView, "id" | "plan" | "plan_sha256">,
  deps: {
    hashPlan: (item: Pick<ApprovalView, "id" | "plan">) => Promise<string>;
    fetchFull: (id: string) => Promise<Pick<ApprovalView, "id" | "plan">>;
  },
): Promise<string> {
  if (item.plan) return deps.hashPlan(item);
  if (item.plan_sha256) return Promise.resolve(item.plan_sha256);
  return deps.fetchFull(item.id).then((full) => deps.hashPlan(full));
}

/**
 * Whether the active set needs a second read for plan text. Event cards group
 * agent updates by the version transition parsed from the plan, and name each
 * node by the node_name line, so without plan text every agent update on the
 * fleet would collapse into one card labelled "Fleet upgrade" with raw ids.
 * The active set is small, so one extra read of exactly those rows with
 * include=plan keeps the cards right. Rows already covered by a fresh cache
 * do not count.
 */
export function agentUpdateRowsNeedingPlans(
  rows: readonly ApprovalView[],
  plans: Readonly<Record<string, CachedPlan>>,
): ApprovalView[] {
  return rows.filter((row) => {
    if (row.plugin !== "agentupdate" || row.plan) return false;
    const cached = plans[row.id];
    return !cached || planCacheIsStale(row, cached);
  });
}

/** Parameters of that second read: the active agent updates, with plan text. */
export function agentUpdatePlanParams(): ApprovalListParams {
  return { status: ACTIVE_STATUSES.join(","), plugin: "agentupdate", include: "plan" };
}

/**
 * What the Agent Updates page reads: every agent-update approval, whatever its
 * status, without plan text.
 *
 * It prints the ones whose plan has gone stale, and staleness is a derived
 * flag rather than a status column value, so it cannot be asked for by status:
 * the server's list filter compares the column literally and status=stale
 * answers an empty list. A stale row's column reads pending, approved or
 * rejected depending on how it was left, so the page reads the plugin's rows
 * and applies isStaleAgentUpdateApprovalView itself, exactly as it did when it
 * read the whole listing. The plugin filter is what makes this small, and the
 * page never opens a plan, so no plan text is asked for.
 */
export function agentUpdateStaleParams(): ApprovalListParams {
  return { plugin: "agentupdate" };
}

/**
 * The prior applied plans for a target, which the diff view needs as its
 * baseline. History is not loaded until asked, and the baseline for one
 * selected row must not cost a page of it, so the panel reads exactly the
 * applied rows for that node and plugin, with plan text. Keyed so one read
 * serves every approval on the same target.
 */
export function baselineKey(row: Pick<ApprovalView, "node_id" | "plugin">): string {
  return `${row.node_id}|${row.plugin}`;
}

export function baselineParams(row: Pick<ApprovalView, "node_id" | "plugin">): ApprovalListParams {
  return { status: "applied", node_id: row.node_id, plugin: row.plugin, include: "plan", limit: HISTORY_PAGE_SIZE };
}

/**
 * The most recent earlier applied plan for the same target (node, plugin,
 * action): what is actually live. Approved-but-not-applied plans are not a
 * live baseline and would make the diff lie about the current state.
 */
export function previousAppliedPlan(current: ApprovalView, rows: readonly ApprovalView[]): string {
  let best: ApprovalView | undefined;
  for (const row of rows) {
    if (
      row.id === current.id ||
      row.node_id !== current.node_id ||
      row.plugin !== current.plugin ||
      row.action !== current.action ||
      row.status !== "applied" ||
      !((row.created_at || "") < (current.created_at || ""))
    ) {
      continue;
    }
    if (!best || (row.created_at || "") > (best.created_at || "")) best = row;
  }
  return best?.plan ?? "";
}
