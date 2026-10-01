<script setup lang="ts">
/**
 * Tasks (design 23, section 4.3): layers Runs and New task on `?view=`,
 * opening on Runs.
 *
 * Runs is one server page of what the operator asked for, through the
 * QueryBar (status, node, origin, approval, and the range as `since`). Each
 * row says why the run failed from its results (the exit code and the first
 * stderr line), the targets with a pass count, and where it came from: the
 * plan that queued it, the run it repeats, or the operator. Never script
 * text: the script is step-up gated and the list carries only its digest.
 * The head's numbers come from the counts read, so "failed" means the last
 * 24 hours, not every failure ever.
 *
 * A row opens the run in the sheet on `?open=`, with per-node results and
 * failed nodes opened to their stderr. Rerun and Cancel live in the row
 * menu, Delete last. The results poll asks only for the rows on screen, by
 * id; paging past page 1 stops the poll so the page holds still.
 *
 * The task actions by design 23, section 3.8. Rerun (every target, or one
 * node from the sheet) runs the script on hosts now and files no approval,
 * so it opens a confirm that previews the targets and the script it repeats.
 * It asks for no typed name: the preview is what the operator judges, and
 * New task queues a script with no dialog at all. Cancel is reversible
 * (Rerun queues a fresh copy) and acts on one click. Delete is irreversible
 * inside Lattice and confirms with impact lines.
 */
