<script setup lang="ts">
import { computed, ref } from "vue";
import { useRoute } from "vue-router";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import { Play, RefreshCw, Terminal, Timer, CheckCircle2, XCircle, RotateCcw, Ban, Trash2 } from "lucide-vue-next";
import { api, unwrap, type TaskResult, type TaskView } from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { useAuthStore } from "@/stores/auth";
import { statusMeta, type BadgeVariant, type NodeHealth } from "@/lib/status";
import { formatDateTime, shortId } from "@/lib/format";
import { cn } from "@/lib/utils";

import PageHeader from "@/components/common/PageHeader.vue";
import DataState from "@/components/common/DataState.vue";
import ConfirmDialog from "@/components/common/ConfirmDialog.vue";
import FreshnessLabel from "@/components/common/FreshnessLabel.vue";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const { t } = useI18n();
const auth = useAuthStore();
const route = useRoute();

type TaskFilter = "all" | "queued" | "running" | "finished" | "failed";
const statusFilter = ref<TaskFilter>("all");
// Seed from a deep-link (Overview "queued tasks" KPI links to /tasks?status=queued).
{
  const s = route.query.status;
  if (s === "queued" || s === "finished" || s === "failed") statusFilter.value = s;
  else if (s === "running" || s === "leased") statusFilter.value = "running";
}
const tasksQuery = useAsyncData(() => api.tasks.list().then((r) => unwrap(r, "tasks")), {
  pollInterval: 8000,
});
const resultsQuery = useAsyncData(() => api.tasks.results().then((r) => unwrap(r, "results")), {
  pollInterval: 8000,
});
const nodesQuery = useAsyncData(() => api.nodes.list().then((r) => unwrap(r, "nodes")), {
  pollInterval: 10000,
});

const selectedTargets = ref<string[]>([]);
const interpreter = ref("sh");
const script = ref("");
const timeoutSec = ref(60);
const outputLimit = ref(65536);
const createPending = ref(false);

const tasks = computed(() => tasksQuery.data.value ?? []);
const results = computed(() => resultsQuery.data.value ?? []);
const nodes = computed(() => nodesQuery.data.value ?? []);
const canRunTasks = computed(() => auth.can("task:run"));

const sortedTasks = computed(() =>
  [...tasks.value].sort((a, b) => (b.created_at || "").localeCompare(a.created_at || "")),
);

const filteredTasks = computed(() =>
  sortedTasks.value.filter((task) => {
    switch (statusFilter.value) {
      case "queued":
        return task.status === "queued";
      case "running":
        return task.status === "leased";
      case "finished":
        return task.status === "finished";
      case "failed":
        return task.status === "failed";
      default:
        return true;
    }
  }),
);

const resultsByTask = computed<Record<string, TaskResult[]>>(() => {
  const grouped: Record<string, TaskResult[]> = {};
  for (const result of results.value) {
    const bucket = grouped[result.task_id] ?? [];
    bucket.push(result);
    grouped[result.task_id] = bucket;
  }
  return grouped;
});

const queuedCount = computed(() => tasks.value.filter((task) => task.status === "queued").length);
const finishedCount = computed(() => tasks.value.filter((task) => task.status === "finished").length);
const failedCount = computed(() => tasks.value.filter((task) => task.status === "failed").length);

function statusLabel(status: TaskView["status"]): string {
  return t(`operations.tasks.status.${status}`);
}

const TASK_HEALTH: Record<TaskView["status"], NodeHealth> = {
  finished: "online",
  failed: "offline",
  queued: "degraded",
  leased: "degraded",
  cancelled: "unknown",
};

const DELETABLE = new Set<TaskView["status"]>(["finished", "failed", "cancelled"]);
function canDelete(task: TaskView): boolean {
  return DELETABLE.has(task.status);
}

function statusVariant(status: TaskView["status"]): BadgeVariant {
  return statusMeta(TASK_HEALTH[status] ?? "unknown").badgeVariant;
}

const formError = computed<string>(() => {
  if (selectedTargets.value.length === 0) return t("operations.tasks.errNoTargets");
  if (!script.value.trim()) return t("operations.tasks.errNoScript");
  return "";
});
const showFormError = ref(false);

function nodeName(id: string): string {
  return nodes.value.find((node) => node.id === id)?.name || id;
}

