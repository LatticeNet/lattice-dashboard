<script setup lang="ts">
/**
 * The share lens of Publishing: the subscription URLs this server serves, and
 * everything that manages them.
 *
 * This used to be a Networking page of its own. It lives here because a share
 * is a Publishing record, one whose bytes are rendered on request rather than
 * read from a bucket, and because it is core-owned: the route, the token
 * comparison, the rate limit and the audit trail belong to the server, and a
 * plugin frame runs with `connect-src 'none'` and can only reach methods its
 * signed manifest declares. Giving it the share API would hand token
 * management to plugin code (DESIGN-PROGRAM-2026-09 §9, Decision A).
 *
 * The token is shown in full, permanently, and the server returns it
 * deliberately: the URL is copied out of here repeatedly, and a credential that
 * is visible only once gets written down somewhere worse.
 *
 * Plugin absent: a share whose renderer plugin is not installed says so on its
 * row and in its detail, and refresh is disabled with that reason. Creating a
 * new plugin-backed share is unavailable with the reason. Proxy-user shares
 * are server-native and unaffected.
 */
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import { toast } from "vue-sonner";
import {
  CalendarClock,
  KeyRound,
  Link2,
  MonitorSmartphone,
  Plus,
  PlugZap,
  RefreshCw,
  Trash2,
} from "lucide-vue-next";

import { api, ApiError } from "@/lib/api";
import type {
  PluginView,
  ProxyUserView,
  PublishingRecord,
  ShareSource,
  SubscriptionShareCreateRequest,
  SubscriptionShareView,
} from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { useAuthStore } from "@/stores/auth";
import { formatDateTime, formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  hasShareCreateDeepLink,
  publishablePlugins as pickPublishablePlugins,
  recordsForShare,
  routeLabel,
  routeState,
  shareCreateTarget,
  shareRefreshable,
  shareRendererState,
  withoutShareDeepLink,
  type RouteState,
  type ShareRendererState,
} from "@/views/platform/publishingModel";
import { SHARE_SLUG_RE, suggestShareSlug } from "@/views/networking/subscriptionSharesModel";
import {
  emptyExpiryForm,
  expiryCreateValue,
  expiryFormError,
  expiryFormFor,
  expiryUpdateBody,
  type ExpiryForm,
} from "@/views/networking/shareExpiryModel";
import {
  SHARE_TARGETS,
  clientUrl,
  isServing,
  publishedState,
  sharePath,
  sourceLabel,
  type PublishedState,
} from "@/views/networking/publishedModel";

import PageHeader from "@/components/common/PageHeader.vue";
import ConfirmDialog from "@/components/common/ConfirmDialog.vue";
import DataTable, { type DataTableColumn } from "@/components/common/DataTable.vue";
import FreshnessLabel from "@/components/common/FreshnessLabel.vue";
import CopyButton from "@/components/common/CopyButton.vue";
import ShareExpiryFields from "@/components/networking/ShareExpiryFields.vue";
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

/** The query key that selects a share, so a detail panel is a link. */
const SHARE_SELECT_PARAM = "share";

const { t } = useI18n();
const auth = useAuthStore();
const route = useRoute();
const router = useRouter();

const canAdmin = computed(() => auth.can("proxy:admin"));

const sharesQuery = useAsyncData<SubscriptionShareView[] | undefined>(
  (signal) => api.subscriptionShares.list({ signal }),
  { pollInterval: 20000 },
);
const shares = computed(() => sharesQuery.data.value ?? []);

/**
 * The plugin list answers two questions on this pane: which plugins a new share
 * may be created against, and whether the plugin behind an existing share is
 * still there to render it. One read, both answers, so they cannot disagree.
 */
const pluginsQuery = useAsyncData<PluginView[] | undefined>((signal) => api.plugins.list({ signal }));
const plugins = computed(() => (pluginsQuery.error.value ? undefined : pluginsQuery.data.value));
const publishablePlugins = computed(() => pickPublishablePlugins(plugins.value));
const pluginShareAvailable = computed(() => publishablePlugins.value.length > 0);

