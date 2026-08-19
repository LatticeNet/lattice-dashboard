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
  CardAction,
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

const namespace = ref("default");
const activeNamespace = ref("default");

const objectsQuery = useAsyncData(
  () => api.static.list(activeNamespace.value || "default"),
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

function loadNamespace() {
  activeNamespace.value = namespace.value.trim() || "default";
  if (canRead.value) objectsQuery.refresh();
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
      bucket: activeNamespace.value || "default",
      path: putPath.value.trim(),
      content: putContent.value,
      content_type: putContentType.value.trim(),
    });
    toast.success(editing.value ? t("platform.static.objectUpdated") : t("platform.static.objectCreated"));
    putOpen.value = false;
    if (canRead.value) objectsQuery.refresh();
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
        <Button
          v-if="canRead"
          variant="outline"
          size="sm"
          :disabled="objectsQuery.refreshing.value"
          :title="$t('platform.static.refreshObjectsHint')"
          @click="objectsQuery.refresh"
        >
          <RefreshCw aria-hidden="true" :class="cn('size-4', objectsQuery.refreshing.value && 'animate-spin')" />
          {{ $t('platform.static.refreshObjects') }}
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
          {{ $t('platform.static.objectsTitle') }}
        </CardTitle>
        <CardDescription>
          <i18n-t keypath="platform.static.objectsIn" tag="span" scope="global">
            <template #namespace><span class="font-mono">{{ activeNamespace }}</span></template>
          </i18n-t>
          <span v-if="!canWrite" class="text-muted-foreground">
            <i18n-t keypath="platform.static.readOnlyHint" tag="span" scope="global">
              <template #scope>static:write</template>
            </i18n-t>
          </span>
        </CardDescription>
        <CardAction>
          <form class="flex flex-wrap items-center gap-2" @submit.prevent="loadNamespace">
            <Label for="static-namespace" class="text-xs font-normal text-muted-foreground">
              {{ $t('platform.static.namespaceLabel') }}
            </Label>
            <Input id="static-namespace" v-model="namespace" class="h-8 w-40" placeholder="default" />
            <Button type="submit" variant="outline" size="sm">{{ $t('platform.static.load') }}</Button>
          </form>
        </CardAction>
      </CardHeader>
      <CardContent class="space-y-4">
        <p class="text-xs text-muted-foreground">{{ $t('platform.static.namespaceHint') }}</p>

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
            <Badge variant="outline">{{ row.content_type || $t('common.misc.none') }}</Badge>
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

    <StorageAdminPanel kind="static" :active-namespace="activeNamespace" />

    <!-- Content preview dialog -->
    <Dialog :open="!!previewTarget" @update:open="(v) => { if (!v) previewTarget = undefined; }">
      <DialogScrollContent class="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle class="break-all font-mono text-base">{{ previewTarget?.path }}</DialogTitle>
          <DialogDescription>{{ previewTarget?.content_type || $t('common.misc.none') }}</DialogDescription>
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
            <i18n-t keypath="platform.static.writingToNamespaceHint" tag="span" scope="global">
              <template #namespace><span class="font-mono">{{ activeNamespace }}</span></template>
            </i18n-t>
          </DialogDescription>
        </DialogHeader>
        <form class="space-y-4" @submit.prevent="submitPut">
          <div class="grid gap-3 sm:grid-cols-2">
            <div class="grid gap-2">
              <Label for="static-path">{{ $t('platform.static.pathLabel') }}</Label>
              <Input
                id="static-path"
                v-model="putPath"
                required
                :disabled="editing"
                :title="editing ? $t('platform.static.pathImmutable') : undefined"
                placeholder="assets/index.html"
              />
              <p v-if="editing" class="text-xs text-muted-foreground">{{ $t('platform.static.pathImmutable') }}</p>
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
