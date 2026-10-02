<script setup lang="ts">
/**
 * Approvals (design 23, section 4.3): layers Needs you, History and Stuck
 * on `?view=`. A bare address opens Needs you when something waits on the
 * operator and History otherwise (production: 1,351 plans, none waiting).
 *
 * Needs you groups the pending plans by the change they belong to, so a
 * 14-node agent update is one card with one batch decision, and lists the
 * agent-update plans that went stale. Stuck lists approved plans that will
 * not apply on their own, each with the control plane's reason. History is
 * one server query through the QueryBar (status, plugin, node, and the range
 * as since); the listing has no actor filter, so there is none.
 *
 * A row opens the plan in the sheet on `?open=`: the diff against what is
 * live, the hash of the bytes on screen, why it has not applied, and the
 * tasks it queued. The decision row orders Approve, Approve and queue, and
 * Reject last. Node identity is always a name (NodeLabel).
 *
 * Approving never takes fewer steps than rejecting. A single-plan card
 * leads with Review the plan; Approve and queue lives in the sheet beside
 * the diff and the hash. A batch approves through a preview in the style
 * of the rerun and Adopt previews: the nodes (six names, then a count), the
 * plan hashes the approvals bind to, the offline nodes, and that it
 * dispatches now. Reject, single or batch, confirms too.
 *
 * The attention list names each class of trouble once and points at where
 * its rows live (the Stuck layer, the stale list in Needs you), so Needs you
 * stays on the first screen of a phone. After a decision focus moves to the
 * card that took the decided one's place, or to the sheet's title when the
 * sheet stays open.
 */
