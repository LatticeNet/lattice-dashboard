<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import { Database, Pencil, Plus, RefreshCw, Save } from "lucide-vue-next";
import { api, type KVEntry } from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { useAuthStore } from "@/stores/auth";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

import PageHeader from "@/components/common/PageHeader.vue";
import DataTable, { type DataTableColumn } from "@/components/common/DataTable.vue";
import StorageAdminPanel from "@/components/platform/StorageAdminPanel.vue";
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
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogScrollContent,
  DialogTitle,
} from "@/components/ui/dialog";

const { t } = useI18n();
const auth = useAuthStore();
const canRead = computed(() => auth.can("kv:read"));
const canWrite = computed(() => auth.can("kv:write"));

const bucket = ref("default");
const activeBucket = ref("default");

const entriesQuery = useAsyncData(
  () => api.kv.list(activeBucket.value || "default"),
  { pollInterval: 0, immediate: canRead.value },
);
const entries = computed(() => entriesQuery.data.value ?? []);
const sortedEntries = computed(() =>
  [...entries.value].sort((a, b) => a.key.localeCompare(b.key)),
);

const columns = computed<DataTableColumn<KVEntry>[]>(() => {
  const cols: DataTableColumn<KVEntry>[] = [
    { key: "key", label: t("platform.kv.colKey"), sortable: true, searchable: true, class: "font-mono text-xs" },
    { key: "value", label: t("platform.kv.colValue"), searchable: true },
    { key: "updated_at", label: t("platform.kv.colUpdated"), sortable: true, class: "text-xs text-muted-foreground" },
  ];
  if (canWrite.value) {
    cols.push({ key: "actions", label: t("platform.kv.colActions"), align: "right" });
  }
  return cols;
});

function loadBucket() {
  activeBucket.value = bucket.value.trim() || "default";
  if (canRead.value) entriesQuery.refresh();
}

// ── Row expand (long values) ────────────────────────────────────────────────
const expanded = ref<Set<string>>(new Set());
function toggleExpand(key: string) {
  const next = new Set(expanded.value);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  expanded.value = next;
}
function isLong(value: string): boolean {
  return value.length > 80 || value.includes("\n");
}

// ── Put dialog ──────────────────────────────────────────────────────────────
const putOpen = ref(false);
const saving = ref(false);
const editing = ref(false);
const putKey = ref("");
const putValue = ref("");

function openCreate() {
  editing.value = false;
  putKey.value = "";
  putValue.value = "";
  putOpen.value = true;
}

function openEdit(entry: KVEntry) {
  editing.value = true;
  putKey.value = entry.key;
  putValue.value = entry.value;
  putOpen.value = true;
}

const canSubmit = computed(() => canWrite.value && !!putKey.value.trim());

