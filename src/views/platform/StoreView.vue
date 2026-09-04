<script setup lang="ts">
/**
 * One page for both object stores.
 *
 * KV and Static were never two systems. The server has one kind-parameterised
 * store behind them: one bucket record, one binding, one access-token type,
 * one handler set under /api/storage, one normalizer. Only the console split
 * them, into two views that were 284 and 283 near-identical lines.
 *
 * Both of those views also opened a bucket literally named "default" and
 * offered a text box to type another one. That is why this page existed while
 * showing nothing: the store held Sub-Store's whole database and vpn-core's
 * line maps, none of it in a bucket called "default", and none of it named
 * anywhere an operator could see. The bucket list here comes from the server's
 * inventory, which reports every bucket that exists rather than only the ones
 * someone registered.
 */
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink, useRoute, useRouter } from "vue-router";
import { toast } from "vue-sonner";
import { Database, FolderOpen, Lock, Pencil, Plus, RefreshCw, Save } from "lucide-vue-next";
import {
  api,
  type KVEntry,
  type StaticObject,
  type StorageBucketInventoryEntry,
  type StorageKind,
  type StorageTokenView,
} from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { useRouteTab } from "@/composables/useRouteTab";
import { useAuthStore } from "@/stores/auth";
import { formatBytes, formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  bucketContentAvailable,
  bucketOwner,
  bucketOwnerNote,
  bucketPluginId,
  bucketTokenWriterNames,
  bucketWritable,
} from "./storeModel";

import PageHeader from "@/components/common/PageHeader.vue";
import DataTable, { type DataTableColumn } from "@/components/common/DataTable.vue";
import DataState from "@/components/common/DataState.vue";
import EmptyState from "@/components/common/EmptyState.vue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogScrollContent,
  DialogTitle,
} from "@/components/ui/dialog";

const STORAGE_KINDS = ["kv", "static"] as const;
const FALLBACK_BUCKET = "default";

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const auth = useAuthStore();

// ── Which store, and which bucket, both live in the URL ──────────────────────
// A bucket an operator is looking at is exactly the thing they need to send to
// someone else, and the thing a reload should not lose.
const kind = useRouteTab<StorageKind>(
  () => STORAGE_KINDS,
  () => "kv",
  "kind",
);
const isStatic = computed(() => kind.value === "static");
const canRead = computed(() => auth.can(`${kind.value}:read`));
const canWrite = computed(() => auth.can(`${kind.value}:write`));
const readScope = computed(() => `${kind.value}:read`);
const writeScope = computed(() => `${kind.value}:write`);

const bucketParam = computed(() => {
  const raw = route.query.bucket;
  const value = Array.isArray(raw) ? raw.find((entry) => typeof entry === "string") : raw;
  return typeof value === "string" ? value.trim() : "";
});

function selectBucket(name: string) {
  if (name === bucketParam.value) return;
  router.push({ query: { ...route.query, bucket: name } }).catch(() => {});
}

// ── The bucket inventory ─────────────────────────────────────────────────────
const inventoryQuery = useAsyncData(
  (signal) => api.storage.buckets(kind.value, { signal }),
  { pollInterval: 0, immediate: false },
);

const inventory = computed<StorageBucketInventoryEntry[]>(() => {
  const res = inventoryQuery.data.value;
  if (!res) return [];
  if (res.inventory) return res.inventory;
  // A server without bucket enumeration only reports the registered records.
  // Projecting them keeps the page working; it cannot invent the buckets that
  // server does not report, so the count reads 0 rather than a wrong number.
  return res.buckets.map((bucket) => ({
    name: bucket.name,
    kind: bucket.kind,
    entries: 0,
    registered: true,
    reserved: false,
  }));
});

/**
 * The bucket the page is showing. The URL wins so a link is honoured even for
 * a bucket the inventory has not loaded yet; otherwise the first bucket that
 * actually exists, and only when the store really is empty does this fall back
 * to the name the old pages hard-coded.
 */
const activeBucket = computed(() => {
  if (bucketParam.value) return bucketParam.value;
  return inventory.value[0]?.name ?? FALLBACK_BUCKET;
});
const activeInventory = computed(() =>
  inventory.value.find((entry) => entry.name === activeBucket.value),
);
const activeReserved = computed(() => activeInventory.value?.reserved ?? false);

