<script setup lang="ts">
/**
 * Raw log sources: which file or virtual stream each node ships, whether it
 * is on, what it holds and when its node last sent a line. Operator sources
 * are created, edited and deleted here; the server's own (agent debug,
 * sing-box) are listed and marked, because it refuses to edit them.
 */
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute } from "vue-router";
import { toast } from "vue-sonner";
import { Pencil, Plus, RefreshCw, Trash2 } from "lucide-vue-next";

import { api, type LogSource, type LogSourceUpsertRequest } from "@/lib/api";
import { formatDateTime, isZeroTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import DataState from "@/components/common/DataState.vue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { useEvidenceContext } from "./evidenceContext";
import {
  EMPTY_EVIDENCE_QUERY,
  RAW_LOG_STALE_MS,
  writeEvidenceLayer,
  writeEvidenceQuery,
} from "./evidenceModel";
import { logSourceNameTaken, sortLogSources } from "./logsModel";

const MAX_LINE_BYTES_DEFAULT = 16384;
const MAX_LINE_BYTES_CAP = 65536;
const MAX_BATCH_LINES_DEFAULT = 500;
const MAX_BATCH_LINES_CAP = 2000;
const PATH_PREFIX = "/var/log";

const { t } = useI18n();
const route = useRoute();
const ctx = useEvidenceContext();

const sources = computed(() => sortLogSources(ctx.sources.data.value ?? []));
const statsBy = computed(() => new Map((ctx.logStats.data.value ?? []).map((entry) => [entry.source_id, entry])));

function lastIngest(source: LogSource): string {
  const at = statsBy.value.get(source.id)?.last_ingest_at ?? "";
  return at && !isZeroTime(at) ? at : "";
}

function stale(source: LogSource): boolean {
  const at = lastIngest(source);
  return !!at && Date.now() - Date.parse(at) > RAW_LOG_STALE_MS;
}

function linesLink(source: LogSource) {
  const base = writeEvidenceLayer({ ...route.query, lens: "log" }, "explore");
  return {
    query: writeEvidenceQuery(
      base,
      { ...EMPTY_EVIDENCE_QUERY, sourceId: source.id, nodeId: source.node_id },
      { range: "all", since: "", until: "" },
    ),
  };
}

/* ------------------------------------------------------------------ */
/* Create and edit                                                     */
/* ------------------------------------------------------------------ */

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

function openCreate(): void {
  if (!ctx.canAdmin.value) return;
  editingId.value = undefined;
  form.value = {
    name: "",
    node_id: "",
    path: "",
    enabled: true,
    max_line_bytes: MAX_LINE_BYTES_DEFAULT,
    max_batch_lines: MAX_BATCH_LINES_DEFAULT,
  };
  formOpen.value = true;
}

function openEdit(source: LogSource): void {
  if (!ctx.canAdmin.value) return;
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
  return p.startsWith(PATH_PREFIX) && !p.includes("..");
});

// The server takes a second source with the same name on the same node
// without complaint, so the form refuses it here, under the field.
const nameError = computed(() =>
  logSourceNameTaken(ctx.sources.data.value ?? [], {
    name: form.value.name,
    nodeId: form.value.node_id,
    excludeId: editingId.value,
  })
    ? t("platform.logs.nameTaken", { name: form.value.name.trim() })
    : "",
);

const canSubmit = computed(
  () =>
    !!form.value.name.trim() &&
    !nameError.value &&
    !!form.value.node_id &&
    pathValid.value &&
    Number(form.value.max_line_bytes) >= 1 &&
    Number(form.value.max_line_bytes) <= MAX_LINE_BYTES_CAP &&
    Number(form.value.max_batch_lines) >= 1 &&
    Number(form.value.max_batch_lines) <= MAX_BATCH_LINES_CAP,
);

async function submitForm(): Promise<void> {
  if (!canSubmit.value || !ctx.canAdmin.value) return;
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
    await api.logs.upsertSource(req);
    toast.success(editingId.value ? t("platform.logs.sourceUpdated") : t("platform.logs.sourceCreated"));
    formOpen.value = false;
    await ctx.sources.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("platform.logs.saveFailed"));
  } finally {
    saving.value = false;
  }
}

/* ------------------------------------------------------------------ */
/* Delete                                                              */
/* ------------------------------------------------------------------ */

const deleteTarget = ref<LogSource | undefined>();
const deleting = ref(false);

async function confirmDelete(): Promise<void> {
  if (!deleteTarget.value) return;
  deleting.value = true;
  try {
    await api.logs.deleteSource(deleteTarget.value.id);
    toast.success(t("platform.logs.sourceDeleted"));
    deleteTarget.value = undefined;
    await ctx.sources.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("platform.logs.deleteFailed"));
  } finally {
    deleting.value = false;
  }
}
</script>