import { computed, nextTick, onScopeDispose, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "@/lib/toast";
import { Ban, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, ClipboardList, ExternalLink, FileCode2, Play, RefreshCw, ServerOff } from "lucide-vue-next";

import {
  api,
  APPROVAL_STALE_AGENT_UPDATE_POLICY_CHANGED,
  isActionablePendingApproval,
  isAgentUpdateNoopError,
  isApprovalStaleError,
  isStaleAgentUpdateApprovalView,
  unwrap,
  type ApprovalCounts,
  type ApprovalView,
  type Node,
} from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { bindLayer } from "@/composables/useLayer";
import { provideNodeDirectory } from "@/composables/useNodeDirectory";
import { useOwnedRoute } from "@/composables/useOwnedRoute";
import { usePlanDigest } from "@/composables/usePlanDigest";
import { useProof } from "@/composables/useProof";
import { bindRouteOpen } from "@/composables/useRouteOpen";
import { useAuthStore } from "@/stores/auth";
import { approvalStatusMeta } from "@/lib/status";
import { isReporting } from "@/lib/nodeStatus";
import { formatDateTime, formatRelativeTime, shortId } from "@/lib/format";
import type { TokenResolvers } from "@/lib/queryTokens";
import { cn } from "@/lib/utils";

import PageHeader from "@/components/common/PageHeader.vue";
import ProofLine, { type ProofSegment } from "@/components/common/ProofLine.vue";
import AttentionList, { type AttentionItem } from "@/components/common/AttentionList.vue";
import MetricStrip, { type Metric } from "@/components/common/MetricStrip.vue";
import LayerTabs, { type LayerTab } from "@/components/common/LayerTabs.vue";
import QueryBar, { type QueryFilterGroup } from "@/components/common/QueryBar.vue";
import DataTable, { type DataTableColumn } from "@/components/common/DataTable.vue";
import EmptyState from "@/components/common/EmptyState.vue";
import DataState from "@/components/common/DataState.vue";
import ObjectSheet from "@/components/common/ObjectSheet.vue";
import NodeLabel from "@/components/common/NodeLabel.vue";
import RowMenu, { type RowMenuItem } from "@/components/common/RowMenu.vue";
import ConfirmDialog from "@/components/common/ConfirmDialog.vue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

import ApprovalReview from "./ApprovalReview.vue";
import {
  UNKNOWN_WRITER,
  approvalWaitLabelKey,
  groupApprovalsIntoEvents,
  isApprovalMoving,
  isApprovalStuck,
  partitionBatchResults,
  runWithConcurrency,
  type ApprovalEventGroup,
} from "./approvalsModel";
import {
  STALE_SLICE,
  activeListParams,
  agentUpdatePlanParams,
  agentUpdateRowsNeedingPlans,
  approvalDigest,
  mergeApprovalRows,
  slicePageParams,
  type CachedPlan,
} from "./approvalsListModel";
import {
  APPROVAL_HISTORY_GRAMMAR,
  APPROVAL_LAYERS,
  APPROVAL_PAGE_SIZE,
  AUTO_LAYER,
  HISTORY_RANGES,
  HISTORY_STATUSES,
  defaultApprovalLayer,
  historyRequest,
  legacyApprovalQuery,
  namePreview,
  nextToReview,
  normalizeApprovalPage,
  stuckReasonSummary,
  type ApprovalLayer,
  type ApprovalLayerChoice,
  type ApprovalPage,
  type ReviewItem,
} from "./approvalsPageModel";
import { pageBounds, rangeWindow } from "./opsQueryModel";
import { useOpsQuery } from "./useOpsQuery";

const { t, locale } = useI18n();
const auth = useAuthStore();

/** One owned route: layer, history query and sheet write the same address. */
const owned = useOwnedRoute();

// Old links: ?selected=<id> (SSH Guard), ?bucket= (plugins), read once.
watch(
  () => owned.query(),
  (current) => {
    if (!owned.owns()) return;
    const next = legacyApprovalQuery(current);
    if (next) owned.replace(next);
  },
  { immediate: true },
);

const choice = bindLayer<ApprovalLayerChoice>(owned, () => APPROVAL_LAYERS, () => AUTO_LAYER);

/* ------------------------------------------------------------------ */
/* Nodes, for names                                                    */
/* ------------------------------------------------------------------ */

const nodesQuery = useAsyncData((signal) => api.nodes.list({ signal }).then((r) => unwrap(r, "nodes")), { pollInterval: 60_000 });
const nodes = computed<Node[]>(() => nodesQuery.data.value ?? []);
provideNodeDirectory(nodes);

function nodeName(id: string | undefined): string {
  if (!id) return t("common.misc.global");
  return nodes.value.find((node) => node.id === id)?.name || id;
}

const resolvers = computed<TokenResolvers>(() => ({
  node: {
    toId: (value) => {
      const list = nodes.value;
      return list.find((node) => node.id === value)?.id ?? list.find((node) => (node.name ?? "").toLowerCase() === value.toLowerCase())?.id;
    },
    label: (id) => nodes.value.find((node) => node.id === id)?.name || id,
  },
}));

/* ------------------------------------------------------------------ */
/* The inbox: the open set, the stale agent updates, the counts        */
/* ------------------------------------------------------------------ */

const activeQuery = useAsyncData((signal) => api.approvals.list(activeListParams(), { signal }).then((r) => unwrap(r, "approvals")), {
  pollInterval: 8000,
});
const countsQuery = useAsyncData<ApprovalCounts>((signal) => api.approvals.counts(undefined, { signal }), { pollInterval: 8000 });
const weekCountsQuery = useAsyncData<ApprovalCounts>(
  (signal) => api.approvals.counts({ since: new Date(Date.now() - 7 * 86_400_000).toISOString() }, { signal }),
  { pollInterval: 30_000 },
);
/**
 * Agent updates the control plane rejected for going stale: the open set
 * cannot reach them (the listing rejects a stale agent update on its way
 * out), and each still needs a fresh plan or a dismissal.
 */
const staleSliceQuery = useAsyncData((signal) => api.approvals.list(slicePageParams(STALE_SLICE), { signal }).then((r) => unwrap(r, "approvals")), {
  pollInterval: 30_000,
});

const planCache = ref<Record<string, CachedPlan>>({});
const { digestFor, digestHex } = usePlanDigest();

async function rememberPlan(row: ApprovalView): Promise<void> {
  if (row.plan === undefined) return;
  const sha256 = row.plan_sha256 || (await digestHex(row.plan));
  planCache.value = { ...planCache.value, [row.id]: { plan: row.plan, sha256 } };
}

async function fetchFull(id: string): Promise<ApprovalView> {
  const full = await api.approvals.get(id);
  await rememberPlan(full);
  return full;
}

// Event cards group agent updates by the version transition in the plan
// text; the open set is read without it, so those rows get one narrow read.
let hydrating = false;
watch(
  () => activeQuery.data.value,
  async (rows) => {
    if (!rows || hydrating || agentUpdateRowsNeedingPlans(rows, planCache.value).length === 0) return;
    hydrating = true;
    try {
      for (const row of unwrap(await api.approvals.list(agentUpdatePlanParams()), "approvals")) await rememberPlan(row);
    } catch {
      // Cards then group without the transition until the next poll.
    } finally {
      hydrating = false;
    }
  },
  { immediate: true },
);

const inbox = computed(() =>
  mergeApprovalRows({
    active: activeQuery.data.value ?? [],
    history: [staleSliceQuery.data.value ?? []],
    plans: planCache.value,
  }),
);

/** Items a batch already decided, hidden until the next read says where they went. */
const concealed = ref<Set<string>>(new Set());
watch(
  () => activeQuery.data.value,
  () => {
    concealed.value = new Set();
  },
);

const pendingRows = computed(() => inbox.value.filter((row) => isActionablePendingApproval(row) && !concealed.value.has(row.id)));
const newestFirst = (a: ApprovalView, b: ApprovalView) => (b.updated_at || b.created_at || "").localeCompare(a.updated_at || a.created_at || "");
/** Stale agent updates still open (pending or approved): each needs a fresh plan or a dismissal. */
const staleRows = computed(() =>
  inbox.value.filter((row) => isStaleAgentUpdateApprovalView(row) && (row.status === "pending" || row.status === "approved")).sort(newestFirst),
);
/**
 * Stale agent updates the control plane already rejected. Closed, so they
 * do not count as waiting on anyone, but a fresh plan or a dismissal is
 * still the way to clear them, so Needs you lists them, folded.
 */
const staleClosedRows = computed(() => inbox.value.filter((row) => isStaleAgentUpdateApprovalView(row) && row.status === "rejected").sort(newestFirst));
const staleClosedOpen = ref(false);
const stuckRows = computed(() =>
  inbox.value.filter(isApprovalStuck).sort((a, b) => (a.updated_at || a.created_at || "").localeCompare(b.updated_at || b.created_at || "")),
);
const movingCount = computed(() => inbox.value.filter(isApprovalMoving).length);
/** Approved, not applied, and the server sent no reason (a control plane older than the field). */
const unexplainedRows = computed(() => inbox.value.filter((row) => row.status === "approved" && !row.waiting).sort(newestFirst));
const unexplainedCount = computed(() => unexplainedRows.value.length);
const needsCount = computed(() => pendingRows.value.length + staleRows.value.length);
const eventGroups = computed(() => groupApprovalsIntoEvents(pendingRows.value));

/**
 * The bare address is resolved once per visit: approving the last pending
 * plan, or a new one arriving, must not swap the layer under the operator.
 */
const settledDefault = ref<ApprovalLayer | null>(null);
const layer = computed<ApprovalLayer | null>(() => {
  if (choice.value !== AUTO_LAYER) return choice.value;
  if (settledDefault.value) return settledDefault.value;
  return defaultApprovalLayer({
    needs: needsCount.value,
    read: activeQuery.data.value !== undefined,
    failed: activeQuery.data.value === undefined && !!activeQuery.error.value,
  });
});
watch(
  layer,
  (value) => {
    if (value && choice.value === AUTO_LAYER && !settledDefault.value && activeQuery.data.value !== undefined) settledDefault.value = value;
  },
  { immediate: true },
);
const layerModel = computed<ApprovalLayer>({
  get: () => layer.value ?? "needs",
  set: (value) => {
    choice.value = value;
  },
});

/* ------------------------------------------------------------------ */
/* History: one server query                                           */
/* ------------------------------------------------------------------ */

const query = useOpsQuery({
  grammar: APPROVAL_HISTORY_GRAMMAR,
  resolvers: () => resolvers.value,
  defaultRange: "all",
  unchecked: () => nodesQuery.data.value === undefined,
  noText: () => t("operations.approvals.query.noText"),
  notFilter: (key) => (key === "actor" ? t("operations.approvals.query.notFilterActor") : t("operations.approvals.query.notFilter", { key })),
  owned,
});
const bar = ref<InstanceType<typeof QueryBar> | null>(null);
const showingHistory = computed(() => layer.value === "history");

const historyQuery = useAsyncData<ApprovalPage>(
  async (signal) => {
    const params = historyRequest({ tokens: query.applied.value, window: rangeWindow(query.range.value, Date.now()), offset: query.offset.value });
    return normalizeApprovalPage(await api.approvals.list(params, { signal }), params);
  },
  { immediate: false },
);
watch(
  () => [showingHistory.value, query.appliedKey.value, JSON.stringify(query.range.value), query.offset.value] as const,
  () => {
    if (showingHistory.value) void historyQuery.refresh();
  },
  { immediate: true },
);
const HISTORY_POLL_MS = 30_000;
const historyPolling = computed(() => showingHistory.value && query.offset.value === 0);
const historyTimer = setInterval(() => {
  if (historyPolling.value && document.visibilityState !== "hidden") void historyQuery.refresh();
}, HISTORY_POLL_MS);
onScopeDispose(() => clearInterval(historyTimer));

const historyRows = computed(() => historyQuery.data.value?.approvals ?? []);
const historyTotal = computed(() => historyQuery.data.value?.total ?? 0);
const historyBounds = computed(() => pageBounds(query.offset.value, historyRows.value.length));
const historyFiltered = computed(() => query.narrowed.value || query.range.value.range !== "all");
/** No plan has ever been filed here and nothing narrows the list: no toolbar over nothing. */
const historyNothing = computed(() => historyQuery.data.value !== undefined && historyTotal.value === 0 && !historyFiltered.value);

function num(n: number): string {
  return n.toLocaleString(locale.value);
}

/* ------------------------------------------------------------------ */
/* Who may decide what                                                 */
/* ------------------------------------------------------------------ */

const canApply = computed(() => auth.can("network:apply"));

function extraScope(approval: ApprovalView): string {
  switch (approval.plugin) {
    case "nftpolicy":
      return "netpolicy:admin";
    case "agentupdate":
      return "node:admin";
    case "selfdns":
      return "dns:admin";
    case "proxycore":
      return "proxy:admin";
    case "cftunnel":
      return "tunnel:admin";
    default:
      return "";
  }
}

function canDecide(approval?: ApprovalView): boolean {
  if (!approval || !canApply.value) return false;
  const scope = extraScope(approval);
  return scope === "" || auth.can(scope);
}

function isStale(approval?: ApprovalView): boolean {
  return isStaleAgentUpdateApprovalView(approval);
}

function staleReason(approval?: ApprovalView): string {
  if (!approval || approval.plugin !== "agentupdate") return "";
  if (approval.stale || approval.stale_code === APPROVAL_STALE_AGENT_UPDATE_POLICY_CHANGED) return approval.reason || t("operations.approvals.toastStale");
  return approval.reason ?? "";
}

function canReplan(approval?: ApprovalView): boolean {
  return !!approval?.node_id && approval.plugin === "agentupdate" && isStale(approval) && auth.can("node:admin") && auth.can("network:plan");
}

function canDismissStale(approval?: ApprovalView): boolean {
  return !!approval && approval.plugin === "agentupdate" && approval.status !== "dismissed" && isStale(approval) && canDecide(approval);
}

function canDismissWaiting(approval?: ApprovalView): boolean {
  return !!approval && approval.waiting?.dismissible === true && canDecide(approval);
}

/* ------------------------------------------------------------------ */
/* The sheet                                                           */
/* ------------------------------------------------------------------ */

const sheet = bindRouteOpen(owned, undefined, { fallback: () => afterDecisionTarget() });

const openQuery = useAsyncData<ApprovalView | null>(
  async () => {
    const id = sheet.openId.value;
    return id ? fetchFull(id) : null;
  },
  { immediate: false },
);
watch(
  () => sheet.openId.value,
  (id) => {
    if (id) void openQuery.refresh();
  },
  { immediate: true },
);
const openTimer = setInterval(() => {
  if (sheet.openId.value && document.visibilityState !== "hidden") void openQuery.refresh();
}, 10_000);
onScopeDispose(() => clearInterval(openTimer));

/** What the page already holds for the open id, shown while its full record is read. */
const openListed = computed(() => {
  const id = sheet.openId.value;
  if (!id) return undefined;
  return inbox.value.find((row) => row.id === id) ?? historyRows.value.find((row) => row.id === id);
});
const openRecord = computed<ApprovalView | undefined>(() => {
  const full = openQuery.data.value;
  if (full && full.id === sheet.openId.value) return full;
  return openListed.value;
});
const openPlanState = computed<"ready" | "loading" | "error">(() => {
  if (openRecord.value?.plan !== undefined) return "ready";
  if (openQuery.error.value) return "error";
  return "loading";
});
const sheetState = computed<"ready" | "loading" | "gone" | "stale">(() => {
  if (openRecord.value) return openQuery.error.value && openQuery.data.value ? "stale" : "ready";
  if (openQuery.error.value) return "gone";
  return "loading";
});
/**
 * Why the open plan is not on screen when the read failed for a reason
 * other than the plan being absent or unreadable to this token (404, 403):
 * a failed read never says the plan does not exist.
 */
const openReadFailure = computed<string | null>(() => {
  const error = openQuery.error.value as (Error & { status?: number }) | undefined;
  if (!error || error.status === 404 || error.status === 403) return null;
  return error.message;
});

function changeLabel(approval: ApprovalView): string {
  return `${approval.plugin} · ${approval.action}`;
}

/* ------------------------------------------------------------------ */
/* Focus after a decision                                              */
/* ------------------------------------------------------------------ */

/** The card a decision was made on, by position, so focus can land on the one in its place. */
let decidedIndex = -1;
/** The Stuck row that takes a dismissed row's place: the next row, or the one before it when it was last. */
let decidedRowNeighbour: string | null = null;
/** The control that opened a confirm; gone when the decision removed its card or row. */
let confirmOpener: HTMLElement | null = null;

/** The Stuck table's rows as shown, without the unexplained list nested under it. */
function stuckRowElements(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[data-testid="approvals-stuck"] tbody tr[data-row-key]')].filter(
    (row) => !row.closest('[data-testid="approvals-unexplained"]'),
  );
}

