<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import { Code2, Play, Plus, RefreshCw, Rocket } from "lucide-vue-next";
import { api, type WorkerRunResponse, type WorkerScript } from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { useAuthStore } from "@/stores/auth";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

import PageHeader from "@/components/common/PageHeader.vue";
import DataTable, { type DataTableColumn } from "@/components/common/DataTable.vue";
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

const { t } = useI18n();
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

const columns = computed<DataTableColumn<WorkerScript>[]>(() => [
  { key: "name", label: t("platform.workers.colName"), sortable: true, searchable: true, value: (w) => w.name || w.id },
  { key: "capabilities", label: t("platform.workers.colCapabilities") },
  { key: "public", label: t("platform.workers.colPublic"), sortable: true },
  { key: "updated_at", label: t("platform.workers.colUpdated"), sortable: true, class: "text-xs text-muted-foreground" },
  { key: "source", label: t("platform.workers.colSource") },
  { key: "actions", label: t("platform.workers.colActions"), align: "right" },
]);

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
    toast.success(t("platform.workers.deployed"));
    deployOpen.value = false;
    workersQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("platform.workers.deployFailed"));
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
    toast.success(t("platform.workers.executed"));
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("platform.workers.runFailed"));
  } finally {
    running.value = false;
  }
}
</script>

