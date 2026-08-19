<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute } from "vue-router";
import { toast } from "vue-sonner";
import { AlertTriangle, ArchiveX, Ban, CheckCircle2, ChevronDown, ChevronRight, FileCode2, Funnel, GitCompare, Play, RefreshCw, Search, ShieldCheck } from "lucide-vue-next";
import {
  api,
  APPROVAL_STALE_AGENT_UPDATE_POLICY_CHANGED,
  isAgentUpdateNoopError,
  isActionablePendingApproval,
  isApprovalStaleError,
  isStaleAgentUpdateApprovalView,
  unwrap,
  type ApprovalStatus,
  type ApprovalView,
} from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { usePlanDigest } from "@/composables/usePlanDigest";
import { useAuthStore } from "@/stores/auth";
import { approvalStatusMeta } from "@/lib/status";
import { formatDateTime, formatRelativeTime, shortId } from "@/lib/format";
import { evalFilterExpression, tokenMatchesText } from "@/lib/filterExpressions";
import { cn } from "@/lib/utils";
import {
  UNKNOWN_WRITER,
  groupApprovalsIntoEvents,
  groupNodePreview,
  isApprovalEventGroupable,
  partitionBatchResults,
  runWithConcurrency,
  type ApprovalEventGroup,
} from "./approvalsModel";

import PageHeader from "@/components/common/PageHeader.vue";
import ConfirmDialog from "@/components/common/ConfirmDialog.vue";
import DataState from "@/components/common/DataState.vue";
import DataTable, { type DataTableColumn } from "@/components/common/DataTable.vue";
import FreshnessLabel from "@/components/common/FreshnessLabel.vue";
import CopyButton from "@/components/common/CopyButton.vue";
import PlanDiff from "@/components/common/PlanDiff.vue";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useRouteTab } from "@/composables/useRouteTab";

const { t } = useI18n();
const route = useRoute();
const auth = useAuthStore();
const includeDismissed = ref(false);
const approvalsQuery = useAsyncData(() => api.approvals.list({ include_dismissed: includeDismissed.value }).then((r) => unwrap(r, "approvals")), {
  pollInterval: 8000,
});

const selectedId = ref("");
type ApprovalBucket = "active" | "pending" | "stale" | "approved" | "applied" | "rejected" | "dismissed" | "all";
const approvalBucket = ref<ApprovalBucket>("active");
const approvalSearch = ref("");
const approvalExpression = ref("");
const pendingApproval = ref<string | undefined>();
const hashingApproval = ref<string | undefined>();
const dismissingApproval = ref<string | undefined>();
const replanningApproval = ref<string | undefined>();
const forceReplanOpen = ref(false);
const forceReplanApproval = ref<ApprovalView | undefined>();
const forceReplanMessage = ref("");
const { digestFor, cache: digestCache } = usePlanDigest();

const approvals = computed(() => approvalsQuery.data.value ?? []);
const pending = computed(() => approvals.value.filter(isActionablePendingApproval));
const selected = computed<ApprovalView | undefined>(() =>
  filteredApprovals.value.find((approval) => approval.id === selectedId.value) ?? filteredApprovals.value[0],
);
const canApply = computed(() => auth.can("network:apply"));
const canDecideSelected = computed(() => canDecideApproval(selected.value));

const planView = ref<"diff" | "full">("diff");
const lastApprovalError = ref<{ approvalId: string; message: string; stale: boolean } | undefined>();
const selectedAgentUpdateStale = computed(() => {
  const approval = selected.value;
  if (!approval || approval.plugin !== "agentupdate") return false;
  if (isStaleAgentUpdateApproval(approval)) return true;
  return lastApprovalError.value?.approvalId === approval.id && lastApprovalError.value.stale;
});
const selectedAgentUpdateStaleReason = computed(() => {
  if (!selectedAgentUpdateStale.value) return "";
  return staleAgentUpdateReason(selected.value) || lastApprovalError.value?.message || t("operations.approvals.toastStale");
});
const canApproveSelected = computed(() => canDecideSelected.value && !selectedAgentUpdateStale.value);
const canReplanSelectedAgentUpdate = computed(() => canReplanAgentUpdate(selected.value, selectedAgentUpdateStale.value));
const canDismissSelectedApproval = computed(() => canDismissApproval(selected.value, selectedAgentUpdateStale.value));

// The most recent earlier applied plan for the same target (node + plugin +
// action), i.e. what is actually live. Approved-but-not-applied plans are not a
// live baseline and would make the diff lie about the current state.
const previousPlan = computed(() => {
  const cur = selected.value;
  if (!cur) return "";
  const prior = approvals.value
    .filter(
      (a) =>
        a.id !== cur.id &&
        a.node_id === cur.node_id &&
        a.plugin === cur.plugin &&
        a.action === cur.action &&
        a.status === "applied" &&
        (a.created_at || "") < (cur.created_at || ""),
    )
    .sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
  return prior[0]?.plan ?? "";
});

const sortedApprovals = computed(() =>
  [...approvals.value].sort((a, b) => {
    const rank = approvalRank(a) - approvalRank(b);
    if (rank !== 0) return rank;
    const created = (b.created_at || "").localeCompare(a.created_at || "");
    if (created !== 0) return created;
    return a.id.localeCompare(b.id);
  }),
);

const APPROVAL_BUCKETS: ApprovalBucket[] = ["active", "pending", "stale", "approved", "applied", "rejected", "dismissed", "all"];

function matchesBucket(approval: ApprovalView, bucket: ApprovalBucket): boolean {
  switch (bucket) {
    case "active":
      return isActionablePendingApproval(approval) || isStaleAgentUpdateApproval(approval) || approval.status === "approved";
    case "pending":
      return isActionablePendingApproval(approval);
    case "stale":
      return isStaleAgentUpdateApproval(approval);
    case "approved":
      return approval.status === "approved";
    case "applied":
      return approval.status === "applied";
    case "rejected":
      return approval.status === "rejected";
    case "dismissed":
      return approval.status === "dismissed";
    default:
      return true;
  }
}