import { computed, onScopeDispose, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import { Ban, ChevronLeft, ChevronRight, ExternalLink, Play, RefreshCw, RotateCcw, Trash2 } from "lucide-vue-next";

import { api, ApiError, unwrap, type Node, type TaskCounts, type TaskResult, type TaskView } from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { bindLayer } from "@/composables/useLayer";
import { useOwnedRoute } from "@/composables/useOwnedRoute";
import { provideNodeDirectory } from "@/composables/useNodeDirectory";
import { useProof } from "@/composables/useProof";
import { bindRouteOpen } from "@/composables/useRouteOpen";
import { rowSelector } from "@/composables/routeOpenModel";
import { useAuthStore } from "@/stores/auth";
import { formatAge, formatBytes, formatDateTime, formatRelativeTime, shortId } from "@/lib/format";
import { isReporting } from "@/lib/nodeStatus";
import { leaseAttemptLabel, stalledText, taskLeaseProgress, taskStateStyle } from "@/lib/taskLease";
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
import ObjectSheet from "@/components/common/ObjectSheet.vue";
import NodeLabel from "@/components/common/NodeLabel.vue";
import RowMenu, { type RowMenuItem } from "@/components/common/RowMenu.vue";
import ConfirmDialog from "@/components/common/ConfirmDialog.vue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

import { runWithConcurrency } from "./approvalsModel";
import { pageBounds, rangeWindow } from "./opsQueryModel";
import TaskComposer from "./TaskComposer.vue";
import TaskRunDetail from "./TaskRunDetail.vue";
import {
  TASK_GRAMMAR,
  TASK_LAYERS,
  TASK_ORIGINS,
  TASK_PAGE_SIZE,
  TASK_RANGES,
  TASK_STATUSES,
  failureReason,
  findTask,
  legacyOpenQuery,
  normalizeTaskPage,
  readResultPages,
  resultsRequest,
  runSummary,
  taskCancellable,
  taskListRequest,
  taskLive,
  type RunSummary,
  type TaskLayer,
  type TaskPage,
} from "./tasksModel";
import { useOpsQuery } from "./useOpsQuery";

const { t, locale } = useI18n();
const auth = useAuthStore();
const canRun = computed(() => auth.can("task:run"));

/**
 * One owned route for the page: the layer, the query and the sheet write the
 * same address, and a write in the same tick as another (switch to Runs and
 * open the new task) must build on the one before it, which only a shared
 * owner knows about.
 */
const owned = useOwnedRoute();
const layer = bindLayer<TaskLayer>(owned, () => TASK_LAYERS, () => "runs");

/* ------------------------------------------------------------------ */
/* Nodes and the server's switches                                     */
/* ------------------------------------------------------------------ */

const versionQuery = useAsyncData((signal) => api.version({ signal }), { pollInterval: 60_000 });
const executionDisabled = computed(() => !!versionQuery.data.value?.task_execution_disabled);

const nodesQuery = useAsyncData((signal) => api.nodes.list({ signal }).then((r) => unwrap(r, "nodes")), { pollInterval: 60_000 });
const nodes = computed<Node[]>(() => nodesQuery.data.value ?? []);
provideNodeDirectory(nodes);

function nodeName(id: string): string {
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
/* The question, the window and the page, all in the address           */
/* ------------------------------------------------------------------ */

const query = useOpsQuery({
  grammar: TASK_GRAMMAR,
  resolvers: () => resolvers.value,
  defaultRange: "all",
  unchecked: () => nodesQuery.data.value === undefined,
  noText: () => t("operations.tasks.query.noText"),
  owned,
});
const bar = ref<InstanceType<typeof QueryBar> | null>(null);

// An old link (/tasks?id=<task>, still sent by the node page) opens the sheet.
watch(
  () => query.owned.query(),
  (current) => {
    if (!query.owned.owns()) return;
    const next = legacyOpenQuery(current);
    if (next) query.owned.replace(next);
  },
  { immediate: true },
);

const listing = computed(() => layer.value === "runs");

interface RunsRead {
  page: TaskPage;
  /** Results for the rows on screen; null when that read failed. */
  results: TaskResult[] | null;
  /** The read stopped before the server ran out of result rows. */
  resultsTruncated: boolean;
  /** Result rows the read took in, for the proof line when it stopped short. */
  resultRowsRead: number;
  resultsError: string | null;
}

const runsQuery = useAsyncData<RunsRead>(
  async (signal) => {
    const params = taskListRequest({
      tokens: query.applied.value,
      window: rangeWindow(query.range.value, Date.now()),
      offset: query.offset.value,
    });
    const page = normalizeTaskPage(await api.tasks.query(params, { signal }), params);
    try {
      const ids = page.tasks.map((task) => task.id);
      const read = await readResultPages(ids, (offset) => api.tasks.results(resultsRequest(ids, offset), { signal }));
      return { page, results: read.results, resultsTruncated: read.truncated, resultRowsRead: read.rowsRead, resultsError: null };
    } catch (error) {
      if ((error as Error)?.name === "AbortError") throw error;
      return { page, results: null, resultsTruncated: false, resultRowsRead: 0, resultsError: error instanceof Error ? error.message : String(error) };
    }
  },
  { immediate: listing.value },
);

watch(
  () => [layer.value, query.appliedKey.value, JSON.stringify(query.range.value), query.offset.value] as const,
  () => {
    if (listing.value) void runsQuery.refresh();
  },
);

const countsQuery = useAsyncData<TaskCounts>((signal) => api.tasks.counts({ signal }), { pollInterval: 10_000 });
/** An older server answers 404: the head then shows no counts rather than zeros. */
const counts = computed<TaskCounts | undefined>(() => countsQuery.data.value);

/**
 * Poll page 1 only, every 10 s. Past it, a tick would re-page under the
 * operator (offset paging over a list that grows at the head).
 */
const POLL_MS = 10_000;
const polling = computed(() => listing.value && query.offset.value === 0);
const timer = setInterval(() => {
  if (document.visibilityState === "hidden") return;
  if (polling.value) void runsQuery.refresh();
  if (lookupLive.value && !lookupQuery.refreshing.value) void lookupQuery.refresh();
}, POLL_MS);
onScopeDispose(() => clearInterval(timer));

const page = computed<TaskPage | undefined>(() => runsQuery.data.value?.page);
const tasks = computed<TaskView[]>(() => page.value?.tasks ?? []);
const total = computed(() => page.value?.total ?? 0);
const resultsByTask = computed<Map<string, TaskResult[]>>(() => {
  const map = new Map<string, TaskResult[]>();
  for (const result of runsQuery.data.value?.results ?? []) {
    const list = map.get(result.task_id);
    if (list) list.push(result);
    else map.set(result.task_id, [result]);
  }
  return map;
});
const resultsRead = computed(() => runsQuery.data.value?.results !== null && runsQuery.data.value !== undefined);
const resultsTruncated = computed(() => !!runsQuery.data.value?.resultsTruncated);
const bounds = computed(() => pageBounds(query.offset.value, tasks.value.length));
const hasPrev = computed(() => query.offset.value > 0);
const hasNext = computed(() => bounds.value.to < total.value);
const filtered = computed(() => query.appliedText.value.trim() !== "" || query.range.value.range !== "all");
/** Nothing has ever been queued here, and nothing narrows the list. */
const nothingYet = computed(() => runsQuery.data.value !== undefined && total.value === 0 && !filtered.value);

function num(n: number): string {
  return n.toLocaleString(locale.value);
}

/* ------------------------------------------------------------------ */
/* The plans behind the rows: titles read once per approval and kept   */
/* ------------------------------------------------------------------ */

const planTitles = reactive(new Map<string, string | null>());
const planWanted = computed(() => [...new Set(tasks.value.map((task) => task.approval_id).filter((id): id is string => !!id))]);

watch(
  planWanted,
  async (ids) => {
    const missing = ids.filter((id) => !planTitles.has(id));
    if (!missing.length || !auth.can("approval:read")) return;
    for (const id of missing) planTitles.set(id, null);
    await runWithConcurrency(missing, 4, async (id) => {
      const approval = await api.approvals.get(id);
      planTitles.set(id, approval ? `${approval.plugin} · ${approval.action.split(":")[0]}` : null);
    });
  },
  { immediate: true },
);

/* ------------------------------------------------------------------ */
/* Rows                                                                */
/* ------------------------------------------------------------------ */

interface RunRow {
  task: TaskView;
  summary: RunSummary;
}

const rows = computed<RunRow[]>(() =>
  tasks.value.map((task) => ({ task, summary: runSummary(task, resultsByTask.value.get(task.id) ?? []) })),
);

function statusVariant(status: string) {
  return taskStateStyle(status).variant;
}

function statusLabel(status: string): string {
  return t(`operations.tasks.status.${status}`);
}

function exitWord(code: number): string {
  return t("operations.tasks.exit", { code });
}

function leaseText() {
  return {
    leasedFor: (age: string) => t("operations.tasks.leasedFor", { age }),
    attemptOf: (attempt: number, max: number) => t("operations.tasks.attemptOf", { attempt, max }),
    duration: {
      days: (n: number) => t("common.duration.days", { n }),
      hours: (n: number) => t("common.duration.hours", { n }),
      minutes: (n: number) => t("common.duration.minutes", { n }),
      seconds: (n: number) => t("common.duration.seconds", { n }),
    },
    stalledNoLease: t("operations.tasks.stalledNoLease"),
  };
}

/**
 * Whether every result this row can have was read. When the read stopped
 * short of the server's rows, a row whose targets have not all reported may
 * have a failure beyond the cap, so it is neither passed nor "no result".
 */
function resultsComplete(row: RunRow): boolean {
  if (!resultsRead.value) return false;
  return !resultsTruncated.value || row.summary.reported >= row.summary.total;
}

/** A row the read stopped before: how much of it was read, never "passed". */
function partlyReadLine(summary: RunSummary): { text: string; tone: "warning" } {
  const text = summary.reported
    ? t("operations.tasks.result.partlyRead", { reported: summary.reported, total: summary.total })
    : t("operations.tasks.result.notRead");
  return { text, tone: "warning" };
}

/** The Result cell: why it failed, or what it is doing, in one line. */
function resultLine(row: RunRow): { text: string; tone: "destructive" | "muted" | "warning" } {
  const { task, summary } = row;
  if (summary.firstFailure) return { text: failureReason(summary.firstFailure.result, exitWord), tone: "destructive" };
  const partlyRead = resultsRead.value && !resultsComplete(row);
  switch (task.status) {
    case "stalled":
      return { text: stalledText(taskLeaseProgress(task), leaseText()), tone: "warning" };
    case "leased": {
      const lease = leaseAttemptLabel(taskLeaseProgress(task), leaseText());
      return { text: lease ? `${t("operations.tasks.running")} · ${lease}` : t("operations.tasks.running"), tone: "muted" };
    }
    case "queued":
    case "pending":
      return { text: t("operations.tasks.waitingLease"), tone: "muted" };
    case "cancelled":
      return { text: t("operations.tasks.result.cancelled"), tone: "muted" };
    case "expired":
      return { text: t("operations.tasks.sheet.expiredNoResult"), tone: "muted" };
    case "failed":
      if (partlyRead) return partlyReadLine(summary);
      return { text: resultsRead.value ? t("operations.tasks.failedNoResult") : t("operations.tasks.result.notRead"), tone: "destructive" };
    default:
      if (!resultsRead.value) return { text: t("operations.tasks.result.notRead"), tone: "muted" };
      if (partlyRead) return partlyReadLine(summary);
      if (!summary.reported) return { text: t("operations.tasks.result.noResults"), tone: "muted" };
      if (summary.reported < summary.total) {
        return { text: t("operations.tasks.result.okPartial", { reported: summary.reported, total: summary.total }), tone: "muted" };
      }
      return { text: t("operations.tasks.result.ok"), tone: "muted" };
  }
}

const columns = computed<DataTableColumn<RunRow>[]>(() => [
  { key: "run", label: t("operations.tasks.cols.run") },
  { key: "targets", label: t("operations.tasks.cols.targets") },
  { key: "result", label: t("operations.tasks.cols.result"), class: "min-w-[16rem] max-w-[28rem]" },
  { key: "origin", label: t("operations.tasks.cols.origin") },
  { key: "created", label: t("operations.tasks.cols.queued"), align: "right" },
  { key: "actions", label: "", align: "right", class: "w-10" },
]);

/* ------------------------------------------------------------------ */
/* Actions                                                             */
/* ------------------------------------------------------------------ */

const actionPending = ref<string | null>(null);
const deleteTarget = ref<TaskView | null>(null);

/**
 * The control that opened a confirm, where focus lands when it closes. A row
 * menu item is gone by then, so the row's menu button stands in for it.
 */
let confirmOpener: HTMLElement | null = null;

function rowMenuButton(id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`${rowSelector(id)} [data-testid="row-menu"]`);
}

function confirmReturn(): HTMLElement | null {
  return confirmOpener?.isConnected ? confirmOpener : null;
}

function askDelete(task: TaskView, opener: HTMLElement | null): void {
  confirmOpener = opener;
  deleteTarget.value = task;
}
const deleteOpen = computed({
  get: () => !!deleteTarget.value,
  set: (open: boolean) => {
    if (!open && !actionPending.value) deleteTarget.value = null;
  },
});

function toastDispatchError(error: unknown, fallback: string) {
  if (error instanceof ApiError && error.code === "capability_denied") {
    const refusals = error.message.split("; ").filter(Boolean);
    toast.error(t("operations.tasks.capabilityRefused", { count: refusals.length }), {
      description: refusals.join("\n"),
      duration: 10000,
      descriptionClass: "whitespace-pre-line",
    });
    return;
  }
  toast.error(error instanceof Error ? error.message : fallback);
}

async function refreshAll(): Promise<void> {
  const reads = [runsQuery.refresh(), countsQuery.refresh()];
  // A run opened by link is read on its own, not with the page; without
  // this, Cancel left its sheet on the old status with Cancel still offered.
  if (sheet.openId.value && !onScreen.value) reads.push(lookupQuery.refresh());
  await Promise.all(reads);
}

/* Rerun: runs now, so it confirms with a preview of what goes out. */

const rerunRequest = ref<{ task: TaskView; nodeId?: string } | null>(null);
const rerunOpen = computed({
  get: () => !!rerunRequest.value,
  set: (open: boolean) => {
    if (!open && !actionPending.value) rerunRequest.value = null;
  },
});

function askRerun(task: TaskView, opener: HTMLElement | null, nodeId?: string): void {
  if (executionDisabled.value) {
    toast.error(t("operations.tasks.taskExecutionDisabled"));
    return;
  }
  confirmOpener = opener;
  rerunRequest.value = { task, nodeId };
}

/** The targets a rerun request goes to: one node, or every distinct target. */
const rerunTargets = computed<string[]>(() => {
  const request = rerunRequest.value;
  if (!request) return [];
  return request.nodeId ? [request.nodeId] : [...new Set(request.task.targets)];
});

const PREVIEW_NAMES_SHOWN = 6;

function previewNames(names: string[]): string {
  if (names.length <= PREVIEW_NAMES_SHOWN) return names.join(", ");
  return t("operations.tasks.preflight.andMore", { names: names.slice(0, PREVIEW_NAMES_SHOWN).join(", "), count: names.length - PREVIEW_NAMES_SHOWN });
}

const rerunTitle = computed(() => {
  const request = rerunRequest.value;
  if (!request) return "";
  const id = shortId(request.task.id, 12);
  const targets = rerunTargets.value;
  return targets.length === 1
    ? t("operations.tasks.rerunConfirm.titleOne", { id, node: nodeName(targets[0] as string) })
    : t("operations.tasks.rerunConfirm.titleAll", { id, n: targets.length });
});

const rerunConfirmLabel = computed(() => {
  const targets = rerunTargets.value;
  return targets.length === 1
    ? t("operations.tasks.rerunConfirm.confirmOne", { name: nodeName(targets[0] as string) })
    : t("operations.tasks.rerunConfirm.confirmAll", { n: targets.length });
});

/** What goes out: where it runs, the script it repeats, and what is already true of those nodes. */
const rerunPreview = computed<string[]>(() => {
  const request = rerunRequest.value;
  if (!request) return [];
  const { task } = request;
  const targets = rerunTargets.value;
  const names = targets.map(nodeName);
  const lines = [
    targets.length === 1
      ? t("operations.tasks.rerunConfirm.targetsOne", { name: names[0] })
      : t("operations.tasks.rerunConfirm.targetsMany", { n: targets.length, names: previewNames(names) }),
  ];
  const script = { interpreter: task.interpreter, size: formatBytes(task.script_size_bytes), timeout: task.timeout_sec ?? 0 };
  lines.push(
    task.script_sha256
      ? t("operations.tasks.rerunConfirm.script", { ...script, digest: shortId(task.script_sha256, 12) })
      : t("operations.tasks.rerunConfirm.scriptNoDigest", script),
  );
  if (task.approval_id) lines.push(t("operations.tasks.rerunConfirm.capability"));
  const known = targets.map((id) => nodes.value.find((node) => node.id === id)).filter((node): node is Node => !!node);
  const offline = known.filter((node) => !isReporting(node)).map((node) => node.name || node.id);
  const refused = known
    .filter((node) => node.agent_runtime?.reported_at && (node.agent_runtime.no_exec || node.agent_runtime.allow_exec === false))
    .map((node) => node.name || node.id);
  if (refused.length) lines.push(t("operations.tasks.preflight.execDisabled", { names: previewNames(refused) }));
  if (offline.length) lines.push(t("operations.tasks.preflight.offline", { names: previewNames(offline) }));
  return lines;
});

async function confirmRerun(): Promise<void> {
  const request = rerunRequest.value;
  if (!request || actionPending.value) return;
  const { task, nodeId } = request;
  actionPending.value = task.id;
  try {
    const next = nodeId ? await api.tasks.rerunNode(task.id, nodeId) : await api.tasks.rerun(task.id);
    toast.success(nodeId ? t("operations.tasks.toastRerunNode", { node: nodeName(nodeId) }) : t("operations.tasks.toastRerun"));
    actionPending.value = null;
    rerunRequest.value = null;
    await refreshAll();
    if (!nodeId && next?.id) sheet.open(next.id);
  } catch (error) {
    toastDispatchError(error, t("operations.tasks.toastRerunFailed"));
  } finally {
    actionPending.value = null;
  }
}

async function cancelTask(task: TaskView): Promise<void> {
  actionPending.value = task.id;
  try {
    await api.tasks.cancel(task.id);
    toast.success(t("operations.tasks.toastCancelled"));
    await refreshAll();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("operations.tasks.toastCancelFailed"));
  } finally {
    actionPending.value = null;
  }
}

