<script setup lang="ts">
/**
 * Publishing: what URL content is visible at, and who may read it, for every
 * origin this server serves from.
 *
 * The origin lens lives in the URL (`origin=all|kv|static|share`). `all` is the
 * plane as one table. `kv` and `static` narrow the table to that origin and
 * open its storage forms under it. `share` opens the share pane, which manages
 * the third origin whole: create, expiry, rotate, revoke, refresh, per-client
 * URLs. Shares were a Networking page of their own until DESIGN-PROGRAM-2026-09
 * §9 folded them in here; the old path redirects with its query.
 */
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Globe, Link2, RefreshCw, ShieldAlert, Trash2 } from "lucide-vue-next";
import { RouterLink, useRoute } from "vue-router";

import {
  api,
  type ProxyUserView,
  type PublishingRecord,
  type StorageKind,
  type SubscriptionShareView,
} from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { useRouteTab } from "@/composables/useRouteTab";
import { useAuthStore } from "@/stores/auth";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  PUBLISHING_DEFAULT_LENS,
  PUBLISHING_LENS_PARAM,
  type PublishingAccessMode,
  type PublishingLens,
  type RouteState,
  accessLegend,
  accessMode,
  arrivedFromWorkers,
  hasShareCreateDeepLink,
  originTarget,
  originTargetLabel,
  publishingPlaneEmpty,
  recordsForLens,
  routeLabel,
  routeState,
  sortRecords,
  unresolvedShareIds,
} from "./publishingModel";

import PageHeader from "@/components/common/PageHeader.vue";
import DataTable, { type DataTableColumn } from "@/components/common/DataTable.vue";
import PlaneGuide from "@/components/platform/PlaneGuide.vue";
import StorageAdminPanel from "@/components/platform/StorageAdminPanel.vue";
import PublishingSharesPane from "./PublishingSharesPane.vue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

const { t } = useI18n();
const auth = useAuthStore();
const route = useRoute();

// An old /platform/workers bookmark lands here. Saying so beats dropping the
// operator on a page they did not ask for and letting them work out why.
const fromWorkers = computed(() => arrivedFromWorkers(route.query));

// ── the lens ─────────────────────────────────────────────────────────────────
// Which lenses the operator may open is the server's answer, not a guess: an
// origin they cannot read is never offered as a tab, and a URL naming one
// resolves to the whole plane.
const allowedLenses = computed<PublishingLens[]>(() => {
  const lenses: PublishingLens[] = ["all"];
  if (auth.can("kv:admin") || auth.can("kv:read")) lenses.push("kv");
  if (auth.can("static:admin") || auth.can("static:read")) lenses.push("static");
  if (auth.can("proxy:admin")) lenses.push("share");
  return lenses;
});
const lensTab = useRouteTab<PublishingLens>(
  () => allowedLenses.value,
  () => PUBLISHING_DEFAULT_LENS,
  PUBLISHING_LENS_PARAM,
);
// A create deep link belongs to the share pane, whichever lens the URL named;
// the pane pins the lens when it consumes the link.
const lens = computed<PublishingLens>({
  get: () =>
    hasShareCreateDeepLink(route.query) && allowedLenses.value.includes("share") ? "share" : lensTab.value,
  set: (value) => {
    lensTab.value = value;
  },
});
const storageLens = computed<StorageKind | undefined>(() =>
  lens.value === "kv" || lens.value === "static" ? lens.value : undefined,
);

// ── the plane ────────────────────────────────────────────────────────────────
const recordsQuery = useAsyncData((signal) => api.publishing.records({ signal }));

const records = computed(() => sortRecords(recordsQuery.data.value?.records ?? []));
const lensRecords = computed(() => recordsForLens(records.value, lens.value));
const visibleOrigins = computed(() => recordsQuery.data.value?.origins ?? []);