function approvalHaystack(approval: ApprovalView): string {
  return [
    approval.id,
    approval.plugin,
    approval.action,
    approval.node_id,
    approval.status,
    approval.reason,
    approval.actor_id,
    approval.approved_by,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

const approvalExpressionError = computed(() => {
  const expr = approvalExpression.value.trim();
  if (!expr) return "";
  const result = evalFilterExpression(expr, () => true);
  return result.ok ? "" : result.error ?? t("common.table.expressionInvalid");
});

function approvalFieldValues(approval: ApprovalView, rawField: string): string[] {
  const field = rawField.trim().toLowerCase().replace(/[\s-]+/g, "_");
  switch (field) {
    case "id":
      return [approval.id, shortId(approval.id)];
    case "plugin":
    case "service":
      return [approval.plugin];
    case "action":
    case "mode":
      return [approval.action];
    case "node":
    case "node_id":
    case "target":
      return [approval.node_id || "global"];
    case "status":
    case "state":
      return [approval.status, isStaleAgentUpdateApproval(approval) ? "stale" : ""];
    case "reason":
    case "message":
      return [approval.reason ?? "", approval.stale_code ?? ""];
    case "actor":
    case "actor_id":
    case "created_by":
      return [approval.actor_id ?? ""];
    case "approved":
    case "approved_by":
    case "reviewer":
      return [approval.approved_by ?? ""];
    case "plan":
    case "diff":
      return [approval.plan ?? ""];
    case "created":
    case "created_at":
      return [approval.created_at ?? ""];
    case "updated":
    case "updated_at":
      return [approval.updated_at ?? ""];
    default:
      return [];
  }
}

function approvalMatchesExpression(approval: ApprovalView): boolean {
  const expr = approvalExpression.value.trim();
  if (!expr || approvalExpressionError.value) return true;
  const result = evalFilterExpression(expr, (rawToken) => {
    const splitAt = rawToken.indexOf(":");
    if (splitAt > 0) {
      const values = approvalFieldValues(approval, rawToken.slice(0, splitAt));
      const needle = rawToken.slice(splitAt + 1).trim();
      return values.length > 0 && values.some((value) => tokenMatchesText(value, needle));
    }
    return tokenMatchesText(approvalHaystack(approval), rawToken);
  });
  return result.ok ? result.value : true;
}

const bucketCounts = computed<Record<ApprovalBucket, number>>(() => {
  const counts = Object.fromEntries(APPROVAL_BUCKETS.map((bucket) => [bucket, 0])) as Record<ApprovalBucket, number>;
  for (const approval of approvals.value) {
    for (const bucket of APPROVAL_BUCKETS) {
      if (matchesBucket(approval, bucket)) counts[bucket] += 1;
    }
  }
  return counts;
});

const filteredApprovals = computed(() => {
  const q = approvalSearch.value.trim().toLowerCase();
  return sortedApprovals.value.filter((approval) => {
    if (!matchesBucket(approval, approvalBucket.value)) return false;
    if (!approvalMatchesExpression(approval)) return false;
    if (!q) return true;
    return approvalHaystack(approval).includes(q);
  });
});

watch(includeDismissed, () => {
  approvalsQuery.refresh();
});

/**
 * Deep-link: /approvals?selected=<id> lands on that approval.
 *
 * A caller that just created an approval knows its id, so handing over a bare
 * /approvals and letting the operator hunt for it in a list of hundreds is a
 * loss of information the page can avoid. Seeded once per id so a poll never
 * yanks the selection back, and the bucket widens when the target sits outside
 * the current slice, since a link that quietly selects something else is worse
 * than one that does nothing.
 */
const seededSelection = ref<string | undefined>(undefined);
watch(
  [approvals, () => route.query.selected],
  ([list, queryId]) => {
    const id = typeof queryId === "string" ? queryId : undefined;
    if (!id || id === seededSelection.value) return;
    if (!list.some((approval) => approval.id === id)) return;
    seededSelection.value = id;
    selectedId.value = id;
    if (!filteredApprovals.value.some((approval) => approval.id === id)) {
      approvalBucket.value = "all";
    }
  },
  { immediate: true },
);

// A fresh read retires batch state: failures still pending reappear as their
// own card by grouping, so a lingering per-card error banner would describe a
// batch the data no longer matches. Entries for batches still in flight stay
// (the poll must not flicker a running progress display).
watch(
  () => approvalsQuery.data.value,
  () => {
    const running: Record<string, EventBatchState> = {};
    for (const [key, state] of Object.entries(eventBatches.value)) {
      if (state.running) running[key] = state;
    }
    eventBatches.value = running;
  },
);

watch(approvalBucket, () => {
  // Re-slicing the inbox is an explicit re-read, so drop the batch concealment.
  concealedIds.value = new Set();
});

// ── Event aggregation + batch disposition ────────────────────────────────────
// The default inbox groups actionable approvals into one card per underlying
// change (see approvalsModel). `concealedIds` hides items a batch has already
// disposed of: approve-and-queue leaves an item in "approved" until the agent
// applies it, so without concealment a fully successful batch would regroup
// into the same card and look like it did nothing. Concealed items stay
// visible in the Individual tab; any manual refresh or filter change
// re-syncs from the server.
type InboxTab = "events" | "individual";
/** Tab lives in the URL so a grouped inbox and a flat list are both linkable. */
const inboxTab = useRouteTab<InboxTab>(() => ["events", "individual"], () => "events");
const expandedEventKeys = ref<Set<string>>(new Set());
const concealedIds = ref<Set<string>>(new Set());

interface EventBatchState {
  running: boolean;
  done: number;
  total: number;
  failed: number;
  error: string;
}
const eventBatches = ref<Record<string, EventBatchState>>({});

const eventGroups = computed(() =>
  groupApprovalsIntoEvents(
    filteredApprovals.value.filter(
      (approval) =>
        isApprovalEventGroupable(approval) && !isStaleAgentUpdateApproval(approval) && !concealedIds.value.has(approval.id),
    ),
  ),
);

function eventTitleFor(group: ApprovalEventGroup<ApprovalView>): string {
  if (group.titleKind === "fleet-upgrade") {
    return group.transition
      ? t("operations.approvals.events.titleFleetUpgrade", {
          current: group.transition.current,
          target: group.transition.target,
        })
      : t("operations.approvals.events.titleFleetUpgradeUnknown");
  }
  if (group.titleKind === "linemeta-sync") return t("operations.approvals.events.titleLinemetaSync");
  return group.title;
}

function eventWriterFor(group: ApprovalEventGroup<ApprovalView>): string {
  return group.writer === UNKNOWN_WRITER ? t("operations.approvals.events.unknownWriter") : group.writer;
}

function eventPendingItems(group: ApprovalEventGroup<ApprovalView>): ApprovalView[] {
  return group.items.filter((item) => item.status === "pending");
}

function eventApprovedCount(group: ApprovalEventGroup<ApprovalView>): number {
  return group.items.filter((item) => item.status === "approved").length;
}

function eventBatchFor(key: string): EventBatchState | undefined {
  return eventBatches.value[key];
}

function canDecideEvent(group: ApprovalEventGroup<ApprovalView>): boolean {
  return canDecideApproval(group.items[0]);
}

function toggleEventExpanded(key: string) {
  const next = new Set(expandedEventKeys.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  expandedEventKeys.value = next;
}

function refreshApprovals() {
  concealedIds.value = new Set();
  void approvalsQuery.refresh();
}

// Every destructive decision (single reject, event batch reject, bulk reject)
// routes through one themed ConfirmDialog instead of a native window.confirm,
// so the operator reads what is about to close before it closes.
const confirmOpen = ref(false);
const confirmTitle = ref("");
const confirmDescription = ref("");
let confirmAction: (() => Promise<void>) | undefined;

function askConfirm(title: string, description: string, action: () => Promise<void>) {
  confirmTitle.value = title;
  confirmDescription.value = description;
  confirmAction = action;
  confirmOpen.value = true;
}

function runConfirmed() {
  const action = confirmAction;
  confirmAction = undefined;
  confirmOpen.value = false;
  void action?.();
}

/** "plugin · action", shared by the cells and their truncation titles. */
function changeLabel(approval: ApprovalView): string {
  return `${approval.plugin} · ${approval.action}`;
}

/** Compute the plan digest with a visible pending state. */
async function computePlanHash(approval: ApprovalView) {
  if (hashingApproval.value) return;
  hashingApproval.value = approval.id;
  try {
    await digestFor(approval);
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("operations.approvals.toastFailed"));
  } finally {
    hashingApproval.value = undefined;
  }
}

function runEventBatch(group: ApprovalEventGroup<ApprovalView>, mode: "approve-queue" | "reject") {
  // Batch actions target pending items only: approved-not-applied items have
  // already been dispositioned, and the server rejects a second decision.
  const targets = eventPendingItems(group);
  if (targets.length === 0 || eventBatches.value[group.key]?.running) return;
  if (mode === "reject") {
    askConfirm(
      t("operations.approvals.events.rejectAllTitle", { count: targets.length }),
      t("operations.approvals.events.rejectAllConfirm", { count: targets.length, title: eventTitleFor(group) }),
      () => performEventBatch(group, mode, targets),
    );
    return;
  }
  void performEventBatch(group, mode, targets);
}

async function performEventBatch(
  group: ApprovalEventGroup<ApprovalView>,
  mode: "approve-queue" | "reject",
  targets: ApprovalView[],
) {
  eventBatches.value = { ...eventBatches.value, [group.key]: { running: true, done: 0, total: targets.length, failed: 0, error: "" } };
  // runWithConcurrency never rejects: per-item failures are collected so the
  // batch runs to completion and the card shrinks to exactly the items that
  // still need attention.
  const results = await runWithConcurrency(
    targets,
    4,
    async (item) => {
      if (mode === "approve-queue") {
        await api.approvals.approve(item.id, true, await digestFor(item));
      } else {
        await api.approvals.reject(item.id);
      }
    },
    (done, total) => {
      const state = eventBatches.value[group.key];
      if (state) eventBatches.value = { ...eventBatches.value, [group.key]: { ...state, done, total } };
    },
  );
  const { succeeded, failed } = partitionBatchResults(targets, results);
  if (succeeded.length > 0) {
    const next = new Set(concealedIds.value);
    for (const item of succeeded) next.add(item.id);
    concealedIds.value = next;
  }
  if (failed.length === 0) {
    toast.success(
      t(`operations.approvals.events.${mode === "approve-queue" ? "toastBatchApproveDone" : "toastBatchRejectDone"}`, {
        count: succeeded.length,
      }),
    );
    const next = { ...eventBatches.value };
    delete next[group.key];
    eventBatches.value = next;
  } else {
    toast.warning(
      t(`operations.approvals.events.${mode === "approve-queue" ? "toastBatchApprovePartial" : "toastBatchRejectPartial"}`, {
        done: succeeded.length,
        failed: failed.length,
      }),
    );
    eventBatches.value = {
      ...eventBatches.value,
      [group.key]: {
        running: false,
        done: targets.length,
        total: targets.length,
        failed: failed.length,
        error: failed[0]?.error ?? "",
      },
    };
  }
  await approvalsQuery.refresh();
}

watch(
  filteredApprovals,
  (list) => {
    if (list.length === 0) {
      selectedId.value = "";
      return;
    }
    if (!selectedId.value || !list.some((approval) => approval.id === selectedId.value)) {
      selectedId.value = list[0]?.id ?? "";
    }
  },
  { immediate: true },
);

function approvalRank(approval: ApprovalView): number {
  if (isActionablePendingApproval(approval)) return 0;
  if (approval.status === "approved") return 1;
  if (isStaleAgentUpdateApproval(approval)) return 2;
  return statusRank(approval.status);
}

function statusRank(status: ApprovalStatus): number {
  switch (status) {
    case "pending":
      return 5;
    case "approved":
      return 1;
    case "applied":
      return 3;
    case "rejected":
      return 4;
    case "dismissed":
      return 6;
    default:
      return 9;
  }
}

function variantFor(status: ApprovalStatus) {
  return approvalStatusMeta(status).badgeVariant;
}

function approvalDecisionExtraScope(approval: ApprovalView): string {
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

function canDecideApproval(approval?: ApprovalView): boolean {
  if (!approval || !auth.can("network:apply")) return false;
  const extraScope = approvalDecisionExtraScope(approval);
  return extraScope === "" || auth.can(extraScope);
}

async function approve(approval: ApprovalView, queueApply: boolean) {
  pendingApproval.value = approval.id;
  lastApprovalError.value = undefined;
  try {
    const digest = await digestFor(approval);
    await api.approvals.approve(approval.id, queueApply, digest);
    toast.success(queueApply ? t("operations.approvals.toastQueued") : t("operations.approvals.toastRecorded"));
    await approvalsQuery.refresh();
  } catch (error) {
    const message = error instanceof Error ? error.message : t("operations.approvals.toastFailed");
    const stale = isApprovalStaleError(error);
    lastApprovalError.value = { approvalId: approval.id, message, stale };
    toast.error(stale ? t("operations.approvals.toastStale") : message);
    await approvalsQuery.refresh();
  } finally {
    pendingApproval.value = undefined;
  }
}

function rejectApproval(approval: ApprovalView) {
  askConfirm(
    t("operations.approvals.rejectTitle"),
    t("operations.approvals.rejectConfirm", {
      plugin: approval.plugin,
      action: approval.action,
      node: approval.node_id || t("common.misc.global"),
    }),
    () => performReject(approval),
  );
}

async function performReject(approval: ApprovalView) {
  pendingApproval.value = approval.id;
  lastApprovalError.value = undefined;
  try {
    await api.approvals.reject(approval.id);
    toast.success(t("operations.approvals.toastRejected"));
    await approvalsQuery.refresh();
  } catch (error) {
    const message = error instanceof Error ? error.message : t("operations.approvals.toastRejectFailed");
    lastApprovalError.value = { approvalId: approval.id, message, stale: false };
    toast.error(message);
    await approvalsQuery.refresh();
  } finally {
    pendingApproval.value = undefined;
  }
}

async function dismissApproval(approval: ApprovalView, staleOverride = false) {
  if (!canDismissApproval(approval, staleOverride)) return;
  dismissingApproval.value = approval.id;
  lastApprovalError.value = undefined;
  try {
    await api.approvals.dismiss(approval.id);
    toast.success(t("operations.approvals.toastDismissed"));
    await approvalsQuery.refresh();
  } catch (error) {
    const message = error instanceof Error ? error.message : t("operations.approvals.toastDismissFailed");
    lastApprovalError.value = { approvalId: approval.id, message, stale: false };
    toast.error(message);
    await approvalsQuery.refresh();
  } finally {
    dismissingApproval.value = undefined;
  }
}

async function replanAgentUpdate(approval: ApprovalView, force = false, staleOverride = false) {
  if (!canReplanAgentUpdate(approval, staleOverride)) return;
  replanningApproval.value = approval.id;
  lastApprovalError.value = undefined;
  try {
    const fresh = await api.agentUpdates.plan(approval.node_id, force || undefined);
    toast.success(t("operations.approvals.replanCreated"));
    forceReplanOpen.value = false;
    forceReplanApproval.value = undefined;
    forceReplanMessage.value = "";
    await approvalsQuery.refresh();
    selectedId.value = fresh.id;
  } catch (error) {
    if (isAgentUpdateNoopError(error) && !force) {
      forceReplanApproval.value = approval;
      forceReplanMessage.value = error.message || t("operations.approvals.forceReplanAlreadyTarget");
      forceReplanOpen.value = true;
    } else {
      toast.error(error instanceof Error ? error.message : t("operations.approvals.replanFailed"));
    }
    await approvalsQuery.refresh();
  } finally {
    replanningApproval.value = undefined;
  }
}

function forceReplanAgentUpdate() {
  if (forceReplanApproval.value) void replanAgentUpdate(forceReplanApproval.value, true);
}

function staleAgentUpdateReason(approval?: ApprovalView): string {
  if (!approval || approval.plugin !== "agentupdate") return "";
  if (approval.stale || approval.stale_code === APPROVAL_STALE_AGENT_UPDATE_POLICY_CHANGED) {
    return approval.reason || t("operations.approvals.toastStale");
  }
  if (!approval.reason) return "";
  const reason = approval.reason.toLowerCase();
  const stale =
    reason.includes("re-plan") ||
    reason.includes("replan") ||
    (reason.includes("policy changed") && reason.includes("approval"));
  return stale ? approval.reason : "";
}

function isStaleAgentUpdateApproval(approval?: ApprovalView): boolean {
  return isStaleAgentUpdateApprovalView(approval);
}

function canReplanAgentUpdate(approval?: ApprovalView, staleOverride = false): boolean {
  return (
    !!approval?.node_id &&
    approval.plugin === "agentupdate" &&
    (isStaleAgentUpdateApproval(approval) || staleOverride) &&
    auth.can("node:admin") &&
    auth.can("network:plan")
  );
}

/**
 * Columns for the individual inbox.
 *
 * A cluster of any size produces approvals faster than a stacked list can be
 * read: forty-five pending decisions in one narrow column can only be scrolled,
 * never sorted, compared, or acted on together. The table is the same data an
 * operator already had, in the shape the job needs: sortable by age and
 * status, and selectable so one decision can cover a whole batch.
 */
const approvalColumns = computed<DataTableColumn<ApprovalView>[]>(() => [
  { key: "status", label: t("operations.approvals.columns.status"), sortable: true, filterable: true, class: "w-[8.5rem]" },
  {
    key: "what",
    label: t("operations.approvals.columns.what"),
    sortable: true,
    searchable: true,
    filterAliases: ["plugin", "action"],
    value: (row) => `${row.plugin} · ${row.action}`,
  },
  {
    key: "target",
    label: t("operations.approvals.columns.target"),
    sortable: true,
    searchable: true,
    filterAliases: ["node"],
    value: (row) => row.node_id || t("common.misc.global"),
  },
  {
    key: "created_at",
    label: t("operations.approvals.columns.age"),
    sortable: true,
    align: "right",
    class: "w-[9rem]",
  },
]);

/** Selected rows, by approval id. */
const selectedRows = ref<Set<string>>(new Set());

/** The selected approvals a decision can still act on. */
const decidableSelection = computed(() =>
  filteredApprovals.value.filter(
    (approval) => selectedRows.value.has(approval.id) && canDecideApproval(approval) && !isStaleAgentUpdateApproval(approval),
  ),
);

const bulkRunning = ref(false);
const bulkProgress = ref({ done: 0, total: 0 });

/**
 * Decide every selected approval.
 *
 * Failures do not stop the run: each item is independent, and abandoning the
 * rest because one plan went stale would leave the operator worse off than
 * before they clicked. What failed is reported, and the list re-reads so the
 * survivors are exactly what still needs attention.
 */
function decideSelected(mode: "approve-queue" | "reject"): void {
  const targets = [...decidableSelection.value];
  if (targets.length === 0 || bulkRunning.value) return;
  if (mode === "reject") {
    askConfirm(
      t("operations.approvals.bulk.rejectTitle", { count: targets.length }),
      t("operations.approvals.bulk.rejectConfirm", { count: targets.length }),
      () => performDecide(mode, targets),
    );
    return;
  }
  void performDecide(mode, targets);
}

async function performDecide(mode: "approve-queue" | "reject", targets: ApprovalView[]): Promise<void> {
  bulkRunning.value = true;
  bulkProgress.value = { done: 0, total: targets.length };
  const results = await runWithConcurrency(
    targets,
    4,
    async (item) => {
      if (mode === "approve-queue") {
        await api.approvals.approve(item.id, true, await digestFor(item));
      } else {
        await api.approvals.reject(item.id);
      }
    },
    (done, total) => {
      bulkProgress.value = { done, total };
    },
  );
  const { succeeded, failed } = partitionBatchResults(targets, results);
  if (failed.length === 0) {
    toast.success(
      t(`operations.approvals.events.${mode === "approve-queue" ? "toastBatchApproveDone" : "toastBatchRejectDone"}`, {
        count: succeeded.length,
      }),
    );
  } else {
    toast.error(t("operations.approvals.bulk.partial", { done: succeeded.length, failed: failed.length }));
  }
  // Keep exactly the failures selected: the next click retries them, and a
  // cleared selection would hide which items still need a decision.
  selectedRows.value = new Set(failed.map((entry) => entry.item.id));
  bulkRunning.value = false;
  await approvalsQuery.refresh();
}

// A selection that survives a filter change would act on rows the operator can
// no longer see, which is the one way a batch decision can surprise them.
watch([approvalBucket, approvalSearch, approvalExpression, inboxTab], () => {
  selectedRows.value = new Set();
});

function canDismissApproval(approval?: ApprovalView, staleOverride = false): boolean {
  return (
    !!approval &&
    approval.plugin === "agentupdate" &&
    approval.status !== "dismissed" &&
    (isStaleAgentUpdateApproval(approval) || staleOverride) &&
    canDecideApproval(approval)
  );
}
</script>

<template>
  <div class="p-6 space-y-6">
    <PageHeader :title="$t('operations.approvals.title')" :description="$t('operations.approvals.description')">
      <template #status>
        <FreshnessLabel :last-updated="approvalsQuery.lastUpdated.value" />
      </template>
      <template #actions>
        <Button variant="outline" size="sm" :disabled="approvalsQuery.refreshing.value" @click="refreshApprovals">
          <RefreshCw :class="cn('size-4', approvalsQuery.refreshing.value && 'animate-spin')" aria-hidden="true" />
          {{ $t('common.actions.refresh') }}
        </Button>
      </template>
    </PageHeader>

    <div class="grid gap-4 md:grid-cols-3">
      <Card>
        <CardContent class="flex items-center justify-between p-4">
          <div>
            <p class="text-sm text-muted-foreground">{{ $t('operations.approvals.total') }}</p>
            <p class="text-2xl font-semibold">{{ approvals.length }}</p>
          </div>
          <ShieldCheck class="size-5 text-muted-foreground" aria-hidden="true" />
        </CardContent>
      </Card>
      <Card>
        <CardContent class="flex items-center justify-between p-4">
          <div>
            <p class="text-sm text-muted-foreground">{{ $t('operations.approvals.pending') }}</p>
            <p class="text-2xl font-semibold text-warning">{{ pending.length }}</p>
          </div>
          <GitCompare class="size-5 text-warning" aria-hidden="true" />
        </CardContent>
      </Card>
      <Card>
        <CardContent class="flex items-center justify-between p-4">
          <div>
            <p class="text-sm text-muted-foreground">{{ $t('operations.approvals.canApply') }}</p>
            <p class="text-2xl font-semibold">{{ canApply ? $t('common.misc.yes') : $t('common.misc.no') }}</p>
          </div>
          <CheckCircle2 class="size-5 text-muted-foreground" aria-hidden="true" />
        </CardContent>
      </Card>
    </div>

    <div class="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,460px)]">
      <Card>
        <CardHeader>
          <CardTitle>{{ $t('operations.approvals.inbox') }}</CardTitle>
          <CardDescription>
            {{ inboxTab === 'events' ? $t('operations.approvals.events.hint') : $t('operations.approvals.inboxHint') }}
          </CardDescription>
        </CardHeader>
        <CardContent class="space-y-3">
          <Tabs v-model="inboxTab">
            <TabsList class="w-full">
              <TabsTrigger value="events" class="flex-1 gap-1.5">
                {{ $t('operations.approvals.events.tab') }}
                <Badge variant="outline">{{ eventGroups.length }}</Badge>
              </TabsTrigger>
              <TabsTrigger value="individual" class="flex-1 gap-1.5">
                {{ $t('operations.approvals.events.tabIndividual') }}
                <Badge variant="outline">{{ filteredApprovals.length }}</Badge>
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <div class="relative">
            <Search
              class="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              v-model="approvalSearch"
              class="pl-8"
              :placeholder="$t('operations.approvals.searchPlaceholder')"
              :aria-label="$t('operations.approvals.searchLabel')"
            />
          </div>
          <div class="relative">
            <Funnel
              class="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              v-model="approvalExpression"
              class="pl-8 font-mono text-xs"
              :class="approvalExpressionError && 'border-destructive focus-visible:ring-destructive/20'"
              :placeholder="$t('operations.approvals.expressionPlaceholder')"
              :aria-label="$t('operations.approvals.expressionLabel')"
            />
          </div>
          <p class="text-xs" :class="approvalExpressionError ? 'text-destructive' : 'text-muted-foreground'">
            {{ approvalExpressionError || $t('operations.approvals.expressionHelp') }}
          </p>

          <div class="flex flex-wrap gap-1.5">
            <Button
              v-for="bucket in APPROVAL_BUCKETS"
              :key="bucket"
              type="button"
              :variant="approvalBucket === bucket ? 'secondary' : 'outline'"
              size="sm"
              :aria-pressed="approvalBucket === bucket"
              :class="approvalBucket === bucket && 'font-semibold'"
              @click="approvalBucket = bucket"
            >
              {{ $t(`operations.approvals.filters.${bucket}`) }}
              <Badge variant="outline" class="ml-1">{{ bucketCounts[bucket] }}</Badge>
            </Button>
          </div>

          <label class="flex items-center gap-2 rounded-md border border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
            <Checkbox v-model="includeDismissed" />
            <span>{{ $t('operations.approvals.includeDismissed') }}</span>
          </label>

          <DataState
            :loading="approvalsQuery.loading.value"
            :error="approvalsQuery.error.value"
            :has-data="approvalsQuery.data.value !== undefined"
            :is-empty="inboxTab === 'individual' && filteredApprovals.length === 0"
            :empty-title="approvals.length ? $t('operations.approvals.noMatchTitle') : $t('operations.approvals.emptyTitle')"
            :empty-description="approvals.length ? $t('operations.approvals.noMatchDescription') : $t('operations.approvals.emptyDescription')"
            @retry="approvalsQuery.refresh"
          >
            <div v-if="inboxTab === 'events'" class="space-y-2">
              <div
                v-if="eventGroups.length === 0"
                class="rounded-md border border-dashed border-border p-4 text-center"
              >
                <p class="text-sm font-medium">{{ $t('operations.approvals.events.noEventsTitle') }}</p>
                <p class="mt-1 text-xs text-muted-foreground">{{ $t('operations.approvals.events.noEventsDescription') }}</p>
                <Button type="button" variant="outline" size="sm" class="mt-3" @click="inboxTab = 'individual'">
                  {{ $t('operations.approvals.events.noEventsSwitch') }}
                </Button>
              </div>

              <div v-for="group in eventGroups" :key="group.key" class="rounded-md border border-border">
                <div class="space-y-2 p-3">
                  <div class="flex items-start justify-between gap-2">
                    <div class="min-w-0">
                      <p class="text-sm font-medium leading-snug">{{ eventTitleFor(group) }}</p>
                      <p class="mt-0.5 text-xs text-muted-foreground">
                        {{ $t('operations.approvals.events.count', { count: group.items.length }) }}
                        · {{ $t('operations.approvals.events.writerBy', { writer: eventWriterFor(group) }) }}
                        · {{ $t('operations.approvals.events.newest', { age: formatRelativeTime(group.newestCreatedAt) }) }}
                      </p>
                    </div>
                    <Badge v-if="group.isSystem" variant="secondary" class="shrink-0">
                      {{ $t('operations.approvals.events.systemBadge') }}
                    </Badge>
                  </div>

                  <div class="flex flex-wrap items-center gap-1">
                    <Badge
                      v-for="node in groupNodePreview(group).nodes"
                      :key="node"
                      variant="outline"
                      class="max-w-40 truncate font-normal"
                      :title="node"
                    >
                      {{ node }}
                    </Badge>
                    <span v-if="groupNodePreview(group).extra > 0" class="text-xs text-muted-foreground">
                      {{ $t('operations.approvals.events.nodesMore', { count: groupNodePreview(group).extra }) }}
                    </span>
                  </div>

                  <p v-if="eventApprovedCount(group) > 0" class="text-xs text-muted-foreground">
                    {{ $t('operations.approvals.events.approvedNote', { count: eventApprovedCount(group) }) }}
                  </p>

                  <div
                    v-if="eventBatchFor(group.key)?.running"
                    class="flex items-center gap-2 text-xs text-muted-foreground"
                  >
                    <RefreshCw class="size-3.5 animate-spin" aria-hidden="true" />
                    {{
                      $t('operations.approvals.events.progress', {
                        done: eventBatchFor(group.key)?.done ?? 0,
                        total: eventBatchFor(group.key)?.total ?? 0,
                      })
                    }}
                  </div>

                  <div
                    v-if="eventBatchFor(group.key)?.error"
                    class="rounded-md border border-destructive/40 bg-destructive/5 p-2.5 text-xs text-muted-foreground"
                  >
                    <p class="font-medium text-foreground">
                      {{
                        $t('operations.approvals.events.batchErrorTitle', {
                          failed: eventBatchFor(group.key)?.failed ?? 0,
                          total: eventBatchFor(group.key)?.total ?? 0,
                        })
                      }}
                    </p>
                    <p class="mt-0.5 break-words">{{ eventBatchFor(group.key)?.error }}</p>
                  </div>

                  <div class="flex flex-wrap items-center gap-1.5">
                    <Button
                      type="button"
                      size="sm"
                      :disabled="!canDecideEvent(group) || eventPendingItems(group).length === 0 || !!eventBatchFor(group.key)?.running"
                      @click="runEventBatch(group, 'approve-queue')"
                    >
                      <Play class="size-4" aria-hidden="true" />
                      {{ $t('operations.approvals.events.approveAllQueue', { count: eventPendingItems(group).length }) }}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      :disabled="!canDecideEvent(group) || eventPendingItems(group).length === 0 || !!eventBatchFor(group.key)?.running"
                      @click="runEventBatch(group, 'reject')"
                    >
                      <Ban class="size-4" aria-hidden="true" />
                      {{ $t('operations.approvals.events.rejectAll', { count: eventPendingItems(group).length }) }}
                    </Button>
                    <Button type="button" variant="ghost" size="sm" class="ml-auto" @click="toggleEventExpanded(group.key)">
                      <ChevronDown v-if="expandedEventKeys.has(group.key)" class="size-4" aria-hidden="true" />
                      <ChevronRight v-else class="size-4" aria-hidden="true" />
                      {{ expandedEventKeys.has(group.key) ? $t('operations.approvals.events.collapse') : $t('operations.approvals.events.expand') }}
                    </Button>
                  </div>
                </div>

                <div v-if="expandedEventKeys.has(group.key)" class="border-t border-border">
                  <button
                    v-for="item in group.items"
                    :key="item.id"
                    type="button"
                    :class="cn(
                      'surface-interactive w-full border-t border-border p-3 text-left first:border-t-0',
                      'outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                      selected?.id === item.id && 'bg-primary/5',
                    )"
                    @click="selectedId = item.id"
                  >
                    <div class="flex items-center justify-between gap-2">
                      <span class="truncate text-sm font-medium" :title="changeLabel(item)">{{ changeLabel(item) }}</span>
                      <Badge :variant="variantFor(item.status)" class="shrink-0">{{ $t('common.status.' + item.status) }}</Badge>
                    </div>
                    <div class="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                      <span>{{ shortId(item.id) }}</span>
                      <span>{{ item.node_id || $t('common.misc.global') }}</span>
                      <span>{{ formatDateTime(item.created_at) }}</span>
                    </div>
                  </button>
                </div>
              </div>
            </div>

            <DataTable
              state-key="approvals"
              v-else
              v-model:selected="selectedRows"
              :columns="approvalColumns"
              :rows="filteredApprovals"
              :row-key="(row) => row.id"
              state-key="approvals"
              :page-size="25"
              :expression-filter="false"
              selectable
              :empty-title="$t('operations.approvals.emptyTitle')"
              :empty-description="$t('operations.approvals.emptyDescription')"
              :no-match-title="$t('operations.approvals.noMatchTitle')"
              :no-match-description="$t('operations.approvals.noMatchDescription')"
              @row-select="selectedId = $event.id"
            >
              <template #cell-status="{ row }">
                <Badge v-if="isStaleAgentUpdateApproval(row)" variant="outline">
                  {{ $t('operations.approvals.staleBadge') }}
                </Badge>
                <Badge v-else :variant="variantFor(row.status)">{{ $t('common.status.' + row.status) }}</Badge>
              </template>

              <template #cell-what="{ row }">
                <div class="min-w-0">
                  <p :class="cn('truncate text-sm', selected?.id === row.id && 'font-semibold text-primary')" :title="changeLabel(row)">
                    {{ changeLabel(row) }}
                  </p>
                  <p class="truncate font-mono text-xs text-muted-foreground" :title="row.id">{{ shortId(row.id) }}</p>
                </div>
              </template>

              <template #cell-target="{ row }">
                <span class="truncate text-sm" :title="row.node_id || $t('common.misc.global')">
                  {{ row.node_id || $t('common.misc.global') }}
                </span>
              </template>

              <template #cell-created_at="{ row }">
                <span class="text-sm" :title="formatDateTime(row.created_at)">
                  {{ formatRelativeTime(row.created_at) }}
                </span>
              </template>

              <template #bulk-actions="{ count, clear }">
                <div class="flex flex-wrap items-center gap-2">
                  <span class="text-sm">
                    {{ $t('operations.approvals.bulk.selected', { count }) }}
                    <template v-if="decidableSelection.length !== count">
                      · {{ $t('operations.approvals.bulk.decidable', { count: decidableSelection.length }) }}
                    </template>
                  </span>
                  <span v-if="bulkRunning" class="text-xs text-muted-foreground">
                    {{ bulkProgress.done }} / {{ bulkProgress.total }}
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    :disabled="!canApply || bulkRunning || decidableSelection.length === 0"
                    @click="decideSelected('approve-queue')"
                  >
                    <CheckCircle2 class="size-4" aria-hidden="true" />
                    {{ $t('operations.approvals.bulk.approve', { count: decidableSelection.length }) }}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    :disabled="bulkRunning || decidableSelection.length === 0"
                    @click="decideSelected('reject')"
                  >
                    <Ban class="size-4" aria-hidden="true" />
                    {{ $t('operations.approvals.bulk.reject', { count: decidableSelection.length }) }}
                  </Button>
                  <Button type="button" size="sm" variant="ghost" :disabled="bulkRunning" @click="clear">
                    {{ $t('common.actions.clear') }}
                  </Button>
                </div>
              </template>
            </DataTable>
          </DataState>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{{ $t('operations.approvals.planReview') }}</CardTitle>
          <CardDescription v-if="selected">
            {{ $t('operations.approvals.planReviewOn', { plugin: selected.plugin, action: selected.action, node: selected.node_id || $t('common.misc.global') }) }}
          </CardDescription>
          <CardDescription v-else>
            {{ $t('operations.approvals.selectPrompt') }}
          </CardDescription>
        </CardHeader>
        <CardContent v-if="selected" class="space-y-4">
          <div class="flex flex-wrap items-center gap-2">
            <Badge v-if="selectedAgentUpdateStale" variant="outline">{{ $t('operations.approvals.staleBadge') }}</Badge>
            <Badge v-else :variant="variantFor(selected.status)">{{ $t('common.status.' + selected.status) }}</Badge>
            <Badge variant="outline">{{ $t('operations.approvals.idLabel', { id: shortId(selected.id, 12) }) }}</Badge>
            <Badge v-if="selected.approved_by" variant="secondary">{{ $t('operations.approvals.byLabel', { actor: selected.approved_by }) }}</Badge>
          </div>
          <div
            v-if="selectedAgentUpdateStale"
            class="rounded-md border border-warning/40 bg-warning/5 p-3 text-sm text-muted-foreground"
          >
            <p class="flex items-center gap-2 font-medium text-foreground">
              <AlertTriangle class="size-4 text-warning" aria-hidden="true" />
              {{ $t('operations.approvals.staleTitle') }}
            </p>
            <p class="mt-1">{{ $t('operations.approvals.staleDescription') }}</p>
            <p class="mt-2 text-xs font-medium uppercase text-muted-foreground">
              {{ $t('operations.approvals.rejectionReason') }}
            </p>
            <p class="mt-1 break-words">{{ selectedAgentUpdateStaleReason }}</p>
            <div class="mt-3 flex flex-wrap gap-2">
              <Button
                v-if="canReplanSelectedAgentUpdate"
                type="button"
                variant="outline"
                size="sm"
                :disabled="replanningApproval === selected.id"
                @click="replanAgentUpdate(selected, false, selectedAgentUpdateStale)"
              >
                <RefreshCw v-if="replanningApproval === selected.id" class="size-4 animate-spin" aria-hidden="true" />
                <FileCode2 v-else class="size-4" aria-hidden="true" />
                {{ $t('operations.approvals.replanAgentUpdate') }}
              </Button>
              <Button
                v-if="canDismissSelectedApproval"
                type="button"
                variant="ghost"
                size="sm"
                :disabled="dismissingApproval === selected.id"
                @click="dismissApproval(selected, selectedAgentUpdateStale)"
              >
                <RefreshCw v-if="dismissingApproval === selected.id" class="size-4 animate-spin" aria-hidden="true" />
                <ArchiveX v-else class="size-4" aria-hidden="true" />
                {{ $t('operations.approvals.dismissStale') }}
              </Button>
            </div>
          </div>
          <div
            v-else-if="selected.status === 'pending' && selected.reason"
            class="rounded-md border border-warning/40 bg-warning/5 p-3 text-sm text-muted-foreground"
          >
            <p class="flex items-center gap-2 font-medium text-foreground">
              <AlertTriangle class="size-4 text-warning" aria-hidden="true" />
              {{ $t('operations.approvals.approvalNote') }}
            </p>
            <p class="mt-1 break-words">{{ selected.reason }}</p>
          </div>
          <div
            v-else-if="selected.status === 'rejected' && selected.reason"
            class="rounded-md border border-warning/40 bg-warning/5 p-3 text-sm text-muted-foreground"
          >
            <p class="font-medium text-foreground">{{ $t('operations.approvals.rejectionReason') }}</p>
            <p class="mt-1 break-words">{{ selected.reason }}</p>
          </div>

          <div class="space-y-2">
            <div class="flex flex-wrap items-center justify-between gap-3">
              <div class="flex items-center gap-1">
                <Button
                  :variant="planView === 'diff' ? 'secondary' : 'ghost'"
                  size="sm"
                  :aria-pressed="planView === 'diff'"
                  :class="planView === 'diff' && 'font-semibold'"
                  @click="planView = 'diff'"
                >
                  <GitCompare class="size-3.5" aria-hidden="true" />
                  {{ $t('operations.approvals.viewDiff') }}
                </Button>
                <Button
                  :variant="planView === 'full' ? 'secondary' : 'ghost'"
                  size="sm"
                  :aria-pressed="planView === 'full'"
                  :class="planView === 'full' && 'font-semibold'"
                  @click="planView = 'full'"
                >
                  {{ $t('operations.approvals.viewFull') }}
                </Button>
              </div>
              <CopyButton :value="selected.plan || ''" />
            </div>
            <template v-if="planView === 'diff'">
              <div class="flex flex-wrap items-center gap-2 rounded-md border border-border bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
                <span>{{ previousPlan ? $t('operations.approvals.diffAgainstApplied') : $t('operations.approvals.diffNoPrior') }}</span>
                <span v-if="previousPlan" class="inline-flex items-center gap-1 rounded-full border border-destructive/30 px-2 py-0.5 text-destructive">
                  <span class="font-mono">−</span>
                  {{ $t('operations.approvals.diffRemovedLabel') }}
                </span>
                <span class="inline-flex items-center gap-1 rounded-full border border-success/30 px-2 py-0.5 text-success">
                  <span class="font-mono">+</span>
                  {{ $t('operations.approvals.diffAddedLabel') }}
                </span>
              </div>
              <PlanDiff :before="previousPlan" :after="selected.plan || ''" />
            </template>
            <pre v-else class="max-h-[520px] overflow-auto whitespace-pre-wrap rounded-md border border-border p-4 font-mono text-xs leading-relaxed">{{ selected.plan }}</pre>
          </div>

          <div v-if="digestCache[selected.id]" class="flex flex-wrap items-center gap-2 rounded-md bg-muted/40 p-3 text-xs">
            <span class="font-medium">{{ $t('operations.approvals.planSha256') }}</span>
            <code class="break-all font-mono">{{ digestCache[selected.id] }}</code>
            <CopyButton :value="digestCache[selected.id] || ''" />
          </div>

          <div
            v-if="lastApprovalError?.approvalId === selected.id && !lastApprovalError.stale"
            :class="cn(
              'rounded-md border p-3 text-sm',
              'border-destructive/40 bg-destructive/5 text-muted-foreground',
            )"
          >
            <p class="font-medium text-foreground">
              {{ $t('operations.approvals.approveErrorTitle') }}
            </p>
            <p class="mt-1">
              {{ lastApprovalError.message }}
            </p>
          </div>

          <div class="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              :disabled="pendingApproval === selected.id || hashingApproval === selected.id"
              @click="computePlanHash(selected)"
            >
              <RefreshCw v-if="hashingApproval === selected.id" class="size-4 animate-spin" aria-hidden="true" />
              <GitCompare v-else class="size-4" aria-hidden="true" />
              {{ $t('operations.approvals.computeHash') }}
            </Button>
            <Button
              v-if="selected.status === 'pending'"
              type="button"
              variant="outline"
              :disabled="!canApproveSelected || pendingApproval === selected.id"
              @click="approve(selected, false)"
            >
              <CheckCircle2 class="size-4" aria-hidden="true" />
              {{ $t('operations.approvals.approveOnly') }}
            </Button>
            <Button
              v-if="selected.status === 'pending'"
              type="button"
              variant="destructive"
              :disabled="!canDecideSelected || pendingApproval === selected.id"
              @click="rejectApproval(selected)"
            >
              <Ban class="size-4" aria-hidden="true" />
              {{ $t('operations.approvals.reject') }}
            </Button>
            <Button
              v-if="selected.status === 'pending'"
              type="button"
              :disabled="!canApproveSelected || pendingApproval === selected.id"
              @click="approve(selected, true)"
            >
              <RefreshCw v-if="pendingApproval === selected.id" class="size-4 animate-spin" aria-hidden="true" />
              <Play v-else class="size-4" aria-hidden="true" />
              {{ $t('operations.approvals.approveAndQueue') }}
            </Button>
          </div>

          <p v-if="!canDecideSelected" class="text-sm text-muted-foreground">
            {{ $t('operations.approvals.applyRequired') }}
          </p>
        </CardContent>
      </Card>
    </div>

    <ConfirmDialog
      v-model:open="confirmOpen"
      :title="confirmTitle"
      :description="confirmDescription"
      :confirm-label="$t('operations.approvals.reject')"
      :cancel-label="$t('common.actions.cancel')"
      @confirm="runConfirmed"
    />

    <Dialog v-model:open="forceReplanOpen">
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{{ $t('operations.approvals.forceReplanTitle') }}</DialogTitle>
          <DialogDescription>{{ forceReplanMessage }}</DialogDescription>
        </DialogHeader>
        <p class="text-sm text-muted-foreground">
          {{ $t('operations.approvals.forceReplanHint') }}
        </p>
        <DialogFooter>
          <DialogClose as-child>
            <Button type="button" variant="outline">{{ $t('common.actions.cancel') }}</Button>
          </DialogClose>
          <Button
            type="button"
            :disabled="!!forceReplanApproval && replanningApproval === forceReplanApproval.id"
            @click="forceReplanAgentUpdate"
          >
            <RefreshCw
              v-if="!!forceReplanApproval && replanningApproval === forceReplanApproval.id"
              class="size-4 animate-spin"
              aria-hidden="true"
            />
            <FileCode2 v-else class="size-4" aria-hidden="true" />
            {{ $t('operations.approvals.forceReplanAgentUpdate') }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