async function confirmDelete(): Promise<void> {
  const task = deleteTarget.value;
  if (!task || actionPending.value) return;
  actionPending.value = task.id;
  try {
    await api.tasks.delete(task.id);
    toast.success(t("operations.tasks.toastDeleted"));
    actionPending.value = null;
    deleteTarget.value = null;
    if (sheet.openId.value === task.id) sheet.close();
    await refreshAll();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("operations.tasks.toastDeleteFailed"));
  } finally {
    actionPending.value = null;
  }
}

const deleteImpact = computed(() => {
  const task = deleteTarget.value;
  if (!task) return [];
  return [
    t("operations.tasks.deleteImpact.results"),
    t("operations.tasks.deleteImpact.running"),
    t("operations.tasks.deleteImpact.audit"),
  ];
});

function menuItems(task: TaskView): RowMenuItem[] {
  const disabledReason = executionDisabled.value ? t("operations.tasks.taskExecutionDisabled") : undefined;
  return [
    {
      key: "plan",
      label: t("operations.tasks.menu.openPlan"),
      icon: ExternalLink,
      hidden: !task.approval_id,
      to: task.approval_id ? { name: "approvals", query: { open: task.approval_id } } : undefined,
    },
    {
      key: "rerun",
      label: t("operations.tasks.actions.rerun"),
      icon: RotateCcw,
      hidden: !canRun.value,
      disabled: executionDisabled.value || actionPending.value === task.id,
      reason: disabledReason,
      run: () => askRerun(task, rowMenuButton(task.id)),
    },
    {
      key: "cancel",
      label: t("operations.tasks.actions.cancel"),
      icon: Ban,
      hidden: !canRun.value || !taskCancellable(task.status),
      disabled: actionPending.value === task.id,
      run: () => void cancelTask(task),
    },
    {
      key: "delete",
      label: t("operations.tasks.actions.delete"),
      icon: Trash2,
      danger: true,
      hidden: !canRun.value,
      run: () => askDelete(task, rowMenuButton(task.id)),
    },
  ];
}

