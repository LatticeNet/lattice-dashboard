<script setup lang="ts">
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import { FolderOpen, Plus, RefreshCw, Save } from "lucide-vue-next";
import { api, type StaticObject } from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { useAuthStore } from "@/stores/auth";
import { formatBytes, formatDateTime } from "@/lib/format";
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

const { t } = useI18n();
const auth = useAuthStore();
const canRead = computed(() => auth.can("static:read"));
const canWrite = computed(() => auth.can("static:write"));

const bucket = ref("default");
const activeBucket = ref("default");

const objectsQuery = useAsyncData(
  () => api.static.list(activeBucket.value || "default"),
  { pollInterval: 0, immediate: canRead.value },
);
const objects = computed(() => objectsQuery.data.value ?? []);
const sortedObjects = computed(() =>
  [...objects.value].sort((a, b) => a.path.localeCompare(b.path)),
);

const columns = computed<DataTableColumn<StaticObject>[]>(() => [
  { key: "path", label: t("platform.static.colPath"), sortable: true, searchable: true, class: "font-mono text-xs" },
  { key: "content_type", label: t("platform.static.colContentType"), sortable: true, searchable: true },
  { key: "size", label: t("platform.static.colSize"), sortable: true, align: "right" },
  { key: "updated_at", label: t("platform.static.colUpdated"), sortable: true, class: "text-xs text-muted-foreground" },
  { key: "actions", label: t("platform.static.colActions"), align: "right" },
]);

function loadBucket() {
  activeBucket.value = bucket.value.trim() || "default";
  objectsQuery.refresh();
}

// ── Content preview dialog ──────────────────────────────────────────────────
const previewTarget = ref<StaticObject | undefined>(undefined);

// ── Put dialog ──────────────────────────────────────────────────────────────
const putOpen = ref(false);
const saving = ref(false);
const editing = ref(false);
const putPath = ref("");
const putContentType = ref("text/plain");
const putContent = ref("");

function openCreate() {
  editing.value = false;
  putPath.value = "";
  putContentType.value = "text/plain";
  putContent.value = "";
  putOpen.value = true;
}

function openEdit(object: StaticObject) {
  editing.value = true;
  putPath.value = object.path;
  putContentType.value = object.content_type || "text/plain";
  putContent.value = object.content;
  putOpen.value = true;
}

const canSubmit = computed(
  () => canWrite.value && !!putPath.value.trim() && !!putContentType.value.trim(),
);

