<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { toast } from "vue-sonner";
import {
  Database,
  FileText,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-vue-next";
import {
  api,
  unwrap,
  type LogLine,
  type LogSource,
  type LogSourceStatsView,
  type LogSourceUpsertRequest,
} from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { useAuthStore } from "@/stores/auth";
import { formatBytes, formatDateTime, shortId } from "@/lib/format";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogScrollContent,
  DialogTitle,
} from "@/components/ui/dialog";

const MAX_LINE_BYTES_DEFAULT = 16384;
const MAX_LINE_BYTES_CAP = 65536;
const MAX_BATCH_LINES_DEFAULT = 500;
const MAX_BATCH_LINES_CAP = 2000;
const TAIL_POLL_MS = 10000;

const auth = useAuthStore();
const canAdmin = computed(() => auth.can("log:admin"));

const sourcesQuery = useAsyncData(
  () => api.logs.sources().then((r) => unwrap(r, "sources")),
  { pollInterval: 15000 },
);
const nodesQuery = useAsyncData(() => api.nodes.list().then((r) => unwrap(r, "nodes")), {
  pollInterval: 15000,
});

const sources = computed(() => sourcesQuery.data.value ?? []);
const nodes = computed(() => nodesQuery.data.value ?? []);

const sortedSources = computed(() =>
  [...sources.value].sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    return (a.name || a.id).localeCompare(b.name || b.id);
  }),
);

const selectedSourceId = ref("");
const selectedSource = computed(() =>
  sources.value.find((source) => source.id === selectedSourceId.value),
);

function nodeName(id: string): string {
  return nodes.value.find((node) => node.id === id)?.name || shortId(id, 14);
}

watch(
  sources,
  (list) => {
    if (list.length === 0) {
      selectedSourceId.value = "";
      return;
    }
    if (!selectedSourceId.value || !list.some((s) => s.id === selectedSourceId.value)) {
      selectedSourceId.value = list[0]?.id ?? "";
    }
  },
  { immediate: true },
);

// ── Log viewer ───────────────────────────────────────────────────────────────
const queryText = ref("");
const queryLimit = ref(200);
const lines = ref<LogLine[]>([]);
const truncated = ref(false);
const nextBeforeSeq = ref<number | undefined>();
const loadingLines = ref(false);
const loadingOlder = ref(false);
const viewerError = ref<string | undefined>();

let tailTimer: ReturnType<typeof setInterval> | undefined;

function clampLimit(): number {
  const value = Number(queryLimit.value);
  if (!Number.isFinite(value) || value <= 0) return 200;
  return Math.min(Math.floor(value), 5000);
}

async function loadNewest(): Promise<void> {
  const source = selectedSource.value;
  if (!source) {
    lines.value = [];
    nextBeforeSeq.value = undefined;
    truncated.value = false;
    return;
  }
  loadingLines.value = true;
  viewerError.value = undefined;
  try {
    const res = await api.logs.query({
      source_id: source.id,
      q: queryText.value.trim() || undefined,
      limit: clampLimit(),
    });
    // API returns lines ascending by seq; keep oldest→newest for display.
    lines.value = [...res.lines].sort((a, b) => a.seq - b.seq);
    truncated.value = res.truncated;
    nextBeforeSeq.value = res.next_before_seq;
  } catch (error) {
    viewerError.value = error instanceof Error ? error.message : "Query failed";
  } finally {
    loadingLines.value = false;
  }
}

async function loadOlder(): Promise<void> {
  const source = selectedSource.value;
  if (!source || nextBeforeSeq.value === undefined) return;
  loadingOlder.value = true;
  try {
    const res = await api.logs.query({
      source_id: source.id,
      q: queryText.value.trim() || undefined,
      limit: clampLimit(),
      before_seq: nextBeforeSeq.value,
    });
    const older = [...res.lines].sort((a, b) => a.seq - b.seq);
    const existing = new Set(lines.value.map((l) => l.seq));
    const merged = [...older.filter((l) => !existing.has(l.seq)), ...lines.value];
    lines.value = merged.sort((a, b) => a.seq - b.seq);
    nextBeforeSeq.value = res.next_before_seq;
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "Load older failed");
  } finally {
    loadingOlder.value = false;
  }
}

