<script setup lang="ts">
import { computed, ref } from "vue";
import { toast } from "vue-sonner";
import { Play, RefreshCw, Terminal, Timer, CheckCircle2, XCircle } from "lucide-vue-next";
import { api, unwrap, type TaskResult, type TaskView } from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { useAuthStore } from "@/stores/auth";
import { formatDateTime, shortId } from "@/lib/format";
import { cn } from "@/lib/utils";

import PageHeader from "@/components/common/PageHeader.vue";
import DataState from "@/components/common/DataState.vue";
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

const auth = useAuthStore();
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

function statusVariant(status: TaskView["status"]): "success" | "warning" | "destructive" | "secondary" {
  if (status === "finished") return "success";
  if (status === "failed") return "destructive";
  if (status === "queued" || status === "leased") return "warning";
  return "secondary";
}

function nodeName(id: string): string {
  return nodes.value.find((node) => node.id === id)?.name || id;
}

function refreshAll() {
  tasksQuery.refresh();
  resultsQuery.refresh();
  nodesQuery.refresh();
}

async function createTask() {
  if (selectedTargets.value.length === 0 || !script.value.trim()) return;
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
    toast.success("Task queued");
    refreshAll();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "Task creation failed");
  } finally {
    createPending.value = false;
  }
}
</script>

<template>
  <div class="p-6 space-y-6">
    <PageHeader title="Tasks" description="Queue bounded batch tasks and inspect node results">
      <template #actions>
        <Button variant="outline" size="sm" :disabled="tasksQuery.refreshing.value || resultsQuery.refreshing.value" @click="refreshAll">
          <RefreshCw :class="cn('size-4', (tasksQuery.refreshing.value || resultsQuery.refreshing.value) && 'animate-spin')" aria-hidden="true" />
          Refresh
        </Button>
      </template>
    </PageHeader>

    <div class="grid gap-4 md:grid-cols-3">
      <Card>
        <CardContent class="flex items-center justify-between p-4">
          <div>
            <p class="text-sm text-muted-foreground">Tasks</p>
            <p class="text-2xl font-semibold">{{ tasks.length }}</p>
          </div>
          <Terminal class="size-5 text-muted-foreground" aria-hidden="true" />
        </CardContent>
      </Card>
      <Card>
        <CardContent class="flex items-center justify-between p-4">
          <div>
            <p class="text-sm text-muted-foreground">Queued</p>
            <p class="text-2xl font-semibold text-warning">{{ queuedCount }}</p>
          </div>
          <Timer class="size-5 text-warning" aria-hidden="true" />
        </CardContent>
      </Card>
      <Card>
        <CardContent class="flex items-center justify-between p-4">
          <div>
            <p class="text-sm text-muted-foreground">Finished</p>
            <p class="text-2xl font-semibold text-success">{{ finishedCount }}</p>
          </div>
          <CheckCircle2 class="size-5 text-success" aria-hidden="true" />
        </CardContent>
      </Card>
    </div>

    <Card v-if="canRunTasks">
      <CardHeader>
        <CardTitle class="flex items-center gap-2">
          <Play class="size-4 text-muted-foreground" aria-hidden="true" />
          Queue Task
        </CardTitle>
        <CardDescription>Tasks run only on selected nodes and within server-enforced limits.</CardDescription>
      </CardHeader>
      <CardContent>
        <form class="space-y-4" @submit.prevent="createTask">
          <div class="grid gap-3 xl:grid-cols-[1fr_140px_140px]">
            <div class="grid gap-2">
              <Label>Targets</Label>
              <DataState
                :loading="nodesQuery.loading.value"
                :error="nodesQuery.error.value"
                :is-empty="nodes.length === 0"
                empty-title="No nodes"
                empty-description="Enroll nodes before queueing tasks."
                @retry="nodesQuery.refresh"
              >
                <div class="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  <label
                    v-for="node in nodes"
                    :key="node.id"
                    class="flex items-center gap-2 rounded-md border border-border p-2 text-sm"
                  >
                    <input v-model="selectedTargets" type="checkbox" :value="node.id" class="size-4 accent-primary" />
                    <span class="min-w-0 flex-1 truncate">{{ node.name || node.id }}</span>
                    <Badge :variant="node.online ? 'success' : 'secondary'">{{ node.online ? "on" : "off" }}</Badge>
                  </label>
                </div>
              </DataState>
            </div>
            <div class="grid gap-2">
              <Label for="task-timeout">Timeout sec</Label>
              <Input id="task-timeout" v-model="timeoutSec" type="number" min="1" max="3600" />
            </div>
            <div class="grid gap-2">
              <Label for="task-output">Output limit</Label>
              <Input id="task-output" v-model="outputLimit" type="number" min="1024" max="1048576" />
            </div>
          </div>

          <div class="grid gap-2">
            <Label for="task-interpreter">Interpreter</Label>
            <select id="task-interpreter" v-model="interpreter" class="h-9 max-w-xs rounded-md border border-input bg-background px-3 text-sm">
              <option value="sh">sh</option>
              <option value="bash">bash</option>
              <option value="python3">python3</option>
              <option value="node">node</option>
            </select>
          </div>

          <div class="grid gap-2">
            <Label for="task-script">Script</Label>
            <textarea
              id="task-script"
              v-model="script"
              class="min-h-36 rounded-md border border-input bg-background p-3 font-mono text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
              placeholder="echo hello"
            />
          </div>

          <Button type="submit" :disabled="createPending || selectedTargets.length === 0 || !script.trim()">
            <RefreshCw v-if="createPending" class="size-4 animate-spin" aria-hidden="true" />
            <Play v-else class="size-4" aria-hidden="true" />
            Queue task
          </Button>
        </form>
      </CardContent>
    </Card>

    <Card>
      <CardHeader>
        <CardTitle>Task History</CardTitle>
        <CardDescription>Queued tasks and collected per-node results</CardDescription>
      </CardHeader>
      <CardContent>
        <DataState
          :loading="tasksQuery.loading.value || resultsQuery.loading.value"
          :error="tasksQuery.error.value || resultsQuery.error.value"
          :is-empty="tasks.length === 0"
          empty-title="No tasks queued"
          empty-description="Created tasks appear here with their node results."
          @retry="refreshAll"
        >
          <div class="space-y-3">
            <div v-for="task in sortedTasks" :key="task.id" class="rounded-lg border border-border p-4">
              <div class="flex flex-wrap items-start justify-between gap-3">
                <div class="min-w-0">
                  <div class="flex flex-wrap items-center gap-2">
                    <Badge :variant="statusVariant(task.status)">{{ task.status }}</Badge>
                    <span class="font-mono text-sm">{{ shortId(task.id, 14) }}</span>
                    <span class="text-sm text-muted-foreground">{{ task.interpreter }}</span>
                  </div>
                  <p class="mt-1 text-xs text-muted-foreground">
                    {{ formatDateTime(task.created_at) }} · {{ task.targets.map(nodeName).join(", ") }}
                  </p>
                </div>
                <div class="flex flex-wrap gap-1">
                  <Badge variant="outline">{{ task.script_size_bytes || 0 }} bytes</Badge>
                  <Badge v-if="task.timeout_sec" variant="outline">{{ task.timeout_sec }}s</Badge>
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
                    <span class="text-xs text-muted-foreground">exit {{ result.exit_code ?? 0 }}</span>
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
  </div>
</template>