/**
 * Who wrote the bucket the page is showing, and what may be done with it.
 *
 * The inventory reports names and counts; it does not say that
 * plugin:latticenet.sub-store is a plugin's private database, that vpnmeta/*
 * is the server's line identity map, or that agent-releases holds binaries
 * nodes install as root. An operator looking at 479 keys they did not write
 * needs that before anything else on the page is useful.
 *
 * A bucket the inventory has not returned yet (a deep link, mid-load) is
 * treated as an operator bucket named by the URL, which is what it will be in
 * the common case and what the write controls already assumed.
 */
const activeFacts = computed(() => ({
  name: activeBucket.value,
  kind: kind.value,
  reserved: activeReserved.value,
}));
/**
 * The storage tokens for this kind, when the operator may read them.
 *
 * They answer the half of "who writes here" the bucket name cannot: a bucket
 * published through a binding is written by any caller holding a write-scoped
 * token for it, and the console used to tell the operator nothing but itself
 * writes there. Reading the list needs kv:admin or static:admin, so it is only
 * asked for when the operator holds it, and its absence is reported as "cannot
 * tell" rather than filled in with a guess.
 */
const canAdmin = computed(() => auth.can(`${kind.value}:admin`));
const adminScope = computed(() => `${kind.value}:admin`);
const tokensQuery = useAsyncData(
  (signal) => api.storage.tokens(kind.value, { signal }).then((res) => res.tokens ?? []),
  { pollInterval: 0, immediate: false },
);
const knownTokens = computed<StorageTokenView[] | undefined>(() =>
  canAdmin.value && !tokensQuery.error.value ? tokensQuery.data.value : undefined,
);

// A reserved bucket states its own case in the card body and gets no owner
// note: two sentences on one card, one of them derived from a name rule that
// never saw this bucket, is how the page came to answer "who wrote this"
// wrongly on the buckets holding VPN user secrets.
const activeOwnerNote = computed(() => bucketOwnerNote(activeFacts.value, knownTokens.value));
// A token the operator never named still writes the bucket, so the sentence is
// still true and only its quotation changes.
const activeTokenWriters = computed(
  () =>
    bucketTokenWriterNames(activeFacts.value, knownTokens.value ?? []).join(", ") ||
    t("platform.store.unnamedToken"),
);
const activePluginId = computed(() => bucketPluginId(activeFacts.value));
const activeWritable = computed(() => canWrite.value && bucketWritable(activeFacts.value));
const activeContentAvailable = computed(() => bucketContentAvailable(activeFacts.value));

// ── Entries in the active bucket ─────────────────────────────────────────────
// The fetcher records what it actually loaded. Switching kind keeps the last
// good rows in the composable, and rendering KV entries through the static
// columns would show an empty table over real data, so the table only trusts
// rows whose kind and bucket still match what the page is asking for.
const loadedKind = ref<StorageKind | undefined>(undefined);
const loadedBucket = ref("");

const entriesQuery = useAsyncData<KVEntry[] | StaticObject[]>(
  async (signal) => {
    const forKind = kind.value;
    const forBucket = activeBucket.value;
    const rows =
      forKind === "static"
        ? await api.static.list(forBucket, { signal })
        : await api.kv.list(forBucket, { signal });
    loadedKind.value = forKind;
    loadedBucket.value = forBucket;
    return rows;
  },
  { pollInterval: 0, immediate: false },
);

const rowsFresh = computed(
  () => loadedKind.value === kind.value && loadedBucket.value === activeBucket.value,
);
const rows = computed(() => (rowsFresh.value ? (entriesQuery.data.value ?? []) : []));

const kvRows = computed<KVEntry[]>(() =>
  isStatic.value
    ? []
    : [...(rows.value as KVEntry[])].sort((a, b) => a.key.localeCompare(b.key)),
);
const staticRows = computed<StaticObject[]>(() =>
  isStatic.value
    ? [...(rows.value as StaticObject[])].sort((a, b) => a.path.localeCompare(b.path))
    : [],
);

function reload() {
  if (!canRead.value) return;
  inventoryQuery.refresh();
  if (!activeReserved.value) entriesQuery.refresh();
}

watch(
  [kind, canRead, canAdmin],
  () => {
    if (canRead.value) inventoryQuery.refresh();
    if (canAdmin.value) tokensQuery.refresh();
  },
  { immediate: true },
);