function refreshAll() {
  tasksQuery.refresh();
  resultsQuery.refresh();
  nodesQuery.refresh();
}

async function createTask() {
  if (formError.value) {
    showFormError.value = true;
    return;
  }
  showFormError.value = false;
  createPending.value = true;
  try {
    await api.tasks.create({
      targets: selectedTargets.value,
      interpreter: interpreter.value,
      script: script.value,
      timeout_sec: Number(timeoutSec.value),
      output_limit: Number(outputLimit.value),
    });
    script.value = "";
    toast.success(t("operations.tasks.toastQueued"));
    refreshAll();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("operations.tasks.toastFailed"));
  } finally {
    createPending.value = false;
  }
}

// Per-task lifecycle actions. Only one runs at a time (busyTaskId disables the
// acting card's buttons); delete is gated behind a confirm dialog.
const busyTaskId = ref<string | null>(null);
const deleteOpen = ref(false);
const deleteTarget = ref<TaskView | null>(null);
const deleting = ref(false);

async function rerunTask(task: TaskView) {
  busyTaskId.value = task.id;
  try {
    await api.tasks.rerun(task.id);
    toast.success(t("operations.tasks.toastRerun"));
    refreshAll();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("operations.tasks.toastFailed"));
  } finally {
    busyTaskId.value = null;
  }
}

async function cancelTask(task: TaskView) {
  busyTaskId.value = task.id;
  try {
    await api.tasks.cancel(task.id);
    toast.success(t("operations.tasks.toastCancelled"));
    refreshAll();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("operations.tasks.toastFailed"));
  } finally {
    busyTaskId.value = null;
  }
}

function askDelete(task: TaskView) {
  deleteTarget.value = task;
  deleteOpen.value = true;
}

async function confirmDelete() {
  const task = deleteTarget.value;
  if (!task) return;
  deleting.value = true;
  try {
    await api.tasks.delete(task.id);
    toast.success(t("operations.tasks.toastDeleted"));
    deleteOpen.value = false;
    deleteTarget.value = null;
    refreshAll();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("operations.tasks.toastFailed"));
  } finally {
    deleting.value = false;
  }
}
</script>