function stopTail(): void {
  if (tailTimer) {
    clearInterval(tailTimer);
    tailTimer = undefined;
  }
}

function startTail(): void {
  stopTail();
  tailTimer = setInterval(() => {
    // Pause polling while the user is paginating older history.
    if (loadingOlder.value || loadingLines.value) return;
    void loadNewest();
  }, TAIL_POLL_MS);
}

watch(
  selectedSourceId,
  () => {
    nextBeforeSeq.value = undefined;
    void loadNewest();
    if (selectedSourceId.value) startTail();
    else stopTail();
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  stopTail();
  sourcesQuery.stop();
  nodesQuery.stop();
  statsQuery.stop();
});

function applyFilter(): void {
  nextBeforeSeq.value = undefined;
  void loadNewest();
}

// ── Stats ────────────────────────────────────────────────────────────────────
const statsQuery = useAsyncData(
  () => {
    if (!selectedSourceId.value) return Promise.resolve([] as LogSourceStatsView[]);
    return api.logs.stats(selectedSourceId.value).then((r) => unwrap(r, "stats"));
  },
  { pollInterval: 15000 },
);
const selectedStats = computed<LogSourceStatsView | undefined>(
  () => (statsQuery.data.value ?? [])[0],
);

watch(selectedSourceId, () => {
  statsQuery.refresh();
});

// ── Source create / edit dialog ──────────────────────────────────────────────
const PATH_PREFIX = "/var/log";
const formOpen = ref(false);
const saving = ref(false);
const editingId = ref<string | undefined>();

const form = ref({
  name: "",
  node_id: "",
  path: "",
  enabled: true,
  max_line_bytes: MAX_LINE_BYTES_DEFAULT,
  max_batch_lines: MAX_BATCH_LINES_DEFAULT,
});

function resetForm(): void {
  form.value = {
    name: "",
    node_id: "",
    path: "",
    enabled: true,
    max_line_bytes: MAX_LINE_BYTES_DEFAULT,
    max_batch_lines: MAX_BATCH_LINES_DEFAULT,
  };
}

function openCreate(): void {
  if (!canAdmin.value) return;
  editingId.value = undefined;
  resetForm();
  formOpen.value = true;
}

function openEdit(source: LogSource): void {
  if (!canAdmin.value) return;
  editingId.value = source.id;
  form.value = {
    name: source.name,
    node_id: source.node_id,
    path: source.path,
    enabled: source.enabled,
    max_line_bytes: source.max_line_bytes,
    max_batch_lines: source.max_batch_lines,
  };
  formOpen.value = true;
}

const pathValid = computed(() => {
  const p = form.value.path.trim();
  return p.startsWith("/") && p.startsWith(PATH_PREFIX) && !p.includes("..");
});

const canSubmit = computed(
  () =>
    !!form.value.name.trim() &&
    !!form.value.node_id &&
    pathValid.value &&
    Number(form.value.max_line_bytes) >= 1 &&
    Number(form.value.max_line_bytes) <= MAX_LINE_BYTES_CAP &&
    Number(form.value.max_batch_lines) >= 1 &&
    Number(form.value.max_batch_lines) <= MAX_BATCH_LINES_CAP,
);

async function submitForm(): Promise<void> {
  if (!canSubmit.value || !canAdmin.value) return;
  saving.value = true;
  try {
    const req: LogSourceUpsertRequest = {
      name: form.value.name.trim(),
      node_id: form.value.node_id,
      path: form.value.path.trim(),
      enabled: form.value.enabled,
      max_line_bytes: Math.min(Number(form.value.max_line_bytes), MAX_LINE_BYTES_CAP),
      max_batch_lines: Math.min(Number(form.value.max_batch_lines), MAX_BATCH_LINES_CAP),
    };
    if (editingId.value) req.id = editingId.value;
    const saved = await api.logs.upsertSource(req);
    toast.success(editingId.value ? "Log source updated" : "Log source created");
    formOpen.value = false;
    selectedSourceId.value = saved.id;
    sourcesQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "Save failed");
  } finally {
    saving.value = false;
  }
}

