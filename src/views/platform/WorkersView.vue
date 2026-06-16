<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { toast } from "vue-sonner";
import { Code2, Play, Plus, RefreshCw, Rocket } from "lucide-vue-next";
import { api, type WorkerRunResponse, type WorkerScript } from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { useAuthStore } from "@/stores/auth";
import { formatDateTime } from "@/lib/format";
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
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogScrollContent,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const auth = useAuthStore();
const canDeploy = computed(() => auth.can("worker:deploy"));

const workersQuery = useAsyncData(() => api.workers.list(), {
  pollInterval: 15000,
  immediate: canDeploy.value,
});
const workers = computed(() => workersQuery.data.value ?? []);
const sortedWorkers = computed(() =>
  [...workers.value].sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id)),
);

function sourcePreview(source: string): string {
  const firstLine = source.split("\n", 1)[0] ?? "";
  return firstLine.length > 80 ? `${firstLine.slice(0, 80)}…` : firstLine;
}

// ── Source view dialog ──────────────────────────────────────────────────────
const sourceTarget = ref<WorkerScript | undefined>(undefined);

// ── Deploy dialog ───────────────────────────────────────────────────────────
const deployOpen = ref(false);
const deploying = ref(false);
const deployName = ref("");
const deploySource = ref("");
const deployCapabilities = ref("");
const deployPublic = ref(false);

function openDeploy() {
  deployName.value = "";
  deploySource.value = "";
  deployCapabilities.value = "";
  deployPublic.value = false;
  deployOpen.value = true;
}

function parseCapabilities(input: string): string[] {
  return input
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean);
}

const canSubmitDeploy = computed(
  () => canDeploy.value && !!deployName.value.trim() && !!deploySource.value.trim(),
);

async function submitDeploy() {
  if (!canSubmitDeploy.value) return;
  deploying.value = true;
  try {
    await api.workers.deploy({
      name: deployName.value.trim(),
      source: deploySource.value,
      capabilities: parseCapabilities(deployCapabilities.value),
      public: deployPublic.value,
    });
    toast.success("Worker deployed");
    deployOpen.value = false;
    workersQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "Worker deploy failed");
  } finally {
    deploying.value = false;
  }
}

// ── Run dialog ──────────────────────────────────────────────────────────────
const runOpen = ref(false);
const running = ref(false);
const runWorkerId = ref("");
const runPath = ref("/");
const runResult = ref<WorkerRunResponse | undefined>(undefined);

function openRun(worker?: WorkerScript) {
  runWorkerId.value = worker?.id ?? sortedWorkers.value[0]?.id ?? "";
  runPath.value = "/";
  runResult.value = undefined;
  runOpen.value = true;
}

watch(runOpen, (open) => {
  if (!open) runResult.value = undefined;
});

const canSubmitRun = computed(() => canDeploy.value && !!runWorkerId.value);

function statusVariant(status: number): "success" | "warning" | "destructive" | "secondary" {
  if (status >= 500) return "destructive";
  if (status >= 400) return "warning";
  if (status >= 200 && status < 300) return "success";
  return "secondary";
}

async function submitRun() {
  if (!canSubmitRun.value) return;
  running.value = true;
  runResult.value = undefined;
  try {
    runResult.value = await api.workers.run(runWorkerId.value, runPath.value);
    toast.success("Worker executed");
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "Worker run failed");
  } finally {
    running.value = false;
  }
}
</script>