/**
 * Called as a confirm opens. A decision made away from the cards (the sheet,
 * a Stuck row, a stale section) clears the card position, so focus never
 * lands by an earlier card decision's index. A decision from a Stuck row's
 * menu remembers the row's menu button (the menu item is gone once the menu
 * closes) and the row that takes its place.
 */
function rememberOpener(groupKey?: string, rowKey?: string): void {
  const rows = rowKey ? stuckRowElements() : [];
  const at = rows.findIndex((row) => row.dataset.rowKey === rowKey);
  const rowMenu = at >= 0 ? rows[at]?.querySelector<HTMLElement>('[data-testid="row-menu"]') : null;
  confirmOpener = rowMenu ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
  decidedIndex = groupKey === undefined ? -1 : eventGroups.value.findIndex((group) => group.key === groupKey);
  decidedRowNeighbour = at >= 0 ? ((rows[at + 1] ?? rows[at - 1])?.dataset.rowKey ?? null) : null;
}

function sheetTitle(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-testid="object-sheet"] [data-slot="dialog-title"]');
}

function activeLayerTab(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-testid="layer-tabs"] [data-state="active"]');
}

/**
 * Where focus goes once the control that made a decision is gone: the open
 * sheet's title, else the Stuck row now in the dismissed row's place, else
 * the card now in the decided card's place (or the last card), else the
 * current layer's tab. Never the document.
 */
function afterDecisionTarget(): HTMLElement | null {
  if (sheet.openId.value && sheetTitle()) return sheetTitle();
  const neighbour = decidedRowNeighbour ? stuckRowElements().find((row) => row.dataset.rowKey === decidedRowNeighbour) : undefined;
  if (neighbour) return neighbour;
  if (layer.value === "needs") {
    const cards = [...document.querySelectorAll<HTMLElement>("[data-event-card] [data-card-primary]")];
    if (cards.length) return cards[Math.min(Math.max(decidedIndex, 0), cards.length - 1)] ?? null;
  }
  return activeLayerTab();
}

function confirmReturn(): HTMLElement | null {
  return confirmOpener?.isConnected ? confirmOpener : afterDecisionTarget();
}

function focusSheetTitle(): void {
  void nextTick(() => sheetTitle()?.focus());
}

/* ------------------------------------------------------------------ */
/* Decisions                                                           */
/* ------------------------------------------------------------------ */

const pending = ref<string | null>(null);
const dismissing = ref<string | null>(null);
const replanning = ref<string | null>(null);
const decisionError = ref<{ id: string; message: string } | null>(null);

function decisionDigest(item: ApprovalView): Promise<string> {
  return approvalDigest(item, { hashPlan: digestFor, fetchFull });
}

async function refreshAfterDecision(): Promise<void> {
  await Promise.all([activeQuery.refresh(), countsQuery.refresh(), weekCountsQuery.refresh(), staleSliceQuery.refresh()]);
  if (sheet.openId.value) void openQuery.refresh();
  if (showingHistory.value) void historyQuery.refresh();
}

/*
 * After a decision in the sheet the footer offers the next plan in the inbox,
 * so a queue is worked through as "decide, next" (approvalsPageModel
 * .nextToReview). Only after a decision made in this sheet: a decided plan
 * opened from History does not grow a "next" button.
 */
const reviewOrder = computed<ReviewItem[]>(() =>
  eventGroups.value.flatMap((group) => group.items.map((item) => ({ id: item.id, decidable: canDecide(item) && !isStale(item) }))),
);
const decidedInSheet = ref<{ id: string; index: number } | null>(null);
watch(
  () => sheet.openId.value,
  (id) => {
    if (decidedInSheet.value && id !== decidedInSheet.value.id) decidedInSheet.value = null;
  },
);

function rememberSheetDecision(approval: ApprovalView): void {
  if (sheet.openId.value !== approval.id) return;
  decidedInSheet.value = { id: approval.id, index: reviewOrder.value.findIndex((item) => item.id === approval.id) };
}

const nextPlan = computed(() => {
  const decided = decidedInSheet.value;
  const open = openRecord.value;
  if (!decided || !open || open.id !== decided.id || open.status === "pending") return null;
  return nextToReview(reviewOrder.value, decided);
});

function reviewNext(): void {
  const next = nextPlan.value;
  if (!next) return;
  sheet.open(next.id);
  focusSheetTitle();
}

async function approve(approval: ApprovalView, queueApply: boolean): Promise<void> {
  pending.value = approval.id;
  decisionError.value = null;
  try {
    await api.approvals.approve(approval.id, queueApply, await decisionDigest(approval));
    rememberSheetDecision(approval);
    toast.success(queueApply ? t("operations.approvals.toastQueued") : t("operations.approvals.toastRecorded"));
    // The sheet stays open on the decided plan and its footer is gone.
    if (sheet.openId.value === approval.id) focusSheetTitle();
  } catch (error) {
    const message = error instanceof Error ? error.message : t("operations.approvals.toastFailed");
    const stale = isApprovalStaleError(error);
    decisionError.value = { id: approval.id, message: stale ? t("operations.approvals.toastStale") : message };
    toast.error(stale ? t("operations.approvals.toastStale") : message);
  } finally {
    pending.value = null;
    await refreshAfterDecision();
  }
}

// One confirm for every closing decision: a single reject, a batch reject,
// a dismissal. The operator reads what is about to close before it closes.
const confirm = ref<{
  title: string;
  description: string;
  label: string;
  impact?: string[];
  impactTitle?: string;
  variant?: "destructive" | "default";
  run: () => Promise<void>;
} | null>(null);
const confirmPending = ref(false);
const confirmOpen = computed({
  get: () => !!confirm.value,
  set: (open: boolean) => {
    if (!open && !confirmPending.value) confirm.value = null;
  },
});

async function runConfirmed(): Promise<void> {
  const current = confirm.value;
  if (!current || confirmPending.value) return;
  confirmPending.value = true;
  try {
    await current.run();
  } finally {
    confirmPending.value = false;
    confirm.value = null;
  }
}

function askReject(approval: ApprovalView, groupKey?: string): void {
  rememberOpener(groupKey);
  confirm.value = {
    title: t("operations.approvals.rejectTitle", { change: changeLabel(approval), node: nodeName(approval.node_id) }),
    description: t("operations.approvals.rejectConfirm"),
    label: t("operations.approvals.reject"),
    run: () => performReject(approval),
  };
}

async function performReject(approval: ApprovalView): Promise<void> {
  pending.value = approval.id;
  decisionError.value = null;
  try {
    await api.approvals.reject(approval.id);
    rememberSheetDecision(approval);
    toast.success(t("operations.approvals.toastRejected"));
  } catch (error) {
    const message = error instanceof Error ? error.message : t("operations.approvals.toastRejectFailed");
    decisionError.value = { id: approval.id, message };
    toast.error(message);
  } finally {
    pending.value = null;
    await refreshAfterDecision();
  }
}

async function dismiss(approval: ApprovalView): Promise<void> {
  dismissing.value = approval.id;
  decisionError.value = null;
  try {
    await api.approvals.dismiss(approval.id);
    toast.success(t("operations.approvals.toastDismissed"));
  } catch (error) {
    const message = error instanceof Error ? error.message : t("operations.approvals.toastDismissFailed");
    decisionError.value = { id: approval.id, message };
    toast.error(message);
  } finally {
    dismissing.value = null;
    await refreshAfterDecision();
  }
}

function askDismissWaiting(approval: ApprovalView, fromRow = false): void {
  rememberOpener(undefined, fromRow ? approval.id : undefined);
  confirm.value = {
    title: t("operations.approvals.waiting.dismissTitle"),
    description: t("operations.approvals.waiting.dismissConfirm", { plugin: approval.plugin, action: approval.action, node: nodeName(approval.waiting?.node_id || approval.node_id) }),
    label: t("operations.approvals.waiting.dismiss"),
    run: () => dismiss(approval),
  };
}

/**
 * Clear a stale list in one decision instead of one trip through the sheet
 * per row. Dismissing is irreversible inside Lattice (the plan stays on
 * record as dismissed), so it confirms with what happens.
 */