// An empty table means three different things, and only two of them are worth
// distinguishing to the operator: nothing is published, or they are not allowed
// to look. The third is that the request failed, and saying "you lack the
// scopes" then would be a confident wrong answer over a failure. A failed or
// not-yet-returned load falls through to the table, which owns the error and
// loading states.
const loaded = computed(() => recordsQuery.data.value !== undefined && !recordsQuery.error.value);
const nothingVisible = computed(() => loaded.value && visibleOrigins.value.length === 0);

/** The guide opens on its own only while the plane the operator can see is empty. */
const planeEmpty = computed(() =>
  publishingPlaneEmpty({
    loaded: loaded.value,
    visibleOrigins: visibleOrigins.value,
    records: records.value,
  }),
);

/**
 * The share list, read here only to name plugin routes on the whole-plane
 * table the way the Shares lens names them, by slug. The pane keeps its own
 * polling query because it is unmounted whenever this table is on screen,
 * and it owns create, rotate and delete against that list. The list is read
 * by the callers who may see the share lens at all; anyone else sees the id.
 */
const canSeeShares = computed(() => auth.can("proxy:admin"));
const sharesQuery = useAsyncData<SubscriptionShareView[] | undefined>(
  async (signal) => (canSeeShares.value ? api.subscriptionShares.list({ signal }) : undefined),
);
const shares = computed(() => (sharesQuery.error.value ? undefined : sharesQuery.data.value));
const shareSlugById = computed(() =>
  shares.value ? new Map(shares.value.map((share) => [share.id, share.slug])) : undefined,
);

/**
 * The proxy users, read once like the share list, so a share route whose user
 * is gone is badged here the way the Shares lens badges the share. Without the
 * list (not allowed, not yet loaded, failed) nothing is called unresolved.
 */
const canReadProxyUsers = computed(() => auth.can("proxy:read"));
const proxyUsersQuery = useAsyncData<ProxyUserView[] | undefined>(
  async (signal) => (canReadProxyUsers.value ? (await api.proxy.users({ signal })).users : undefined),
);
const knownProxyUsers = computed(() => {
  const users = proxyUsersQuery.error.value ? undefined : proxyUsersQuery.data.value;
  return users ? new Set(users.map((user) => user.id)) : undefined;
});
const unresolvedShares = computed(() => unresolvedShareIds(shares.value, knownProxyUsers.value));

const sharesPane = ref<InstanceType<typeof PublishingSharesPane> | null>(null);
const refreshing = computed(() => recordsQuery.refreshing.value);

/** One Refresh for the page: the plane, and the share pane when it is open. */
async function refreshAll(): Promise<void> {
  await Promise.all([
    recordsQuery.refresh(),
    sharesQuery.refresh(),
    proxyUsersQuery.refresh(),
    sharesPane.value?.refresh(),
  ]);
}

const columns = computed<DataTableColumn<PublishingRecord>[]>(() => [
  { key: "route", label: t("platform.publishing.columnRoute"), searchable: true },
  { key: "origin", label: t("platform.publishing.columnOrigin"), sortable: true, searchable: true },
  { key: "target", label: t("platform.publishing.columnServes"), searchable: true },
  // "Who may read it" is half of what the plane is for, and the three origins
  // answer it three different ways: a KV route demands a storage token even on
  // GET, a static route is anonymous, and a share carries its bearer token in
  // the URL. Without the column the table presented all three as one kind of
  // thing.
  {
    key: "access",
    label: t("platform.publishing.columnAccess"),
    sortable: true,
    searchable: true,
    value: (record) => t(`platform.publishing.access.${accessMode(record)}`),
  },
  { key: "state", label: t("platform.publishing.columnState") },
]);

/**
 * The access column's own explanation, kept on the page rather than in a
 * pointer-only tooltip. The badge's title attribute sits on a span nothing can
 * focus, so tabbing the page goes from the search box straight into the bucket
 * form and never reaches it. The legend covers the modes on screen.
 */
const visibleAccessModes = computed(() => accessLegend(lensRecords.value));