function rendererState(share: SubscriptionShareView): ShareRendererState {
  return shareRendererState(share, plugins.value);
}

function rendererPluginId(share: SubscriptionShareView): string {
  return share.source.kind === "plugin" ? share.source.plugin_id : "";
}

/**
 * The proxy users the server has, for the same two questions about the other
 * source kind: which users a new share may point at, and whether the user
 * behind an existing share is still there. The share API accepts any
 * non-empty id and serves a dangling share as an empty 404, so this list is
 * the only place the console can tell. It is read only by a caller who may
 * (the endpoint wants proxy:read, which proxy:admin does not imply), and a
 * list that was not read or failed stays unknown: the dialog falls back to a
 * free-text id and no share is called unresolved on a guess.
 */
const canReadProxyUsers = computed(() => auth.can("proxy:read"));
const proxyUsersQuery = useAsyncData<ProxyUserView[] | undefined>(
  async (signal) => (await api.proxy.users({ signal })).users,
  { immediate: false },
);
const proxyUsers = computed(() => (proxyUsersQuery.error.value ? undefined : proxyUsersQuery.data.value));
const knownProxyUsers = computed(() => (proxyUsers.value ? new Set(proxyUsers.value.map((user) => user.id)) : undefined));

async function loadProxyUsers(): Promise<void> {
  if (canReadProxyUsers.value) await proxyUsersQuery.refresh();
}

/** The state a row and its detail show: the share alone, checked against the users actually read. */
function shareState(share: SubscriptionShareView): PublishedState {
  return publishedState(share, Date.now(), knownProxyUsers.value);
}

function serving(share: SubscriptionShareView): boolean {
  return isServing(share, Date.now(), knownProxyUsers.value);
}

/** The sentence the disabled refresh button and the detail notice both carry. */
function rendererReason(share: SubscriptionShareView): string {
  switch (rendererState(share)) {
    case "native":
      return t("networking.shares.refreshPluginOnly");
    case "missing":
      return t("platform.publishing.renderer.missingHint", { plugin: rendererPluginId(share) });
    case "inactive":
      return t("platform.publishing.renderer.inactiveHint", { plugin: rendererPluginId(share) });
    default:
      return t("networking.shares.refreshHint");
  }
}

const busyId = ref("");

// ── selection lives in the URL ─────────────────────────────────────────────
// The routes table on the whole plane links a plugin route to its share, and a
// selected share is what an operator sends to another. Selecting refines the
// page rather than leaving it, so it replaces the entry like a table filter.
const selectedId = computed(() => {
  const raw = route.query[SHARE_SELECT_PARAM];
  const value = Array.isArray(raw) ? raw.find((entry) => typeof entry === "string") : raw;
  return typeof value === "string" ? value : "";
});
const selected = computed(() => shares.value.find((share) => share.id === selectedId.value));

function select(id: string): void {
  if (id === selectedId.value) return;
  const query = { ...route.query };
  if (id) query[SHARE_SELECT_PARAM] = id;
  else delete query[SHARE_SELECT_PARAM];
  router.replace({ query }).catch(() => {});
}

/**
 * Where a share is reachable comes from the publishing records, so this pane
 * and the routes table above it cannot drift into two different answers about
 * the same URL. The share still owns its token, its default format and its
 * per-client links, because those belong to the origin rather than to the route.
 */
const routesQuery = useAsyncData((signal) => api.publishing.records({ signal }), { pollInterval: 20000 });
const selectedRoutes = computed(() =>
  selected.value ? recordsForShare(routesQuery.data.value?.records ?? [], selected.value.id) : [],
);
/** The selected share's routes carry its unresolved state, as the routes table does. */
function selectedRouteState(record: PublishingRecord): RouteState {
  const unresolved =
    selected.value && shareState(selected.value) === "unresolved" ? new Set([selected.value.id]) : undefined;
  return routeState(record, unresolved);
}

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
  unresolved: "destructive",
};