function askDismissAll(rows: ApprovalView[]): void {
  if (!rows.length) return;
  rememberOpener();
  confirm.value = {
    title: t("operations.approvals.needs.dismissAllTitle", { n: rows.length }),
    description: t("operations.approvals.needs.dismissAllDescription"),
    label: t("operations.approvals.needs.dismissAll", { n: rows.length }),
    impact: [t("operations.approvals.needs.dismissAllImpactList"), t("operations.approvals.needs.dismissAllImpactReplan")],
    impactTitle: t("operations.approvals.needs.dismissAllImpactTitle"),
    run: () => performDismissAll(rows),
  };
}

async function performDismissAll(rows: ApprovalView[]): Promise<void> {
  const results = await runWithConcurrency(rows, 4, (row) => api.approvals.dismiss(row.id));
  const { succeeded, failed } = partitionBatchResults(rows, results);
  if (failed.length === 0) toast.success(t("operations.approvals.needs.toastDismissedAll", { count: succeeded.length }, succeeded.length));
  else toast.warning(t("operations.approvals.needs.toastDismissPartial", { done: succeeded.length, failed: failed.length, reason: failed[0]?.error ?? "" }));
  await refreshAfterDecision();
}

const forceReplan = ref<{ approval: ApprovalView; message: string } | null>(null);
const forceReplanOpen = computed({
  get: () => !!forceReplan.value,
  set: (open: boolean) => {
    if (!open) forceReplan.value = null;
  },
});

async function replan(approval: ApprovalView, force = false): Promise<void> {
  if (!canReplan(approval)) return;
  replanning.value = approval.id;
  try {
    const fresh = await api.agentUpdates.plan(approval.node_id, force || undefined);
    toast.success(t("operations.approvals.replanCreated"));
    forceReplan.value = null;
    await refreshAfterDecision();
    if (fresh?.id) sheet.open(fresh.id);
  } catch (error) {
    if (isAgentUpdateNoopError(error) && !force) {
      forceReplan.value = { approval, message: error.message || t("operations.approvals.forceReplanAlreadyTarget") };
    } else {
      toast.error(error instanceof Error ? error.message : t("operations.approvals.replanFailed"));
    }
  } finally {
    replanning.value = null;
  }
}

/* ------------------------------------------------------------------ */
/* Batch decisions on an event card                                    */
/* ------------------------------------------------------------------ */

interface BatchState {
  running: boolean;
  done: number;
  total: number;
  failed: number;
  error: string;
}
const batches = ref<Record<string, BatchState>>({});
const expanded = ref<Set<string>>(new Set());