// ── Delete confirmation ──────────────────────────────────────────────────────
const deleteTarget = ref<LogSource | undefined>();
const deleting = ref(false);

async function confirmDelete(): Promise<void> {
  if (!deleteTarget.value) return;
  deleting.value = true;
  try {
    await api.logs.deleteSource(deleteTarget.value.id);
    toast.success("Log source deleted");
    if (selectedSourceId.value === deleteTarget.value.id) selectedSourceId.value = "";
    deleteTarget.value = undefined;
    sourcesQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : "Delete failed");
  } finally {
    deleting.value = false;
  }
}

function refreshAll(): void {
  sourcesQuery.refresh();
  statsQuery.refresh();
  void loadNewest();
}
</script>

<template>
  <div class="p-6 space-y-6">
    <PageHeader title="Logs" description="Tailable node log sources with bounded query history">
      <template #actions>
        <Button
          variant="outline"
          size="sm"
          :disabled="sourcesQuery.refreshing.value"
          @click="refreshAll"
        >
          <RefreshCw :class="cn('size-4', sourcesQuery.refreshing.value && 'animate-spin')" />
          Refresh
        </Button>
        <Button v-if="canAdmin" size="sm" @click="openCreate">
          <Plus class="size-4" />
          New source
        </Button>
      </template>
    </PageHeader>

    <div class="grid gap-6 xl:grid-cols-[340px_minmax(0,1fr)]">
      <!-- Source list -->
      <Card>
        <CardHeader>
          <CardTitle class="flex items-center gap-2">
            <FileText class="size-4 text-muted-foreground" />
            Sources
          </CardTitle>
          <CardDescription>
            {{ sources.length }} {{ sources.length === 1 ? "source" : "sources" }} visible to your token
          </CardDescription>
        </CardHeader>
        <CardContent>
          <DataState
            :loading="sourcesQuery.loading.value"
            :error="sourcesQuery.error.value"
            :is-empty="sources.length === 0"
            empty-title="No log sources"
            empty-description="Register a node log source to start tailing."
            @retry="sourcesQuery.refresh"
          >
            <div class="space-y-2">
              <div
                v-for="source in sortedSources"
                :key="source.id"
                :class="cn(
                  'rounded-lg border border-border p-3 transition-colors hover:bg-muted/35',
                  selectedSourceId === source.id && 'border-primary bg-primary/5',
                )"
              >
                <button
                  type="button"
                  class="block w-full text-left"
                  @click="selectedSourceId = source.id"
                >
                  <div class="flex items-start justify-between gap-2">
                    <span class="truncate font-medium">{{ source.name || source.id }}</span>
                    <Badge :variant="source.enabled ? 'success' : 'secondary'">
                      {{ source.enabled ? "enabled" : "disabled" }}
                    </Badge>
                  </div>
                  <p class="mt-1 break-all font-mono text-xs text-muted-foreground">
                    {{ source.path }}
                  </p>
                  <p class="mt-1 text-xs text-muted-foreground">{{ nodeName(source.node_id) }}</p>
                </button>
                <div v-if="canAdmin" class="mt-2 flex justify-end gap-1">
                  <Button variant="ghost" size="icon-sm" aria-label="Edit source" @click="openEdit(source)">
                    <Pencil class="size-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Delete source"
                    @click="deleteTarget = source"
                  >
                    <Trash2 class="size-4 text-destructive" />
                  </Button>
                </div>
              </div>
            </div>
          </DataState>
        </CardContent>
      </Card>

      <!-- Viewer + stats -->
      <div class="space-y-6">
        <!-- Stats -->
        <Card v-if="selectedSource">
          <CardHeader>
            <CardTitle class="flex items-center gap-2">
              <Database class="size-4 text-muted-foreground" />
              {{ selectedSource.name || selectedSource.id }}
            </CardTitle>
            <CardDescription class="break-all font-mono">
              {{ selectedSource.path }} · {{ nodeName(selectedSource.node_id) }}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <div class="rounded-md border border-border p-3">
                <p class="text-xs text-muted-foreground">Lines</p>
                <p class="mt-1 text-lg font-semibold tabular">{{ selectedStats?.lines ?? 0 }}</p>
              </div>
              <div class="rounded-md border border-border p-3">
                <p class="text-xs text-muted-foreground">Stored bytes</p>
                <p class="mt-1 text-lg font-semibold tabular">{{ formatBytes(selectedStats?.bytes) }}</p>
              </div>
              <div class="rounded-md border border-border p-3">
                <p class="text-xs text-muted-foreground">Limits</p>
                <p class="mt-1 text-sm tabular">
                  {{ selectedSource.max_line_bytes }} B/line · {{ selectedSource.max_batch_lines }}/batch
                </p>
              </div>
              <div class="rounded-md border border-border p-3">
                <p class="text-xs text-muted-foreground">First seen</p>
                <p class="mt-1 text-sm">{{ selectedStats?.first_at ? formatDateTime(selectedStats.first_at) : "—" }}</p>
              </div>
              <div class="rounded-md border border-border p-3">
                <p class="text-xs text-muted-foreground">Last line</p>
                <p class="mt-1 text-sm">{{ selectedStats?.last_at ? formatDateTime(selectedStats.last_at) : "—" }}</p>
              </div>
              <div class="rounded-md border border-border p-3">
                <p class="text-xs text-muted-foreground">Last ingest</p>
                <p class="mt-1 text-sm">{{ selectedStats?.last_ingest_at ? formatDateTime(selectedStats.last_ingest_at) : "—" }}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <!-- Viewer -->
        <Card>
          <CardHeader>
            <div class="flex flex-wrap items-start justify-between gap-3">
              <div>
                <CardTitle>Log viewer</CardTitle>
                <CardDescription>
                  <template v-if="selectedSource">Newest lines first; polls every 10s when idle.</template>
                  <template v-else>Select a source to view its lines.</template>
                </CardDescription>
              </div>
            </div>
          </CardHeader>
          <CardContent class="space-y-4">
            <form
              v-if="selectedSource"
              class="flex flex-wrap items-end gap-3"
              @submit.prevent="applyFilter"
            >
              <div class="grid flex-1 gap-2" style="min-width: 200px">
                <Label for="log-q">Filter</Label>
                <Input id="log-q" v-model="queryText" placeholder="substring match" />
              </div>
              <div class="grid w-28 gap-2">
                <Label for="log-limit">Limit</Label>
                <Input id="log-limit" v-model.number="queryLimit" type="number" min="1" max="5000" />
              </div>
              <Button type="submit" variant="outline" :disabled="loadingLines">
                <RefreshCw v-if="loadingLines" class="size-4 animate-spin" />
                <Search v-else class="size-4" />
                Query
              </Button>
            </form>

            <DataState
              :loading="loadingLines && lines.length === 0"
              :error="viewerError ? new Error(viewerError) : null"
              :is-empty="!selectedSource || lines.length === 0"
              empty-title="No lines"
              empty-description="No log lines match the current filter for this source."
              @retry="loadNewest"
            >
              <div class="space-y-3">
                <div v-if="nextBeforeSeq !== undefined" class="flex justify-center">
                  <Button variant="outline" size="sm" :disabled="loadingOlder" @click="loadOlder">
                    <RefreshCw v-if="loadingOlder" class="size-4 animate-spin" />
                    Load older
                  </Button>
                </div>

                <div class="overflow-x-auto rounded-md border border-border bg-muted/10">
                  <table class="w-full text-xs">
                    <thead>
                      <tr class="border-b border-border text-left text-muted-foreground">
                        <th class="px-3 py-2 font-medium">Seq</th>
                        <th class="px-3 py-2 font-medium">Time</th>
                        <th class="px-3 py-2 font-medium">Line</th>
                      </tr>
                    </thead>
                    <tbody class="font-mono">
                      <tr
                        v-for="line in [...lines].reverse()"
                        :key="line.seq"
                        class="border-b border-border last:border-b-0 hover:bg-muted/40"
                      >
                        <td class="whitespace-nowrap px-3 py-1.5 text-muted-foreground tabular">{{ line.seq }}</td>
                        <td class="whitespace-nowrap px-3 py-1.5 text-muted-foreground">{{ formatDateTime(line.at) }}</td>
                        <td class="px-3 py-1.5">
                          <span class="whitespace-pre-wrap break-all">{{ line.line }}</span>
                          <Badge v-if="line.truncated" variant="warning" class="ml-2">truncated</Badge>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>

                <p v-if="truncated" class="text-xs text-warning">
                  Result truncated to the requested limit. Increase the limit or load older pages.
                </p>
              </div>
            </DataState>
          </CardContent>
        </Card>
      </div>
    </div>

    <!-- Create / edit dialog -->
    <Dialog v-model:open="formOpen">
      <DialogScrollContent class="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{{ editingId ? "Edit log source" : "New log source" }}</DialogTitle>
          <DialogDescription>
            Pin a tailable file on a node. Paths must be absolute and under
            <code class="font-mono">/var/log</code>.
          </DialogDescription>
        </DialogHeader>

        <form class="space-y-4" @submit.prevent="submitForm">
          <div class="grid gap-3 sm:grid-cols-2">
            <div class="grid gap-2">
              <Label for="src-name">Name</Label>
              <Input id="src-name" v-model="form.name" required placeholder="nginx-access" />
            </div>
            <div class="grid gap-2">
              <Label for="src-node">Node</Label>
              <Select v-model="form.node_id" :disabled="!!editingId">
                <SelectTrigger id="src-node">
                  <SelectValue placeholder="Select a node" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="node in nodes" :key="node.id" :value="node.id">
                    {{ node.name || node.id }}
                  </SelectItem>
                </SelectContent>
              </Select>
              <p v-if="editingId" class="text-xs text-muted-foreground">Node is immutable on update.</p>
            </div>
          </div>

          <div class="grid gap-2">
            <Label for="src-path">Path</Label>
            <Input
              id="src-path"
              v-model="form.path"
              required
              placeholder="/var/log/nginx/access.log"
              :class="cn(form.path && !pathValid && 'border-destructive')"
            />
            <p v-if="form.path && !pathValid" class="text-xs text-destructive">
              Must be absolute and under /var/log (no "..").
            </p>
          </div>

          <div class="grid gap-3 sm:grid-cols-2">
            <div class="grid gap-2">
              <Label for="src-line-bytes">Max line bytes</Label>
              <Input
                id="src-line-bytes"
                v-model.number="form.max_line_bytes"
                type="number"
                min="1"
                :max="MAX_LINE_BYTES_CAP"
              />
              <p class="text-xs text-muted-foreground">default 16384 · max 65536</p>
            </div>
            <div class="grid gap-2">
              <Label for="src-batch-lines">Max batch lines</Label>
              <Input
                id="src-batch-lines"
                v-model.number="form.max_batch_lines"
                type="number"
                min="1"
                :max="MAX_BATCH_LINES_CAP"
              />
              <p class="text-xs text-muted-foreground">default 500 · max 2000</p>
            </div>
          </div>

          <label class="flex items-center gap-2 text-sm">
            <input v-model="form.enabled" type="checkbox" class="size-4 accent-primary" />
            Enabled
          </label>

          <DialogFooter>
            <DialogClose as-child>
              <Button type="button" variant="outline">Cancel</Button>
            </DialogClose>
            <Button type="submit" :disabled="saving || !canSubmit">
              <RefreshCw v-if="saving" class="size-4 animate-spin" />
              <Plus v-else-if="!editingId" class="size-4" />
              <Pencil v-else class="size-4" />
              {{ editingId ? "Save" : "Create" }}
            </Button>
          </DialogFooter>
        </form>
      </DialogScrollContent>
    </Dialog>

    <!-- Delete confirmation -->
    <Dialog :open="!!deleteTarget" @update:open="(v) => { if (!v) deleteTarget = undefined; }">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete log source?</DialogTitle>
          <DialogDescription>
            Remove "{{ deleteTarget?.name || deleteTarget?.id }}" and purge its stored lines. This cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose as-child>
            <Button type="button" variant="outline">Cancel</Button>
          </DialogClose>
          <Button type="button" variant="destructive" :disabled="deleting" @click="confirmDelete">
            <RefreshCw v-if="deleting" class="size-4 animate-spin" />
            <Trash2 v-else class="size-4" />
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