/* ------------------------------------------------------------------ */
/* The sheet: the run on screen, or found by id                        */
/* ------------------------------------------------------------------ */

const sheet = bindRouteOpen(owned);
const onScreen = computed(() => tasks.value.find((task) => task.id === sheet.openId.value));

/**
 * A run opened by link (the node page, an approval, the audit trace) may not
 * be on this page. The list has no id filter, so the sheet finds it by
 * walking the list (findTask); once found, a refresh asks the narrow
 * question that still holds it. It is read again with every action and,
 * while it can still change, on the page's 10 s tick, so its status and the
 * actions it offers do not freeze at the first read.
 */
let lookupHint: TaskView | null = null;
const lookupQuery = useAsyncData<TaskView | null>(
  async (signal) => {
    const id = sheet.openId.value;
    if (!id) return null;
    const found = await findTask((params) => api.tasks.query(params, { signal }), id, lookupHint);
    lookupHint = found;
    return found;
  },
  { immediate: false },
);

/** The Runs page is still being read for the first time; a failed read is not "still". */
const listPending = computed(() => listing.value && runsQuery.data.value === undefined && !runsQuery.error.value);

watch(
  () => [sheet.openId.value, !!onScreen.value, listPending.value] as const,
  ([id, shown, pendingList]) => {
    if (!id || shown || pendingList) return;
    if (lookupQuery.data.value?.id === id) return;
    void lookupQuery.refresh();
  },
  { immediate: true },
);