async function submitPut() {
  if (!canSubmit.value) return;
  saving.value = true;
  try {
    await api.static.put({
      bucket: activeBucket.value || "default",
      path: putPath.value.trim(),
      content: putContent.value,
      content_type: putContentType.value.trim(),
    });
    toast.success(editing.value ? t("platform.static.objectUpdated") : t("platform.static.objectCreated"));
    putOpen.value = false;
    objectsQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("platform.static.writeFailed"));
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="p-6 space-y-6">
    <PageHeader
      :title="$t('platform.static.title')"
      :description="$t('platform.static.description')"
    >
      <template #actions>
        <Button variant="outline" size="sm" :disabled="objectsQuery.refreshing.value" @click="objectsQuery.refresh">
          <RefreshCw aria-hidden="true" :class="cn('size-4', objectsQuery.refreshing.value && 'animate-spin')" />
          {{ $t('common.actions.refresh') }}
        </Button>
        <Button v-if="canWrite" size="sm" @click="openCreate">
          <Plus aria-hidden="true" class="size-4" />
          {{ $t('platform.static.newObject') }}
        </Button>
      </template>
    </PageHeader>

    <Card>
      <CardHeader>
        <CardTitle class="flex items-center gap-2">
          <FolderOpen aria-hidden="true" class="size-4 text-muted-foreground" />
          {{ $t('platform.static.bucketTitle') }}
        </CardTitle>
        <CardDescription>
          <i18n-t keypath="platform.static.objectsIn" tag="span" scope="global">
            <template #bucket><span class="font-mono">{{ activeBucket }}</span></template>
          </i18n-t>
          <span v-if="!canWrite" class="text-muted-foreground">
            <i18n-t keypath="platform.static.readOnlyHint" tag="span" scope="global">
              <template #scope>static:write</template>
            </i18n-t>
          </span>
        </CardDescription>
      </CardHeader>
      <CardContent class="space-y-4">
        <form class="flex flex-wrap items-end gap-2" @submit.prevent="loadBucket">
          <div class="grid gap-2">
            <Label for="static-bucket">{{ $t('platform.static.bucketLabel') }}</Label>
            <Input id="static-bucket" v-model="bucket" class="w-64" placeholder="default" />
          </div>
          <Button type="submit" variant="outline">{{ $t('platform.static.load') }}</Button>
        </form>

        <DataTable
          v-if="canRead"
          :columns="columns"
          :rows="sortedObjects"
          :row-key="(object) => object.path"
          :loading="objectsQuery.loading.value"
          :error="objectsQuery.error.value"
          :page-size="50"
          searchable
          :search-placeholder="$t('platform.shared.searchPaths')"
          :empty-title="$t('platform.static.emptyTitle')"
          :empty-description="$t('platform.static.emptyDescription')"
          :no-match-title="$t('platform.shared.noMatchesTitle')"
          :no-match-description="$t('platform.shared.noMatchesDescription')"
          @retry="objectsQuery.refresh"
        >
          <template #cell-path="{ row }">
            <span class="font-mono text-xs">{{ row.path }}</span>
          </template>
          <template #cell-content_type="{ row }">
            <Badge variant="outline">{{ row.content_type || "—" }}</Badge>
          </template>
          <template #cell-size="{ row }">
            <span class="font-mono text-xs tabular text-muted-foreground">{{ formatBytes(row.size) }}</span>
          </template>
          <template #cell-updated_at="{ row }">
            <span class="text-xs text-muted-foreground">{{ formatDateTime(row.updated_at) }}</span>
          </template>
          <template #cell-actions="{ row }">
            <div class="flex items-center justify-end gap-1">
              <Button variant="ghost" size="sm" @click="previewTarget = row">
                {{ $t('platform.static.preview') }}
              </Button>
              <Button v-if="canWrite" variant="outline" size="sm" @click="openEdit(row)">{{ $t('common.actions.edit') }}</Button>
            </div>
          </template>
        </DataTable>
        <p v-else class="text-sm text-muted-foreground">
          <i18n-t keypath="platform.static.readScopeRequired" tag="span" scope="global">
            <template #scope><code class="font-mono">static:read</code></template>
          </i18n-t>
        </p>
      </CardContent>
    </Card>

    <StorageAdminPanel kind="static" :active-bucket="activeBucket" />

    <!-- Content preview dialog -->
    <Dialog :open="!!previewTarget" @update:open="(v) => { if (!v) previewTarget = undefined; }">
      <DialogScrollContent class="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle class="break-all font-mono text-base">{{ previewTarget?.path }}</DialogTitle>
          <DialogDescription>{{ previewTarget?.content_type || "—" }}</DialogDescription>
        </DialogHeader>
        <pre class="max-h-[420px] overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/30 p-3 font-mono text-xs leading-relaxed">{{ previewTarget?.content }}</pre>
        <DialogFooter>
          <Button type="button" variant="outline" @click="previewTarget = undefined">{{ $t('common.actions.close') }}</Button>
        </DialogFooter>
      </DialogScrollContent>
    </Dialog>

    <!-- Put dialog -->
    <Dialog v-model:open="putOpen">
      <DialogScrollContent class="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{{ editing ? $t('platform.static.editObject') : $t('platform.static.newObject') }}</DialogTitle>
          <DialogDescription>
            <i18n-t keypath="platform.static.writingToBucketHint" tag="span" scope="global">
              <template #bucket><span class="font-mono">{{ activeBucket }}</span></template>
            </i18n-t>
          </DialogDescription>
        </DialogHeader>
        <form class="space-y-4" @submit.prevent="submitPut">
          <div class="grid gap-3 sm:grid-cols-2">
            <div class="grid gap-2">
              <Label for="static-path">{{ $t('platform.static.pathLabel') }}</Label>
              <Input id="static-path" v-model="putPath" required :disabled="editing" placeholder="assets/index.html" />
            </div>
            <div class="grid gap-2">
              <Label for="static-ct">{{ $t('platform.static.contentTypeLabel') }}</Label>
              <Input id="static-ct" v-model="putContentType" required placeholder="text/plain" />
            </div>
          </div>
          <div class="grid gap-2">
            <Label for="static-content">{{ $t('platform.static.contentLabel') }}</Label>
            <textarea
              id="static-content"
              v-model="putContent"
              rows="10"
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