// Anonymous is the one mode that reads as a warning: it is the only route
// anybody who knows the URL can fetch. The badge and the legend line share the
// rule so the same mode cannot be coloured two ways on one page.
function accessModeVariant(mode: PublishingAccessMode) {
  return mode === "anonymous" ? "warning" : "secondary";
}

function accessVariant(record: Pick<PublishingRecord, "origin">) {
  return accessModeVariant(accessMode(record));
}

function recordState(record: PublishingRecord): RouteState {
  return routeState(record, unresolvedShares.value);
}

function stateVariant(record: PublishingRecord) {
  switch (recordState(record)) {
    case "serving":
      return "default";
    case "expired":
    case "unresolved":
      return "destructive";
    default:
      return "secondary";
  }
}

// ── the guide's links land on a control ──────────────────────────────────────
// The router's scrollBehavior scrolls the window, and the document scrolls
// inside the layout's own scroller, so a hash has to be honoured here. A hash
// naming nothing on the page is a no-op.
function scrollToHash(): void {
  if (typeof document === "undefined" || !route.hash) return;
  const id = route.hash.slice(1);
  void nextTick(() => document.getElementById(id)?.scrollIntoView({ block: "start" }));
}
onMounted(scrollToHash);
watch(() => route.fullPath, scrollToHash);
</script>