async function refresh(): Promise<void> {
  await Promise.all([sharesQuery.refresh(), routesQuery.refresh(), pluginsQuery.refresh(), loadProxyUsers()]);
}

// The page-level Refresh button reloads this pane too, so one control means
// one thing for the whole page.
defineExpose({ refresh });

// ── publish ────────────────────────────────────────────────────────────────
//
// The dialog reads the plugin's own records rather than asking for ids as free
// text, so publishing is a choice rather than a transcription.

const publishOpen = ref(false);
const publishing = ref(false);
const draft = ref<{
  kind: ShareSource["kind"];
  pluginId: string;
  subscriptionId: string;
  proxyUserId: string;
  slug: string;
  defaultFormat: string;
  expiry: ExpiryForm;
}>({
  kind: "plugin",
  pluginId: "",
  subscriptionId: "",
  proxyUserId: "",
  slug: "",
  defaultFormat: "",
  expiry: emptyExpiryForm(),
});

// The clock the expiry forms validate against, sampled when a dialog opens. A
// live ticking `now` would let "the last day" flip to invalid mid-edit while the
// operator is still typing. The server checks the instant again on arrival.
const now = ref(Date.now());

interface PluginRecord {
  id: string;
  name?: string;
  display_name?: string;
  kind?: string;
}

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
  if (expiryFormError(draft.value.expiry, now.value)) return false;
  if (draft.value.kind === "plugin") {
    return pluginShareAvailable.value && !!draft.value.pluginId && !!draft.value.subscriptionId;
  }
  return !!draft.value.proxyUserId.trim();
});

function openPublish(): void {
  // Plugin absent: the dialog opens on the kind that can still be created, and
  // the plugin kind stays in the picker, disabled, with the reason beside it.
  draft.value = {
    kind: pluginShareAvailable.value ? "plugin" : "core.proxy_user",
    pluginId: publishablePlugins.value[0]?.id ?? "",
    subscriptionId: "",
    proxyUserId: "",
    slug: "",
    defaultFormat: "",
    expiry: emptyExpiryForm(),
  };
  now.value = Date.now();
  publishOpen.value = true;
  void loadRecords();
  // Re-read once per opening, so a user created since the pane loaded is offered.
  void loadProxyUsers();
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
      expires_at: expiryCreateValue(draft.value.expiry, now.value),
    };
    const created = await api.subscriptionShares.create(body);
    toast.success(t("networking.shares.published", { slug: created.slug }));
    publishOpen.value = false;
    select(created.id);
    await Promise.all([sharesQuery.refresh(), routesQuery.refresh()]);
  } catch (error) {
    toast.error(describe(error, t("networking.shares.publishFailed")));
  } finally {
    publishing.value = false;
  }
}

// Changing the expiry of a share that already exists. Deliberately not part of
// rotate or delete: rotation mints a new URL and breaks every client holding the
// old one, while changing when a URL dies does not touch the URL at all.
const expiryOpen = ref(false);
const expirySaving = ref(false);
const expiryTarget = ref<SubscriptionShareView | null>(null);
const expiryDraft = ref<ExpiryForm>(emptyExpiryForm());

function openExpiry(share: SubscriptionShareView): void {
  expiryTarget.value = share;
  expiryDraft.value = expiryFormFor(share);
  now.value = Date.now();
  expiryOpen.value = true;
}

async function saveExpiry(): Promise<void> {
  const share = expiryTarget.value;
  if (!share || expiryFormError(expiryDraft.value, now.value)) return;
  expirySaving.value = true;
  try {
    await api.subscriptionShares.update(share.id, expiryUpdateBody(expiryDraft.value, now.value));
    toast.success(t("networking.shares.expiry.saved"));
    expiryOpen.value = false;
    await Promise.all([sharesQuery.refresh(), routesQuery.refresh()]);
  } catch (error) {
    toast.error(describe(error, t("networking.shares.expiry.saveFailed")));
  } finally {
    expirySaving.value = false;
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
    if (selectedId.value === share.id) select("");
    await Promise.all([sharesQuery.refresh(), routesQuery.refresh()]);
  } catch (error) {
    toast.error(describe(error, t("networking.shares.deleteFailed")));
  } finally {
    busyId.value = "";
  }
}

