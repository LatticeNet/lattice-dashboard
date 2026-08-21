<script setup lang="ts">
/**
 * Published subscriptions: the public URLs this server serves.
 *
 * This lives in the dashboard rather than in a plugin because shares are
 * core-owned: the route, the token comparison, the rate limit and the audit
 * trail belong to the server, and a plugin frame runs with `connect-src 'none'`
 * and can only reach methods its signed manifest declares. Giving it the share
 * API would hand token management to plugin code.
 *
 * What changed here is the shape, not the ownership. The page used to be a row
 * of bare inputs asking the operator to type a plugin id and a subscription id
 * copied from another screen, above a stack of naked URLs. Publishing now picks
 * the record from the plugin that owns it, and the list is a table like every
 * other high-cardinality surface in this console.
 *
 * The token is shown in full, permanently, and the server returns it
 * deliberately: the URL is copied out of here repeatedly, and a credential that
 * is visible only once gets written down somewhere worse.
 */
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import { toast } from "vue-sonner";
import {
  Copy,
  ExternalLink,
  KeyRound,
  Link2,
  MonitorSmartphone,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-vue-next";

import { api, ApiError, unwrap } from "@/lib/api";
import { publishingState, recordsForShare, routeLabel } from "@/views/platform/publishingModel";
import type {
  PluginView,
  ShareSource,
  SubscriptionShareCreateRequest,
  SubscriptionShareView,
} from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { useAuthStore } from "@/stores/auth";
import { formatDateTime, formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { SHARE_SLUG_RE, suggestShareSlug } from "./subscriptionSharesModel";
import {
  SHARE_TARGETS,
  clientUrl,
  isServing,
  publishedState,
  sharePath,
  sourceLabel,
  type PublishedState,
} from "./publishedModel";

import PageHeader from "@/components/common/PageHeader.vue";
import ConfirmDialog from "@/components/common/ConfirmDialog.vue";
import DataTable, { type DataTableColumn } from "@/components/common/DataTable.vue";
import FreshnessLabel from "@/components/common/FreshnessLabel.vue";
import CopyButton from "@/components/common/CopyButton.vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
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
const route = useRoute();
const router = useRouter();

const canAdmin = computed(() => auth.can("proxy:admin"));

const sharesQuery = useAsyncData<SubscriptionShareView[] | undefined>(
  () => api.subscriptionShares.list(),
  { pollInterval: 20000 },
);
const shares = computed(() => sharesQuery.data.value ?? []);


const busyId = ref("");
const selectedId = ref("");
const selected = computed(() => shares.value.find((share) => share.id === selectedId.value));
/**
 * Where a share is reachable comes from the publishing plane, so this page and
 * the Publishing page cannot drift into two different answers about the same
 * URL. The share still owns its token, its default format and its per-client
 * links, because those belong to the origin rather than to the route.
 */
const routesQuery = useAsyncData(() => api.publishing.records(), { pollInterval: 20000 });
const selectedRoutes = computed(() =>
  selected.value ? recordsForShare(routesQuery.data.value?.records ?? [], selected.value.id) : [],
);

/** The origin the browser is on is the origin the share is served from, so the
 *  displayed URL is the real one rather than a guess at LATTICE_PUBLIC_URL. */
const origin = computed(() => (typeof window === "undefined" ? "" : window.location.origin));
function shareUrl(share: SubscriptionShareView): string {
  return `${origin.value}${sharePath(share)}`;
}

function describe(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message;
  return error instanceof Error ? error.message : fallback;
}

const stateVariant: Record<PublishedState, "default" | "secondary" | "destructive" | "outline"> = {
  live: "secondary",
  expiring: "outline",
  expired: "destructive",
  paused: "outline",
};

// ── publish ────────────────────────────────────────────────────────────────
//
// The old form asked for a plugin id and a subscription id as free text, with
// the hint "as listed in the plugin's Subscriptions tab", an instruction to go
// to another screen, copy an identifier, and come back. The dialog reads the
// plugin's own records instead, so publishing is a choice rather than a
// transcription.

const publishOpen = ref(false);
const publishing = ref(false);
const draft = ref<{
  kind: ShareSource["kind"];
  pluginId: string;
  subscriptionId: string;
  proxyUserId: string;
  slug: string;
  defaultFormat: string;
}>({ kind: "plugin", pluginId: "", subscriptionId: "", proxyUserId: "", slug: "", defaultFormat: "" });

interface PluginRecord {
  id: string;
  name?: string;
  display_name?: string;
  kind?: string;
}

const pluginsQuery = useAsyncData<PluginView[] | undefined>(() => api.plugins.list());
/** Plugins that can actually back a share: the capability is what makes a
 *  plugin able to produce a subscription body the core serves. */
const publishablePlugins = computed(() =>
  (pluginsQuery.data.value ?? []).filter((plugin) =>
    (plugin.capabilities ?? []).includes("subscription:serve"),
  ),
);

const records = ref<PluginRecord[]>([]);
const recordsLoading = ref(false);
const recordsError = ref("");

/** Read the chosen plugin's records through the gateway. A plugin that does not
 *  answer is reported as such rather than leaving an empty picker that looks
 *  like a plugin with nothing in it. */
async function loadRecords(): Promise<void> {
  const pluginId = draft.value.pluginId;
  records.value = [];
  recordsError.value = "";
  if (!pluginId) return;
  recordsLoading.value = true;
  try {
    const response = await api.plugins.call<{ subscriptions?: PluginRecord[] } | PluginRecord[]>(
      pluginId,
      `${pluginId}/subscription`,
      "list",
      {},
    );
    const list = Array.isArray(response) ? response : (response.subscriptions ?? []);
    records.value = list.filter((record) => !!record?.id);
  } catch (error) {
    recordsError.value = describe(error, t("networking.shares.recordsFailed"));
  } finally {
    recordsLoading.value = false;
  }
}

watch(() => draft.value.pluginId, loadRecords);
watch(
  () => draft.value.subscriptionId,
  (id) => {
    if (!id || draft.value.slug.trim()) return;
    const record = records.value.find((entry) => entry.id === id);
    const name = record?.display_name || record?.name || id;
    draft.value.slug = suggestShareSlug(name, shares.value.map((share) => share.slug));
  },
);

const slugError = computed(() => {
  const slug = draft.value.slug.trim();
  if (!slug) return "";
  if (!SHARE_SLUG_RE.test(slug)) return t("networking.shares.slugRule");
  if (shares.value.some((share) => share.slug === slug)) return t("networking.shares.slugTaken");
  return "";
});

const canPublish = computed(() => {
  if (!draft.value.slug.trim() || slugError.value || publishing.value) return false;
  return draft.value.kind === "plugin"
    ? !!draft.value.pluginId && !!draft.value.subscriptionId
    : !!draft.value.proxyUserId.trim();
});

function openPublish(): void {
  draft.value = {
    kind: "plugin",
    pluginId: publishablePlugins.value[0]?.id ?? "",
    subscriptionId: "",
    proxyUserId: "",
    slug: "",
    defaultFormat: "",
  };
  publishOpen.value = true;
  void loadRecords();
}

async function publish(): Promise<void> {
  if (!canPublish.value) return;
  publishing.value = true;
  try {
    const source: ShareSource =
      draft.value.kind === "plugin"
        ? {
            kind: "plugin",
            plugin_id: draft.value.pluginId,
            subscription_id: draft.value.subscriptionId,
          }
        : { kind: "core.proxy_user", proxy_user_id: draft.value.proxyUserId.trim() };
    const body: SubscriptionShareCreateRequest = {
      slug: draft.value.slug.trim(),
      source,
      default_format: draft.value.defaultFormat || undefined,
    };
    const created = await api.subscriptionShares.create(body);
    toast.success(t("networking.shares.published", { slug: created.slug }));
    publishOpen.value = false;
    selectedId.value = created.id;
    await sharesQuery.refresh();
  } catch (error) {
    toast.error(describe(error, t("networking.shares.publishFailed")));
  } finally {
    publishing.value = false;
  }
}

// ── per-share actions ──────────────────────────────────────────────────────

const rotateTarget = ref<SubscriptionShareView | null>(null);
const deleteTarget = ref<SubscriptionShareView | null>(null);
/** Rotating and deleting both break every client already using the URL, so the
 *  confirmation asks for the slug back rather than for a click. */
const confirmText = ref("");
const confirmMatches = computed(() => {
  const target = rotateTarget.value ?? deleteTarget.value;
  return !!target && confirmText.value.trim() === target.slug;
});

/** Set when Confirm is pressed with a slug that does not match, so the click
 *  answers instead of doing nothing. */
const confirmError = ref(false);
watch(confirmText, () => {
  if (confirmMatches.value) confirmError.value = false;
});

function askRotate(share: SubscriptionShareView): void {
  confirmText.value = "";
  confirmError.value = false;
  deleteTarget.value = null;
  rotateTarget.value = share;
}

function askDelete(share: SubscriptionShareView): void {
  confirmText.value = "";
  confirmError.value = false;
  rotateTarget.value = null;
  deleteTarget.value = share;
}

function confirmDestructive(): void {
  if (!confirmMatches.value) {
    confirmError.value = true;
    return;
  }
  if (rotateTarget.value) void rotate();
  else void remove();
}

async function rotate(): Promise<void> {
  const share = rotateTarget.value;
  if (!share || !confirmMatches.value) return;
  busyId.value = share.id;
  try {
    const rotated = await api.subscriptionShares.rotate(share.id);
    toast.success(t("networking.shares.rotated", { slug: rotated.slug }));
    rotateTarget.value = null;
    await sharesQuery.refresh();
  } catch (error) {
    toast.error(describe(error, t("networking.shares.rotateFailed")));
  } finally {
    busyId.value = "";
  }
}

async function remove(): Promise<void> {
  const share = deleteTarget.value;
  if (!share || !confirmMatches.value) return;
  busyId.value = share.id;
  try {
    await api.subscriptionShares.remove(share.id);
    toast.success(t("networking.shares.deleted", { slug: share.slug }));
    deleteTarget.value = null;
    if (selectedId.value === share.id) selectedId.value = "";
    await sharesQuery.refresh();
  } catch (error) {
    toast.error(describe(error, t("networking.shares.deleteFailed")));
  } finally {
    busyId.value = "";
  }
}

async function refreshSource(share: SubscriptionShareView): Promise<void> {
  busyId.value = share.id;
  try {
    // The endpoint answers 200 even when the provider failed and the previous
    // snapshot was kept, flagging it as `stale`. Reporting that as a successful
    // refresh is exactly the lie this console exists to avoid.
    const result = (await api.subscriptionShares.refresh(share.id)) as { stale?: boolean } | null;
    if (result?.stale) toast.warning(t("networking.shares.refreshStale", { slug: share.slug }));
    else toast.success(t("networking.shares.refreshed", { slug: share.slug }));
  } catch (error) {
    // A provider that cannot be reached is not a broken share: the last good
    // snapshot keeps being served. Say both halves.
    toast.error(`${describe(error, t("networking.shares.refreshFailed"))} ${t("networking.shares.lastGoodServed")}`);
  } finally {
    busyId.value = "";
  }
}

async function copy(text: string, message: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(message);
  } catch {
    toast.error(t("networking.shares.clipboardUnavailable"));
  }
}

// ── table ──────────────────────────────────────────────────────────────────

const columns = computed<DataTableColumn<SubscriptionShareView>[]>(() => [
  { key: "slug", label: t("networking.shares.columns.slug"), sortable: true, searchable: true },
  {
    key: "state",
    label: t("networking.shares.columns.state"),
    sortable: true,
    filterable: true,
    class: "w-[7.5rem]",
    value: (row) => publishedState(row),
  },
  {
    key: "source",
    label: t("networking.shares.columns.source"),
    sortable: true,
    searchable: true,
    filterAliases: ["plugin", "record"],
    value: (row) => sourceLabel(row),
  },
  {
    key: "format",
    label: t("networking.shares.columns.format"),
    sortable: true,
    class: "w-[8rem]",
    value: (row) => row.default_format || "",
  },
  {
    key: "rotated",
    label: t("networking.shares.columns.rotated"),
    sortable: true,
    align: "right",
    class: "w-[9rem]",
    value: (row) => row.rotated_at || row.created_at,
  },
]);

// ── deep link from a plugin ────────────────────────────────────────────────

/**
 * The Sub-Store frame asks the host to navigate here with
 * ?create=1&for=<record>. The dialog opens with that record already chosen, so
 * the operator lands on a decision instead of a blank form.
 */
async function applyDeepLink(): Promise<void> {
  if (route.query.create !== "1") return;
  const raw = route.query.for;
  const name = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  const query = { ...route.query };
  delete query.create;
  delete query.for;
  void router.replace({ query });
  openPublish();
  if (!name) return;
  await nextTick();
  // The record may be identified by id or by name depending on the caller.
  const match = records.value.find((record) => record.id === name || record.name === name);
  draft.value.subscriptionId = match?.id ?? name;
  draft.value.slug = suggestShareSlug(match?.display_name || match?.name || name, shares.value.map((s) => s.slug));
}

onMounted(async () => {
  await sharesQuery.refresh();
  await applyDeepLink();
});
watch(() => route.query, applyDeepLink);
</script>

<template>
  <div class="p-6 space-y-6">
    <PageHeader
      :title="$t('networking.shares.title')"
      :description="$t('networking.shares.description')"
    >
      <template #status>
        <FreshnessLabel :last-updated="sharesQuery.lastUpdated.value" />
      </template>
      <template #actions>
        <Button variant="outline" size="sm" :disabled="sharesQuery.refreshing.value" @click="sharesQuery.refresh">
          <RefreshCw :class="cn('size-4', sharesQuery.refreshing.value && 'animate-spin')" aria-hidden="true" />
          {{ $t('common.actions.refresh') }}
        </Button>
        <Button v-if="canAdmin" size="sm" @click="openPublish">
          <Plus class="size-4" aria-hidden="true" />
          {{ $t('networking.shares.publish') }}
        </Button>
      </template>
    </PageHeader>

    <div class="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,420px)]">
      <DataTable
        state-key="shares"
        :columns="columns"
        :rows="shares"
        :row-key="(row) => row.id"
        :loading="sharesQuery.loading.value"
        :error="sharesQuery.error.value"
        :page-size="25"
        searchable
        :search-placeholder="$t('networking.shares.searchPlaceholder')"
        :empty-title="$t('networking.shares.emptyTitle')"
        :empty-description="$t('networking.shares.emptyDescription')"
        @row-select="selectedId = $event.id"
        @retry="sharesQuery.refresh"
      >
        <template #cell-slug="{ row }">
          <div class="min-w-0">
            <p
              :class="cn('truncate font-medium', selectedId === row.id && 'text-primary')"
              :title="`/${row.slug}`"
            >/{{ row.slug }}</p>
            <p class="truncate font-mono text-xs text-muted-foreground" :title="sharePath(row)">
              {{ sharePath(row) }}
            </p>
          </div>
        </template>

        <template #cell-state="{ row }">
          <Badge :variant="stateVariant[publishedState(row)]">
            {{ $t('networking.shares.state.' + publishedState(row)) }}
          </Badge>
        </template>

        <template #cell-source="{ row }">
          <span class="truncate text-sm" :title="sourceLabel(row)">{{ sourceLabel(row) }}</span>
        </template>

        <template #cell-format="{ row }">
          <span class="text-sm text-muted-foreground">
            {{ row.default_format || $t('networking.shares.formatAuto') }}
          </span>
        </template>

        <template #cell-rotated="{ row }">
          <span class="text-sm tabular" :title="formatDateTime(row.rotated_at || row.created_at)">
            {{ formatRelativeTime(row.rotated_at || row.created_at) }}
          </span>
        </template>
      </DataTable>

      <!-- Detail: one share, its URL, and the client-specific links. -->
      <div class="space-y-4">
        <div v-if="!selected" class="rounded-lg border border-dashed border-border p-6 text-center">
          <Link2 class="mx-auto size-5 text-muted-foreground" aria-hidden="true" />
          <p class="mt-2 text-sm font-medium">{{ $t('networking.shares.selectTitle') }}</p>
          <p class="mt-1 text-xs text-muted-foreground">{{ $t('networking.shares.selectHint') }}</p>
        </div>

        <div v-else class="rounded-lg border border-border">
          <div class="flex items-start justify-between gap-3 border-b border-border p-4">
            <div class="min-w-0">
              <p class="truncate font-medium" :title="`/${selected.slug}`">/{{ selected.slug }}</p>
              <p class="truncate text-xs text-muted-foreground" :title="sourceLabel(selected)">{{ sourceLabel(selected) }}</p>
            </div>
            <Badge :variant="stateVariant[publishedState(selected)]">
              {{ $t('networking.shares.state.' + publishedState(selected)) }}
            </Badge>
          </div>

          <div class="space-y-3 p-4">
            <div>
              <p class="text-xs font-medium text-muted-foreground">{{ $t('networking.shares.url') }}</p>
              <div class="mt-1 flex items-start gap-2">
                <code class="min-w-0 flex-1 break-all rounded bg-muted px-2 py-1.5 font-mono text-xs">{{ shareUrl(selected) }}</code>
                <CopyButton :value="shareUrl(selected)" :label="$t('common.actions.copy')" />
              </div>
              <p class="mt-1.5 text-xs text-muted-foreground">{{ $t('networking.shares.tokenNote') }}</p>
            </div>

            <div v-if="!isServing(selected)" class="rounded-md border-l-2 border-warning bg-muted/40 px-3 py-2 text-xs">
              {{ $t('networking.shares.notServing') }}
            </div>

            <div v-if="selectedRoutes.length">
              <p class="text-xs font-medium text-muted-foreground">{{ $t('platform.publishing.shareRouteTitle') }}</p>
              <p class="mt-1 text-xs text-muted-foreground">{{ $t('platform.publishing.shareRouteDescription') }}</p>
              <div
                v-for="record in selectedRoutes"
                :key="record.id"
                class="mt-2 flex flex-wrap items-center gap-2 text-xs"
              >
                <code class="rounded bg-muted px-2 py-1 font-mono">{{ routeLabel(record, $t('platform.publishing.anyHost')) }}</code>
                <Badge variant="outline">{{ $t(`platform.publishing.state.${publishingState(record)}`) }}</Badge>
                <Badge v-if="record.reserved" variant="outline" :title="$t('platform.publishing.reservedHint')">
                  {{ $t('platform.publishing.reserved') }}
                </Badge>
                <RouterLink
                  to="/platform/publishing"
                  class="rounded-sm text-primary outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
                >{{ $t('platform.publishing.openPublishing') }}</RouterLink>
              </div>
            </div>

            <div>
              <p class="text-xs font-medium text-muted-foreground">{{ $t('networking.shares.clientLinks') }}</p>
              <p class="mt-1 text-xs text-muted-foreground">{{ $t('networking.shares.clientLinksHint') }}</p>
              <div class="mt-2 grid grid-cols-2 gap-1.5">
                <Button
                  v-for="target in SHARE_TARGETS"
                  :key="target.id"
                  variant="outline"
                  size="sm"
                  class="justify-between"
                  :title="clientUrl(origin, selected, target.id)"
                  @click="copy(clientUrl(origin, selected, target.id), $t('networking.shares.copiedClient', { target: target.label }))"
                >
                  <span class="truncate">{{ target.label }}</span>
                  <MonitorSmartphone class="size-3.5 shrink-0 opacity-60" aria-hidden="true" />
                </Button>
              </div>
            </div>

            <dl class="grid grid-cols-2 gap-2 border-t border-border pt-3 text-xs">
              <div>
                <dt class="text-muted-foreground">{{ $t('networking.shares.columns.format') }}</dt>
                <dd>{{ selected.default_format || $t('networking.shares.formatAuto') }}</dd>
              </div>
              <div>
                <dt class="text-muted-foreground">{{ $t('networking.shares.created') }}</dt>
                <dd>{{ formatRelativeTime(selected.created_at) }}</dd>
              </div>
              <div v-if="selected.rotated_at">
                <dt class="text-muted-foreground">{{ $t('networking.shares.rotatedAt') }}</dt>
                <dd>{{ formatRelativeTime(selected.rotated_at) }}</dd>
              </div>
              <div v-if="selected.expires_at">
                <dt class="text-muted-foreground">{{ $t('networking.shares.expires') }}</dt>
                <dd>{{ formatDateTime(selected.expires_at) }}</dd>
              </div>
            </dl>
          </div>

          <div v-if="canAdmin" class="flex flex-wrap gap-2 border-t border-border p-4">
            <Button
              variant="outline"
              size="sm"
              :disabled="busyId === selected.id || selected.source.kind !== 'plugin'"
              :title="selected.source.kind === 'plugin'
                ? $t('networking.shares.refreshHint')
                : $t('networking.shares.refreshPluginOnly')"
              @click="refreshSource(selected)"
            >
              <RefreshCw :class="cn('size-4', busyId === selected.id && 'animate-spin')" aria-hidden="true" />
              {{ $t('networking.shares.refreshSource') }}
            </Button>
            <Button variant="outline" size="sm" :disabled="busyId === selected.id" @click="askRotate(selected)">
              <KeyRound class="size-4" aria-hidden="true" />
              {{ $t('networking.shares.rotate') }}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              class="ml-auto text-destructive"
              :disabled="busyId === selected.id"
              @click="askDelete(selected)"
            >
              <Trash2 class="size-4" aria-hidden="true" />
              {{ $t('common.actions.delete') }}
            </Button>
          </div>
        </div>

        <!-- The other two ways this server publishes. Naming them here is what
             keeps an operator from assuming subscriptions are a special case. -->
        <div class="rounded-lg border border-border p-4">
          <p class="text-xs font-medium text-muted-foreground">{{ $t('networking.shares.alsoPublishes') }}</p>
          <div class="mt-2 flex flex-wrap gap-2">
            <Button variant="outline" size="sm" as-child>
              <RouterLink to="/platform/static">
                <ExternalLink class="size-3.5" aria-hidden="true" />
                {{ $t('networking.shares.staticLink') }}
              </RouterLink>
            </Button>
            <Button variant="outline" size="sm" as-child>
              <RouterLink to="/platform/workers">
                <ExternalLink class="size-3.5" aria-hidden="true" />
                {{ $t('networking.shares.workersLink') }}
              </RouterLink>
            </Button>
          </div>
        </div>
      </div>
    </div>

    <!-- ── publish dialog ──────────────────────────────────────────────── -->
    <Dialog v-model:open="publishOpen">
      <DialogContent class="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{{ $t('networking.shares.publishTitle') }}</DialogTitle>
          <DialogDescription>{{ $t('networking.shares.publishDescription') }}</DialogDescription>
        </DialogHeader>

        <div class="space-y-4">
          <div class="grid gap-2">
            <Label>{{ $t('networking.shares.sourceKind') }}</Label>
            <Select v-model="draft.kind">
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="plugin">{{ $t('networking.shares.kindPlugin') }}</SelectItem>
                <SelectItem value="core.proxy_user">{{ $t('networking.shares.kindProxyUser') }}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <template v-if="draft.kind === 'plugin'">
            <div class="grid gap-2">
              <Label>{{ $t('networking.shares.plugin') }}</Label>
              <Select v-model="draft.pluginId">
                <SelectTrigger><SelectValue :placeholder="$t('networking.shares.pluginPlaceholder')" /></SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="plugin in publishablePlugins" :key="plugin.id" :value="plugin.id">
                    {{ plugin.name || plugin.id }}
                  </SelectItem>
                </SelectContent>
              </Select>
              <p v-if="!publishablePlugins.length" class="text-xs text-muted-foreground">
                {{ $t('networking.shares.noPublishablePlugins') }}
              </p>
            </div>

            <div class="grid gap-2">
              <Label>{{ $t('networking.shares.record') }}</Label>
              <Select v-model="draft.subscriptionId" :disabled="recordsLoading || !records.length">
                <SelectTrigger>
                  <SelectValue :placeholder="recordsLoading ? $t('common.state.loading') : $t('networking.shares.recordPlaceholder')" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="record in records" :key="record.id" :value="record.id">
                    {{ record.display_name || record.name || record.id }}
                  </SelectItem>
                </SelectContent>
              </Select>
              <p v-if="recordsError" class="text-xs text-destructive">{{ recordsError }}</p>
              <p v-else-if="!recordsLoading && !records.length && draft.pluginId" class="text-xs text-muted-foreground">
                {{ $t('networking.shares.noRecords') }}
              </p>
            </div>
          </template>

          <div v-else class="grid gap-2">
            <Label for="share-proxy-user">{{ $t('networking.shares.proxyUser') }}</Label>
            <Input id="share-proxy-user" v-model="draft.proxyUserId" autocomplete="off" />
          </div>

          <div class="grid gap-2">
            <Label for="share-slug">{{ $t('networking.shares.slug') }}</Label>
            <Input id="share-slug" v-model="draft.slug" autocomplete="off" spellcheck="false" placeholder="team-nodes" />
            <p v-if="slugError" class="text-xs text-destructive">{{ slugError }}</p>
            <p v-else class="text-xs text-muted-foreground">{{ $t('networking.shares.slugHint') }}</p>
          </div>

          <div class="grid gap-2">
            <Label>{{ $t('networking.shares.defaultFormat') }}</Label>
            <Select v-model="draft.defaultFormat">
              <SelectTrigger><SelectValue :placeholder="$t('networking.shares.formatAuto')" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="plain">plain</SelectItem>
                <SelectItem value="base64">base64</SelectItem>
                <SelectItem value="sing-box">sing-box</SelectItem>
              </SelectContent>
            </Select>
            <p class="text-xs text-muted-foreground">{{ $t('networking.shares.formatHint') }}</p>
          </div>
        </div>

        <DialogFooter>
          <DialogClose as-child>
            <Button variant="outline">{{ $t('common.actions.cancel') }}</Button>
          </DialogClose>
          <Button :disabled="!canPublish" @click="publish">
            <RefreshCw v-if="publishing" class="size-4 animate-spin" aria-hidden="true" />
            <Link2 v-else class="size-4" aria-hidden="true" />
            {{ $t('networking.shares.publish') }}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>

    <!-- ── rotate / delete confirmation ────────────────────────────────── -->
    <ConfirmDialog
      :open="!!rotateTarget || !!deleteTarget"
      :title="rotateTarget ? $t('networking.shares.rotateTitle') : $t('networking.shares.deleteTitle')"
      :description="rotateTarget
        ? $t('networking.shares.rotateWarning', { slug: rotateTarget.slug })
        : $t('networking.shares.deleteWarning', { slug: deleteTarget?.slug ?? '' })"
      :confirm-label="rotateTarget ? $t('networking.shares.rotate') : $t('common.actions.delete')"
      :cancel-label="$t('common.actions.cancel')"
      :variant="deleteTarget ? 'destructive' : 'default'"
      :pending="!!busyId"
      :confirm-disabled="!confirmMatches"
      @update:open="(open) => { if (!open) { rotateTarget = null; deleteTarget = null; } }"
      @confirm="confirmDestructive"
    >
      <div class="grid gap-2">
        <Label for="share-confirm">
          {{ $t('networking.shares.confirmPrompt', { slug: (rotateTarget ?? deleteTarget)?.slug }) }}
        </Label>
        <Input
          id="share-confirm"
          v-model="confirmText"
          autocomplete="off"
          spellcheck="false"
          :aria-invalid="confirmError || undefined"
        />
        <p v-if="confirmError" class="text-xs text-destructive">
          {{ $t('networking.shares.confirmMismatch') }}
        </p>
      </div>
    </ConfirmDialog>
  </div>
</template>
