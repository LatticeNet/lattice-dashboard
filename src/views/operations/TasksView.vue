<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import {
  Ban,
  CheckCircle2,
  ChevronDown,
  ListChecks,
  Play,
  RefreshCw,
  RotateCcw,
  Search,
  Terminal,
  Timer,
  Trash2,
  XCircle,
} from "lucide-vue-next";
import { api, unwrap, type LinesListResponse, type Node, type TaskResult, type TaskView } from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { useAuthStore } from "@/stores/auth";
import { formatDateTime, shortId } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  agentConfigBadges,
  evalFilterExpression,
  nodeMatchesTargetToken,
  vpnLineNodeIds,
} from "@/lib/nodeFilterExpressions";

import PageHeader from "@/components/common/PageHeader.vue";
import DataState from "@/components/common/DataState.vue";
import FreshnessLabel from "@/components/common/FreshnessLabel.vue";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type StatusFilter = "all" | TaskView["status"];
type BadgeVariant = "default" | "secondary" | "destructive" | "outline";
type NodeRunStatus = "queued" | "leased" | "finished" | "failed" | "cancelled";

interface Attempt {
  task: TaskView;
  result?: TaskResult;
}

interface NodeExecutionRow {
  nodeId: string;
  node?: Node;
  attempts: Attempt[];
  latestTask?: TaskView;
  latestResult?: TaskResult;
  status: NodeRunStatus;
  failed: boolean;
}

const { t } = useI18n();
const route = useRoute();
const auth = useAuthStore();
const canRunTasks = computed(() => auth.can("task:run"));

const tasksQuery = useAsyncData<TaskView[] | undefined>(
  () => api.tasks.list().then((r) => unwrap(r, "tasks")),
  { pollInterval: 5000 },
);
const resultsQuery = useAsyncData<TaskResult[] | undefined>(
  () => api.tasks.results().then((r) => unwrap(r, "results")),
  { pollInterval: 5000 },
);
const nodesQuery = useAsyncData<Node[] | undefined>(
  () => api.nodes.list().then((r) => unwrap(r, "nodes")),
  { pollInterval: 5000 },
);
const vpnLinesQuery = useAsyncData(
  () =>
    api.plugins
      .call<LinesListResponse>("latticenet.vpn-core", "latticenet.vpn-core/lines", "list")
      .catch(() => ({ groups: [], count: 0 })),
  { pollInterval: 30000 },
);

const statusFilter = ref<StatusFilter>("all");
{
  const seeded = route.query.status;
  if (seeded === "queued" || seeded === "leased" || seeded === "finished" || seeded === "failed" || seeded === "cancelled") {
    statusFilter.value = seeded;
  }
}

const targetSearch = ref("");
const targetTag = ref("all");
const targetRegion = ref("all");
const targetExpr = ref("");
const selectedTargets = ref<string[]>([]);
const interpreter = ref("sh");
const script = ref("");
const timeoutSec = ref(60);
const outputLimit = ref(16384);
const taskSearch = ref("");
const expandedTasks = ref<Set<string>>(new Set());
const expandedNodeRows = ref<Set<string>>(new Set());
const historyPage = ref(1);
const HISTORY_PAGE_SIZE = 8;
const creating = ref(false);
const actionPending = ref<string | null>(null);

const nodes = computed<Node[]>(() => nodesQuery.data.value ?? []);
const tasks = computed<TaskView[]>(() => tasksQuery.data.value ?? []);
const results = computed<TaskResult[]>(() => resultsQuery.data.value ?? []);
const vpnLineNodes = computed(() => vpnLineNodeIds(vpnLinesQuery.data.value?.groups));
const nodesById = computed<Record<string, Node>>(() => Object.fromEntries(nodes.value.map((n) => [n.id, n])));
const tasksById = computed<Record<string, TaskView>>(() => Object.fromEntries(tasks.value.map((task) => [task.id, task])));

const allTags = computed(() => {
  const set = new Set<string>();
  for (const node of nodes.value) for (const tag of node.tags ?? []) set.add(tag);
  return [...set].sort((a, b) => a.localeCompare(b));
});

const allRegions = computed(() => {
  const set = new Set<string>();
  for (const node of nodes.value) set.add(nodeRegion(node));
  return [...set].sort((a, b) => a.localeCompare(b));
});