<template>
  <div class="p-6 space-y-6">
    <PageHeader :title="$t('operations.tasks.title')" :description="$t('operations.tasks.description')">
      <template #status>
        <FreshnessLabel :last-updated="tasksQuery.lastUpdated.value" />
      </template>
      <template #actions>
        <Button variant="outline" size="sm" :disabled="tasksQuery.refreshing.value || resultsQuery.refreshing.value" @click="refreshAll">
          <RefreshCw :class="cn('size-4', (tasksQuery.refreshing.value || resultsQuery.refreshing.value) && 'animate-spin')" aria-hidden="true" />
          {{ $t('common.actions.refresh') }}
        </Button>
      </template>
    </PageHeader>

    <div class="grid gap-4 md:grid-cols-4">
      <Card interactive :class="statusFilter === 'all' ? 'ring-2 ring-primary' : ''" @click="statusFilter = 'all'">
        <CardContent class="flex items-center justify-between p-4">
          <div>
            <p class="text-sm text-muted-foreground">{{ $t('operations.tasks.tasks') }}</p>
            <p class="text-2xl font-semibold">{{ tasks.length }}</p>
          </div>
          <Terminal class="size-5 text-muted-foreground" aria-hidden="true" />
        </CardContent>
      </Card>
      <Card interactive :class="statusFilter === 'queued' ? 'ring-2 ring-primary' : ''" @click="statusFilter = 'queued'">
        <CardContent class="flex items-center justify-between p-4">
          <div>
            <p class="text-sm text-muted-foreground">{{ $t('operations.tasks.queued') }}</p>
            <p class="text-2xl font-semibold text-warning">{{ queuedCount }}</p>
          </div>
          <Timer class="size-5 text-warning" aria-hidden="true" />
        </CardContent>
      </Card>
      <Card interactive :class="statusFilter === 'finished' ? 'ring-2 ring-primary' : ''" @click="statusFilter = 'finished'">
        <CardContent class="flex items-center justify-between p-4">
          <div>
            <p class="text-sm text-muted-foreground">{{ $t('operations.tasks.finished') }}</p>
            <p class="text-2xl font-semibold text-success">{{ finishedCount }}</p>
          </div>
          <CheckCircle2 class="size-5 text-success" aria-hidden="true" />
        </CardContent>
      </Card>
      <Card interactive :class="statusFilter === 'failed' ? 'ring-2 ring-primary' : ''" @click="statusFilter = 'failed'">
        <CardContent class="flex items-center justify-between p-4">
          <div>
            <p class="text-sm text-muted-foreground">{{ $t('operations.tasks.failed') }}</p>
            <p class="text-2xl font-semibold text-destructive">{{ failedCount }}</p>
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
        <form class="space-y-4" @submit.prevent="createTask">
          <div class="grid gap-3 xl:grid-cols-[1fr_140px_140px]">
            <div class="grid gap-2">
              <Label>{{ $t('operations.tasks.targets') }}</Label>
              <DataState
                :loading="nodesQuery.loading.value"
                :error="nodesQuery.error.value"
                :has-data="nodesQuery.data.value !== undefined"
                :is-empty="nodes.length === 0"
                :empty-title="$t('operations.tasks.noNodesTitle')"
                :empty-description="$t('operations.tasks.noNodesDescription')"
                @retry="nodesQuery.refresh"
              >
                <div class="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  <label
                    v-for="node in nodes"
                    :key="node.id"
                    class="surface-interactive flex items-center gap-2 rounded-md border border-border p-2 text-sm"
                  >
                    <input v-model="selectedTargets" type="checkbox" :value="node.id" class="size-4 accent-primary" />
                    <span class="min-w-0 flex-1 truncate">{{ node.name || node.id }}</span>
                    <Badge :variant="node.online ? 'success' : 'secondary'">{{ node.online ? $t('operations.tasks.on') : $t('operations.tasks.off') }}</Badge>
                  </label>
                </div>
              </DataState>
            </div>
            <div class="grid gap-2">
              <Label for="task-timeout">{{ $t('operations.tasks.timeoutSec') }}</Label>
              <Input id="task-timeout" v-model="timeoutSec" type="number" min="1" max="3600" />
            </div>
            <div class="grid gap-2">
              <Label for="task-output">{{ $t('operations.tasks.outputLimit') }}</Label>
              <Input id="task-output" v-model="outputLimit" type="number" min="1024" max="1048576" />
            </div>
          </div>

          <div class="grid gap-2">
            <Label for="task-interpreter">{{ $t('operations.tasks.interpreter') }}</Label>
            <Select v-model="interpreter">
              <SelectTrigger id="task-interpreter" class="max-w-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="sh">sh</SelectItem>
                <SelectItem value="bash">bash</SelectItem>
                <SelectItem value="python3">python3</SelectItem>
                <SelectItem value="node">node</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div class="grid gap-2">
            <Label for="task-script">{{ $t('operations.tasks.script') }}</Label>
            <textarea
              id="task-script"
              v-model="script"
              class="min-h-36 rounded-md border bg-background p-3 font-mono text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
              :class="showFormError && !script.trim() ? 'border-destructive' : 'border-input'"
              :aria-invalid="showFormError && !script.trim()"
              placeholder="echo hello"
            />
            <p v-if="showFormError && formError" class="text-sm text-destructive">{{ formError }}</p>
          </div>

          <Button type="submit" :disabled="createPending">
            <RefreshCw v-if="createPending" class="size-4 animate-spin" aria-hidden="true" />
            <Play v-else class="size-4" aria-hidden="true" />
            {{ $t('operations.tasks.queueTaskCta') }}
          </Button>
        </form>
      </CardContent>
    </Card>

    <Card>
      <CardHeader>
        <CardTitle>{{ $t('operations.tasks.history') }}</CardTitle>
        <CardDescription>{{ $t('operations.tasks.historyHint') }}</CardDescription>
      </CardHeader>
      <CardContent>
        <DataState
          :loading="tasksQuery.loading.value || resultsQuery.loading.value"
          :error="tasksQuery.error.value || resultsQuery.error.value"
          :has-data="tasksQuery.data.value !== undefined"
          :is-empty="tasks.length === 0"
          :empty-title="$t('operations.tasks.emptyTitle')"
          :empty-description="$t('operations.tasks.emptyDescription')"
          @retry="refreshAll"
        >
          <div class="space-y-3">
            <div
              v-if="filteredTasks.length === 0"
              class="rounded-md border border-border p-6 text-center text-sm text-muted-foreground"
            >
              {{ $t('operations.tasks.noMatch') }}
            </div>
            <div v-for="task in filteredTasks" :key="task.id" class="rounded-lg border border-border p-4">
              <div class="flex flex-wrap items-start justify-between gap-3">
                <div class="min-w-0">
                  <div class="flex flex-wrap items-center gap-2">
                    <Badge :variant="statusVariant(task.status)">{{ statusLabel(task.status) }}</Badge>
                    <span class="font-mono text-sm">{{ shortId(task.id, 14) }}</span>
                    <span class="text-sm text-muted-foreground">{{ task.interpreter }}</span>
                  </div>
                  <p class="mt-1 text-xs text-muted-foreground">
                    {{ formatDateTime(task.created_at) }} · {{ task.targets.map(nodeName).join(", ") }}
                  </p>
                </div>
                <div class="flex flex-col items-end gap-2">
                  <div class="flex flex-wrap justify-end gap-1">
                    <Badge variant="outline">{{ $t('operations.tasks.bytes', { count: task.script_size_bytes || 0 }) }}</Badge>
                    <Badge v-if="task.timeout_sec" variant="outline">{{ $t('operations.tasks.seconds', { count: task.timeout_sec }) }}</Badge>
                  </div>
                  <div v-if="canRunTasks" class="flex flex-wrap justify-end gap-1">
                    <Button
                      v-if="task.status === 'queued'"
                      variant="outline"
                      size="sm"
                      :disabled="busyTaskId === task.id"
                      @click="cancelTask(task)"
                    >
                      <Ban class="size-3.5" aria-hidden="true" />
                      {{ $t('operations.tasks.actions.cancel') }}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      :disabled="busyTaskId === task.id"
                      @click="rerunTask(task)"
                    >
                      <RotateCcw :class="cn('size-3.5', busyTaskId === task.id && 'animate-spin')" aria-hidden="true" />
                      {{ $t('operations.tasks.actions.rerun') }}
                    </Button>
                    <Button
                      v-if="canDelete(task)"
                      variant="ghost"
                      size="sm"
                      class="text-destructive hover:text-destructive"
                      :disabled="busyTaskId === task.id"
                      @click="askDelete(task)"
                    >
                      <Trash2 class="size-3.5" aria-hidden="true" />
                      {{ $t('operations.tasks.actions.delete') }}
                    </Button>
                  </div>
                </div>
              </div>

              <div v-if="resultsByTask[task.id]?.length" class="mt-4 space-y-2">
                <div
                  v-for="result in resultsByTask[task.id]"
                  :key="`${result.task_id}:${result.node_id}:${result.started_at}`"
                  class="rounded-md bg-muted/40 p-3"
                >
                  <div class="flex flex-wrap items-center gap-2">
                    <Badge :variant="result.error || result.exit_code ? 'destructive' : 'success'">
                      <XCircle v-if="result.error || result.exit_code" class="size-3" aria-hidden="true" />
                      <CheckCircle2 v-else class="size-3" aria-hidden="true" />
                      {{ nodeName(result.node_id) }}
                    </Badge>
                    <span class="text-xs text-muted-foreground">{{ $t('operations.tasks.exit', { code: result.exit_code ?? 0 }) }}</span>
                    <span class="text-xs text-muted-foreground">{{ formatDateTime(result.finished_at || result.started_at) }}</span>
                  </div>
                  <pre v-if="result.stdout" class="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-background/70 p-2 font-mono text-xs">{{ result.stdout }}</pre>
                  <pre v-if="result.stderr || result.error" class="mt-2 max-h-48 overflow-auto whitespace-pre-wrap rounded bg-destructive/10 p-2 font-mono text-xs text-destructive">{{ result.stderr || result.error }}</pre>
                </div>
              </div>
            </div>
          </div>
        </DataState>
      </CardContent>
    </Card>

    <ConfirmDialog
      :open="deleteOpen"
      :title="$t('operations.tasks.deleteTitle')"
      :description="deleteTarget ? $t('operations.tasks.deleteDescription', { id: shortId(deleteTarget.id, 14) }) : ''"
      :confirm-label="$t('common.actions.delete')"
      :cancel-label="$t('common.actions.cancel')"
      :pending="deleting"
      @update:open="(v: boolean) => { if (!v) deleteOpen = false; }"
      @confirm="confirmDelete"
    />
  </div>
</template>