<template>
  <div class="p-6 space-y-6">
    <PageHeader
      :title="$t('platform.publishing.title')"
      :description="$t('platform.publishing.description')"
    >
      <template #actions>
        <Button
          variant="outline"
          size="sm"
          :disabled="refreshing"
          @click="refreshAll"
        >
          <RefreshCw aria-hidden="true" :class="cn('size-4', refreshing && 'animate-spin')" />
          {{ $t('common.actions.refresh') }}
        </Button>
      </template>
    </PageHeader>

    <!-- Where Workers went, said once, to whoever followed an old link. -->
    <p
      v-if="fromWorkers"
      class="flex items-start gap-2 rounded-md border border-border bg-muted/30 p-3 text-sm text-muted-foreground"
    >
      <Trash2 aria-hidden="true" class="mt-0.5 size-4 shrink-0" />
      <span>{{ $t('platform.publishing.workersRemoved') }}</span>
    </p>

    <PlaneGuide
      page="publishing"
      :plane-empty="planeEmpty"
      :title="$t('platform.publishing.guide.title')"
      :what="$t('platform.publishing.guide.what')"
    />

    <!-- Which origin. One control, in the URL, so a lens is a link. -->
    <Tabs v-model="lens">
      <TabsList class="w-full sm:w-auto" :aria-label="$t('platform.publishing.lensLabel')">
        <TabsTrigger v-for="option in allowedLenses" :key="option" :value="option">
          {{ $t(`platform.publishing.lens.${option}`) }}
        </TabsTrigger>
      </TabsList>
    </Tabs>

    <!-- The share origin, managed whole. Its table is the share table, and the
         route each share answers on is read from the same records as the
         plane's table, so the two cannot disagree. -->
    <PublishingSharesPane v-if="lens === 'share'" ref="sharesPane" />

    <template v-else>
      <Card>
        <CardHeader>
          <CardTitle class="flex items-center gap-2">
            <Globe aria-hidden="true" class="size-4 text-muted-foreground" />
            {{ $t('platform.publishing.routesTitle') }}
          </CardTitle>
          <CardDescription>{{ $t('platform.publishing.routesDescription') }}</CardDescription>
        </CardHeader>
        <CardContent class="space-y-4">
          <p
            v-if="nothingVisible"
            class="flex items-start gap-2 rounded-md border border-border bg-muted/30 p-3 text-sm text-muted-foreground"
          >
            <ShieldAlert aria-hidden="true" class="mt-0.5 size-4 shrink-0" />
            {{ $t('platform.publishing.noOriginsVisible') }}
          </p>

          <DataTable
            v-else
            :columns="columns"
            :rows="lensRecords"
            :row-key="(record) => record.id"
            :loading="recordsQuery.loading.value"
            :error="recordsQuery.error.value"
            :page-size="25"
            searchable
            :search-placeholder="$t('platform.publishing.searchRoutes')"
            :empty-title="$t('platform.publishing.emptyTitle')"
            :empty-description="$t('platform.publishing.emptyDescription')"
            :no-match-title="$t('platform.shared.noMatchesTitle')"
            :no-match-description="$t('platform.shared.noMatchesDescription')"
            @retry="recordsQuery.refresh"
          >
            <template #cell-route="{ row }">
              <span class="font-mono text-xs">{{ routeLabel(row, $t('platform.publishing.anyHost')) }}</span>
              <!-- Reserved keeps its literal meaning: the route belongs to its
                   share and cannot be moved or deleted as a route. The share
                   itself is managed on the Shares lens. -->
              <Badge
                v-if="row.reserved"
                variant="outline"
                class="ml-2 align-middle text-[10px]"
                :title="$t('platform.publishing.reservedHint')"
              >
                {{ $t('platform.publishing.reserved') }}
              </Badge>
            </template>
            <template #cell-origin="{ row }">
              <span class="text-xs">{{ $t(`platform.publishing.origin.${row.origin}`) }}</span>
            </template>
            <template #cell-target="{ row }">
              <!-- Named by slug, as the Shares lens names it; the id stays on
                   the title and in the link. -->
              <RouterLink
                v-if="row.origin === 'plugin'"
                :to="{ path: '/platform/publishing', query: { origin: 'share', share: originTarget(row) } }"
                class="inline-flex items-center gap-1 rounded-sm font-mono text-xs text-primary outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
                :title="originTarget(row)"
              >
                <Link2 aria-hidden="true" class="size-3" />
                {{ originTargetLabel(row, shareSlugById) }}
              </RouterLink>
              <span v-else class="font-mono text-xs">{{ originTarget(row) }}</span>
            </template>
            <template #cell-access="{ row }">
              <Badge :variant="accessVariant(row)" :title="$t(`platform.publishing.accessHint.${accessMode(row)}`)">
                {{ $t(`platform.publishing.access.${accessMode(row)}`) }}
              </Badge>
            </template>
            <template #cell-state="{ row }">
              <Badge :variant="stateVariant(row)">
                {{ $t(`platform.publishing.state.${recordState(row)}`) }}
              </Badge>
              <span v-if="row.expires_at" class="ml-2 text-xs text-muted-foreground">
                {{ formatDateTime(row.expires_at) }}
              </span>
            </template>
          </DataTable>

          <!--
            What the Access column means, for every input method. Keyboard and
            touch operators cannot reach a title attribute, so the sentences the
            badges carry are also on the page, under the table they describe.
          -->
          <dl
            v-if="visibleAccessModes.length"
            class="mt-4 space-y-1.5 border-t border-border pt-3 text-xs text-muted-foreground"
          >
            <div class="font-medium text-foreground">{{ $t('platform.publishing.accessLegendTitle') }}</div>
            <div v-for="mode in visibleAccessModes" :key="mode" class="flex flex-wrap items-baseline gap-2">
              <dt>
                <Badge :variant="accessModeVariant(mode)" class="text-[10px]">
                  {{ $t(`platform.publishing.access.${mode}`) }}
                </Badge>
              </dt>
              <dd class="min-w-0 flex-1 leading-relaxed">{{ $t(`platform.publishing.accessHint.${mode}`) }}</dd>
            </div>
          </dl>
        </CardContent>
      </Card>

      <!--
        One "Publishing and access" block for the whole console, for the origin
        the lens names. It used to be rendered on the KV page and again on the
        Static page, which is what made publishing read as two unrelated
        features instead of one.
      -->
      <StorageAdminPanel v-if="storageLens" :key="storageLens" :kind="storageLens" />
    </template>
  </div>
</template>