const filteredTargetNodes = computed(() => {
  const q = targetSearch.value.trim().toLowerCase();
  return nodes.value
    .filter((node) => {
      if (targetTag.value !== "all" && !(node.tags ?? []).includes(targetTag.value)) return false;
      if (targetRegion.value !== "all" && nodeRegion(node) !== targetRegion.value) return false;
      if (targetExpr.value.trim() && !evalFilterExpression(targetExpr.value, (token) => nodeMatchesTargetToken(node, token, vpnLineNodes.value.has(node.id))).value) return false;
      if (!q) return true;
      return [
        node.id,
        node.name,
        node.role,
        node.geo?.country,
        node.geo?.region,
        node.geo?.city,
        ...(node.tags ?? []),
      ]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(q));
    })
    .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
});

const selectedSet = computed(() => new Set(selectedTargets.value));

const resultsByTask = computed<Record<string, TaskResult[]>>(() => {
  const grouped: Record<string, TaskResult[]> = {};
  for (const result of results.value) {
    (grouped[result.task_id] ||= []).push(result);
  }
  for (const list of Object.values(grouped)) {
    list.sort((a, b) => timeValue(b.finished_at) - timeValue(a.finished_at));
  }
  return grouped;
});

const childTasksByRoot = computed<Record<string, TaskView[]>>(() => {
  const grouped: Record<string, TaskView[]> = {};
  for (const task of tasks.value) {
    if (!task.rerun_of_task_id) continue;
    (grouped[task.rerun_of_task_id] ||= []).push(task);
  }
  for (const list of Object.values(grouped)) {
    list.sort((a, b) => timeValue(a.created_at) - timeValue(b.created_at));
  }
  return grouped;
});

const rootTasks = computed(() =>
  tasks.value
    .filter((task) => !task.rerun_of_task_id || !tasksById.value[task.rerun_of_task_id])
    .sort((a, b) => timeValue(b.created_at) - timeValue(a.created_at)),
);

const filteredRootTasks = computed(() => {
  const q = taskSearch.value.trim().toLowerCase();
  return rootTasks.value.filter((task) => {
    const rows = nodeRows(task);
    if (statusFilter.value !== "all" && groupStatus(task, rows) !== statusFilter.value) return false;
    if (!q) return true;
    const attemptIds = attemptTasks(task).map((attempt) => attempt.id);
    const haystack = [
      task.id,
      task.interpreter,
      groupStatus(task, rows),
      ...attemptIds,
      ...task.targets,
      ...task.targets.map((id) => nodeName(id)),
      ...rows.map((row) => row.latestResult?.error ?? ""),
    ].join(" ").toLowerCase();
    return haystack.includes(q);
  });
});

const queuedCount = computed(() => tasks.value.filter((task) => task.status === "queued").length);
const runningCount = computed(() => tasks.value.filter((task) => task.status === "leased").length);
const failedCount = computed(() => rootTasks.value.filter((task) => groupStatus(task, nodeRows(task)) === "failed").length);
const historyTotalPages = computed(() => Math.max(1, Math.ceil(filteredRootTasks.value.length / HISTORY_PAGE_SIZE)));
const pagedRootTasks = computed(() => {
  const page = Math.min(historyPage.value, historyTotalPages.value);
  const start = (page - 1) * HISTORY_PAGE_SIZE;
  return filteredRootTasks.value.slice(start, start + HISTORY_PAGE_SIZE);
});

watch(
  () => [taskSearch.value, statusFilter.value, filteredRootTasks.value.length],
  () => {
    if (historyPage.value > historyTotalPages.value) historyPage.value = historyTotalPages.value;
    else historyPage.value = 1;
  },
);

function nodeRegion(node: Node): string {
  return [node.geo?.country, node.geo?.region].filter(Boolean).join(" / ") || t("operations.tasks.unknownRegion");
}

function nodeName(id: string): string {
  return nodesById.value[id]?.name || id;
}