<template>
  <section class="space-y-3" aria-labelledby="evidence-sources-title">
    <div class="flex flex-wrap items-end justify-between gap-2">
      <div class="space-y-1">
        <h2 id="evidence-sources-title" class="text-sm font-semibold tracking-[-0.01em]">{{ $t('platform.logs.sourcesTitle') }}</h2>
        <p class="max-w-3xl text-sm text-muted-foreground">{{ $t('platform.evidence.collection.sourcesHint') }}</p>
      </div>
      <Button
        variant="outline"
        size="sm"
        :disabled="!ctx.canAdmin.value"
        :title="ctx.canAdmin.value ? undefined : $t('platform.trace.needsAdmin', { scope: 'log:admin' })"
        @click="openCreate"
      >
        <Plus aria-hidden="true" class="size-4" />
        {{ $t('platform.logs.newSource') }}
      </Button>
    </div>

    <DataState
      :loading="ctx.sources.loading.value"
      :error="ctx.sources.error.value"
      :has-data="ctx.sources.data.value !== undefined"
      :is-empty="sources.length === 0"
      :empty-title="$t('platform.logs.sourcesEmptyTitle')"
      :empty-description="$t('platform.logs.sourcesEmptyDescription')"
      @retry="ctx.sources.refresh"
    >
      <div class="relative overflow-x-auto rounded-md border border-border">
        <table class="w-full min-w-[820px] text-sm">
          <thead>
            <tr class="border-b border-border text-left text-xs text-muted-foreground">
              <th scope="col" class="pin-start px-3 py-2 font-medium [--pin-max:14rem]">{{ $t('platform.logs.nameLabel') }}</th>
              <th scope="col" class="px-3 py-2 font-medium">{{ $t('platform.logs.nodeLabel') }}</th>
              <th scope="col" class="px-3 py-2 font-medium">{{ $t('platform.logs.pathLabel') }}</th>
              <th scope="col" class="px-3 py-2 font-medium">{{ $t('platform.evidence.collection.colState') }}</th>
              <th scope="col" class="px-3 py-2 text-right font-medium">{{ $t('platform.logs.statLines') }}</th>
              <th scope="col" class="px-3 py-2 font-medium">{{ $t('platform.logs.statLastIngest') }}</th>
              <th scope="col" class="pin-end px-3 py-2 text-right font-medium"><span class="sr-only">{{ $t('platform.trace.colSessionActions') }}</span></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="source in sources" :key="source.id" class="border-b border-border last:border-b-0">
              <th scope="row" class="pin-start px-3 py-2 text-left font-medium [--pin-max:14rem]">
                <RouterLink :to="linesLink(source)" class="block truncate hover:underline" :title="source.name || source.id">
                  {{ source.name || source.id }}
                </RouterLink>
              </th>
              <td class="px-3 py-2 text-xs whitespace-nowrap">{{ ctx.nodeLabel(source.node_id) }}</td>
              <td class="max-w-64 px-3 py-2 font-mono text-xs text-muted-foreground"><span class="block truncate" :title="source.path">{{ source.path }}</span></td>
              <td class="px-3 py-2">
                <div class="flex flex-wrap items-center gap-1">
                  <span :class="cn('text-xs', !source.enabled && 'text-muted-foreground')">
                    {{ source.enabled ? $t('common.status.enabled') : $t('common.status.disabled') }}
                  </span>
                  <Badge v-if="source.managed" variant="outline" :title="$t('platform.logs.managedSourceHint')">{{ $t('platform.logs.managedSource') }}</Badge>
                </div>
              </td>
              <td class="px-3 py-2 text-right font-mono text-xs tabular">
                <span v-if="statsBy.get(source.id)">{{ statsBy.get(source.id)!.lines }}</span>
                <span v-else class="text-muted-foreground">{{ $t('platform.evidence.overview.unread') }}</span>
              </td>
              <td class="px-3 py-2 whitespace-nowrap">
                <span class="font-mono text-xs tabular">{{ lastIngest(source) ? formatDateTime(lastIngest(source)) : $t('platform.evidence.overview.neverShipped') }}</span>
                <Badge v-if="stale(source)" variant="warning" class="ml-2" :title="$t('platform.evidence.overview.staleHint')">{{ $t('platform.evidence.overview.stale') }}</Badge>
              </td>
              <td class="pin-end px-3 py-2">
                <!-- The server owns its synthetic sources and refuses to edit
                     or delete them; drawing the controls only produced a
                     failing click. -->
                <div v-if="!source.managed && ctx.canAdmin.value" class="flex justify-end gap-1">
                  <Button variant="ghost" size="icon-sm" :aria-label="$t('platform.logs.editSourceAria')" @click="openEdit(source)">
                    <Pencil class="size-4" />
                  </Button>
                  <Button variant="ghost" size="icon-sm" :aria-label="$t('platform.logs.deleteSourceAria')" @click="deleteTarget = source">
                    <Trash2 class="size-4 text-destructive" />
                  </Button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </DataState>

    <!-- Create / edit -->
    <Dialog v-model:open="formOpen">
      <DialogScrollContent class="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{{ editingId ? $t('platform.logs.editSourceTitle') : $t('platform.logs.newSourceTitle') }}</DialogTitle>
          <DialogDescription>
            <i18n-t keypath="platform.logs.formHint" tag="span" scope="global">
              <template #path><code class="font-mono">/var/log</code></template>
            </i18n-t>
          </DialogDescription>
        </DialogHeader>

        <form class="space-y-4" @submit.prevent="submitForm">
          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div class="grid gap-2">
              <Label for="src-name">{{ $t('platform.logs.nameLabel') }}</Label>
              <Input id="src-name" v-model="form.name" required placeholder="nginx-access" :aria-invalid="!!nameError" />
              <p v-if="nameError" class="text-xs text-destructive">{{ nameError }}</p>
            </div>
            <div class="grid gap-2">
              <Label for="src-node">{{ $t('platform.logs.nodeLabel') }}</Label>
              <Select v-if="ctx.canReadNodes.value" v-model="form.node_id" :disabled="!!editingId">
                <SelectTrigger id="src-node"><SelectValue :placeholder="$t('platform.logs.selectNode')" /></SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="node in ctx.nodes.value" :key="node.id" :value="node.id">{{ node.name || node.id }}</SelectItem>
                </SelectContent>
              </Select>
              <Input v-else id="src-node" v-model.trim="form.node_id" :disabled="!!editingId" :placeholder="$t('platform.logs.nodeIdPlaceholder')" />
              <p v-if="editingId" class="text-xs text-muted-foreground">{{ $t('platform.logs.nodeImmutable') }}</p>
              <p v-else-if="!ctx.canReadNodes.value" class="text-xs text-muted-foreground">{{ $t('platform.logs.nodeIdManualHint') }}</p>
            </div>
          </div>

          <div class="grid gap-2">
            <Label for="src-path">{{ $t('platform.logs.pathLabel') }}</Label>
            <Input
              id="src-path"
              v-model="form.path"
              required
              placeholder="/var/log/nginx/access.log"
              :class="cn(form.path && !pathValid && 'border-destructive')"
            />
            <p v-if="form.path && !pathValid" class="text-xs text-destructive">{{ $t('platform.logs.pathInvalid') }}</p>
          </div>

          <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div class="grid gap-2">
              <Label for="src-line-bytes">{{ $t('platform.logs.maxLineBytesLabel') }}</Label>
              <Input id="src-line-bytes" v-model.number="form.max_line_bytes" type="number" min="1" :max="MAX_LINE_BYTES_CAP" />
              <p class="text-xs text-muted-foreground">{{ $t('platform.logs.maxLineBytesHint') }}</p>
            </div>
            <div class="grid gap-2">
              <Label for="src-batch-lines">{{ $t('platform.logs.maxBatchLinesLabel') }}</Label>
              <Input id="src-batch-lines" v-model.number="form.max_batch_lines" type="number" min="1" :max="MAX_BATCH_LINES_CAP" />
              <p class="text-xs text-muted-foreground">{{ $t('platform.logs.maxBatchLinesHint') }}</p>
            </div>
          </div>

          <label class="flex cursor-pointer items-center gap-2 text-sm">
            <Checkbox v-model="form.enabled" />
            <span>{{ $t('platform.logs.enabledLabel') }}</span>
          </label>

          <DialogFooter>
            <DialogClose as-child>
              <Button type="button" variant="outline">{{ $t('common.actions.cancel') }}</Button>
            </DialogClose>
            <Button type="submit" :disabled="saving || !canSubmit">
              <RefreshCw v-if="saving" aria-hidden="true" class="size-4 animate-spin" />
              <Plus v-else-if="!editingId" aria-hidden="true" class="size-4" />
              <Pencil v-else aria-hidden="true" class="size-4" />
              {{ editingId ? $t('common.actions.save') : $t('common.actions.create') }}
            </Button>
          </DialogFooter>
        </form>
      </DialogScrollContent>
    </Dialog>

    <!-- Delete confirmation -->
    <Dialog :open="!!deleteTarget" @update:open="(v) => { if (!v) deleteTarget = undefined; }">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{{ $t('platform.logs.deleteSourceTitle') }}</DialogTitle>
          <DialogDescription>{{ $t('platform.logs.deleteSourceConfirm', { name: deleteTarget?.name || deleteTarget?.id }) }}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose as-child>
            <Button type="button" variant="outline">{{ $t('common.actions.cancel') }}</Button>
          </DialogClose>
          <Button type="button" variant="destructive" :disabled="deleting" @click="confirmDelete">
            <RefreshCw v-if="deleting" aria-hidden="true" class="size-4 animate-spin" />
            <Trash2 v-else aria-hidden="true" class="size-4" />
            {{ $t('common.actions.delete') }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </section>
</template>