async function submitPut() {
  if (!canSubmit.value) return;
  saving.value = true;
  try {
    await api.kv.put({
      bucket: activeBucket.value || "default",
      key: putKey.value.trim(),
      value: putValue.value,
    });
    toast.success(editing.value ? t("platform.kv.entryUpdated") : t("platform.kv.entryCreated"));
    putOpen.value = false;
    if (canRead.value) entriesQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("platform.kv.writeFailed"));
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="p-6 space-y-6">
    <PageHeader
      :title="$t('platform.kv.title')"
      :description="$t('platform.kv.description')"
    >
      <template #actions>
        <Button v-if="canRead" variant="outline" size="sm" :disabled="entriesQuery.refreshing.value" @click="entriesQuery.refresh">
          <RefreshCw aria-hidden="true" :class="cn('size-4', entriesQuery.refreshing.value && 'animate-spin')" />
          {{ $t('common.actions.refresh') }}
        </Button>
        <Button v-if="canWrite" size="sm" @click="openCreate">
          <Plus aria-hidden="true" class="size-4" />
          {{ $t('platform.kv.newEntry') }}
        </Button>
      </template>
    </PageHeader>

    <Card>
      <CardHeader>
        <CardTitle class="flex items-center gap-2">
          <Database aria-hidden="true" class="size-4 text-muted-foreground" />
          {{ $t('platform.kv.bucketTitle') }}
        </CardTitle>
        <CardDescription>
          <i18n-t keypath="platform.kv.entriesIn" tag="span" scope="global">
            <template #bucket><span class="font-mono">{{ activeBucket }}</span></template>
          </i18n-t>
          <span v-if="!canWrite" class="text-muted-foreground">
            <i18n-t keypath="platform.kv.readOnlyHint" tag="span" scope="global">
              <template #scope>kv:write</template>
            </i18n-t>
          </span>
        </CardDescription>
      </CardHeader>
      <CardContent class="space-y-4">
        <form class="flex flex-wrap items-end gap-2" @submit.prevent="loadBucket">
          <div class="grid gap-2">
            <Label for="kv-bucket">{{ $t('platform.kv.bucketLabel') }}</Label>
            <Input id="kv-bucket" v-model="bucket" class="w-64" placeholder="default" />
          </div>
          <Button type="submit" variant="outline">{{ $t('platform.kv.load') }}</Button>
        </form>

        <DataTable
          v-if="canRead"
          :columns="columns"
          :rows="sortedEntries"
          :row-key="(entry) => entry.key"
          :loading="entriesQuery.loading.value"
          :error="entriesQuery.error.value"
          :page-size="50"
          searchable
          :search-placeholder="$t('platform.shared.searchKeys')"
          :empty-title="$t('platform.kv.emptyTitle')"
          :empty-description="$t('platform.kv.emptyDescription')"
          :no-match-title="$t('platform.shared.noMatchesTitle')"
          :no-match-description="$t('platform.shared.noMatchesDescription')"
          @retry="entriesQuery.refresh"
        >
          <template #cell-key="{ row }">
            <span class="font-mono text-xs">{{ row.key }}</span>
          </template>
          <template #cell-value="{ row }">
            <template v-if="isLong(row.value)">
              <pre
                v-if="expanded.has(row.key)"
                class="max-h-[280px] overflow-auto whitespace-pre-wrap rounded-md bg-muted/30 p-2 font-mono text-xs"
              >{{ row.value }}</pre>
              <span v-else class="block max-w-[420px] truncate font-mono text-xs text-muted-foreground">{{ row.value }}</span>
              <button
                type="button"
                class="mt-1 text-xs text-primary hover:underline"
                @click="toggleExpand(row.key)"
              >
                {{ expanded.has(row.key) ? $t('platform.kv.collapse') : $t('platform.kv.expand') }}
              </button>
            </template>
            <span v-else class="font-mono text-xs">{{ row.value || "—" }}</span>
          </template>
          <template #cell-updated_at="{ row }">
            <span class="text-xs text-muted-foreground">{{ formatDateTime(row.updated_at) }}</span>
          </template>
          <template #cell-actions="{ row }">
            <div class="flex items-center justify-end gap-1">
              <Button variant="ghost" size="icon-sm" :aria-label="$t('common.actions.edit')" @click="openEdit(row)">
                <Pencil class="size-4" />
              </Button>
            </div>
          </template>
        </DataTable>
        <p v-else class="text-sm text-muted-foreground">
          <i18n-t keypath="platform.kv.readScopeRequired" tag="span" scope="global">
            <template #scope><code class="font-mono">kv:read</code></template>
          </i18n-t>
        </p>
      </CardContent>
    </Card>

    <StorageAdminPanel kind="kv" :active-bucket="activeBucket" />

    <!-- Put dialog -->
    <Dialog v-model:open="putOpen">
      <DialogScrollContent class="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{{ editing ? $t('platform.kv.editEntry') : $t('platform.kv.newEntry') }}</DialogTitle>
          <DialogDescription>
            <i18n-t keypath="platform.kv.writingToBucket" tag="span" scope="global">
              <template #bucket><span class="font-mono">{{ activeBucket }}</span></template>
            </i18n-t>
          </DialogDescription>
        </DialogHeader>
        <form class="space-y-4" @submit.prevent="submitPut">
          <div class="grid gap-2">
            <Label for="kv-key">{{ $t('platform.kv.keyLabel') }}</Label>
            <Input id="kv-key" v-model="putKey" required :disabled="editing" placeholder="my-key" />
          </div>
          <div class="grid gap-2">
            <Label for="kv-value">{{ $t('platform.kv.valueLabel') }}</Label>
            <textarea
              id="kv-value"
              v-model="putValue"
              rows="6"
              spellcheck="false"
              class="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" @click="putOpen = false">{{ $t('common.actions.cancel') }}</Button>
            <Button type="submit" :disabled="!canSubmit || saving">
              <RefreshCw v-if="saving" aria-hidden="true" class="size-4 animate-spin" />
              <Save v-else aria-hidden="true" class="size-4" />
              {{ editing ? $t('common.actions.save') : $t('common.actions.create') }}
            </Button>
          </DialogFooter>
        </form>
      </DialogScrollContent>
    </Dialog>
  </div>
</template>