<template>
  <div class="p-6 space-y-6">
    <PageHeader
      :title="$t('platform.workers.title')"
      :description="$t('platform.workers.description')"
    >
      <template #status>
        <FreshnessLabel :last-updated="workersQuery.lastUpdated.value" />
      </template>
      <template #actions>
        <Button variant="outline" size="sm" :disabled="workersQuery.refreshing.value" @click="workersQuery.refresh">
          <RefreshCw aria-hidden="true" :class="cn('size-4', workersQuery.refreshing.value && 'animate-spin')" />
          {{ $t('common.actions.refresh') }}
        </Button>
        <Button v-if="canDeploy" variant="outline" size="sm" @click="openRun()">
          <Play aria-hidden="true" class="size-4" />
          {{ $t('common.actions.run') }}
        </Button>
        <Button v-if="canDeploy" size="sm" @click="openDeploy">
          <Plus aria-hidden="true" class="size-4" />
          {{ $t('platform.workers.deployWorker') }}
        </Button>
      </template>
    </PageHeader>

    <Card>
      <CardHeader>
        <CardTitle class="flex items-center gap-2">
          <Code2 aria-hidden="true" class="size-4 text-muted-foreground" />
          {{ $t('platform.workers.scriptsTitle') }}
        </CardTitle>
        <CardDescription>{{ $t('platform.workers.scriptsCount', { count: workers.length }) }}</CardDescription>
      </CardHeader>
      <CardContent>
        <DataTable
          v-if="canDeploy"
          :columns="columns"
          :rows="sortedWorkers"
          :row-key="(worker) => worker.id"
          :loading="workersQuery.loading.value"
          :error="workersQuery.error.value"
          :has-data="workersQuery.data.value !== undefined"
          :page-size="50"
          searchable
          :search-placeholder="$t('platform.shared.searchNames')"
          :empty-title="$t('platform.workers.emptyTitle')"
          :empty-description="$t('platform.workers.emptyDescription')"
          :no-match-title="$t('platform.shared.noMatchesTitle')"
          :no-match-description="$t('platform.shared.noMatchesDescription')"
          @retry="workersQuery.refresh"
        >
          <template #cell-name="{ row }">
            <div class="font-medium">{{ row.name || row.id }}</div>
            <div class="font-mono text-xs text-muted-foreground">{{ row.id }}</div>
          </template>
          <template #cell-capabilities="{ row }">
            <div class="flex flex-wrap gap-1">
              <Badge v-for="cap in row.capabilities" :key="cap" variant="secondary" class="font-mono">{{ cap }}</Badge>
              <span v-if="!row.capabilities.length" class="text-xs text-muted-foreground">{{ $t('common.misc.none') }}</span>
            </div>
          </template>
          <template #cell-public="{ row }">
            <Badge :variant="row.public ? 'info' : 'secondary'">{{ row.public ? $t('platform.workers.public') : $t('platform.workers.private') }}</Badge>
          </template>
          <template #cell-updated_at="{ row }">
            <span class="text-xs text-muted-foreground">{{ formatDateTime(row.updated_at) }}</span>
          </template>
          <template #cell-source="{ row }">
            <button
              type="button"
              class="max-w-[280px] truncate text-left font-mono text-xs text-muted-foreground hover:text-primary"
              :title="$t('platform.workers.viewSource')"
              @click="sourceTarget = row"
            >
              {{ sourcePreview(row.source) || $t('platform.workers.sourceEmpty') }}
            </button>
          </template>
          <template #cell-actions="{ row }">
            <div class="flex items-center justify-end gap-1">
              <Button variant="outline" size="sm" @click="openRun(row)">
                <Play aria-hidden="true" class="size-4" />
                {{ $t('common.actions.run') }}
              </Button>
            </div>
          </template>
        </DataTable>
        <p v-else class="text-sm text-muted-foreground">
          <i18n-t keypath="platform.workers.deployScopeRequired" tag="span" scope="global">
            <template #scope><code class="font-mono">worker:deploy</code></template>
          </i18n-t>
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
          <Button type="button" variant="outline" @click="sourceTarget = undefined">{{ $t('common.actions.close') }}</Button>
        </DialogFooter>
      </DialogScrollContent>
    </Dialog>

    <!-- Deploy dialog -->
    <Dialog v-model:open="deployOpen">
      <DialogScrollContent class="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{{ $t('platform.workers.deployWorker') }}</DialogTitle>
          <DialogDescription>{{ $t('platform.workers.deployHint') }}</DialogDescription>
        </DialogHeader>
        <form class="space-y-4" @submit.prevent="submitDeploy">
          <div class="grid gap-2">
            <Label for="worker-name">{{ $t('platform.workers.nameLabel') }}</Label>
            <Input id="worker-name" v-model="deployName" required placeholder="hello-worker" />
          </div>
          <div class="grid gap-2">
            <Label for="worker-source">{{ $t('platform.workers.sourceLabel') }}</Label>
            <textarea
              id="worker-source"
              v-model="deploySource"
              rows="10"
              spellcheck="false"
              :placeholder="$t('platform.workers.sourcePlaceholder')"
              class="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </div>
          <div class="grid gap-3 sm:grid-cols-2">
            <div class="grid gap-2">
              <Label for="worker-caps">{{ $t('platform.workers.capabilitiesLabel') }}</Label>
              <Input id="worker-caps" v-model="deployCapabilities" placeholder="kv:read, static:read" />
            </div>
            <div class="flex items-end">
              <label class="flex items-center gap-2 text-sm">
                <input v-model="deployPublic" type="checkbox" class="size-4 accent-primary" />
                {{ $t('platform.workers.publicWorker') }}
              </label>
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" @click="deployOpen = false">{{ $t('common.actions.cancel') }}</Button>
            <Button type="submit" :disabled="!canSubmitDeploy || deploying">
              <RefreshCw v-if="deploying" aria-hidden="true" class="size-4 animate-spin" />
              <Rocket v-else aria-hidden="true" class="size-4" />
              {{ $t('platform.workers.deploy') }}
            </Button>
          </DialogFooter>
        </form>
      </DialogScrollContent>
    </Dialog>

    <!-- Run dialog -->
    <Dialog v-model:open="runOpen">
      <DialogScrollContent class="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{{ $t('platform.workers.runTitle') }}</DialogTitle>
          <DialogDescription>{{ $t('platform.workers.runHint') }}</DialogDescription>
        </DialogHeader>
        <form class="space-y-4" @submit.prevent="submitRun">
          <div class="grid gap-3 sm:grid-cols-2">
            <div class="grid gap-2">
              <Label for="run-worker">{{ $t('platform.workers.workerLabel') }}</Label>
              <Select v-model="runWorkerId">
                <SelectTrigger id="run-worker" class="w-full">
                  <SelectValue :placeholder="$t('platform.workers.selectWorker')" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="worker in sortedWorkers" :key="worker.id" :value="worker.id">
                    {{ worker.name || worker.id }}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div class="grid gap-2">
              <Label for="run-path">{{ $t('platform.workers.pathLabel') }}</Label>
              <Input id="run-path" v-model="runPath" placeholder="/" />
            </div>
          </div>

          <div v-if="runResult" class="space-y-3 rounded-md border border-border p-4">
            <div class="flex items-center gap-2">
              <span class="text-xs font-medium uppercase text-muted-foreground">{{ $t('platform.workers.statusLabel') }}</span>
              <Badge :variant="statusVariant(runResult.status)">{{ runResult.status }}</Badge>
            </div>
            <pre class="max-h-[320px] overflow-auto whitespace-pre-wrap rounded-md bg-muted/30 p-3 font-mono text-xs leading-relaxed">{{ runResult.body }}</pre>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" @click="runOpen = false">{{ $t('common.actions.close') }}</Button>
            <Button type="submit" :disabled="!canSubmitRun || running">
              <RefreshCw v-if="running" aria-hidden="true" class="size-4 animate-spin" />
              <Play v-else aria-hidden="true" class="size-4" />
              {{ $t('common.actions.run') }}
            </Button>
          </DialogFooter>
        </form>
      </DialogScrollContent>
    </Dialog>
  </div>
</template>