const openTask = computed<TaskView | undefined>(() => {
  if (onScreen.value) return onScreen.value;
  const found = lookupQuery.data.value;
  return found && found.id === sheet.openId.value ? found : undefined;
});

/** The open run was read on its own and can still change: the tick reads it again. */
const lookupLive = computed(() => !onScreen.value && !!openTask.value && taskLive(openTask.value.status));

const sheetState = computed<"ready" | "loading" | "gone">(() => {
  if (openTask.value) return "ready";
  if (lookupQuery.loading.value || lookupQuery.refreshing.value || listPending.value) return "loading";
  if (lookupQuery.data.value === undefined && !lookupQuery.error.value) return "loading";
  return "gone";
});

/** The lookup failed: the task was not read, which is not the same as deleted. */
const lookupFailure = computed<string | null>(() => (openTask.value ? null : (lookupQuery.error.value?.message ?? null)));

const openReruns = computed(() => tasks.value.filter((task) => task.rerun_of_task_id && task.rerun_of_task_id === openTask.value?.id));

function onQueued(task: TaskView): void {
  layer.value = "runs";
  sheet.open(task.id);
  void refreshAll();
}

/* ------------------------------------------------------------------ */
/* The head: proof line, attention, four numbers, layers              */
/* ------------------------------------------------------------------ */

const listProof = useProof(
  {
    data: runsQuery.data,
    error: runsQuery.error,
    loading: runsQuery.loading,
    refreshing: runsQuery.refreshing,
    lastUpdated: runsQuery.lastUpdated,
    get pollMs() {
      return polling.value ? POLL_MS : 0;
    },
  },
);
const countsProof = useProof(countsQuery, { hasData: () => countsQuery.data.value !== undefined });
const proof = computed(() => (listing.value ? listProof.value : countsProof.value));

function rangeText(): string {
  const range = query.range.value;
  return t(`operations.opsRange.proof.${range.range === "custom" ? "all" : range.range}`);
}

const proofSegments = computed<ProofSegment[]>(() => {
  const segments: ProofSegment[] = [];
  if (counts.value) segments.push({ key: "total", text: t("operations.tasks.proof.tasks", { n: num(counts.value.total) }) });
  if (listing.value && page.value) {
    if (filtered.value) segments.push({ key: "match", text: t("operations.tasks.proof.match", { n: num(total.value), range: rangeText() }) });
    else if (!counts.value) segments.push({ key: "total", text: t("operations.tasks.proof.tasks", { n: num(total.value) }) });
    segments.push({ key: "attempts", text: t("operations.tasks.proof.attempts"), tone: "muted" });
    if (!page.value.serverFiltered) segments.push({ key: "client", text: t("operations.tasks.proof.clientFiltered"), tone: "warning" });
    const resultsError = runsQuery.data.value?.resultsError;
    if (resultsError) segments.push({ key: "results", text: t("operations.tasks.proof.resultsNotRead", { reason: resultsError }), tone: "warning" });
    else if (resultsTruncated.value) segments.push({ key: "results", text: t("operations.tasks.proof.resultsTruncated", { n: num(runsQuery.data.value?.resultRowsRead ?? 0) }), tone: "warning" });
  }
  return segments;
});

const stalledQuery = useAsyncData<TaskView[]>(
  async (signal) => {
    if (!counts.value?.stalled) return [];
    const params = { status: ["stalled" as const], limit: 5, offset: 0 };
    return normalizeTaskPage(await api.tasks.query(params, { signal }), params).tasks;
  },
  { immediate: false, pollInterval: 30_000 },
);
watch(
  () => counts.value?.stalled ?? 0,
  (n, before) => {
    if (n !== before) void stalledQuery.refresh();
  },
  { immediate: true },
);

function showStatus(status: (typeof TASK_STATUSES)[number], range?: "24h"): void {
  layer.value = "runs";
  query.edit(bar, (next) => {
    next.enums.status = [status];
  });
  if (range) query.setRange(range);
}