watch(
  [kind, activeBucket, canRead, activeReserved],
  () => {
    // A reserved bucket is listed by name and never fetched. The server would
    // refuse it anyway; asking would only turn a deliberate refusal into an
    // error panel that reads like a fault.
    if (!canRead.value || activeReserved.value) return;
    entriesQuery.refresh();
  },
  { immediate: true },
);

// ── Columns ──────────────────────────────────────────────────────────────────
const kvColumns = computed<DataTableColumn<KVEntry>[]>(() => {
  const cols: DataTableColumn<KVEntry>[] = [
    { key: "key", label: t("platform.kv.colKey"), sortable: true, searchable: true, class: "font-mono text-xs" },
    { key: "value", label: t("platform.kv.colValue"), sortable: true, searchable: true },
    { key: "updated_at", label: t("platform.kv.colUpdated"), sortable: true, class: "text-xs text-muted-foreground" },
  ];
  // No column rather than a column of controls the page has already said it
  // will not use. A bucket the server owns is listed and not edited here, and
  // an enabled pencil beside that sentence is what made the note read as
  // decoration.
  if (activeWritable.value) {
    cols.push({ key: "actions", label: t("platform.kv.colActions"), align: "right" });
  }
  return cols;
});

const staticColumns = computed<DataTableColumn<StaticObject>[]>(() => {
  const cols: DataTableColumn<StaticObject>[] = [
    { key: "path", label: t("platform.static.colPath"), sortable: true, searchable: true, class: "font-mono text-xs" },
    { key: "content_type", label: t("platform.static.colContentType"), sortable: true, searchable: true },
    { key: "size", label: t("platform.static.colSize"), sortable: true, align: "right" },
    { key: "updated_at", label: t("platform.static.colUpdated"), sortable: true, class: "text-xs text-muted-foreground" },
  ];
  // No column rather than a column of disabled controls. The agent release
  // bucket has neither action available: its listing carries no bytes to
  // preview and the server refuses a write. The card above says why once.
  if (activeContentAvailable.value) {
    cols.push({ key: "actions", label: t("platform.static.colActions"), align: "right" });
  }
  return cols;
});

// ── Row expand (long KV values) ──────────────────────────────────────────────
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

// ── Static content preview ───────────────────────────────────────────────────
const previewTarget = ref<StaticObject | undefined>(undefined);

// ── Put dialog ───────────────────────────────────────────────────────────────
const putOpen = ref(false);
const saving = ref(false);
const editing = ref(false);
const putKey = ref("");
const putValue = ref("");
const putContentType = ref("text/plain");

function openCreate() {
  editing.value = false;
  putKey.value = "";
  putValue.value = "";
  putContentType.value = "text/plain";
  putOpen.value = true;
}

function openEditKV(entry: KVEntry) {
  editing.value = true;
  putKey.value = entry.key;
  putValue.value = entry.value;
  putOpen.value = true;
}

function openEditStatic(object: StaticObject) {
  editing.value = true;
  putKey.value = object.path;
  putValue.value = object.content;
  putContentType.value = object.content_type || "text/plain";
  putOpen.value = true;
}

const canSubmit = computed(() => {
  if (!activeWritable.value || !putKey.value.trim()) return false;
  return !isStatic.value || !!putContentType.value.trim();
});