<template>
  <div class="p-6 space-y-6">
    <PageHeader
      title="Workers"
      description="Deployable in-process request handlers executed against a request path"
    >
      <template #actions>
        <Button variant="outline" size="sm" :disabled="workersQuery.refreshing.value" @click="workersQuery.refresh">
          <RefreshCw :class="cn('size-4', workersQuery.refreshing.value && 'animate-spin')" />
          Refresh
        </Button>
        <Button v-if="canDeploy" variant="outline" size="sm" @click="openRun()">
          <Play class="size-4" />
          Run
        </Button>
        <Button v-if="canDeploy" size="sm" @click="openDeploy">
          <Plus class="size-4" />
          Deploy worker
        </Button>
      </template>
    </PageHeader>

    <Card>
      <CardHeader>
        <CardTitle class="flex items-center gap-2">
          <Code2 class="size-4 text-muted-foreground" />
          Worker scripts
        </CardTitle>
        <CardDescription>{{ workers.length }} deployed worker{{ workers.length === 1 ? "" : "s" }}.</CardDescription>
      </CardHeader>
      <CardContent>
        <DataState
          v-if="canDeploy"
          :loading="workersQuery.loading.value"
          :error="workersQuery.error.value"
          :is-empty="workers.length === 0"
          empty-title="No workers deployed"
          empty-description="Deploy a worker script to handle requests in-process."
          @retry="workersQuery.refresh"
        >
          <div class="overflow-x-auto">
            <table class="w-full text-sm">
              <thead>
                <tr class="border-b border-border text-left text-xs text-muted-foreground">
                  <th class="py-2 pr-3 font-medium">Name</th>
                  <th class="py-2 pr-3 font-medium">Capabilities</th>
                  <th class="py-2 pr-3 font-medium">Public</th>
                  <th class="py-2 pr-3 font-medium">Updated</th>
                  <th class="py-2 pr-3 font-medium">Source</th>
                  <th class="py-2 pl-3 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="worker in sortedWorkers"
                  :key="worker.id"
                  class="border-b border-border last:border-b-0 hover:bg-muted/40"
                >
                  <td class="py-3 pr-3">
                    <div class="font-medium">{{ worker.name || worker.id }}</div>
                    <div class="font-mono text-xs text-muted-foreground">{{ worker.id }}</div>
                  </td>
                  <td class="py-3 pr-3">
                    <div class="flex flex-wrap gap-1">
                      <Badge v-for="cap in worker.capabilities" :key="cap" variant="secondary" class="font-mono">{{ cap }}</Badge>
                      <span v-if="!worker.capabilities.length" class="text-xs text-muted-foreground">none</span>
                    </div>
                  </td>
                  <td class="py-3 pr-3">
                    <Badge :variant="worker.public ? 'info' : 'secondary'">{{ worker.public ? "public" : "private" }}</Badge>
                  </td>
                  <td class="py-3 pr-3 text-xs text-muted-foreground">{{ formatDateTime(worker.updated_at) }}</td>
                  <td class="py-3 pr-3">
                    <button
                      type="button"
                      class="max-w-[280px] truncate text-left font-mono text-xs text-muted-foreground hover:text-primary"
                      :title="'View source'"
                      @click="sourceTarget = worker"
                    >
                      {{ sourcePreview(worker.source) || "(empty)" }}
                    </button>
                  </td>
                  <td class="py-3 pl-3">
                    <div class="flex items-center justify-end gap-1">
                      <Button variant="outline" size="sm" @click="openRun(worker)">
                        <Play class="size-4" />
                        Run
                      </Button>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </DataState>
        <p v-else class="text-sm text-muted-foreground">
          The <code class="font-mono">worker:deploy</code> scope is required to list and deploy workers.
        </p>
      </CardContent>
    </Card>

    <!-- Source view dialog -->
    <Dialog :open="!!sourceTarget" @update:open="(v) => { if (!v) sourceTarget = undefined; }">
      <DialogScrollContent class="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{{ sourceTarget?.name || sourceTarget?.id }}</DialogTitle>
          <DialogDescription>{{ sourceTarget?.id }}</DialogDescription>
        </DialogHeader>
        <pre class="max-h-[480px] overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/30 p-4 font-mono text-xs leading-relaxed">{{ sourceTarget?.source }}</pre>
        <DialogFooter>
          <Button type="button" variant="outline" @click="sourceTarget = undefined">Close</Button>
        </DialogFooter>
      </DialogScrollContent>
    </Dialog>

    <!-- Deploy dialog -->
    <Dialog v-model:open="deployOpen">
      <DialogScrollContent class="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Deploy worker</DialogTitle>
          <DialogDescription>The server validates the source before storing the script.</DialogDescription>
        </DialogHeader>
        <form class="space-y-4" @submit.prevent="submitDeploy">
          <div class="grid gap-2">
            <Label for="worker-name">Name</Label>
            <Input id="worker-name" v-model="deployName" required placeholder="hello-worker" />
          </div>
          <div class="grid gap-2">
            <Label for="worker-source">Source</Label>
            <textarea
              id="worker-source"
              v-model="deploySource"
              rows="10"
              spellcheck="false"
              placeholder="// worker source"
              class="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </div>
          <div class="grid gap-3 sm:grid-cols-2">
            <div class="grid gap-2">
              <Label for="worker-caps">Capabilities</Label>
              <Input id="worker-caps" v-model="deployCapabilities" placeholder="kv:read, static:read" />
            </div>
            <div class="flex items-end">
              <label class="flex items-center gap-2 text-sm">
                <input v-model="deployPublic" type="checkbox" class="size-4 accent-primary" />
                Public worker
              </label>
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" @click="deployOpen = false">Cancel</Button>
            <Button type="submit" :disabled="!canSubmitDeploy || deploying">
              <RefreshCw v-if="deploying" class="size-4 animate-spin" />
              <Rocket v-else class="size-4" />
              Deploy
            </Button>
          </DialogFooter>
        </form>
      </DialogScrollContent>
    </Dialog>

    <!-- Run dialog -->
    <Dialog v-model:open="runOpen">
      <DialogScrollContent class="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Run worker</DialogTitle>
          <DialogDescription>Synchronously execute a stored worker against a request path.</DialogDescription>
        </DialogHeader>
        <form class="space-y-4" @submit.prevent="submitRun">
          <div class="grid gap-3 sm:grid-cols-2">
            <div class="grid gap-2">
              <Label for="run-worker">Worker</Label>
              <Select v-model="runWorkerId">
                <SelectTrigger id="run-worker" class="w-full">
                  <SelectValue placeholder="Select a worker" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="worker in sortedWorkers" :key="worker.id" :value="worker.id">
                    {{ worker.name || worker.id }}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div class="grid gap-2">
              <Label for="run-path">Path</Label>
              <Input id="run-path" v-model="runPath" placeholder="/" />
            </div>
          </div>

          <div v-if="runResult" class="space-y-3 rounded-md border border-border p-4">
            <div class="flex items-center gap-2">
              <span class="text-xs font-medium uppercase text-muted-foreground">Status</span>
              <Badge :variant="statusVariant(runResult.status)">{{ runResult.status }}</Badge>
            </div>
            <pre class="max-h-[320px] overflow-auto whitespace-pre-wrap rounded-md bg-muted/30 p-3 font-mono text-xs leading-relaxed">{{ runResult.body }}</pre>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" @click="runOpen = false">Close</Button>
            <Button type="submit" :disabled="!canSubmitRun || running">
              <RefreshCw v-if="running" class="size-4 animate-spin" />
              <Play v-else class="size-4" />
              Run
            </Button>
          </DialogFooter>
        </form>
      </DialogScrollContent>
    </Dialog>
  </div>
</template>