const attention = computed<AttentionItem[]>(() => {
  const items: AttentionItem[] = [];
  const c = counts.value;
  if (executionDisabled.value) {
    items.push({ key: "disabled", tone: "warning", claim: t("operations.tasks.attention.disabled"), proof: t("operations.tasks.attention.disabledProof") });
  }
  if (c?.stalled) {
    const stalled = stalledQuery.data.value ?? [];
    if (stalled.length) {
      for (const task of stalled) {
        const lease = taskLeaseProgress(task);
        const since = task.started_at ?? task.created_at;
        items.push({
          key: `stalled:${task.id}`,
          tone: "danger",
          claim: t("operations.tasks.attention.stalled", {
            node: task.targets.length === 1 ? nodeName(task.targets[0] as string) : t("operations.tasks.attention.nodes", { n: task.targets.length }),
            age: since ? formatAge(Date.now() - Date.parse(since), locale.value) : "?",
          }),
          proof: lease?.stalledReason ?? task.stalled_reason ?? shortId(task.id, 12),
          action: { label: t("operations.tasks.attention.open"), run: () => sheet.open(task.id) },
        });
      }
    } else {
      items.push({
        key: "stalled",
        tone: "danger",
        claim: t("operations.tasks.attention.stalledCount", { n: c.stalled }),
        action: { label: t("operations.tasks.attention.show"), run: () => showStatus("stalled") },
      });
    }
  }
  if (c?.pending) {
    items.push({
      key: "pending",
      tone: "warning",
      claim: t("operations.tasks.attention.pending", { n: c.pending }),
      proof: t("operations.tasks.attention.pendingProof"),
      action: { label: t("operations.tasks.attention.show"), run: () => showStatus("pending") },
    });
  }
  return items;
});

const metrics = computed<Metric[]>(() => {
  const c = counts.value;
  if (!c) return [];
  return [
    { key: "running", label: t("operations.tasks.metrics.running"), value: num(c.running), to: { query: { status: "leased" } } },
    { key: "queued", label: t("operations.tasks.metrics.queued"), value: num(c.queued + (c.pending ?? 0)), to: { query: { status: "pending,queued" } } },
    {
      key: "failed",
      label: t("operations.tasks.metrics.failed24h"),
      value: num(c.failed_24h),
      tone: c.failed_24h > 0 ? "destructive" : "default",
      to: { query: { status: "failed", range: "24h" } },
    },
    { key: "finished", label: t("operations.tasks.metrics.finished24h"), value: num(c.finished_24h) },
  ];
});

const layerTabs = computed<LayerTab<TaskLayer>[]>(() => [
  { value: "runs", label: t("operations.tasks.layers.runs") },
  { value: "new", label: t("operations.tasks.layers.new") },
]);

/* ------------------------------------------------------------------ */
/* Filters popover                                                     */
/* ------------------------------------------------------------------ */

const FILTER_STATUSES = ["failed", "stalled", "leased", "queued", "pending", "finished", "cancelled", "expired"] as const;

const filterCount = computed(() => {
  const applied = query.applied.value;
  return (applied.enums.status?.length ?? 0) + (applied.enums.origin?.length ?? 0) + (applied.values.node ? 1 : 0) + (applied.values.approval ? 1 : 0);
});

function toggleEnum(key: "status" | "origin", value: string): void {
  query.edit(bar, (next) => {
    const list = next.enums[key] ?? [];
    next.enums[key] = list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
    if (!next.enums[key]?.length) delete next.enums[key];
  });
}

const filterGroups = computed<QueryFilterGroup[]>(() => {
  const applied = query.applied.value;
  return [
    {
      key: "status",
      legend: t("operations.tasks.colStatus"),
      options: FILTER_STATUSES.map((status) => ({
        key: status,
        label: statusLabel(status),
        token: `status:${status}`,
        checked: applied.enums.status?.includes(status) ?? false,
        toggle: () => toggleEnum("status", status),
      })),
    },
    {
      key: "origin",
      legend: t("operations.tasks.cols.origin"),
      options: TASK_ORIGINS.map((origin) => ({
        key: origin,
        label: t(`operations.tasks.originFilter.${origin}`),
        token: `origin:${origin}`,
        checked: applied.enums.origin?.includes(origin) ?? false,
        toggle: () => toggleEnum("origin", origin),
      })),
    },
  ];
});

function refreshNow(): void {
  void refreshAll();
  void nodesQuery.refresh();
}
</script>