function timeValue(value?: string): number {
  return value ? new Date(value).getTime() || 0 : 0;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function toggleTarget(id: string) {
  const next = new Set(selectedTargets.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selectedTargets.value = [...next];
}

function selectVisible(onlineOnly = false) {
  const next = new Set(selectedTargets.value);
  for (const node of filteredTargetNodes.value) {
    if (!onlineOnly || node.online) next.add(node.id);
  }
  selectedTargets.value = [...next];
}

function clearVisible() {
  const visible = new Set(filteredTargetNodes.value.map((node) => node.id));
  selectedTargets.value = selectedTargets.value.filter((id) => !visible.has(id));
}

function attemptTasks(root: TaskView): TaskView[] {
  return [root, ...(childTasksByRoot.value[root.id] ?? [])].sort((a, b) => timeValue(a.created_at) - timeValue(b.created_at));
}

function latestResultFor(taskId: string, nodeId: string): TaskResult | undefined {
  return (resultsByTask.value[taskId] ?? []).find((result) => result.node_id === nodeId);
}

function nodeRows(root: TaskView): NodeExecutionRow[] {
  const attempts = attemptTasks(root);
  const targets = unique(root.targets);
  return targets.map((nodeId) => {
    const nodeAttempts = attempts
      .filter((task) => task.targets.includes(nodeId))
      .map((task) => ({ task, result: latestResultFor(task.id, nodeId) }));
    const latest = nodeAttempts[nodeAttempts.length - 1];
    const latestResult = latest?.result;
    const latestTask = latest?.task;
    const failed = !!latestResult && resultFailed(latestResult);
    const status = latestResult
      ? failed
        ? "failed"
        : "finished"
      : latestTask?.status === "failed"
        ? "failed"
        : latestTask?.status === "cancelled"
          ? "cancelled"
          : latestTask?.status === "leased"
            ? "leased"
            : "queued";
    return {
      nodeId,
      node: nodesById.value[nodeId],
      attempts: nodeAttempts,
      latestTask,
      latestResult,
      status,
      failed: status === "failed",
    };
  });
}

function groupStatus(root: TaskView, rows: NodeExecutionRow[]): TaskView["status"] {
  if (rows.some((row) => row.status === "leased")) return "leased";
  if (rows.some((row) => row.status === "queued")) return root.status === "cancelled" ? "cancelled" : "queued";
  if (rows.some((row) => row.status === "failed")) return "failed";
  if (rows.length > 0 && rows.every((row) => row.status === "cancelled")) return "cancelled";
  return root.status === "cancelled" ? "cancelled" : "finished";
}

function resultFailed(result: TaskResult): boolean {
  return !!result.error || (result.exit_code ?? 0) !== 0;
}

function statusLabel(status: NodeRunStatus | TaskView["status"]): string {
  return t(`operations.tasks.status.${status}`);
}

function statusVariant(status: NodeRunStatus | TaskView["status"]): BadgeVariant {
  if (status === "failed") return "destructive";
  if (status === "finished") return "default";
  if (status === "leased") return "secondary";
  return "outline";
}

function taskCounts(rows: NodeExecutionRow[]) {
  const done = rows.filter((row) => row.latestResult).length;
  const failed = rows.filter((row) => row.failed).length;
  return { done, failed, total: rows.length };
}

function isExpanded(id: string): boolean {
  return expandedTasks.value.has(id);
}

function toggleExpanded(id: string) {
  const next = new Set(expandedTasks.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expandedTasks.value = next;
}

function nodeRowKey(taskId: string, nodeId: string): string {
  return `${taskId}:${nodeId}`;
}

function isNodeExpanded(taskId: string, nodeId: string): boolean {
  return expandedNodeRows.value.has(nodeRowKey(taskId, nodeId));
}

function toggleNodeExpanded(taskId: string, nodeId: string) {
  const key = nodeRowKey(taskId, nodeId);
  const next = new Set(expandedNodeRows.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  expandedNodeRows.value = next;
}

function hasExpandedNode(task: TaskView): boolean {
  return nodeRows(task).some((row) => isNodeExpanded(task.id, row.nodeId));
}

function rowLatestText(row: NodeExecutionRow): string {
  if (!row.latestResult) return row.status === "queued" ? t("operations.tasks.waitingLease") : t("operations.tasks.running");
  const exit = t("operations.tasks.exit", { code: row.latestResult.exit_code ?? 0 });
  const error = row.latestResult.error?.trim();
  return error ? `${exit} · ${error}` : `${exit} · ${formatDateTime(row.latestResult.finished_at)}`;
}

function taskLatestSummary(task: TaskView): string {
  const rows = nodeRows(task);
  const failed = rows.find((row) => row.failed);
  if (failed) return `${nodeName(failed.nodeId)} · ${rowLatestText(failed)}`;
  const active = rows.find((row) => row.status === "leased" || row.status === "queued");
  if (active) return `${nodeName(active.nodeId)} · ${rowLatestText(active)}`;
  const latest = [...rows]
    .filter((row) => row.latestResult)
    .sort((a, b) => timeValue(b.latestResult?.finished_at) - timeValue(a.latestResult?.finished_at))[0];
  return latest ? `${nodeName(latest.nodeId)} · ${rowLatestText(latest)}` : statusLabel(task.status);
}

function taskProgressLabel(task: TaskView): string {
  const counts = taskCounts(nodeRows(task));
  return `${counts.done}/${counts.total} · ${counts.failed} failed · ${attemptTasks(task).length} attempts`;
}

function nodeAgentBadges(node?: Node): string[] {
  return node ? agentConfigBadges(node, vpnLineNodes.value.has(node.id)) : [];
}

async function refreshAll() {
  await Promise.all([tasksQuery.refresh(), resultsQuery.refresh(), nodesQuery.refresh()]);
}

async function createTask() {
  if (!selectedTargets.value.length) {
    toast.error(t("operations.tasks.errNoTargets"));
    return;
  }
  if (!script.value.trim()) {
    toast.error(t("operations.tasks.errNoScript"));
    return;
  }
  creating.value = true;
  try {
    await api.tasks.create({
      targets: selectedTargets.value,
      interpreter: interpreter.value,
      script: script.value,
      timeout_sec: timeoutSec.value,
      output_limit: outputLimit.value,
    });
    toast.success(t("operations.tasks.toastQueued"));
    script.value = "";
    await refreshAll();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("operations.tasks.toastFailed"));
  } finally {
    creating.value = false;
  }
}

async function rerunTask(task: TaskView) {
  actionPending.value = `task:${task.id}`;
  try {
    await api.tasks.rerun(task.id);
    toast.success(t("operations.tasks.toastRerun"));
    await refreshAll();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("operations.tasks.toastRerunFailed"));
  } finally {
    actionPending.value = null;
  }
}

async function rerunNode(task: TaskView, nodeId: string) {
  actionPending.value = `node:${task.id}:${nodeId}`;
  try {
    await api.tasks.rerunNode(task.id, nodeId);
    toast.success(t("operations.tasks.toastRerunNode", { node: nodeName(nodeId) }));
    await refreshAll();
    if (!isExpanded(task.id)) toggleExpanded(task.id);
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("operations.tasks.toastRerunFailed"));
  } finally {
    actionPending.value = null;
  }
}

async function cancelTask(task: TaskView) {
  actionPending.value = `task:${task.id}`;
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

async function deleteTask(task: TaskView) {
  if (!window.confirm(t("operations.tasks.deleteConfirm", { id: shortId(task.id) }))) return;
  actionPending.value = `task:${task.id}`;
  try {
    await api.tasks.delete(task.id);
    toast.success(t("operations.tasks.toastDeleted"));
    await refreshAll();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("operations.tasks.toastDeleteFailed"));
  } finally {
    actionPending.value = null;
  }
}
</script>

<template>
  <div class="space-y-6 p-6">
    <PageHeader :title="$t('operations.tasks.title')" :description="$t('operations.tasks.description')">
      <template #meta>
        <FreshnessLabel :last-updated="tasksQuery.lastUpdated.value || resultsQuery.lastUpdated.value" />
      </template>
      <template #actions>
        <Button variant="outline" size="sm" :disabled="tasksQuery.refreshing.value" @click="refreshAll">
          <RefreshCw :class="cn('size-4', tasksQuery.refreshing.value && 'animate-spin')" aria-hidden="true" />
          {{ $t('common.actions.refresh') }}
        </Button>
      </template>
    </PageHeader>

    <div class="grid gap-4 md:grid-cols-3">
      <Card>
        <CardContent class="flex items-center justify-between p-4">
          <div>
            <p class="text-xs font-medium uppercase text-muted-foreground">{{ $t('operations.tasks.queued') }}</p>
            <p class="mt-1 text-2xl font-semibold">{{ queuedCount }}</p>
          </div>
          <Timer class="size-5 text-muted-foreground" aria-hidden="true" />
        </CardContent>
      </Card>
      <Card>
        <CardContent class="flex items-center justify-between p-4">
          <div>
            <p class="text-xs font-medium uppercase text-muted-foreground">{{ $t('operations.tasks.running') }}</p>
            <p class="mt-1 text-2xl font-semibold">{{ runningCount }}</p>
          </div>
          <Terminal class="size-5 text-muted-foreground" aria-hidden="true" />
        </CardContent>
      </Card>
      <Card>
        <CardContent class="flex items-center justify-between p-4">
          <div>
            <p class="text-xs font-medium uppercase text-muted-foreground">{{ $t('operations.tasks.failed') }}</p>
            <p class="mt-1 text-2xl font-semibold">{{ failedCount }}</p>
          </div>
          <XCircle class="size-5 text-destructive" aria-hidden="true" />
        </CardContent>
      </Card>
    </div>

    <Card v-if="canRunTasks">
      <CardHeader>
        <CardTitle class="flex items-center gap-2">
          <Play class="size-4 text-muted-foreground" aria-hidden="true" />
          {{ $t('operations.tasks.queueTask') }}
        </CardTitle>
        <CardDescription>{{ $t('operations.tasks.queueTaskHint') }}</CardDescription>
      </CardHeader>
      <CardContent>
        <form class="grid gap-5 xl:grid-cols-[minmax(360px,0.9fr)_1fr]" @submit.prevent="createTask">
          <div class="space-y-3 rounded-lg border border-border bg-muted/20 p-3">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <div>
                <Label>{{ $t('operations.tasks.targets') }}</Label>
                <p class="text-xs text-muted-foreground">
                  {{ $t('operations.tasks.selectedTargets', { count: selectedTargets.length }) }}
                </p>
              </div>
              <div class="flex flex-wrap gap-1.5">
                <Button type="button" variant="outline" size="sm" @click="selectVisible(false)">
                  {{ $t('operations.tasks.selectVisible') }}
                </Button>
                <Button type="button" variant="outline" size="sm" @click="selectVisible(true)">
                  {{ $t('operations.tasks.selectOnline') }}
                </Button>
                <Button type="button" variant="ghost" size="sm" @click="clearVisible">
                  {{ $t('operations.tasks.clearVisible') }}
                </Button>
              </div>
            </div>

            <div class="grid gap-2 md:grid-cols-[1fr_0.8fr_0.8fr]">
              <div class="relative">
                <Search class="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" aria-hidden="true" />
                <Input v-model="targetSearch" class="pl-8" :placeholder="$t('operations.tasks.targetSearch')" />
              </div>
              <Select v-model="targetTag">
                <SelectTrigger><SelectValue :placeholder="$t('operations.tasks.filterTag')" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{{ $t('operations.tasks.allTags') }}</SelectItem>
                  <SelectItem v-for="tag in allTags" :key="tag" :value="tag">{{ tag }}</SelectItem>
                </SelectContent>
              </Select>
              <Select v-model="targetRegion">
                <SelectTrigger><SelectValue :placeholder="$t('operations.tasks.filterRegion')" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{{ $t('operations.tasks.allRegions') }}</SelectItem>
                  <SelectItem v-for="region in allRegions" :key="region" :value="region">{{ region }}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div class="grid gap-1.5">
              <Label for="task-target-expr" class="text-xs text-muted-foreground">{{ $t('operations.tasks.targetExpression') }}</Label>
              <Input
                id="task-target-expr"
                v-model="targetExpr"
                class="font-mono text-xs"
                :placeholder="$t('operations.tasks.targetExpressionPlaceholder')"
              />
            </div>

            <DataState
              :loading="nodesQuery.loading.value"
              :error="nodesQuery.error.value"
              :empty="filteredTargetNodes.length === 0"
              :empty-title="$t('operations.tasks.noNodesTitle')"
              :empty-description="$t('operations.tasks.noNodesDescription')"
              @retry="nodesQuery.refresh"
            >
              <div class="max-h-[26rem] space-y-1.5 overflow-y-auto pr-1">
                <button
                  v-for="node in filteredTargetNodes"
                  :key="node.id"
                  type="button"
                  :class="cn(
                    'grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-md border px-2.5 py-2 text-left transition-colors',
                    selectedSet.has(node.id) ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/40',
                  )"
                  @click="toggleTarget(node.id)"
                >
                  <div class="grid min-w-0 gap-1">
                    <div class="flex min-w-0 flex-wrap items-center gap-1.5">
                      <span class="truncate text-sm font-medium">{{ node.name || node.id }}</span>
                      <Badge :variant="node.online ? 'default' : 'secondary'">
                        {{ node.online ? $t('operations.tasks.on') : $t('operations.tasks.off') }}
                      </Badge>
                      <Badge
                        v-for="badge in nodeAgentBadges(node).slice(0, 3)"
                        :key="`${node.id}:${badge}`"
                        :variant="badge === 'vpn-lines' ? 'success' : 'outline'"
                        class="text-[10px]"
                      >
                        {{ badge }}
                      </Badge>
                    </div>
                    <div class="flex min-w-0 flex-wrap items-center gap-1 text-xs text-muted-foreground">
                      <span class="truncate font-mono">{{ node.id }}</span>
                      <span aria-hidden="true">·</span>
                      <span class="truncate">{{ nodeRegion(node) }}</span>
                    </div>
                    <div class="flex max-h-6 flex-wrap gap-1 overflow-hidden">
                      <Badge variant="outline" class="text-[10px]">{{ nodeRegion(node) }}</Badge>
                      <Badge v-for="tag in (node.tags ?? []).slice(0, 5)" :key="tag" variant="secondary" class="text-[10px]">{{ tag }}</Badge>
                      <Badge v-if="(node.tags ?? []).length > 5" variant="outline" class="text-[10px]">+{{ (node.tags ?? []).length - 5 }}</Badge>
                    </div>
                  </div>
                  <span
                    :class="cn(
                      'mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border',
                      selectedSet.has(node.id) ? 'border-primary bg-primary text-primary-foreground' : 'border-border',
                    )"
                  >
                    <CheckCircle2 v-if="selectedSet.has(node.id)" class="size-3.5" aria-hidden="true" />
                  </span>
                </button>
              </div>
            </DataState>
          </div>

          <div class="space-y-3">
            <div class="grid gap-3 sm:grid-cols-3">
              <div class="grid gap-2">
                <Label>{{ $t('operations.tasks.interpreter') }}</Label>
                <Select v-model="interpreter">
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="sh">sh</SelectItem>
                    <SelectItem value="bash">bash</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div class="grid gap-2">
                <Label>{{ $t('operations.tasks.timeoutSec') }}</Label>
                <Input v-model.number="timeoutSec" type="number" min="1" max="600" />
              </div>
              <div class="grid gap-2">
                <Label>{{ $t('operations.tasks.outputLimit') }}</Label>
                <Input v-model.number="outputLimit" type="number" min="256" max="65536" />
              </div>
            </div>
            <div class="grid gap-2">
              <Label>{{ $t('operations.tasks.script') }}</Label>
              <textarea
                v-model="script"
                rows="12"
                class="rounded-md border border-input bg-background p-3 font-mono text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
                placeholder="uname -a"
              />
            </div>
            <div class="flex flex-wrap items-center justify-between gap-2">
              <p class="text-xs text-muted-foreground">
                {{ $t('operations.tasks.fanoutHint') }}
              </p>
              <Button type="submit" :disabled="creating || !selectedTargets.length || !script.trim()">
                <RefreshCw v-if="creating" class="size-4 animate-spin" aria-hidden="true" />
                <Play v-else class="size-4" aria-hidden="true" />
                {{ $t('operations.tasks.queueTaskCta') }}
              </Button>
            </div>
          </div>
        </form>
      </CardContent>
    </Card>

    <Card>
      <CardHeader>
        <div class="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>{{ $t('operations.tasks.history') }}</CardTitle>
            <CardDescription>{{ $t('operations.tasks.historyHint') }}</CardDescription>
          </div>
          <div class="flex flex-wrap gap-2">
            <div class="relative">
              <Search class="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" aria-hidden="true" />
              <Input v-model="taskSearch" class="w-72 pl-8" :placeholder="$t('operations.tasks.searchPlaceholder')" />
            </div>
            <Select v-model="statusFilter">
              <SelectTrigger class="w-36"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{{ $t('operations.tasks.allStatuses') }}</SelectItem>
                <SelectItem value="queued">{{ $t('operations.tasks.status.queued') }}</SelectItem>
                <SelectItem value="leased">{{ $t('operations.tasks.status.leased') }}</SelectItem>
                <SelectItem value="finished">{{ $t('operations.tasks.status.finished') }}</SelectItem>
                <SelectItem value="failed">{{ $t('operations.tasks.status.failed') }}</SelectItem>
                <SelectItem value="cancelled">{{ $t('operations.tasks.status.cancelled') }}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <DataState
          :loading="tasksQuery.loading.value || resultsQuery.loading.value"
          :error="tasksQuery.error.value || resultsQuery.error.value"
          :empty="filteredRootTasks.length === 0"
          :empty-title="rootTasks.length ? $t('operations.tasks.noMatch') : $t('operations.tasks.emptyTitle')"
          :empty-description="rootTasks.length ? '' : $t('operations.tasks.emptyDescription')"
          @retry="refreshAll"
        >
          <div class="mb-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>{{ $t('operations.tasks.showing', { shown: filteredRootTasks.length, total: rootTasks.length }) }}</span>
            <span v-if="historyTotalPages > 1" class="font-mono">
              {{ $t('operations.tasks.pageStatus', { page: historyPage, total: historyTotalPages }) }}
            </span>
          </div>

          <div class="space-y-4">
            <div
              v-for="task in pagedRootTasks"
              :key="task.id"
              class="rounded-xl border border-border bg-card shadow-sm"
            >
              <div class="space-y-3 p-3">
                <div class="flex flex-wrap items-start justify-between gap-3">
                  <div class="min-w-0 space-y-2">
                    <div class="flex flex-wrap items-center gap-2">
                      <Badge :variant="statusVariant(groupStatus(task, nodeRows(task)))">
                        {{ statusLabel(groupStatus(task, nodeRows(task))) }}
                      </Badge>
                      <span class="font-mono text-sm font-semibold">{{ shortId(task.id) }}</span>
                      <Badge variant="outline">{{ task.interpreter }}</Badge>
                      <span class="text-xs text-muted-foreground">{{ formatDateTime(task.created_at) }}</span>
                    </div>
                    <div class="flex flex-wrap items-center gap-1.5">
                      <Badge
                        v-for="nodeId in task.targets.slice(0, 4)"
                        :key="nodeId"
                        variant="secondary"
                        class="max-w-52 truncate"
                      >
                        {{ nodeName(nodeId) }}
                      </Badge>
                      <Badge v-if="task.targets.length > 4" variant="outline">
                        +{{ task.targets.length - 4 }}
                      </Badge>
                    </div>
                    <p class="line-clamp-1 text-xs text-muted-foreground">
                      {{ taskLatestSummary(task) }}
                    </p>
                  </div>

                  <div class="flex flex-wrap items-center justify-end gap-2">
                    <Badge variant="outline">
                      {{ $t('operations.tasks.bytes', { count: task.script_size_bytes ?? 0 }) }}
                    </Badge>
                    <Badge variant="outline">
                      {{ $t('operations.tasks.seconds', { count: task.timeout_sec ?? 0 }) }}
                    </Badge>
                    <Button variant="outline" size="sm" :disabled="actionPending === `task:${task.id}`" @click="rerunTask(task)">
                      <RotateCcw class="size-4" aria-hidden="true" />
                      {{ $t('operations.tasks.actions.rerun') }}
                    </Button>
                    <Button v-if="task.status === 'queued'" variant="outline" size="sm" :disabled="actionPending === `task:${task.id}`" @click="cancelTask(task)">
                      <Ban class="size-4" aria-hidden="true" />
                      {{ $t('operations.tasks.actions.cancel') }}
                    </Button>
                    <Button variant="ghost" size="icon" class="text-destructive" :disabled="actionPending === `task:${task.id}`" @click="deleteTask(task)">
                      <Trash2 class="size-4" aria-hidden="true" />
                    </Button>
                  </div>
                </div>

                <div class="grid gap-2 text-sm md:grid-cols-4">
                  <div class="rounded-md border border-border bg-muted/20 p-2.5">
                    <p class="text-xs text-muted-foreground">{{ $t('operations.tasks.targetProgress') }}</p>
                    <p class="mt-1 font-medium">
                      {{ taskCounts(nodeRows(task)).done }} / {{ taskCounts(nodeRows(task)).total }}
                    </p>
                  </div>
                  <div class="rounded-md border border-border bg-muted/20 p-2.5">
                    <p class="text-xs text-muted-foreground">{{ $t('operations.tasks.failedTargets') }}</p>
                    <p class="mt-1 font-medium">{{ taskCounts(nodeRows(task)).failed }}</p>
                  </div>
                  <div class="rounded-md border border-border bg-muted/20 p-2.5">
                    <p class="text-xs text-muted-foreground">{{ $t('operations.tasks.attempts') }}</p>
                    <p class="mt-1 font-medium">{{ attemptTasks(task).length }}</p>
                  </div>
                  <div class="rounded-md border border-border bg-muted/20 p-2.5">
                    <p class="text-xs text-muted-foreground">{{ $t('operations.tasks.latest') }}</p>
                    <p class="mt-1 line-clamp-1 text-xs">{{ taskProgressLabel(task) }}</p>
                  </div>
                </div>

                <Button variant="ghost" size="sm" @click="toggleExpanded(task.id)">
                  <ChevronDown :class="cn('size-4 transition-transform', isExpanded(task.id) && 'rotate-180')" aria-hidden="true" />
                  {{ isExpanded(task.id) ? $t('operations.tasks.collapseResults') : $t('operations.tasks.expandResults') }}
                </Button>

                <div v-if="isExpanded(task.id)" class="overflow-x-auto rounded-lg border border-border">
                  <table class="w-full min-w-[760px] text-sm">
                    <thead class="bg-muted/50 text-xs uppercase text-muted-foreground">
                      <tr>
                        <th class="px-3 py-2 text-left">{{ $t('operations.tasks.colTarget') }}</th>
                        <th class="px-3 py-2 text-left">{{ $t('operations.tasks.colStatus') }}</th>
                        <th class="px-3 py-2 text-left">{{ $t('operations.tasks.colLatest') }}</th>
                        <th class="px-3 py-2 text-left">{{ $t('operations.tasks.colAttempts') }}</th>
                        <th class="px-3 py-2 text-right">{{ $t('operations.tasks.colActions') }}</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="row in nodeRows(task)" :key="row.nodeId" class="border-t border-border">
                        <td class="px-3 py-2">
                          <div class="min-w-0">
                            <p class="truncate font-medium">{{ nodeName(row.nodeId) }}</p>
                            <p class="truncate font-mono text-xs text-muted-foreground">{{ row.nodeId }}</p>
                          </div>
                        </td>
                        <td class="px-3 py-2">
                          <Badge :variant="statusVariant(row.status)">{{ statusLabel(row.status) }}</Badge>
                        </td>
                        <td class="px-3 py-2">
                          <p v-if="row.latestResult" class="font-mono text-xs">
                            {{ $t('operations.tasks.exit', { code: row.latestResult.exit_code ?? 0 }) }}
                            · {{ formatDateTime(row.latestResult.finished_at) }}
                          </p>
                          <p v-else class="text-xs text-muted-foreground">
                            {{ row.status === 'queued' ? $t('operations.tasks.waitingLease') : $t('operations.tasks.running') }}
                          </p>
                          <p v-if="row.latestResult?.error" class="mt-1 line-clamp-1 text-xs text-destructive">
                            {{ row.latestResult.error }}
                          </p>
                        </td>
                        <td class="px-3 py-2">
                          <Badge variant="outline">
                            <ListChecks class="size-3.5" aria-hidden="true" />
                            {{ row.attempts.length }}
                          </Badge>
                        </td>
                        <td class="px-3 py-2 text-right">
                          <Button
                            variant="ghost"
                            size="sm"
                            @click="toggleNodeExpanded(task.id, row.nodeId)"
                          >
                            <ChevronDown :class="cn('size-4 transition-transform', isNodeExpanded(task.id, row.nodeId) && 'rotate-180')" aria-hidden="true" />
                            {{ isNodeExpanded(task.id, row.nodeId) ? $t('operations.tasks.collapseAttempts') : $t('operations.tasks.expandAttempts') }}
                          </Button>
                          <Button
                            v-if="row.failed"
                            variant="outline"
                            size="sm"
                            :disabled="actionPending === `node:${task.id}:${row.nodeId}`"
                            @click="rerunNode(task, row.nodeId)"
                          >
                            <RotateCcw class="size-4" aria-hidden="true" />
                            {{ $t('operations.tasks.actions.rerunNode') }}
                          </Button>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>

              <div v-if="isExpanded(task.id) && hasExpandedNode(task)" class="space-y-3 border-t border-border bg-muted/15 p-4">
                <div v-for="row in nodeRows(task)" v-show="isNodeExpanded(task.id, row.nodeId)" :key="`${task.id}:${row.nodeId}:attempts`" class="space-y-2">
                  <p class="text-sm font-medium">{{ nodeName(row.nodeId) }}</p>
                  <div
                    v-for="attempt in row.attempts"
                    :key="`${attempt.task.id}:${row.nodeId}`"
                    class="rounded-md border border-border bg-background p-3"
                  >
                    <div class="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <Badge :variant="attempt.result ? statusVariant(resultFailed(attempt.result) ? 'failed' : 'finished') : statusVariant(attempt.task.status)">
                        {{ attempt.result ? statusLabel(resultFailed(attempt.result) ? 'failed' : 'finished') : statusLabel(attempt.task.status) }}
                      </Badge>
                      <span class="font-mono">{{ shortId(attempt.task.id) }}</span>
                      <span v-if="attempt.task.rerun_of_node_id">{{ $t('operations.tasks.nodeRerunBadge') }}</span>
                      <span>{{ formatDateTime(attempt.result?.finished_at || attempt.task.created_at) }}</span>
                    </div>
                    <pre v-if="attempt.result?.stdout" class="max-h-56 overflow-auto rounded bg-muted p-3 text-xs">{{ attempt.result.stdout }}</pre>
                    <pre v-if="attempt.result?.stderr" class="mt-2 max-h-56 overflow-auto rounded bg-destructive/10 p-3 text-xs text-destructive">{{ attempt.result.stderr }}</pre>
                    <pre v-if="attempt.result?.error" class="mt-2 max-h-56 overflow-auto rounded bg-destructive/10 p-3 text-xs text-destructive">{{ attempt.result.error }}</pre>
                    <p v-if="!attempt.result" class="text-xs text-muted-foreground">{{ $t('operations.tasks.noResultYet') }}</p>
                  </div>
                </div>
              </div>
            </div>
          </div>
          <div v-if="historyTotalPages > 1" class="mt-4 flex items-center justify-end gap-2">
            <Button variant="outline" size="sm" :disabled="historyPage <= 1" @click="historyPage -= 1">
              {{ $t('operations.tasks.prevPage') }}
            </Button>
            <Button variant="outline" size="sm" :disabled="historyPage >= historyTotalPages" @click="historyPage += 1">
              {{ $t('operations.tasks.nextPage') }}
            </Button>
          </div>
        </DataState>
      </CardContent>
    </Card>
  </div>
</template>