async function refreshSource(share: SubscriptionShareView): Promise<void> {
  if (!shareRefreshable(rendererState(share))) return;
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

/**
 * At xl the detail column sits beside the table, selected or not, and leaves
 * it about 700px. Format and Last rotated pushed Serves, with its
 * renderer-absent marker, out of view at that width, so at xl they leave the
 * table: both are in the detail, and below xl the detail stacks under a
 * full-width table that has room for them. They are hidden rather than
 * removed from the column list, so a sort on Last rotated survives, and they
 * are hidden whether or not a share is selected, so a click on a row does not
 * pull two columns out from under it.
 *
 * Slug and Serves carry `max-w-0`: in an auto-layout table a nowrap span
 * claims its whole text as the column's minimum, so the token path alone
 * held Slug at 460px and the table overflowed whatever else was hidden. A zero
 * max-width makes the two columns share what the fixed ones leave and lets
 * the truncation inside them actually truncate.
 */
const FOLDED_BESIDE_DETAIL = "xl:hidden";

const columns = computed<DataTableColumn<SubscriptionShareView>[]>(() => [
  { key: "slug", label: t("networking.shares.columns.slug"), sortable: true, searchable: true, class: "max-w-0" },
  {
    key: "state",
    label: t("networking.shares.columns.state"),
    sortable: true,
    filterable: true,
    class: "w-[7.5rem]",
    value: (row) => shareState(row),
  },
  {
    key: "source",
    label: t("networking.shares.columns.source"),
    sortable: true,
    searchable: true,
    filterAliases: ["plugin", "record"],
    class: "max-w-0",
    value: (row) => sourceLabel(row),
  },
  {
    key: "format",
    label: t("networking.shares.columns.format"),
    sortable: true,
    class: cn("w-[8rem]", FOLDED_BESIDE_DETAIL),
    value: (row) => row.default_format || "",
  },
  {
    key: "rotated",
    label: t("networking.shares.columns.rotated"),
    sortable: true,
    align: "right",
    class: cn("w-[9rem]", FOLDED_BESIDE_DETAIL),
    value: (row) => row.rotated_at || row.created_at,
  },
]);

// ── deep link from a plugin ────────────────────────────────────────────────

/**
 * The Sub-Store frame asks the host to navigate here with
 * ?create=1&for=<record>, today through the redirect from the retired path.
 * The dialog opens with that record already chosen, so the operator lands on a
 * decision instead of a blank form. The keys are consumed so a reload does not
 * reopen it, and the lens stays pinned so this pane stays mounted.
 */
async function applyDeepLink(): Promise<void> {
  if (!hasShareCreateDeepLink(route.query)) return;
  const name = shareCreateTarget(route.query);
  void router.replace({ query: withoutShareDeepLink(route.query) });
  openPublish();
  if (!name || !pluginShareAvailable.value) return;
  await nextTick();
  // The record may be identified by id or by name depending on the caller.
  const match = records.value.find((record) => record.id === name || record.name === name);
  draft.value.subscriptionId = match?.id ?? name;
  draft.value.slug = suggestShareSlug(match?.display_name || match?.name || name, shares.value.map((s) => s.slug));
}

onMounted(async () => {
  await Promise.all([sharesQuery.refresh(), pluginsQuery.refresh(), loadProxyUsers()]);
  await applyDeepLink();
});
watch(() => route.query, applyDeepLink);
</script>

<template>
  <section class="space-y-4">
    <PageHeader
      level="section"
      :title="$t('networking.shares.title')"
      :description="$t('networking.shares.description')"
    >
      <template #status>
        <FreshnessLabel :last-updated="sharesQuery.lastUpdated.value" />
      </template>
      <template #actions>
        <Button v-if="canAdmin" size="sm" @click="openPublish">
          <Plus class="size-4" aria-hidden="true" />
          {{ $t('networking.shares.publish') }}
        </Button>
      </template>
    </PageHeader>

    <!-- The single column below xl is minmax(0,1fr) too: an implicit auto track
         grows to the token path's unbreakable width and pushed the whole pane
         past a phone's edge. -->
    <div class="grid grid-cols-[minmax(0,1fr)] gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,420px)]">
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
        @row-select="select($event.id)"
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
          <Badge :variant="stateVariant[shareState(row)]">
            {{ $t('networking.shares.state.' + shareState(row)) }}
          </Badge>
        </template>

        <template #cell-source="{ row }">
          <div class="min-w-0">
            <span class="block truncate text-sm" :title="sourceLabel(row)">{{ sourceLabel(row) }}</span>
            <!-- Plugin absent, said on the row: the share exists, its renderer
                 does not, and the two facts read together. -->
            <span
              v-if="rendererState(row) === 'missing' || rendererState(row) === 'inactive'"
              class="mt-0.5 flex items-center gap-1 text-xs text-warning"
              :title="rendererReason(row)"
            >
              <PlugZap class="size-3 shrink-0" aria-hidden="true" />
              {{ $t(`platform.publishing.renderer.${rendererState(row)}`) }}
            </span>
          </div>
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
            <Badge :variant="stateVariant[shareState(selected)]">
              {{ $t('networking.shares.state.' + shareState(selected)) }}
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

            <!-- A dangling proxy user is one specific reason for a 404, and it
                 gets its own sentence in place of the general one. -->
            <div
              v-if="shareState(selected) === 'unresolved'"
              class="rounded-md border-l-2 border-destructive bg-muted/40 px-3 py-2 text-xs"
            >
              {{ $t('networking.shares.unresolvedHint') }}
            </div>
            <div
              v-else-if="!serving(selected)"
              class="rounded-md border-l-2 border-warning bg-muted/40 px-3 py-2 text-xs"
            >
              {{ $t('networking.shares.notServing') }}
            </div>

            <div
              v-if="rendererState(selected) === 'missing' || rendererState(selected) === 'inactive'"
              class="rounded-md border-l-2 border-warning bg-muted/40 px-3 py-2 text-xs"
            >
              <p class="font-medium">{{ $t(`platform.publishing.renderer.${rendererState(selected)}`) }}</p>
              <p class="mt-1 text-muted-foreground">{{ rendererReason(selected) }}</p>
              <RouterLink
                to="/platform/plugins"
                class="mt-1 inline-block rounded-sm text-primary outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
              >{{ $t('platform.publishing.renderer.openPlugins') }}</RouterLink>
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
                <!-- The same rule the routes table applies, so this badge cannot
                     say Serving under a callout saying the URL returns 404. -->
                <Badge :variant="selectedRouteState(record) === 'unresolved' ? 'destructive' : 'outline'">
                  {{ $t(`platform.publishing.state.${selectedRouteState(record)}`) }}
                </Badge>
                <Badge v-if="record.reserved" variant="outline" :title="$t('platform.publishing.reservedHint')">
                  {{ $t('platform.publishing.reserved') }}
                </Badge>
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
              <!-- Shown even when there is none: "no expiry row" and "expires next
                   week" look the same to someone scanning the panel, and only one
                   of them is safe to hand out. -->
              <div>
                <dt class="text-muted-foreground">{{ $t('networking.shares.expires') }}</dt>
                <dd v-if="selected.expires_at" :title="formatDateTime(selected.expires_at)">
                  {{ formatDateTime(selected.expires_at) }}
                  <span class="text-muted-foreground">· {{ formatRelativeTime(selected.expires_at) }}</span>
                </dd>
                <dd v-else class="text-muted-foreground">{{ $t('networking.shares.expiry.never') }}</dd>
              </div>
            </dl>
          </div>

          <div v-if="canAdmin" class="flex flex-wrap gap-2 border-t border-border p-4">
            <Button
              variant="outline"
              size="sm"
              :disabled="busyId === selected.id || !shareRefreshable(rendererState(selected))"
              :title="rendererReason(selected)"
              @click="refreshSource(selected)"
            >
              <RefreshCw :class="cn('size-4', busyId === selected.id && 'animate-spin')" aria-hidden="true" />
              {{ $t('networking.shares.refreshSource') }}
            </Button>
            <Button variant="outline" size="sm" :disabled="busyId === selected.id" @click="openExpiry(selected)">
              <CalendarClock class="size-4" aria-hidden="true" />
              {{ $t('networking.shares.expiry.change') }}
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
                <SelectItem value="plugin" :disabled="!pluginShareAvailable">{{ $t('networking.shares.kindPlugin') }}</SelectItem>
                <SelectItem value="core.proxy_user">{{ $t('networking.shares.kindProxyUser') }}</SelectItem>
              </SelectContent>
            </Select>
            <!-- Plugin absent: the option is there and disabled, and this is why. -->
            <p v-if="!pluginShareAvailable" class="flex items-start gap-1.5 text-xs text-muted-foreground">
              <PlugZap class="mt-0.5 size-3 shrink-0" aria-hidden="true" />
              {{ $t('platform.publishing.renderer.createUnavailable') }}
            </p>
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
            <!-- A choice from the users the server has, like the record picker
                 above. Only when the list could not be read does this fall
                 back to a typed id, and it says so: a picker that blocked on a
                 failed list would make one unreadable endpoint stop publishing. -->
            <template v-if="proxyUsersQuery.loading.value || proxyUsers">
              <Select v-model="draft.proxyUserId" :disabled="proxyUsersQuery.loading.value || !proxyUsers?.length">
                <SelectTrigger id="share-proxy-user">
                  <SelectValue
                    :placeholder="proxyUsersQuery.loading.value ? $t('common.state.loading') : $t('networking.shares.proxyUserPlaceholder')"
                  />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem v-for="user in proxyUsers" :key="user.id" :value="user.id">
                    <span>{{ user.name || user.id }}</span>
                    <span v-if="user.name && user.name !== user.id" class="ml-2 font-mono text-xs text-muted-foreground">{{ user.id }}</span>
                  </SelectItem>
                </SelectContent>
              </Select>
              <p v-if="!proxyUsersQuery.loading.value && !proxyUsers?.length" class="text-xs text-muted-foreground">
                {{ $t('networking.shares.noProxyUsers') }}
              </p>
            </template>
            <template v-else>
              <Input id="share-proxy-user" v-model="draft.proxyUserId" autocomplete="off" spellcheck="false" />
              <p class="text-xs text-muted-foreground">{{ $t('networking.shares.proxyUsersUnread') }}</p>
            </template>
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

          <ShareExpiryFields v-model="draft.expiry" id-prefix="publish" :now="now" />
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

    <!-- ── expiry ──────────────────────────────────────────────────────── -->
    <!-- Editing the expiry is not destructive, so it does not go through
         ConfirmDialog: nothing a client holds stops working because of it, and
         the URL is untouched. -->
    <Dialog v-model:open="expiryOpen">
      <DialogContent class="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{{ $t('networking.shares.expiry.dialogTitle', { slug: expiryTarget?.slug }) }}</DialogTitle>
          <DialogDescription>{{ $t('networking.shares.expiry.dialogDescription') }}</DialogDescription>
        </DialogHeader>

        <ShareExpiryFields v-model="expiryDraft" id-prefix="edit" :now="now" />

        <DialogFooter>
          <DialogClose as-child>
            <Button variant="outline">{{ $t('common.actions.cancel') }}</Button>
          </DialogClose>
          <Button :disabled="expirySaving || !!expiryFormError(expiryDraft, now)" @click="saveExpiry">
            <RefreshCw v-if="expirySaving" class="size-4 animate-spin" aria-hidden="true" />
            <CalendarClock v-else class="size-4" aria-hidden="true" />
            {{ $t('common.actions.save') }}
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
  </section>
</template>