async function submitPut() {
  if (!canSubmit.value) return;
  saving.value = true;
  try {
    if (isStatic.value) {
      await api.static.put({
        bucket: activeBucket.value,
        path: putKey.value.trim(),
        content: putValue.value,
        content_type: putContentType.value.trim(),
      });
      toast.success(
        editing.value ? t("platform.static.objectUpdated") : t("platform.static.objectCreated"),
      );
    } else {
      await api.kv.put({
        bucket: activeBucket.value,
        key: putKey.value.trim(),
        value: putValue.value,
      });
      toast.success(editing.value ? t("platform.kv.entryUpdated") : t("platform.kv.entryCreated"));
    }
    putOpen.value = false;
    reload();
  } catch (error) {
    const fallback = isStatic.value
      ? t("platform.static.writeFailed")
      : t("platform.kv.writeFailed");
    toast.error(error instanceof Error ? error.message : fallback);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div class="p-6 space-y-6">
    <PageHeader :title="$t('platform.store.title')" :description="$t('platform.store.description')">
      <template #actions>
        <Button
          v-if="canRead"
          variant="outline"
          size="sm"
          :disabled="inventoryQuery.refreshing.value || entriesQuery.refreshing.value"
          @click="reload"
        >
          <RefreshCw
            aria-hidden="true"
            :class="cn('size-4', (inventoryQuery.refreshing.value || entriesQuery.refreshing.value) && 'animate-spin')"
          />
          {{ $t('common.actions.refresh') }}
        </Button>
        <Button v-if="canWrite" size="sm" :disabled="!activeWritable" @click="openCreate">
          <Plus aria-hidden="true" class="size-4" />
          {{ isStatic ? $t('platform.static.newObject') : $t('platform.kv.newEntry') }}
        </Button>
      </template>
    </PageHeader>

    <!-- Which store. One control, because the two are one store server-side. -->
    <div class="inline-flex rounded-lg border border-border p-1" role="group" :aria-label="$t('platform.store.kindLabel')">
      <Button
        v-for="option in STORAGE_KINDS"
        :key="option"
        :variant="kind === option ? 'secondary' : 'ghost'"
        size="sm"
        :aria-pressed="kind === option"
        @click="kind = option"
      >
        <component :is="option === 'static' ? FolderOpen : Database" aria-hidden="true" class="size-4" />
        {{ option === 'static' ? $t('platform.store.kindStatic') : $t('platform.store.kindKv') }}
      </Button>
    </div>

    <div v-if="canRead" class="grid gap-6 lg:grid-cols-[minmax(240px,300px)_1fr] lg:items-start">
      <!-- ── Buckets that actually exist ──────────────────────────────────── -->
      <Card>
        <CardHeader>
          <CardTitle class="text-base">{{ $t('platform.store.bucketsTitle') }}</CardTitle>
          <CardDescription>{{ $t('platform.store.bucketsDescription') }}</CardDescription>
        </CardHeader>
        <CardContent>
          <DataState
            :loading="inventoryQuery.loading.value"
            :error="inventoryQuery.error.value"
            :is-empty="inventory.length === 0"
            :has-data="inventory.length > 0"
            :empty-title="$t('platform.store.noBucketsTitle')"
            :empty-description="$t('platform.store.noBucketsDescription')"
            :skeleton-rows="4"
            @retry="inventoryQuery.refresh"
          >
            <ul class="space-y-1">
              <li v-for="entry in inventory" :key="entry.name">
                <button
                  type="button"
                  :class="cn(
                    'w-full rounded-md border px-3 py-2 text-left outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50',
                    entry.name === activeBucket
                      ? 'border-primary/40 bg-primary/5'
                      : 'border-transparent hover:bg-muted/50',
                  )"
                  :aria-current="entry.name === activeBucket ? 'true' : undefined"
                  @click="selectBucket(entry.name)"
                >
                  <span class="flex items-center gap-1.5">
                    <Lock v-if="entry.reserved" aria-hidden="true" class="size-3.5 shrink-0 text-muted-foreground" />
                    <span class="truncate font-mono text-xs" :title="entry.name">{{ entry.name }}</span>
                  </span>
                  <span class="mt-1 flex flex-wrap items-center gap-1">
                    <span class="text-xs tabular text-muted-foreground">
                      {{ entry.entries === 1
                        ? $t('platform.store.entryCountOne', { count: entry.entries })
                        : $t('platform.store.entryCount', { count: entry.entries }) }}
                    </span>
                    <Badge variant="secondary">{{ $t(`platform.store.owner.${bucketOwner(entry)}`) }}</Badge>
                    <Badge v-if="entry.reserved" variant="outline">{{ $t('platform.store.reserved') }}</Badge>
                    <Badge v-else-if="!entry.registered" variant="outline">{{ $t('platform.store.unregistered') }}</Badge>
                  </span>
                </button>
              </li>
            </ul>
          </DataState>
        </CardContent>
      </Card>

      <!-- ── The active bucket ────────────────────────────────────────────── -->
      <!-- min-w-0: a grid item's automatic minimum is its content width, which
           for a wide table is wider than the column, and the whole page would
           scroll sideways instead of the table. -->
      <Card class="min-w-0">
        <CardHeader>
          <CardTitle class="flex items-center gap-2 text-base">
            <component :is="isStatic ? FolderOpen : Database" aria-hidden="true" class="size-4 text-muted-foreground" />
            <span class="break-all font-mono">{{ activeBucket }}</span>
          </CardTitle>
          <CardDescription>
            <i18n-t
              :keypath="isStatic ? 'platform.static.objectsIn' : 'platform.kv.entriesIn'"
              tag="span"
              scope="global"
            >
              <template #bucket><span class="font-mono">{{ activeBucket }}</span></template>
            </i18n-t>
            <span v-if="!canWrite" class="text-muted-foreground">
              <i18n-t
                :keypath="isStatic ? 'platform.static.readOnlyHint' : 'platform.kv.readOnlyHint'"
                tag="span"
                scope="global"
              >
                <template #scope>{{ writeScope }}</template>
              </i18n-t>
            </span>
          </CardDescription>
          <!--
            Who writes here. Everything this store holds on production was
            written by a machine except one leftover key, and a page that lists
            it without saying so reads as "some keys, origin unknown".
          -->
          <p v-if="activeOwnerNote" class="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <i18n-t
              v-if="activeOwnerNote === 'plugin'"
              keypath="platform.store.ownerNote.plugin"
              tag="span"
              scope="global"
            >
              <template #plugin><span class="font-mono">{{ activePluginId }}</span></template>
            </i18n-t>
            <i18n-t
              v-else-if="activeOwnerNote === 'operatorToken'"
              keypath="platform.store.ownerNote.operatorToken"
              tag="span"
              scope="global"
            >
              <template #tokens><span class="font-mono">{{ activeTokenWriters }}</span></template>
            </i18n-t>
            <i18n-t
              v-else-if="activeOwnerNote === 'operatorUnknown'"
              keypath="platform.store.ownerNote.operatorUnknown"
              tag="span"
              scope="global"
            >
              <template #scope><span class="font-mono">{{ adminScope }}</span></template>
            </i18n-t>
            <span v-else>{{ $t(`platform.store.ownerNote.${activeOwnerNote}`) }}</span>
            <RouterLink
              v-if="activeOwnerNote === 'agent'"
              to="/platform/agent-updates"
              class="rounded-sm text-primary outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >{{ $t('platform.store.openAgentUpdates') }}</RouterLink>
          </p>
        </CardHeader>
        <CardContent>
          <!-- A reserved bucket is named, never opened. -->
          <EmptyState
            v-if="activeReserved"
            :icon="Lock"
            :title="$t('platform.store.reservedTitle')"
            :description="$t('platform.store.reservedDescription')"
          />

          <DataTable
            v-else-if="isStatic"
            state-key="store"
            :columns="staticColumns"
            :rows="staticRows"
            :row-key="(object) => object.path"
            :loading="entriesQuery.loading.value"
            :error="entriesQuery.error.value"
            :page-size="50"
            searchable
            :search-placeholder="$t('platform.shared.searchPaths')"
            :empty-title="$t('platform.static.emptyTitle')"
            :empty-description="$t('platform.static.emptyDescription')"
            :no-match-title="$t('platform.shared.noMatchesTitle')"
            :no-match-description="$t('platform.shared.noMatchesDescription')"
            @retry="entriesQuery.refresh"
          >
            <template #cell-path="{ row }">
              <!-- break-all: an agent release path is one unbroken token with
                   a 64-char digest in it, and the stacked mobile row has no
                   width for it. -->
              <span class="font-mono text-xs break-all">{{ row.path }}</span>
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
                <Button v-if="activeWritable" variant="outline" size="sm" @click="openEditStatic(row)">
                  {{ $t('common.actions.edit') }}
                </Button>
              </div>
            </template>
          </DataTable>

          <DataTable
            v-else
            state-key="store"
            :columns="kvColumns"
            :rows="kvRows"
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
                <span
                  v-else
                  class="block max-w-[420px] truncate font-mono text-xs text-muted-foreground"
                  :title="row.value"
                >{{ row.value }}</span>
                <button
                  type="button"
                  class="mt-1 rounded-sm text-xs text-primary outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
                  :aria-expanded="expanded.has(row.key)"
                  @click="toggleExpand(row.key)"
                >
                  {{ expanded.has(row.key) ? $t('platform.kv.collapse') : $t('platform.kv.expand') }}
                </button>
              </template>
              <span v-else class="font-mono text-xs">{{ row.value || $t('common.misc.none') }}</span>
            </template>
            <template #cell-updated_at="{ row }">
              <span class="text-xs text-muted-foreground">{{ formatDateTime(row.updated_at) }}</span>
            </template>
            <template #cell-actions="{ row }">
              <div class="flex items-center justify-end gap-1">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  :aria-label="$t('common.actions.edit')"
                  @click="openEditKV(row)"
                >
                  <Pencil class="size-4" />
                </Button>
              </div>
            </template>
          </DataTable>
        </CardContent>
      </Card>
    </div>

    <p v-else class="text-sm text-muted-foreground">
      <i18n-t keypath="platform.store.readScopeRequired" tag="span" scope="global">
        <template #scope><code class="font-mono">{{ readScope }}</code></template>
      </i18n-t>
    </p>

    <p class="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
      {{ $t('platform.publishing.movedFromStorage') }}
      <RouterLink
        to="/platform/publishing"
        class="rounded-sm text-primary outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >{{ $t('platform.publishing.openPublishing') }}</RouterLink>
    </p>

    <!-- Static content preview -->
    <Dialog :open="!!previewTarget" @update:open="(v) => { if (!v) previewTarget = undefined; }">
      <DialogScrollContent class="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle class="break-all font-mono text-base">{{ previewTarget?.path }}</DialogTitle>
          <DialogDescription>{{ previewTarget?.content_type || $t('common.misc.none') }}</DialogDescription>
        </DialogHeader>
        <pre class="max-h-[420px] overflow-auto whitespace-pre-wrap rounded-md border border-border bg-muted/30 p-3 font-mono text-xs leading-relaxed">{{ previewTarget?.content }}</pre>
        <DialogFooter>
          <Button type="button" variant="outline" @click="previewTarget = undefined">
            {{ $t('common.actions.close') }}
          </Button>
        </DialogFooter>
      </DialogScrollContent>
    </Dialog>

    <!-- Put dialog -->
    <Dialog v-model:open="putOpen">
      <DialogScrollContent :class="isStatic ? 'sm:max-w-2xl' : 'sm:max-w-xl'">
        <DialogHeader>
          <DialogTitle>
            <template v-if="isStatic">
              {{ editing ? $t('platform.static.editObject') : $t('platform.static.newObject') }}
            </template>
            <template v-else>
              {{ editing ? $t('platform.kv.editEntry') : $t('platform.kv.newEntry') }}
            </template>
          </DialogTitle>
          <DialogDescription>
            <i18n-t
              :keypath="isStatic ? 'platform.static.writingToBucketHint' : 'platform.kv.writingToBucket'"
              tag="span"
              scope="global"
            >
              <template #bucket><span class="font-mono">{{ activeBucket }}</span></template>
            </i18n-t>
          </DialogDescription>
        </DialogHeader>
        <form class="space-y-4" @submit.prevent="submitPut">
          <div :class="isStatic ? 'grid gap-3 sm:grid-cols-2' : 'grid gap-2'">
            <div class="grid gap-2">
              <Label for="store-key">
                {{ isStatic ? $t('platform.static.pathLabel') : $t('platform.kv.keyLabel') }}
              </Label>
              <Input
                id="store-key"
                v-model="putKey"
                required
                :disabled="editing"
                :title="editing ? (isStatic ? $t('platform.static.pathImmutable') : $t('platform.kv.keyImmutable')) : undefined"
                :placeholder="isStatic ? 'assets/index.html' : 'my-key'"
              />
              <p v-if="editing" class="text-xs text-muted-foreground">
                {{ isStatic ? $t('platform.static.pathImmutable') : $t('platform.kv.keyImmutable') }}
              </p>
            </div>
            <div v-if="isStatic" class="grid gap-2">
              <Label for="store-content-type">{{ $t('platform.static.contentTypeLabel') }}</Label>
              <Input id="store-content-type" v-model="putContentType" required placeholder="text/plain" />
            </div>
          </div>
          <div class="grid gap-2">
            <Label for="store-value">
              {{ isStatic ? $t('platform.static.contentLabel') : $t('platform.kv.valueLabel') }}
            </Label>
            <Textarea
              id="store-value"
              v-model="putValue"
              :rows="isStatic ? 10 : 6"
              spellcheck="false"
              class="font-mono text-xs"
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" @click="putOpen = false">
              {{ $t('common.actions.cancel') }}
            </Button>
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