<template>
  <div class="space-y-5 p-4 sm:p-6">
    <PageHeader :title="$t('operations.tasks.title')">
      <template #description>
        <p class="text-sm text-muted-foreground">{{ $t('operations.tasks.description') }}</p>
        <ProofLine v-bind="proof" :segments="proofSegments" data-testid="tasks-proof-line" @retry="refreshNow" />
      </template>
      <template #actions>
        <Button variant="outline" size="sm" :disabled="runsQuery.refreshing.value" @click="refreshNow">
          <RefreshCw :class="cn('size-4', runsQuery.refreshing.value && 'animate-spin')" aria-hidden="true" />
          {{ $t('common.actions.refresh') }}
        </Button>
      </template>
    </PageHeader>

    <AttentionList :items="attention" />
    <MetricStrip v-if="metrics.length" :metrics="metrics" :columns="4" data-testid="tasks-metrics" />

    <LayerTabs v-model="layer" :tabs="layerTabs" :label="$t('operations.tasks.layers.label')" />

    <!-- Runs: one question, one page of answers. -->
    <template v-if="listing">
      <!-- No toolbar over a control plane that has never run a task. -->
      <QueryBar
        v-if="!nothingYet"
        ref="bar"
        testid="tasks-query-bar"
        :applied-text="query.appliedText.value"
        :applied-key="query.appliedKey.value"
        :label="$t('operations.tasks.query.label')"
        :placeholder="$t('operations.tasks.query.placeholder')"
        :ready="nodesQuery.data.value !== undefined || nodesQuery.error.value !== undefined"
        :problems="query.problems"
        :canonical="query.canonical"
        :ranges="TASK_RANGES"
        :range="query.range.value.range"
        :range-label="(value) => $t(`operations.opsRange.${value}`)"
        :filter-count="filterCount"
        :filter-groups="filterGroups"
        :filters-hint="$t('operations.tasks.query.filtersHint')"
        @submit="query.submit"
        @clear="query.clear"
        @update:range="query.setRange"
      />

      <DataTable
        :columns="columns"
        :rows="rows"
        :row-key="(row) => row.task.id"
        :loading="runsQuery.loading.value"
        :error="runsQuery.error.value"
        :has-data="runsQuery.data.value !== undefined"
        :show-summary="false"
        :row-click="(row, el) => sheet.open(row.task.id, el)"
        :active-row-id="sheet.openId.value"
        data-testid="tasks-table"
        @retry="refreshNow"
      >
        <template #empty>
          <EmptyState
            v-if="!filtered"
            :title="$t('operations.tasks.emptyTitle')"
            :description="$t('operations.tasks.empty.description')"
          >
            <Button v-if="canRun" size="sm" type="button" @click="layer = 'new'">
              <Play class="size-4" aria-hidden="true" />
              {{ $t('operations.tasks.layers.new') }}
            </Button>
          </EmptyState>
          <EmptyState
            v-else
            :title="$t('operations.tasks.empty.noMatchTitle')"
            :description="$t('operations.tasks.empty.noMatchDescription', { range: rangeText() })"
          >
            <Button v-if="query.range.value.range !== 'all'" variant="outline" size="sm" type="button" @click="query.setRange('all')">
              {{ $t('operations.opsRange.searchAnyTime') }}
            </Button>
            <Button v-else variant="outline" size="sm" type="button" @click="query.clear()">
              {{ $t('operations.tasks.empty.clearQuery') }}
            </Button>
          </EmptyState>
        </template>

        <template #cell-run="{ row }">
          <div class="flex min-w-0 flex-col items-start gap-1">
            <Badge :variant="statusVariant(row.task.status)">{{ statusLabel(row.task.status) }}</Badge>
            <span class="max-w-full truncate font-mono text-xs text-muted-foreground" :title="row.task.id">{{ shortId(row.task.id, 12) }}</span>
          </div>
        </template>

        <template #cell-targets="{ row }">
          <div class="min-w-0 space-y-0.5">
            <p class="flex min-w-0 items-center gap-1 text-sm">
              <NodeLabel :id="row.task.targets[0] ?? ''" class="max-w-[12rem]" />
              <span v-if="row.summary.total > 1" class="shrink-0 text-xs text-muted-foreground">
                {{ $t('operations.tasks.moreTargets', { n: row.summary.total - 1 }) }}
              </span>
            </p>
            <p v-if="resultsComplete(row) && row.summary.reported" class="text-xs tabular" :class="row.summary.failed ? 'text-destructive' : 'text-muted-foreground'">
              {{ $t('operations.tasks.passCount', { passed: row.summary.passed, total: row.summary.total }) }}
            </p>
          </div>
        </template>

        <template #cell-result="{ row }">
          <p
            :class="cn(
              'line-clamp-2 break-words font-mono text-xs',
              resultLine(row).tone === 'destructive' ? 'text-destructive' : resultLine(row).tone === 'warning' ? 'text-warning-text' : 'text-muted-foreground',
            )"
            :title="resultLine(row).text"
          >
            {{ resultLine(row).text }}
          </p>
        </template>

        <template #cell-origin="{ row }">
          <div class="min-w-0 text-sm">
            <template v-if="row.task.approval_id">
              <p class="text-xs text-muted-foreground">{{ $t('operations.tasks.origin.approval') }}</p>
              <RouterLink
                :to="{ name: 'approvals', query: { open: row.task.approval_id } }"
                class="block max-w-[14rem] truncate rounded-sm text-primary underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                :title="row.task.approval_id"
                data-no-row-nav
              >
                {{ planTitles.get(row.task.approval_id) || shortId(row.task.approval_id, 14) }}
              </RouterLink>
            </template>
            <template v-else-if="row.task.rerun_of_task_id || row.task.origin === 'rerun'">
              <p class="text-xs text-muted-foreground">{{ $t('operations.tasks.origin.rerun') }}</p>
              <RouterLink
                v-if="row.task.rerun_of_task_id"
                :to="{ query: { ...query.owned.query(), open: row.task.rerun_of_task_id } }"
                replace
                class="font-mono text-xs text-primary underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                :title="row.task.rerun_of_task_id"
                data-no-row-nav
              >
                {{ shortId(row.task.rerun_of_task_id, 12) }}
              </RouterLink>
            </template>
            <template v-else>
              <p class="text-xs text-muted-foreground">{{ $t('operations.tasks.origin.direct') }}</p>
              <p class="truncate">{{ row.task.actor_id || $t('common.misc.none') }}</p>
            </template>
          </div>
        </template>

        <template #cell-created="{ row }">
          <span class="whitespace-nowrap text-xs text-muted-foreground tabular" :title="formatDateTime(row.task.created_at)">
            {{ formatRelativeTime(row.task.created_at) }}
          </span>
        </template>

        <template #cell-actions="{ row }">
          <RowMenu :name="shortId(row.task.id, 12)" :items="menuItems(row.task)" />
        </template>
      </DataTable>

      <div
        v-if="runsQuery.data.value !== undefined && tasks.length"
        class="flex flex-wrap items-center justify-between gap-2 text-sm"
        data-testid="tasks-pager"
      >
        <span class="text-muted-foreground tabular">
          {{ $t('operations.tasks.showingRange', { from: num(bounds.from), to: num(bounds.to), total: num(total) }) }}
        </span>
        <div class="flex items-center gap-2">
          <span v-if="!polling" class="text-xs text-muted-foreground">{{ $t('operations.audit.pausedPastFirst') }}</span>
          <Button variant="outline" size="sm" :disabled="!hasPrev || runsQuery.loading.value" @click="query.setOffset(query.offset.value - TASK_PAGE_SIZE)">
            <ChevronLeft class="size-4" aria-hidden="true" />
            {{ $t('operations.audit.prev') }}
          </Button>
          <Button variant="outline" size="sm" :disabled="!hasNext || runsQuery.loading.value" @click="query.setOffset(query.offset.value + TASK_PAGE_SIZE)">
            {{ $t('operations.audit.next') }}
            <ChevronRight class="size-4" aria-hidden="true" />
          </Button>
        </div>
      </div>
    </template>

    <!-- New task stays mounted, so a draft survives a look at Runs. -->
    <TaskComposer
      v-show="layer === 'new'"
      :nodes="nodes"
      :nodes-loading="nodesQuery.loading.value"
      :nodes-error="nodesQuery.error.value"
      :nodes-loaded="nodesQuery.data.value !== undefined"
      :can-run="canRun"
      :execution-disabled="executionDisabled"
      @queued="onQueued"
      @retry-nodes="nodesQuery.refresh"
    />

    <ObjectSheet
      :open="!!sheet.openId.value"
      :title="$t('operations.tasks.detailTitle', { id: shortId(sheet.openId.value ?? '', 12) })"
      :subtitle="sheet.openId.value ?? undefined"
      :state="sheetState"
      :read-only="!canRun"
      :gone-title="lookupFailure ? $t('operations.tasks.sheet.notReadTitle') : $t('operations.tasks.sheet.goneTitle')"
      :gone-description="lookupFailure
        ? $t('operations.tasks.sheet.notReadDescription', { reason: lookupFailure })
        : $t('operations.tasks.sheet.goneDescription')"
      :return-focus="sheet.returnFocus"
      @close="sheet.close"
    >
      <TaskRunDetail
        v-if="openTask"
        :task="openTask"
        :nodes="nodes"
        :plan-title="openTask.approval_id ? planTitles.get(openTask.approval_id) : null"
        :reruns="openReruns"
        :can-run="canRun"
        :execution-disabled="executionDisabled"
        :busy="actionPending === openTask.id"
        @rerun-node="(nodeId, el) => openTask && askRerun(openTask, el, nodeId)"
      />
      <template v-if="openTask && canRun" #actions>
        <Button
          variant="outline"
          size="sm"
          type="button"
          :disabled="executionDisabled || actionPending === openTask.id"
          @click="(e: MouseEvent) => openTask && askRerun(openTask, e.currentTarget as HTMLElement)"
        >
          <RotateCcw class="size-4" aria-hidden="true" />
          {{ $t('operations.tasks.actions.rerun') }}
        </Button>
        <Button
          v-if="taskCancellable(openTask.status)"
          variant="outline"
          size="sm"
          type="button"
          :disabled="actionPending === openTask.id"
          @click="cancelTask(openTask)"
        >
          <Ban class="size-4" aria-hidden="true" />
          {{ $t('operations.tasks.actions.cancel') }}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          type="button"
          class="ms-auto text-destructive"
          @click="(e: MouseEvent) => openTask && askDelete(openTask, e.currentTarget as HTMLElement)"
        >
          <Trash2 class="size-4" aria-hidden="true" />
          {{ $t('operations.tasks.actions.delete') }}
        </Button>
      </template>
    </ObjectSheet>

    <ConfirmDialog
      v-model:open="deleteOpen"
      :title="$t('operations.tasks.deleteTitle')"
      :description="deleteTarget
        ? $t('operations.tasks.deleteSummary', { id: shortId(deleteTarget.id, 12), targets: deleteTarget.targets.map(nodeName).join(', ') })
        : ''"
      :impact="deleteImpact"
      :impact-title="$t('operations.tasks.deleteImpact.title')"
      :confirm-label="$t('operations.tasks.actions.delete')"
      :cancel-label="$t('common.actions.cancel')"
      :pending="!!deleteTarget && actionPending === deleteTarget.id"
      :return-focus="confirmReturn"
      @confirm="confirmDelete"
    />

    <ConfirmDialog
      v-model:open="rerunOpen"
      :title="rerunTitle"
      :description="$t('operations.tasks.rerunConfirm.description')"
      :impact="rerunPreview"
      :impact-title="$t('operations.tasks.rerunConfirm.previewTitle')"
      :confirm-label="rerunConfirmLabel"
      :cancel-label="$t('common.actions.cancel')"
      :pending="!!rerunRequest && actionPending === rerunRequest.task.id"
      :return-focus="confirmReturn"
      @confirm="confirmRerun"
    />
  </div>
</template>