function toggleExpanded(key: string): void {
  const next = new Set(expanded.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  expanded.value = next;
}

function eventTitle(group: ApprovalEventGroup<ApprovalView>): string {
  if (group.titleKind === "fleet-upgrade") {
    return group.transition
      ? t("operations.approvals.events.titleFleetUpgrade", { current: group.transition.current, target: group.transition.target })
      : t("operations.approvals.events.titleFleetUpgradeUnknown");
  }
  if (group.titleKind === "linemeta-sync") return t("operations.approvals.events.titleLinemetaSync");
  // The action as the plan and the sheet spell it ("sshguard · arm"), not title-cased.
  return `${group.plugin} · ${group.actionPrefix}`;
}

function joinPreview(names: string[], shown = 6): string {
  const preview = namePreview(names, shown);
  const list = preview.names.join(", ");
  return preview.extra ? t("operations.approvals.events.andMore", { names: list, count: preview.extra }) : list;
}

/** The first nodes a card names, by id so NodeLabel prints names, and how many more. */
function nodePreview(group: ApprovalEventGroup<ApprovalView>): { ids: string[]; extra: number } {
  const ids = [...new Set(group.items.map((item) => item.node_id || ""))];
  return { ids: ids.slice(0, 6), extra: Math.max(0, ids.length - 6) };
}

/** The stale lists Needs you shows: open ones as they are, closed ones folded. */
const staleParts = computed(() => {
  const parts: { key: string; title: string; hint: string; rows: ApprovalView[]; foldable: boolean; dismissable: ApprovalView[] }[] = [];
  if (staleRows.value.length) {
    parts.push({
      key: "stale",
      title: t("operations.approvals.needs.staleTitle", { n: staleRows.value.length }),
      hint: t("operations.approvals.staleDescription"),
      rows: staleRows.value,
      foldable: false,
      dismissable: staleRows.value.filter(canDismissStale),
    });
  }
  if (staleClosedRows.value.length) {
    parts.push({
      key: "stale-closed",
      title: t("operations.approvals.needs.staleClosedTitle", { n: staleClosedRows.value.length }),
      hint: t("operations.approvals.needs.staleClosedHint"),
      rows: staleClosedRows.value,
      foldable: true,
      dismissable: staleClosedRows.value.filter(canDismissStale),
    });
  }
  return parts;
});

function eventWriter(group: ApprovalEventGroup<ApprovalView>): string {
  return group.writer === UNKNOWN_WRITER ? t("operations.approvals.events.unknownWriter") : group.writer;
}

function askRejectGroup(group: ApprovalEventGroup<ApprovalView>): void {
  const targets = group.items.filter((item) => item.status === "pending");
  if (!targets.length || batches.value[group.key]?.running) return;
  // One plan is named, not counted ("Reject all 1 approvals?").
  if (targets.length === 1 && targets[0]) {
    askReject(targets[0], group.key);
    return;
  }
  rememberOpener(group.key);
  confirm.value = {
    title: t("operations.approvals.events.rejectAllTitle", { count: targets.length }),
    description: t("operations.approvals.events.rejectAllConfirm", { count: targets.length, title: eventTitle(group) }),
    label: t("operations.approvals.events.rejectAll", { count: targets.length }),
    run: () => performBatch(group, "reject", targets),
  };
}

/**
 * Approve a batch through a preview of what goes out. The hashes are read
 * before the dialog opens, so the preview shows the exact values each
 * approval sends, and a plan that cannot be read stops here with a reason.
 */
async function askApproveGroup(group: ApprovalEventGroup<ApprovalView>): Promise<void> {
  const targets = group.items.filter((item) => item.status === "pending");
  if (!targets.length || batches.value[group.key]?.running) return;
  rememberOpener(group.key);
  let digests: Map<string, string>;
  try {
    digests = new Map(await Promise.all(targets.map(async (item) => [item.id, await decisionDigest(item)] as const)));
  } catch (error) {
    toast.error(t("operations.approvals.events.digestsFailed", { message: error instanceof Error ? error.message : String(error) }));
    return;
  }
  const names = [...new Set(targets.map((item) => nodeName(item.node_id)))];
  const hashes = [...new Set(digests.values())].map((digest) => shortId(digest, 12));
  const offline = [...new Set(targets.map((item) => item.node_id))]
    .map((id) => nodes.value.find((node) => node.id === id))
    .filter((node): node is Node => !!node && !isReporting(node))
    .map((node) => node.name || node.id);
  const impact = [
    names.length === 1 && names[0]
      ? t("operations.approvals.events.previewNodesOne", { name: names[0] })
      : t("operations.approvals.events.previewNodes", { n: names.length, names: joinPreview(names) }),
    t("operations.approvals.events.previewDigests", { digests: joinPreview(hashes, 3) }),
  ];
  if (offline.length) impact.push(t("operations.approvals.events.previewOffline", { names: joinPreview(offline) }));
  confirm.value = {
    title: t("operations.approvals.events.approveAllTitle", { title: eventTitle(group), count: targets.length }),
    description: t("operations.approvals.events.approveAllDescription"),
    label: t("operations.approvals.events.approveAllConfirm", { count: targets.length }),
    impact,
    impactTitle: t("operations.approvals.events.previewTitle"),
    variant: "default",
    run: () => performBatch(group, "approve-queue", targets, digests),
  };
}

async function performBatch(
  group: ApprovalEventGroup<ApprovalView>,
  mode: "approve-queue" | "reject",
  targets: ApprovalView[],
  digests?: Map<string, string>,
): Promise<void> {
  batches.value = { ...batches.value, [group.key]: { running: true, done: 0, total: targets.length, failed: 0, error: "" } };
  const results = await runWithConcurrency(
    targets,
    4,
    async (item) => {
      if (mode === "approve-queue") await api.approvals.approve(item.id, true, digests?.get(item.id) ?? (await decisionDigest(item)));
      else await api.approvals.reject(item.id);
    },
    (done, total) => {
      const state = batches.value[group.key];
      if (state) batches.value = { ...batches.value, [group.key]: { ...state, done, total } };
    },
  );
  const { succeeded, failed } = partitionBatchResults(targets, results);
  const hidden = new Set(concealed.value);
  for (const item of succeeded) hidden.add(item.id);
  concealed.value = hidden;
  const next = { ...batches.value };
  if (failed.length === 0) {
    toast.success(t(`operations.approvals.events.${mode === "approve-queue" ? "toastBatchApproveDone" : "toastBatchRejectDone"}`, { count: succeeded.length }, succeeded.length));
    delete next[group.key];
  } else {
    toast.warning(
      t(`operations.approvals.events.${mode === "approve-queue" ? "toastBatchApprovePartial" : "toastBatchRejectPartial"}`, { done: succeeded.length, failed: failed.length }),
    );
    next[group.key] = { running: false, done: targets.length, total: targets.length, failed: failed.length, error: failed[0]?.error ?? "" };
  }
  batches.value = next;
  await Promise.all([countsQuery.refresh(), weekCountsQuery.refresh()]);
  // The open set re-reads last: its watcher lifts the concealment.
  await activeQuery.refresh();
}

/* ------------------------------------------------------------------ */
/* The head                                                            */
/* ------------------------------------------------------------------ */

const proof = useProof([activeQuery, countsQuery]);

const proofSegments = computed<ProofSegment[]>(() => {
  const segments: ProofSegment[] = [];
  const counts = countsQuery.data.value;
  if (counts) segments.push({ key: "total", text: t("operations.approvals.proof.plans", { n: num(counts.total) }) });
  if (movingCount.value) segments.push({ key: "moving", text: t("operations.approvals.proof.moving", { n: movingCount.value }) });
  if (unexplainedCount.value) {
    segments.push({
      key: "unexplained",
      text: t("operations.approvals.proof.unexplained", { n: unexplainedCount.value }, unexplainedCount.value),
      tone: "warning",
      to: { query: { view: "stuck" } },
    });
  }
  if (showingHistory.value && historyQuery.data.value) {
    if (historyFiltered.value) segments.push({ key: "match", text: t("operations.approvals.proof.match", { n: num(historyTotal.value) }) });
    if (!historyQuery.data.value.serverFiltered) segments.push({ key: "client", text: t("operations.approvals.proof.clientFiltered"), tone: "warning" });
  }
  return segments;
});

/**
 * The proof of the stuck class in one short line: the reason that matters
 * most (a failed apply, else the most common) and how many are stuck for
 * something else. The Stuck layer lists every row with its own reason.
 */
function stuckProof(rows: ApprovalView[]): string {
  const summary = stuckReasonSummary(rows);
  const lead = summary.find((entry) => entry.code === "task_failed") ?? summary[0];
  if (!lead) return "";
  const reason = t(approvalWaitLabelKey(lead.code));
  const more = rows.length - lead.count;
  return more > 0
    ? t("operations.approvals.attention.reasonMore", { reason, n: lead.count, more })
    : t("operations.approvals.attention.reasonCount", { reason, n: lead.count });
}

/** Show the stale list in Needs you, scrolled to, for a class with more than one row. */
function showStale(): void {
  layerModel.value = "needs";
  void nextTick(() => document.querySelector('[data-testid="approvals-stale"]')?.scrollIntoView({ block: "start" }));
}

/**
 * One line per class, not per plan. Stuck plans have a layer and stale
 * agent updates have a list in Needs you, so each class is stated once with
 * where its rows are; listing them item by item repeated the Stuck layer and
 * pushed the plans waiting on the operator two phone screens down. A class
 * of one opens its plan directly.
 */
const attention = computed<AttentionItem[]>(() => {
  const items: AttentionItem[] = [];
  const stuck = stuckRows.value;
  const onlyStuck = stuck.length === 1 ? stuck[0] : undefined;
  if (onlyStuck) {
    items.push({
      key: "stuck",
      tone: onlyStuck.waiting?.code === "task_failed" ? "danger" : "warning",
      claim: t("operations.approvals.attention.stuck", { change: changeLabel(onlyStuck), node: nodeName(onlyStuck.node_id) }),
      proof: onlyStuck.waiting?.reason ?? t(approvalWaitLabelKey(onlyStuck.waiting?.code)),
      action: { label: t("operations.approvals.attention.open"), run: () => sheet.open(onlyStuck.id) },
    });
  } else if (stuck.length > 1) {
    items.push({
      key: "stuck",
      tone: stuck.some((row) => row.waiting?.code === "task_failed") ? "danger" : "warning",
      claim: t("operations.approvals.attention.stuckClass", { n: stuck.length }, stuck.length),
      proof: stuckProof(stuck),
      action: { label: t("operations.approvals.attention.showStuck"), run: () => (layerModel.value = "stuck") },
    });
  }
  const stale = staleRows.value;
  const onlyStale = stale.length === 1 ? stale[0] : undefined;
  if (onlyStale) {
    items.push({
      key: "stale",
      tone: "warning",
      claim: t("operations.approvals.attention.stale", { node: nodeName(onlyStale.node_id) }),
      proof: staleReason(onlyStale) || undefined,
      action: { label: t("operations.approvals.attention.open"), run: () => sheet.open(onlyStale.id) },
    });
  } else if (stale.length > 1) {
    items.push({
      key: "stale",
      tone: "warning",
      claim: t("operations.approvals.attention.staleClass", { n: stale.length }, stale.length),
      action: { label: t("operations.approvals.attention.showStale"), run: showStale },
    });
  }
  if (!canApply.value) items.push({ key: "scope", tone: "info", claim: t("operations.approvals.applyRequired") });
  return items;
});

const metrics = computed<Metric[]>(() => {
  if (activeQuery.data.value === undefined) return [];
  const week = weekCountsQuery.data.value;
  return [
    {
      key: "needs",
      label: t("operations.approvals.metrics.needs"),
      value: num(needsCount.value),
      tone: needsCount.value > 0 ? "warning" : "default",
      to: { query: { view: "needs" } },
    },
    {
      key: "applied",
      label: t("operations.approvals.metrics.applied7d"),
      value: week ? num(week.applied ?? 0) : t("operations.approvals.metrics.notRead"),
      tone: week ? "default" : "muted",
      to: { query: { view: "history", status: "applied", range: "7d" } },
    },
    {
      key: "rejected",
      label: t("operations.approvals.metrics.rejected7d"),
      value: week ? num(week.rejected ?? 0) : t("operations.approvals.metrics.notRead"),
      tone: week ? "default" : "muted",
      to: { query: { view: "history", status: "rejected", range: "7d" } },
    },
    {
      key: "stuck",
      label: t("operations.approvals.metrics.stuck"),
      value: num(stuckRows.value.length),
      tone: stuckRows.value.length > 0 ? "destructive" : "default",
      to: { query: { view: "stuck" } },
    },
  ];
});

const layerTabs = computed<LayerTab<ApprovalLayer>[]>(() => [
  { value: "needs", label: t("operations.approvals.layers.needs"), count: activeQuery.data.value ? needsCount.value : undefined, tone: needsCount.value > 0 ? "warning" : "default" },
  { value: "history", label: t("operations.approvals.layers.history") },
  { value: "stuck", label: t("operations.approvals.layers.stuck"), count: activeQuery.data.value ? stuckRows.value.length : undefined, tone: stuckRows.value.length > 0 ? "destructive" : "default" },
]);

/* ------------------------------------------------------------------ */
/* Tables                                                              */
/* ------------------------------------------------------------------ */

function statusLabel(status: string): string {
  return t(`common.status.${status}`);
}

const historyColumns = computed<DataTableColumn<ApprovalView>[]>(() => [
  { key: "change", label: t("operations.approvals.columns.what") },
  { key: "status", label: t("operations.approvals.columns.status") },
  { key: "target", label: t("operations.approvals.columns.target") },
  { key: "writer", label: t("operations.approvals.sheet.writer") },
  { key: "updated", label: t("operations.approvals.sheet.updated"), align: "right" },
  { key: "actions", label: "", align: "right", class: "w-10" },
]);

const stuckColumns = computed<DataTableColumn<ApprovalView>[]>(() => [
  { key: "change", label: t("operations.approvals.columns.what") },
  { key: "target", label: t("operations.approvals.columns.target") },
  { key: "why", label: t("operations.approvals.stuckLayer.why"), class: "min-w-[16rem] max-w-[30rem]" },
  { key: "updated", label: t("operations.approvals.stuckLayer.approved"), align: "right" },
  { key: "actions", label: "", align: "right", class: "w-10" },
]);

const staleColumns = computed<DataTableColumn<ApprovalView>[]>(() => [
  { key: "change", label: t("operations.approvals.columns.what") },
  { key: "target", label: t("operations.approvals.columns.target") },
  { key: "why", label: t("operations.approvals.rejectionReason"), class: "min-w-[16rem] max-w-[30rem]" },
  { key: "updated", label: t("operations.approvals.sheet.updated"), align: "right" },
]);

function historyMenu(row: ApprovalView): RowMenuItem[] {
  return [
    {
      key: "node",
      label: t("operations.approvals.menu.openNode"),
      icon: ExternalLink,
      hidden: !row.node_id,
      to: row.node_id ? { name: "node-detail", params: { id: row.node_id } } : undefined,
    },
    {
      key: "tasks",
      label: t("operations.approvals.menu.tasks"),
      icon: ClipboardList,
      hidden: row.status === "pending" || !auth.can("task:read"),
      to: { name: "tasks", query: { approval_id: row.id } },
    },
  ];
}

function stuckMenu(row: ApprovalView): RowMenuItem[] {
  return [
    ...historyMenu(row),
    {
      key: "superseding",
      label: t("operations.approvals.waiting.openSuperseding"),
      icon: FileCode2,
      hidden: !row.waiting?.superseded_by,
      run: () => row.waiting?.superseded_by && sheet.open(row.waiting.superseded_by),
    },
    {
      key: "dismiss",
      label: t("operations.approvals.waiting.dismiss"),
      danger: true,
      hidden: !row.waiting?.dismissible || !canApply.value,
      disabled: !canDismissWaiting(row),
      reason: canDismissWaiting(row) ? undefined : t("operations.approvals.applyRequired"),
      run: () => askDismissWaiting(row, true),
    },
  ];
}

/* ------------------------------------------------------------------ */
/* History filters popover                                             */
/* ------------------------------------------------------------------ */

const filterCount = computed(() => {
  const applied = query.applied.value;
  return (applied.enums.status?.length ?? 0) + (applied.values.plugin ? 1 : 0) + (applied.values.node ? 1 : 0);
});

const PLUGINS = ["agentupdate", "vpn-core", "netguard", "nftpolicy", "sshguard", "wireguard", "sub-store"] as const;

const filterGroups = computed<QueryFilterGroup[]>(() => {
  const applied = query.applied.value;
  return [
    {
      key: "status",
      legend: t("operations.approvals.columns.status"),
      options: HISTORY_STATUSES.map((status) => ({
        key: status,
        label: statusLabel(status),
        token: `status:${status}`,
        checked: applied.enums.status?.includes(status) ?? false,
        toggle: () =>
          query.edit(bar, (next) => {
            const list = next.enums.status ?? [];
            next.enums.status = list.includes(status) ? list.filter((v) => v !== status) : [...list, status];
            if (!next.enums.status.length) delete next.enums.status;
          }),
      })),
    },
    {
      key: "plugin",
      legend: t("operations.approvals.query.plugin"),
      options: PLUGINS.map((plugin) => ({
        key: plugin,
        label: plugin,
        token: `plugin:${plugin}`,
        checked: applied.values.plugin === plugin,
        toggle: () =>
          query.edit(bar, (next) => {
            if (next.values.plugin === plugin) delete next.values.plugin;
            else next.values.plugin = plugin;
          }),
      })),
    },
  ];
});

function rangeText(): string {
  const range = query.range.value.range;
  return t(`operations.opsRange.proof.${range === "custom" ? "all" : range}`);
}

function refreshAll(): void {
  concealed.value = new Set();
  void activeQuery.refresh();
  void countsQuery.refresh();
  void weekCountsQuery.refresh();
  void staleSliceQuery.refresh();
  void nodesQuery.refresh();
  if (showingHistory.value) void historyQuery.refresh();
  if (sheet.openId.value) void openQuery.refresh();
}
</script>

<template>
  <div class="space-y-5 p-4 sm:p-6">
    <PageHeader :title="$t('operations.approvals.title')">
      <template #description>
        <p class="text-sm text-muted-foreground">{{ $t('operations.approvals.description') }}</p>
        <ProofLine v-bind="proof" :segments="proofSegments" data-testid="approvals-proof-line" @retry="refreshAll" />
      </template>
      <template #actions>
        <Button variant="outline" size="sm" :disabled="activeQuery.refreshing.value" @click="refreshAll">
          <RefreshCw :class="cn('size-4', activeQuery.refreshing.value && 'animate-spin')" aria-hidden="true" />
          {{ $t('common.actions.refresh') }}
        </Button>
      </template>
    </PageHeader>

    <AttentionList :items="attention" />
    <MetricStrip v-if="metrics.length" :metrics="metrics" :columns="4" data-testid="approvals-metrics" />

    <template v-if="layer">
      <LayerTabs v-model="layerModel" :tabs="layerTabs" :label="$t('operations.approvals.layers.label')" />

      <!-- Needs you: pending plans grouped by change, and stale agent updates. -->
      <section v-if="layer === 'needs'" class="space-y-4" data-testid="approvals-needs">
        <DataState
          v-if="activeQuery.data.value === undefined"
          :loading="activeQuery.loading.value || !activeQuery.error.value"
          :error="activeQuery.error.value"
          @retry="refreshAll"
        />
        <EmptyState
          v-else-if="!eventGroups.length && !staleRows.length && !staleClosedRows.length"
          tone="positive"
          :title="$t('operations.approvals.needs.emptyTitle')"
          :description="$t('operations.approvals.needs.emptyDescription')"
          data-testid="approvals-needs-empty"
        >
          <Button variant="outline" size="sm" type="button" @click="layerModel = 'history'">{{ $t('operations.approvals.needs.openHistory') }}</Button>
          <Button v-if="stuckRows.length" size="sm" type="button" @click="layerModel = 'stuck'">
            {{ $t('operations.approvals.waiting.showStuck') }}
          </Button>
        </EmptyState>

        <template v-else>
          <p v-if="!eventGroups.length && !staleRows.length" class="rounded-lg border border-dashed border-border px-4 py-3 text-sm text-muted-foreground" data-testid="approvals-needs-none">
            {{ $t('operations.approvals.needs.noneWaiting') }}
          </p>
          <ul v-if="eventGroups.length" class="space-y-3" :aria-label="$t('operations.approvals.needs.eventsLabel')">
            <li v-for="group in eventGroups" :key="group.key" class="rounded-lg border border-border bg-card" data-event-card>
              <div class="space-y-2 p-4">
                <div class="flex flex-wrap items-start justify-between gap-2">
                  <div class="min-w-0">
                    <p class="text-sm font-medium leading-snug">{{ eventTitle(group) }}</p>
                    <p class="mt-0.5 text-xs text-muted-foreground">
                      {{ $t('operations.approvals.events.count', { count: group.items.length }, group.items.length) }}
                      · {{ $t('operations.approvals.events.writerBy', { writer: eventWriter(group) }) }}
                      · {{ $t('operations.approvals.events.newest', { age: formatRelativeTime(group.newestCreatedAt) }) }}
                    </p>
                  </div>
                  <Badge v-if="group.isSystem" variant="secondary" class="shrink-0">{{ $t('operations.approvals.events.systemBadge') }}</Badge>
                </div>
                <p class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                  <span v-for="id in nodePreview(group).ids" :key="id" class="max-w-48 truncate rounded border border-border px-1.5 py-0.5">
                    <NodeLabel v-if="id" :id="id" />
                    <template v-else>{{ $t('common.misc.global') }}</template>
                  </span>
                  <span v-if="nodePreview(group).extra > 0">{{ $t('operations.approvals.events.nodesMore', { count: nodePreview(group).extra }) }}</span>
                </p>
                <p v-if="batches[group.key]?.running" class="flex items-center gap-2 text-xs text-muted-foreground">
                  <RefreshCw class="size-3.5 animate-spin" aria-hidden="true" />
                  {{ $t('operations.approvals.events.progress', { done: batches[group.key]?.done ?? 0, total: batches[group.key]?.total ?? 0 }) }}
                </p>
                <div v-if="batches[group.key]?.error" class="rounded-md border border-destructive/40 bg-destructive/5 p-2.5 text-xs text-muted-foreground">
                  <p class="font-medium text-foreground">
                    {{ $t('operations.approvals.events.batchErrorTitle', { failed: batches[group.key]?.failed ?? 0, total: batches[group.key]?.total ?? 0 }) }}
                  </p>
                  <p class="mt-0.5 break-words">{{ batches[group.key]?.error }}</p>
                </div>
                <p v-if="!canDecide(group.items[0])" class="text-xs text-muted-foreground" data-testid="approvals-card-readonly">
                  {{ extraScope(group.items[0]!)
                    ? $t('operations.approvals.events.readOnlyScope', { scope: extraScope(group.items[0]!) }, group.items.length)
                    : $t('operations.approvals.events.readOnly', group.items.length) }}
                </p>
                <div class="flex flex-wrap items-center gap-2 pt-1">
                  <!-- One plan: read it first; Approve and queue is in the sheet beside the diff and the hash. -->
                  <Button
                    v-if="group.items.length === 1"
                    type="button"
                    size="sm"
                    data-card-primary
                    :data-row-key="group.items[0]?.id"
                    @click="(event: MouseEvent) => group.items[0] && sheet.open(group.items[0].id, event.currentTarget as HTMLElement)"
                  >
                    <FileCode2 class="size-4" aria-hidden="true" />
                    {{ $t('operations.approvals.needs.review') }}
                  </Button>
                  <template v-else>
                    <Button
                      type="button"
                      size="sm"
                      data-card-primary
                      :disabled="!canDecide(group.items[0]) || !!batches[group.key]?.running"
                      @click="askApproveGroup(group)"
                    >
                      <Play class="size-4" aria-hidden="true" />
                      {{ $t('operations.approvals.events.approveAllQueue', { count: group.items.length }) }}
                    </Button>
                    <Button type="button" variant="ghost" size="sm" :aria-expanded="expanded.has(group.key)" @click="toggleExpanded(group.key)">
                      <ChevronDown :class="cn('size-4 transition-transform', expanded.has(group.key) && 'rotate-180')" aria-hidden="true" />
                      {{ expanded.has(group.key) ? $t('operations.approvals.events.collapse') : $t('operations.approvals.events.expand') }}
                    </Button>
                  </template>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    class="ms-auto text-destructive"
                    :disabled="!canDecide(group.items[0]) || !!batches[group.key]?.running"
                    @click="askRejectGroup(group)"
                  >
                    <Ban class="size-4" aria-hidden="true" />
                    {{ group.items.length === 1 ? $t('operations.approvals.reject') : $t('operations.approvals.events.rejectAll', { count: group.items.length }) }}
                  </Button>
                </div>
              </div>
              <ul v-if="expanded.has(group.key)" class="divide-y divide-border border-t border-border">
                <li v-for="item in group.items" :key="item.id">
                  <button
                    type="button"
                    :data-row-key="item.id"
                    :aria-current="sheet.openId.value === item.id ? 'true' : undefined"
                    :class="cn(
                      'flex w-full min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-left text-sm outline-none transition-colors hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                      sheet.openId.value === item.id && 'bg-primary/5',
                    )"
                    @click="(event) => sheet.open(item.id, event.currentTarget as HTMLElement)"
                  >
                    <NodeLabel v-if="item.node_id" :id="item.node_id" class="font-medium" />
                    <span v-else class="font-medium">{{ $t('common.misc.global') }}</span>
                    <span class="truncate text-xs text-muted-foreground">{{ changeLabel(item) }}</span>
                    <span class="ms-auto text-xs text-muted-foreground" :title="formatDateTime(item.created_at)">{{ formatRelativeTime(item.created_at) }}</span>
                  </button>
                </li>
              </ul>
            </li>
          </ul>

          <section v-for="part in staleParts" :key="part.key" class="space-y-2" :data-testid="`approvals-${part.key}`">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <h2 class="text-sm font-medium">{{ part.title }}</h2>
              <div class="flex flex-wrap items-center gap-2">
                <Button
                  v-if="part.dismissable.length > 1"
                  variant="outline"
                  size="sm"
                  type="button"
                  :data-testid="`approvals-${part.key}-dismiss-all`"
                  @click="askDismissAll(part.dismissable)"
                >
                  {{ $t('operations.approvals.needs.dismissAll', { n: part.dismissable.length }) }}
                </Button>
                <Button v-if="part.foldable" variant="ghost" size="sm" type="button" :aria-expanded="staleClosedOpen" @click="staleClosedOpen = !staleClosedOpen">
                  <ChevronDown :class="cn('size-4 transition-transform', staleClosedOpen && 'rotate-180')" aria-hidden="true" />
                  {{ staleClosedOpen ? $t('operations.approvals.events.collapse') : $t('operations.approvals.needs.showClosed') }}
                </Button>
              </div>
            </div>
            <p class="text-xs text-muted-foreground">{{ part.hint }}</p>
            <DataTable
              v-if="!part.foldable || staleClosedOpen"
              :columns="staleColumns"
              :rows="part.rows"
              :row-key="(row) => row.id"
              :show-summary="false"
              :row-click="(row, el) => sheet.open(row.id, el)"
              :active-row-id="sheet.openId.value"
            >
              <template #cell-change="{ row }">
                <p class="truncate text-sm font-medium">{{ changeLabel(row) }}</p>
              </template>
              <template #cell-target="{ row }"><NodeLabel :id="row.node_id" /></template>
              <template #cell-why="{ row }">
                <p class="line-clamp-2 break-words text-xs text-muted-foreground">{{ staleReason(row) }}</p>
              </template>
              <template #cell-updated="{ row }">
                <span class="whitespace-nowrap text-xs text-muted-foreground" :title="formatDateTime(row.updated_at)">{{ formatRelativeTime(row.updated_at || row.created_at) }}</span>
              </template>
            </DataTable>
          </section>
        </template>
      </section>

      <!-- History: one server query. -->
      <template v-else-if="layer === 'history'">
        <QueryBar
          v-if="!historyNothing"
          ref="bar"
          testid="approvals-query-bar"
          :applied-text="query.appliedText.value"
          :applied-key="query.appliedKey.value"
          :label="$t('operations.approvals.query.label')"
          :placeholder="$t('operations.approvals.query.placeholder')"
          :ready="nodesQuery.data.value !== undefined || nodesQuery.error.value !== undefined"
          :problems="query.problems"
          :canonical="query.canonical"
          :ranges="HISTORY_RANGES"
          :range="query.range.value.range"
          :range-label="(value) => $t(`operations.opsRange.${value}`)"
          :filter-count="filterCount"
          :filter-groups="filterGroups"
          :filters-hint="$t('operations.approvals.query.filtersHint')"
          @submit="query.submit"
          @clear="query.clear"
          @update:range="query.setRange"
        />
        <DataTable
          :columns="historyColumns"
          :rows="historyRows"
          :row-key="(row) => row.id"
          :loading="historyQuery.loading.value || (historyQuery.data.value === undefined && !historyQuery.error.value)"
          :error="historyQuery.error.value"
          :has-data="historyQuery.data.value !== undefined"
          :show-summary="false"
          :row-click="(row, el) => sheet.open(row.id, el)"
          :active-row-id="sheet.openId.value"
          data-testid="approvals-history-table"
          @retry="historyQuery.refresh"
        >
          <template #empty>
            <EmptyState
              v-if="!historyFiltered"
              :title="$t('operations.approvals.emptyTitle')"
              :description="$t('operations.approvals.emptyDescription')"
            />
            <EmptyState v-else :title="$t('operations.approvals.noMatchTitle')" :description="$t('operations.approvals.history.noMatch', { range: rangeText() })">
              <Button v-if="query.range.value.range !== 'all'" variant="outline" size="sm" type="button" @click="query.setRange('all')">
                {{ $t('operations.opsRange.searchAnyTime') }}
              </Button>
              <Button v-else variant="outline" size="sm" type="button" @click="query.clear()">{{ $t('operations.tasks.empty.clearQuery') }}</Button>
            </EmptyState>
          </template>
          <template #cell-change="{ row }">
            <div class="min-w-0">
              <p class="truncate text-sm font-medium" :title="changeLabel(row)">{{ changeLabel(row) }}</p>
              <p class="truncate font-mono text-xs text-muted-foreground" :title="row.id">{{ shortId(row.id, 14) }}</p>
            </div>
          </template>
          <template #cell-status="{ row }">
            <div class="flex flex-wrap items-center gap-1">
              <Badge v-if="isStale(row)" variant="outline">{{ $t('operations.approvals.staleBadge') }}</Badge>
              <Badge v-else :variant="approvalStatusMeta(row.status).badgeVariant">{{ statusLabel(row.status) }}</Badge>
              <Badge v-if="isApprovalStuck(row)" variant="warning">{{ $t('operations.approvals.waiting.stuckBadge') }}</Badge>
            </div>
          </template>
          <template #cell-target="{ row }">
            <NodeLabel v-if="row.node_id" :id="row.node_id" />
            <span v-else class="text-muted-foreground">{{ $t('common.misc.global') }}</span>
          </template>
          <template #cell-writer="{ row }">
            <span class="text-sm">{{ row.actor_id || $t('operations.approvals.events.unknownWriter') }}</span>
            <span v-if="row.approved_by || row.rejected_by" class="block text-xs text-muted-foreground">
              {{ row.approved_by ? $t('operations.approvals.sheet.approvedBy', { actor: row.approved_by }) : $t('operations.approvals.sheet.rejectedBy', { actor: row.rejected_by }) }}
            </span>
          </template>
          <template #cell-updated="{ row }">
            <span class="whitespace-nowrap text-xs text-muted-foreground tabular" :title="formatDateTime(row.updated_at)">{{ formatRelativeTime(row.updated_at || row.created_at) }}</span>
          </template>
          <template #cell-actions="{ row }">
            <RowMenu :name="changeLabel(row)" :items="historyMenu(row)" />
          </template>
        </DataTable>
        <div v-if="historyQuery.data.value !== undefined && historyRows.length" class="flex flex-wrap items-center justify-between gap-2 text-sm" data-testid="approvals-pager">
          <span class="text-muted-foreground tabular">
            {{ $t('operations.tasks.showingRange', { from: num(historyBounds.from), to: num(historyBounds.to), total: num(historyTotal) }) }}
          </span>
          <div class="flex items-center gap-2">
            <span v-if="!historyPolling" class="text-xs text-muted-foreground">{{ $t('operations.audit.pausedPastFirst') }}</span>
            <Button variant="outline" size="sm" :disabled="query.offset.value === 0 || historyQuery.loading.value" @click="query.setOffset(query.offset.value - APPROVAL_PAGE_SIZE)">
              <ChevronLeft class="size-4" aria-hidden="true" />
              {{ $t('operations.audit.prev') }}
            </Button>
            <Button variant="outline" size="sm" :disabled="historyBounds.to >= historyTotal || historyQuery.loading.value" @click="query.setOffset(query.offset.value + APPROVAL_PAGE_SIZE)">
              {{ $t('operations.audit.next') }}
              <ChevronRight class="size-4" aria-hidden="true" />
            </Button>
          </div>
        </div>
      </template>

      <!-- Stuck: approved, and going nowhere. -->
      <section v-else class="space-y-2" data-testid="approvals-stuck">
        <p class="text-sm text-muted-foreground">{{ $t('operations.approvals.bucketHint.stuck') }}</p>
        <DataTable
          :columns="stuckColumns"
          :rows="stuckRows"
          :row-key="(row) => row.id"
          :loading="activeQuery.loading.value"
          :error="activeQuery.error.value"
          :has-data="activeQuery.data.value !== undefined"
          :show-summary="false"
          :row-click="(row, el) => sheet.open(row.id, el)"
          :active-row-id="sheet.openId.value"
          @retry="refreshAll"
        >
          <template #empty>
            <EmptyState
              tone="positive"
              :title="$t('operations.approvals.stuckLayer.emptyTitle')"
              :description="unexplainedCount
                ? $t('operations.approvals.stuckLayer.emptyDescriptionUnexplained')
                : $t('operations.approvals.stuckLayer.emptyDescription')"
            />
          </template>
          <template #cell-change="{ row }">
            <p class="truncate text-sm font-medium" :title="changeLabel(row)">{{ changeLabel(row) }}</p>
          </template>
          <template #cell-target="{ row }">
            <NodeLabel v-if="row.node_id" :id="row.node_id" />
            <span v-else class="text-muted-foreground">{{ $t('common.misc.global') }}</span>
          </template>
          <template #cell-why="{ row }">
            <p class="flex items-start gap-1.5 text-xs">
              <ServerOff class="mt-0.5 size-3.5 shrink-0 text-warning-text" aria-hidden="true" />
              <span class="min-w-0">
                <span class="font-medium text-foreground">{{ $t(approvalWaitLabelKey(row.waiting?.code)) }}</span>
                <span class="line-clamp-2 break-words text-muted-foreground">{{ row.waiting?.reason }}</span>
              </span>
            </p>
          </template>
          <template #cell-updated="{ row }">
            <span class="whitespace-nowrap text-xs text-muted-foreground" :title="formatDateTime(row.updated_at)">{{ formatRelativeTime(row.updated_at || row.created_at) }}</span>
          </template>
          <template #cell-actions="{ row }">
            <RowMenu :name="changeLabel(row)" :items="stuckMenu(row)" />
          </template>
        </DataTable>

        <!-- Approved, not applied, and no reason from the server: not counted as stuck, since nobody knows. -->
        <section v-if="unexplainedRows.length" class="space-y-2 pt-3" data-testid="approvals-unexplained">
          <h2 class="text-sm font-medium">{{ $t('operations.approvals.stuckLayer.unexplainedTitle', { n: unexplainedRows.length }) }}</h2>
          <p class="text-xs text-muted-foreground">{{ $t('operations.approvals.waiting.unexplainedBody') }}</p>
          <DataTable
            :columns="staleColumns.filter((column) => column.key !== 'why')"
            :rows="unexplainedRows"
            :row-key="(row) => row.id"
            :show-summary="false"
            :row-click="(row, el) => sheet.open(row.id, el)"
            :active-row-id="sheet.openId.value"
          >
            <template #cell-change="{ row }">
              <p class="truncate text-sm font-medium" :title="changeLabel(row)">{{ changeLabel(row) }}</p>
            </template>
            <template #cell-target="{ row }">
              <NodeLabel v-if="row.node_id" :id="row.node_id" />
              <span v-else class="text-muted-foreground">{{ $t('common.misc.global') }}</span>
            </template>
            <template #cell-updated="{ row }">
              <span class="whitespace-nowrap text-xs text-muted-foreground" :title="formatDateTime(row.updated_at)">{{ formatRelativeTime(row.updated_at || row.created_at) }}</span>
            </template>
          </DataTable>
        </section>
      </section>
    </template>

    <ObjectSheet
      :open="!!sheet.openId.value"
      :title="openRecord ? changeLabel(openRecord) : $t('operations.approvals.sheet.title')"
      :subtitle="sheet.openId.value ?? undefined"
      :state="sheetState"
      :error="openQuery.error.value?.message ?? null"
      :read-only="openRecord?.status === 'pending' && !canDecide(openRecord)"
      :gone-title="openReadFailure ? $t('operations.approvals.sheet.notReadTitle') : $t('operations.approvals.sheet.goneTitle')"
      :gone-description="openReadFailure
        ? $t('operations.approvals.sheet.notReadDescription', { reason: openReadFailure })
        : $t('operations.approvals.sheet.goneDescription')"
      :return-focus="sheet.returnFocus"
      @close="sheet.close"
    >
      <ApprovalReview
        v-if="openRecord"
        :approval="openRecord"
        :plan-state="openPlanState"
        :plan-error="openQuery.error.value?.message ?? null"
        :stale="isStale(openRecord)"
        :stale-reason="staleReason(openRecord)"
        :can-replan="canReplan(openRecord)"
        :can-dismiss-stale="canDismissStale(openRecord)"
        :can-dismiss-waiting="canDismissWaiting(openRecord)"
        :dismissing="dismissing === openRecord.id"
        :replanning="replanning === openRecord.id"
        :decision-error="decisionError?.id === openRecord.id ? decisionError.message : null"
        @retry-plan="openQuery.refresh"
        @dismiss-waiting="askDismissWaiting(openRecord)"
        @dismiss-stale="dismiss(openRecord)"
        @replan="replan(openRecord)"
        @open-approval="(id) => sheet.open(id)"
      />
      <template v-if="openRecord && openRecord.status === 'pending' && !isStale(openRecord)" #actions>
        <Button type="button" variant="outline" size="sm" :disabled="!canDecide(openRecord) || pending === openRecord.id" @click="approve(openRecord, false)">
          <CheckCircle2 class="size-4" aria-hidden="true" />
          {{ $t('operations.approvals.approveOnly') }}
        </Button>
        <Button type="button" size="sm" :disabled="!canDecide(openRecord) || pending === openRecord.id" @click="approve(openRecord, true)">
          <RefreshCw v-if="pending === openRecord.id" class="size-4 animate-spin" aria-hidden="true" />
          <Play v-else class="size-4" aria-hidden="true" />
          {{ $t('operations.approvals.approveAndQueue') }}
        </Button>
        <Button type="button" variant="ghost" size="sm" class="ms-auto text-destructive" :disabled="!canDecide(openRecord) || pending === openRecord.id" @click="askReject(openRecord)">
          <Ban class="size-4" aria-hidden="true" />
          {{ $t('operations.approvals.reject') }}
        </Button>
      </template>
      <template v-else-if="nextPlan" #actions>
        <Button type="button" size="sm" data-testid="approvals-review-next" @click="reviewNext">
          {{ $t('operations.approvals.sheet.reviewNext', { n: nextPlan.waiting }) }}
          <ChevronRight class="size-4" aria-hidden="true" />
        </Button>
      </template>
    </ObjectSheet>

    <ConfirmDialog
      v-model:open="confirmOpen"
      :title="confirm?.title ?? ''"
      :description="confirm?.description ?? ''"
      :impact="confirm?.impact"
      :impact-title="confirm?.impactTitle"
      :variant="confirm?.variant ?? 'destructive'"
      :confirm-label="confirm?.label ?? $t('operations.approvals.reject')"
      :cancel-label="$t('common.actions.cancel')"
      :pending="confirmPending"
      :return-focus="confirmReturn"
      @confirm="runConfirmed"
    />

    <Dialog v-model:open="forceReplanOpen">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{{ $t('operations.approvals.forceReplanTitle') }}</DialogTitle>
          <DialogDescription>{{ forceReplan?.message }}</DialogDescription>
        </DialogHeader>
        <p class="text-sm text-muted-foreground">{{ $t('operations.approvals.forceReplanHint') }}</p>
        <DialogFooter>
          <DialogClose as-child>
            <Button type="button" variant="outline">{{ $t('common.actions.cancel') }}</Button>
          </DialogClose>
          <Button type="button" :disabled="!!forceReplan && replanning === forceReplan.approval.id" @click="forceReplan && replan(forceReplan.approval, true)">
            <RefreshCw v-if="!!forceReplan && replanning === forceReplan.approval.id" class="size-4 animate-spin" aria-hidden="true" />
            <FileCode2 v-else class="size-4" aria-hidden="true" />
            {{ $t('operations.approvals.forceReplanAgentUpdate') }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
