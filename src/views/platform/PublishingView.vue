<script setup lang="ts">
/**
 * Publishing (design 23, section 4.5): what URL serves what, who may read it,
 * what expires, and how to revoke it, for every origin this server serves
 * from.
 *
 * Four layers on `?view=`. Overview: attention for anonymous routes and
 * shares that lapse, then who can read what as the one picture. Routes: the
 * plane as one table, narrowed by origin on `?origin=` (a mode inside the
 * layer, as before); a route opens in the sheet on `?open=`, and the share
 * origin is the share pane, whose rows open the share in the same sheet.
 * Tokens and Buckets list the storage tokens and buckets across both kinds.
 * The create forms sit behind one Publish menu, each in a side sheet on the
 * layer the operator is on.
 *
 * The share pane is mounted on every layer (its table shows only on the share
 * origin), so a plugin route, an Overview attention item or the Publish menu
 * opens the share or its form over the current table: nothing rewrites
 * `?origin=` or changes the rows under the operator.
 *
 * Old links keep working: `?origin=`, `?share=` and the create link
 * Sub-Store's Publish action and attention item navigate to
 * (`?origin=share&create=1&for=<id>`) land on the Routes layer
 * (canonicalPublishingQuery), and the share pane consumes the create keys.
 *
 * Serving is the quiet state; Anonymous, the one mode anyone with the URL can
 * read, is the loud one. Deleting a binding and revoking a token break
 * something outside Lattice (design 23, 3.8): impact lines and a typed name.
 */
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "vue-sonner";
import { ChevronDown, Database, FolderPlus, Globe2, KeyRound, Link2, RefreshCw, Trash2 } from "lucide-vue-next";
import { RouterLink } from "vue-router";

import {
  api,
  type ProxyUserView,
  type PublishingRecord,
  type StorageBucket,
  type StorageKind,
  type StorageTokenView,
  type SubscriptionShareView,
} from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { useLayer } from "@/composables/useLayer";
import { useOwnedRoute } from "@/composables/useOwnedRoute";
import { useProof } from "@/composables/useProof";
import { useRouteOpen } from "@/composables/useRouteOpen";
import { useRouteTab } from "@/composables/useRouteTab";
import { useAuthStore } from "@/stores/auth";
import { formatDateTime, formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { proofReason } from "@/components/common/proofModel";
import {
  PUBLISHING_DEFAULT_LENS,
  PUBLISHING_LAYERS,
  PUBLISHING_LENS_PARAM,
  type PublishingAccessMode,
  type PublishingLayer,
  type PublishingLens,
  type RouteState,
  accessMode,
  arrivedFromWorkers,
  canonicalPublishingQuery,
  originTarget,
  originTargetLabel,
  publishingPlaneEmpty,
  recordsForLens,
  routeLabel,
  routeState,
  sortRecords,
  unresolvedShareIds,
} from "./publishingModel";
import { publishedState } from "./publishedModel";

import PageHeader from "@/components/common/PageHeader.vue";
import ProofLine, { type ProofSegment } from "@/components/common/ProofLine.vue";
import AttentionList, { type AttentionItem } from "@/components/common/AttentionList.vue";
import LayerTabs, { type LayerTab } from "@/components/common/LayerTabs.vue";
import DataTable, { type DataTableColumn } from "@/components/common/DataTable.vue";
import ObjectSheet from "@/components/common/ObjectSheet.vue";
import RowMenu, { type RowMenuItem } from "@/components/common/RowMenu.vue";
import ConfirmDialog from "@/components/common/ConfirmDialog.vue";
import PlaneGuide from "@/components/platform/PlaneGuide.vue";
import StorageCreateSheet, { type StorageCreateMode } from "@/components/platform/StorageCreateSheet.vue";
import PublishingSharesPane from "./PublishingSharesPane.vue";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const { t } = useI18n();
const auth = useAuthStore();
const owned = useOwnedRoute();

// An old /platform/workers bookmark lands here. Saying so beats dropping the
// operator on a page they did not ask for and letting them work out why.
const fromWorkers = computed(() => arrivedFromWorkers(owned.query()));

/* ------------------------------------------------------------------ */
/* Scopes                                                              */
/* ------------------------------------------------------------------ */

const KINDS: StorageKind[] = ["kv", "static"];
const readKinds = computed(() => KINDS.filter((kind) => auth.can(`${kind}:read`) || auth.can(`${kind}:admin`)));
const adminKinds = computed(() => KINDS.filter((kind) => auth.can(`${kind}:admin`)));
const canSeeShares = computed(() => auth.can("proxy:admin"));
const canReadProxyUsers = computed(() => auth.can("proxy:read"));

/* ------------------------------------------------------------------ */
/* Layers, lens and old links                                          */
/* ------------------------------------------------------------------ */

const allowedLayers = computed<PublishingLayer[]>(() =>
  PUBLISHING_LAYERS.filter((layer) => {
    if (layer === "tokens") return adminKinds.value.length > 0;
    if (layer === "buckets") return readKinds.value.length > 0;
    return true;
  }),
);
const layer = useLayer<PublishingLayer>(() => allowedLayers.value, () => "overview");

/** Old lens, selection and create links land on Routes, once, with replace. */
watch(
  () => owned.query(),
  (query) => {
    if (!owned.owns()) return;
    const canonical = canonicalPublishingQuery(query);
    if (canonical) owned.replace(canonical);
  },
  { immediate: true },
);

// Which origins the operator may narrow to is the server's answer, not a
// guess: an origin they cannot read is never offered, and a URL naming one
// resolves to the whole plane.
const allowedLenses = computed<PublishingLens[]>(() => {
  const lenses: PublishingLens[] = ["all"];
  if (readKinds.value.includes("kv")) lenses.push("kv");
  if (readKinds.value.includes("static")) lenses.push("static");
  if (canSeeShares.value) lenses.push("share");
  return lenses;
});
const lens = useRouteTab<PublishingLens>(() => allowedLenses.value, () => PUBLISHING_DEFAULT_LENS, PUBLISHING_LENS_PARAM);

/* ------------------------------------------------------------------ */
/* Reads                                                               */
/* ------------------------------------------------------------------ */

const recordsQuery = useAsyncData((signal) => api.publishing.records({ signal }), { pollInterval: 30_000 });
const records = computed(() => sortRecords(recordsQuery.data.value?.records ?? []));
const visibleOrigins = computed(() => recordsQuery.data.value?.origins ?? []);
const loaded = computed(() => recordsQuery.data.value !== undefined && !recordsQuery.error.value);
const nothingVisible = computed(() => loaded.value && visibleOrigins.value.length === 0);
const planeEmpty = computed(() =>
  publishingPlaneEmpty({ loaded: loaded.value, visibleOrigins: visibleOrigins.value, records: records.value }),
);

/**
 * The share list, for the overview's attention and to name plugin routes by
 * slug. The share pane keeps its own query because it owns create, rotate
 * and delete against that list.
 */
const sharesQuery = useAsyncData<SubscriptionShareView[] | undefined>(
  async (signal) => (canSeeShares.value ? api.subscriptionShares.list({ signal }) : undefined),
  { pollInterval: 30_000 },
);
const shares = computed(() => (sharesQuery.error.value ? undefined : sharesQuery.data.value));
const shareSlugById = computed(() => (shares.value ? new Map(shares.value.map((share) => [share.id, share.slug])) : undefined));

const proxyUsersQuery = useAsyncData<ProxyUserView[] | undefined>(async (signal) =>
  canReadProxyUsers.value ? (await api.proxy.users({ signal })).users : undefined,
);
const knownProxyUsers = computed(() => {
  const users = proxyUsersQuery.error.value ? undefined : proxyUsersQuery.data.value;
  return users ? new Set(users.map((user) => user.id)) : undefined;
});
const unresolvedShares = computed(() => unresolvedShareIds(shares.value, knownProxyUsers.value));

type KindToken = StorageTokenView & { kind: StorageKind };
type KindBucket = StorageBucket & { kind: StorageKind };

const tokensQuery = useAsyncData<KindToken[]>(
  async () => {
    const lists = await Promise.all(
      adminKinds.value.map((kind) => api.storage.tokens(kind).then((r) => r.tokens.map((token) => ({ ...token, kind })))),
    );
    return lists.flat().sort((a, b) => a.name.localeCompare(b.name));
  },
  { pollInterval: 30_000, immediate: adminKinds.value.length > 0 },
);
const tokens = computed(() => tokensQuery.data.value ?? []);
const liveTokens = computed(() => tokens.value.filter((token) => !token.revoked_at));

const bucketsQuery = useAsyncData<KindBucket[]>(
  async () => {
    const lists = await Promise.all(
      readKinds.value.map((kind) => api.storage.buckets(kind).then((r) => r.buckets.map((bucket) => ({ ...bucket, kind })))),
    );
    return lists.flat().sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
  },
  { immediate: readKinds.value.length > 0 },
);
const buckets = computed(() => bucketsQuery.data.value ?? []);

const sharesPane = ref<InstanceType<typeof PublishingSharesPane> | null>(null);

async function refreshAll(): Promise<void> {
  await Promise.all([
    recordsQuery.refresh(),
    canSeeShares.value ? sharesQuery.refresh() : Promise.resolve(),
    canReadProxyUsers.value ? proxyUsersQuery.refresh() : Promise.resolve(),
    adminKinds.value.length ? tokensQuery.refresh() : Promise.resolve(),
    readKinds.value.length ? bucketsQuery.refresh() : Promise.resolve(),
    sharesPane.value?.refresh(),
  ]);
}

/* ------------------------------------------------------------------ */
/* State words                                                         */
/* ------------------------------------------------------------------ */

function recordState(record: PublishingRecord): RouteState {
  return routeState(record, unresolvedShares.value);
}

const STATE_TONE: Record<RouteState, string> = {
  serving: "text-muted-foreground",
  disabled: "text-muted-foreground",
  expired: "text-destructive",
  unresolved: "text-destructive",
};

/** Anonymous is the one mode that reads as a warning; the others are plain words. */
function accessClass(mode: PublishingAccessMode): string {
  return mode === "anonymous" ? "text-warning-text font-medium" : "text-muted-foreground";
}

function recordUrl(record: PublishingRecord): string {
  return routeLabel(record, t("platform.publishing.anyHost"));
}

function shareOf(record: PublishingRecord): string {
  return record.share_id || originTarget(record);
}

/* ------------------------------------------------------------------ */
/* Head: proof line and attention                                      */
/* ------------------------------------------------------------------ */

// The routes are the page's subject. A failed share or token read is named in
// its own segment, so it never wipes the counts the routes read holds.
const proof = useProof(recordsQuery);

const anonymous = computed(() => records.value.filter((record) => accessMode(record) === "anonymous" && recordState(record) === "serving"));

const shareStates = computed(() =>
  (shares.value ?? []).map((share) => ({ share, state: publishedState(share, Date.now(), knownProxyUsers.value) })),
);

const proofSegments = computed<ProofSegment[]>(() => {
  const n = records.value.length;
  const parts: ProofSegment[] = [{ key: "routes", text: t("platform.publishingPage.proof.routes", { n }, n), to: { query: { view: "routes" } } }];
  if (anonymous.value.length) {
    parts.push({ key: "anonymous", text: t("platform.publishingPage.proof.anonymous", { n: anonymous.value.length }), tone: "warning", to: { query: { view: "routes", origin: "static" } } });
  }
  if (canSeeShares.value && !shares.value && sharesQuery.error.value) {
    parts.push({ key: "shares", text: t("platform.publishingPage.proof.sharesUnread", { reason: proofReason(sharesQuery.error.value) }), tone: "warning" });
  }
  if (shares.value) {
    parts.push({ key: "shares", text: t("platform.publishingPage.proof.shares", { n: shares.value.length }, shares.value.length) });
    const lapsing = shareStates.value.filter((entry) => entry.state === "expiring" || entry.state === "expired").length;
    if (lapsing) parts.push({ key: "lapsing", text: t("platform.publishingPage.proof.lapsing", { n: lapsing }), tone: "warning" });
  }
  if (tokensQuery.data.value !== undefined) {
    parts.push({ key: "tokens", text: t("platform.publishingPage.proof.tokens", { n: liveTokens.value.length }, liveTokens.value.length), to: { query: { view: "tokens" } } });
  } else if (tokensQuery.error.value) {
    parts.push({ key: "tokens", text: t("platform.publishingPage.proof.tokensUnread", { reason: proofReason(tokensQuery.error.value) }), tone: "warning" });
  }
  return parts;
});

const sheet = useRouteOpen();

/** After a change in the share pane: the page's share list and routes, read again. */
function reloadShares(): Promise<unknown> {
  return Promise.all([sharesQuery.refresh(), recordsQuery.refresh()]);
}

/** Opens a share in the pane's sheet over whatever layer is showing. */
function openShare(id: string, opener?: HTMLElement | null): void {
  sharesPane.value?.openShare(id, opener);
}

const attention = computed<AttentionItem[]>(() => {
  const items: AttentionItem[] = [];
  for (const { share, state } of shareStates.value) {
    const action = { label: t("platform.publishingPage.attention.open"), run: () => openShare(share.id) };
    if (state === "expired") {
      items.push({
        key: `share-expired:${share.id}`,
        tone: "danger",
        claim: t("platform.publishingPage.attention.shareExpired", { slug: share.slug }),
        proof: t("platform.publishingPage.attention.shareExpiredProof", { when: formatDateTime(share.expires_at) }),
        action,
      });
    } else if (state === "unresolved") {
      items.push({
        key: `share-unresolved:${share.id}`,
        tone: "danger",
        claim: t("platform.publishingPage.attention.shareUnresolved", { slug: share.slug }),
        proof: t("networking.shares.unresolvedHint"),
        action,
      });
    } else if (state === "expiring") {
      items.push({
        key: `share-expiring:${share.id}`,
        tone: "warning",
        claim: t("platform.publishingPage.attention.shareExpiring", { slug: share.slug, when: formatRelativeTime(share.expires_at!) }),
        // The date, not the path: a share's path carries its bearer token.
        proof: t("platform.publishingPage.attention.shareExpiringProof", { when: formatDateTime(share.expires_at) }),
        action,
      });
    }
  }
  for (const record of records.value) {
    if (record.origin === "plugin") continue;
    if (recordState(record) === "expired") {
      items.push({
        key: `route-expired:${record.id}`,
        tone: "danger",
        claim: t("platform.publishingPage.attention.routeExpired", { url: recordUrl(record) }),
        proof: formatDateTime(record.expires_at),
        action: { label: t("platform.publishingPage.attention.open"), to: { query: { view: "routes", open: record.id } } },
      });
    }
  }
  for (const record of anonymous.value) {
    items.push({
      key: `anonymous:${record.id}`,
      tone: "warning",
      claim: t("platform.publishingPage.attention.anonymous", { url: recordUrl(record) }),
      proof: t("platform.publishingPage.attention.anonymousProof", { bucket: record.bucket }),
      action: { label: t("platform.publishingPage.attention.open"), to: { query: { view: "routes", open: record.id } } },
    });
  }
  return items;
});

/** The overview's picture: who can read what, one line per access mode. */
const ACCESS_LENS: Record<PublishingAccessMode, PublishingLens> = {
  anonymous: "static",
  storage_token: "kv",
  share_token: "share",
  unknown: "all",
};
const accessGroups = computed(() => {
  const order: PublishingAccessMode[] = ["anonymous", "storage_token", "share_token", "unknown"];
  return order
    .map((mode) => ({ mode, records: records.value.filter((record) => accessMode(record) === mode) }))
    .filter((group) => group.records.length > 0);
});

/* ------------------------------------------------------------------ */
/* Layer tabs                                                          */
/* ------------------------------------------------------------------ */

const layerTabs = computed<LayerTab<PublishingLayer>[]>(() =>
  allowedLayers.value.map((value) => ({
    value,
    label: t(`platform.publishingPage.layers.${value}`),
    count:
      value === "routes" && recordsQuery.data.value !== undefined
        ? records.value.length
        : value === "tokens" && tokensQuery.data.value !== undefined
          ? liveTokens.value.length
          : value === "buckets" && bucketsQuery.data.value !== undefined
            ? buckets.value.length
            : undefined,
  })),
);

/* ------------------------------------------------------------------ */
/* Routes layer                                                        */
/* ------------------------------------------------------------------ */

const lensRecords = computed(() => recordsForLens(records.value, lens.value));
const lensCounts = computed<Record<PublishingLens, number>>(() => ({
  all: records.value.length,
  kv: recordsForLens(records.value, "kv").length,
  static: recordsForLens(records.value, "static").length,
  share: shares.value?.length ?? recordsForLens(records.value, "share").length,
}));

const columns = computed<DataTableColumn<PublishingRecord>[]>(() => [
  { key: "route", label: t("platform.publishing.columnRoute"), searchable: true, value: (record) => recordUrl(record) },
  { key: "origin", label: t("platform.publishing.columnOrigin"), sortable: true, value: (record) => t(`platform.publishing.origin.${record.origin}`) },
  { key: "target", label: t("platform.publishing.columnServes"), searchable: true, value: (record) => originTargetLabel(record, shareSlugById.value) },
  {
    key: "access",
    label: t("platform.publishing.columnAccess"),
    sortable: true,
    searchable: true,
    value: (record) => t(`platform.publishing.access.${accessMode(record)}`),
  },
  { key: "state", label: t("platform.publishing.columnState"), sortable: true, value: (record) => recordState(record) },
  { key: "actions", label: "", class: "w-12", pin: "end" },
]);

/**
 * A share route opens its share and a storage route its own sheet, both over
 * this table: the origin filter stays what the operator chose, and Escape
 * returns focus to this row.
 */
function openRecord(record: PublishingRecord, el: HTMLElement): void {
  // Without proxy:admin the share cannot be opened, so the route opens its own sheet.
  if (record.origin === "plugin" && canSeeShares.value) {
    openShare(shareOf(record), el);
    return;
  }
  sheet.open(record.id, el);
}

/** Whether `?open=` names a share, which the share pane's sheet shows instead of the route sheet. */
// The same list the share pane decides from (kept across a failed refresh), so
// one ?open= never opens both sheets.
const openIsShare = computed(() => !!sheet.openId.value && !!sharesQuery.data.value?.some((share) => share.id === sheet.openId.value));
/** The row to highlight: a share's route row when the share is open. */
const activeRouteId = computed(() => {
  const id = sheet.openId.value;
  if (!id || !openIsShare.value) return id;
  return records.value.find((record) => record.origin === "plugin" && shareOf(record) === id)?.id ?? null;
});

function canDeleteBinding(record: PublishingRecord): boolean {
  return (record.origin === "kv" || record.origin === "static") && !record.reserved && auth.can(`${record.origin}:admin`);
}

function recordMenu(record: PublishingRecord): RowMenuItem[] {
  if (record.origin === "plugin") {
    return [{ key: "share", label: t("platform.publishingPage.openShare"), icon: Link2, hidden: !canSeeShares.value, run: () => openShare(shareOf(record)) }];
  }
  return [
    {
      key: "store",
      label: t("platform.publishingPage.openBucket", { bucket: record.bucket }),
      icon: Database,
      to: { path: "/platform/store", query: { kind: record.origin, bucket: record.bucket } },
    },
    {
      key: "delete",
      label: t("platform.storage.deleteBinding"),
      icon: Trash2,
      danger: true,
      hidden: !canDeleteBinding(record),
      run: () => (pendingBinding.value = record),
    },
  ];
}

const openRecordRow = computed(() =>
  layer.value === "routes" && lens.value !== "share" ? records.value.find((record) => record.id === sheet.openId.value) : undefined,
);
const routeSheetOpen = computed(() => layer.value === "routes" && lens.value !== "share" && !!sheet.openId.value && !openIsShare.value);
const routeSheetState = computed(() => {
  if (openRecordRow.value) return recordsQuery.error.value ? ("stale" as const) : ("ready" as const);
  if (recordsQuery.data.value === undefined) return recordsQuery.error.value ? ("gone" as const) : ("loading" as const);
  return "gone" as const;
});

/* ------------------------------------------------------------------ */
/* Deleting a binding: a live URL goes offline (design 23, 3.8)        */
/* ------------------------------------------------------------------ */

const pendingBinding = ref<PublishingRecord | null>(null);
const deletingBinding = ref(false);

function bindingAddress(record: PublishingRecord): string {
  return record.path_prefix ? `${record.hostname}/${record.path_prefix}` : record.hostname;
}

const bindingImpact = computed(() => {
  const record = pendingBinding.value;
  if (!record) return [];
  return [
    t("platform.storage.deleteBindingImpactUrl", { url: `https://${bindingAddress(record)}`, bucket: record.bucket }),
    t("platform.storage.deleteBindingImpactKept"),
  ];
});

// The dialog closes only when the delete succeeded. On failure it stays open
// with the typed address, beside the error toast, so the operator can retry.
async function confirmDeleteBinding(): Promise<void> {
  const record = pendingBinding.value;
  if (!record) return;
  deletingBinding.value = true;
  try {
    await api.storage.deleteBinding(record.origin as StorageKind, record.id);
    toast.success(t("platform.storage.bindingDeleted"));
    pendingBinding.value = null;
    if (sheet.openId.value === record.id) sheet.close();
    void recordsQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("platform.storage.bindingDeleteFailed"));
  } finally {
    deletingBinding.value = false;
  }
}

/* ------------------------------------------------------------------ */
/* Tokens layer: revoking breaks every client holding it               */
/* ------------------------------------------------------------------ */

const tokenColumns = computed<DataTableColumn<KindToken>[]>(() => [
  { key: "name", label: t("platform.storage.colToken"), sortable: true, searchable: true },
  { key: "kind", label: t("platform.publishingPage.colKind"), sortable: true, value: (token) => t(`platform.publishing.origin.${token.kind}`) },
  { key: "access", label: t("platform.storage.colAccess"), sortable: true },
  { key: "buckets", label: t("platform.storage.colBuckets"), searchable: true, value: (token) => token.buckets?.join(", ") ?? "" },
  { key: "last_used", label: t("platform.storage.colLastUsed"), sortable: true, value: (token) => token.last_used_at ?? "" },
  { key: "actions", label: "", class: "w-12", pin: "end" },
]);

const pendingToken = ref<KindToken | null>(null);
const revokingToken = ref(false);

function tokenMenu(token: KindToken): RowMenuItem[] {
  return [
    {
      key: "revoke",
      label: t("platform.storage.revokeToken"),
      icon: Trash2,
      danger: true,
      disabled: !!token.revoked_at,
      reason: token.revoked_at ? t("platform.storage.revoked") : undefined,
      run: () => (pendingToken.value = token),
    },
  ];
}

const tokenImpact = computed(() => {
  const token = pendingToken.value;
  if (!token) return [];
  return [
    t("platform.storage.revokeTokenImpactClients", { name: token.name, access: token.access, buckets: token.buckets?.join(", ") || "-" }),
    t("platform.storage.revokeTokenImpactFinal"),
    token.last_used_at
      ? t("platform.storage.revokeTokenImpactUsed", { time: formatDateTime(token.last_used_at) })
      : t("platform.storage.revokeTokenImpactUnused"),
  ];
});

async function confirmRevokeToken(): Promise<void> {
  const token = pendingToken.value;
  if (!token) return;
  revokingToken.value = true;
  try {
    await api.storage.revokeToken(token.kind, token.id);
    toast.success(t("platform.storage.tokenRevoked"));
    pendingToken.value = null;
    void tokensQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("platform.storage.tokenRevokeFailed"));
  } finally {
    revokingToken.value = false;
  }
}

/* ------------------------------------------------------------------ */
/* Buckets layer                                                       */
/* ------------------------------------------------------------------ */

const bucketColumns = computed<DataTableColumn<KindBucket>[]>(() => [
  { key: "name", label: t("platform.storage.colBucket"), sortable: true, searchable: true },
  { key: "kind", label: t("platform.publishingPage.colKind"), sortable: true, value: (bucket) => t(`platform.publishing.origin.${bucket.kind}`) },
  // A column every row leaves blank is noise; it shows once one bucket has a description.
  ...(buckets.value.some((bucket) => bucket.description)
    ? [{ key: "description", label: t("platform.storage.colDescription"), searchable: true, value: (bucket: KindBucket) => bucket.description ?? "" }]
    : []),
  { key: "routes", label: t("platform.publishingPage.colRoutes"), align: "right", sortable: true, value: (bucket) => routesForBucket(bucket).length },
  { key: "updated", label: t("platform.storage.colUpdated"), sortable: true, value: (bucket) => bucket.updated_at },
  { key: "actions", label: "", class: "w-12", pin: "end" },
]);

/* A bucket's page is Store; its menu goes there, as a route row's does, instead of a chevron row. */
function bucketMenu(bucket: KindBucket): RowMenuItem[] {
  return [
    {
      key: "store",
      label: t("platform.publishingPage.openBucket", { bucket: bucket.name }),
      icon: Database,
      to: { path: "/platform/store", query: { kind: bucket.kind, bucket: bucket.name } },
    },
  ];
}

function routesForBucket(bucket: KindBucket): PublishingRecord[] {
  return records.value.filter((record) => record.origin === bucket.kind && record.bucket === bucket.name);
}

/* ------------------------------------------------------------------ */
/* Publish menu                                                        */
/* ------------------------------------------------------------------ */

const createMode = ref<StorageCreateMode | null>(null);

function onCreated(_kind: StorageKind, mode: StorageCreateMode): void {
  if (mode === "binding") void recordsQuery.refresh();
  if (mode === "token") void tokensQuery.refresh();
  if (mode === "bucket") void bucketsQuery.refresh();
}

/** The share form is the share pane's, in a side sheet on the current layer like the other creates. */
function publishShare(): void {
  sharesPane.value?.openPublish();
}

const canPublishAnything = computed(() => adminKinds.value.length > 0 || canSeeShares.value);
</script>

<template>
  <div class="space-y-5 p-4 sm:p-6">
    <PageHeader :title="$t('platform.publishing.title')">
      <template #description>
        <p class="text-sm text-muted-foreground">{{ $t('platform.publishing.description') }}</p>
        <ProofLine v-bind="proof" :segments="proofSegments" @retry="refreshAll" />
      </template>
      <template #actions>
        <Button variant="outline" size="sm" :disabled="recordsQuery.refreshing.value" @click="refreshAll">
          <RefreshCw aria-hidden="true" :class="cn('size-4', recordsQuery.refreshing.value && 'animate-spin')" />
          {{ $t('common.actions.refresh') }}
        </Button>
        <DropdownMenu v-if="canPublishAnything">
          <DropdownMenuTrigger as-child>
            <Button size="sm" data-testid="publish-menu">
              {{ $t('platform.publishingPage.publish') }}
              <ChevronDown aria-hidden="true" class="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" class="min-w-56">
            <DropdownMenuItem v-if="canSeeShares" @select="publishShare">
              <Link2 aria-hidden="true" />
              {{ $t('platform.publishingPage.menu.share') }}
            </DropdownMenuItem>
            <template v-if="adminKinds.length">
              <DropdownMenuItem @select="createMode = 'binding'">
                <Globe2 aria-hidden="true" />
                {{ $t('platform.publishingPage.menu.binding') }}
              </DropdownMenuItem>
              <DropdownMenuItem @select="createMode = 'token'">
                <KeyRound aria-hidden="true" />
                {{ $t('platform.publishingPage.menu.token') }}
              </DropdownMenuItem>
              <DropdownMenuItem @select="createMode = 'bucket'">
                <FolderPlus aria-hidden="true" />
                {{ $t('platform.publishingPage.menu.bucket') }}
              </DropdownMenuItem>
            </template>
          </DropdownMenuContent>
        </DropdownMenu>
      </template>
    </PageHeader>

    <!-- Where Workers went, said once, to whoever followed an old link. -->
    <p v-if="fromWorkers" class="flex items-start gap-2 rounded-md border border-border bg-muted/30 p-3 text-sm text-muted-foreground">
      <Trash2 aria-hidden="true" class="mt-0.5 size-4 shrink-0" />
      <span>{{ $t('platform.publishing.workersRemoved') }}</span>
    </p>

    <LayerTabs v-model="layer" :tabs="layerTabs" :label="$t('platform.publishingPage.layersLabel')" />

    <!-- Overview: what needs attention, then who can read what. -->
    <template v-if="layer === 'overview'">
      <AttentionList :items="attention" />

      <p v-if="nothingVisible" class="rounded-md border border-border bg-muted/30 p-3 text-sm text-muted-foreground">
        {{ $t('platform.publishing.noOriginsVisible') }}
      </p>
      <section v-else-if="accessGroups.length" class="space-y-2" aria-labelledby="publishing-access-heading">
        <h2 id="publishing-access-heading" class="text-sm font-medium">{{ $t('platform.publishingPage.whoReads') }}</h2>
        <ul class="divide-y divide-border rounded-md border border-border" data-testid="access-picture">
          <li v-for="group in accessGroups" :key="group.mode" class="grid grid-cols-1 gap-x-4 gap-y-1 px-3 py-2.5 text-sm sm:grid-cols-[12rem_minmax(0,1fr)_auto] sm:items-baseline">
            <span :class="accessClass(group.mode)">
              {{ $t(`platform.publishing.access.${group.mode}`) }}
              <span class="font-mono text-xs tabular-nums text-muted-foreground">{{ group.records.length }}</span>
            </span>
            <span class="min-w-0 text-xs text-muted-foreground">
              <span class="block">{{ $t(`platform.publishing.accessHint.${group.mode}`) }}</span>
              <span class="block truncate font-mono text-foreground">{{ group.records.slice(0, 3).map(recordUrl).join(', ') }}{{ group.records.length > 3 ? ` +${group.records.length - 3}` : '' }}</span>
            </span>
            <RouterLink
              :to="{ query: { view: 'routes', ...(ACCESS_LENS[group.mode] === 'all' ? {} : { origin: ACCESS_LENS[group.mode] }) } }"
              class="text-xs text-primary underline-offset-4 hover:underline"
            >{{ $t('platform.publishingPage.showRoutes') }}</RouterLink>
          </li>
        </ul>
      </section>

      <PlaneGuide
        page="publishing"
        :plane-empty="planeEmpty"
        :title="$t('platform.publishing.guide.title')"
        :what="$t('platform.publishing.guide.what')"
      />
    </template>

    <!-- Routes: the plane, narrowed by origin; the share origin is the share pane. -->
    <template v-else-if="layer === 'routes'">
      <div class="flex flex-wrap items-center gap-1" role="group" :aria-label="$t('platform.publishing.lensLabel')">
        <Button
          v-for="option in allowedLenses"
          :key="option"
          size="sm"
          type="button"
          :variant="lens === option ? 'secondary' : 'ghost'"
          :aria-pressed="lens === option"
          @click="lens = option"
        >
          {{ $t(`platform.publishing.lens.${option}`) }}
          <span class="font-mono text-xs tabular text-muted-foreground">{{ lensCounts[option] }}</span>
        </Button>
      </div>

      <template v-if="lens !== 'share'">
        <p v-if="nothingVisible" class="rounded-md border border-border bg-muted/30 p-3 text-sm text-muted-foreground">
          {{ $t('platform.publishing.noOriginsVisible') }}
        </p>
        <DataTable
          v-else
          state-key="routes"
          :columns="columns"
          :rows="lensRecords"
          :row-key="(record) => record.id"
          :loading="recordsQuery.loading.value"
          :error="recordsQuery.error.value"
          :has-data="recordsQuery.data.value !== undefined"
          :page-size="25"
          :searchable="lensRecords.length > 6"
          :expression-filter="false"
          :search-placeholder="$t('platform.publishing.searchRoutes')"
          :row-click="openRecord"
          :active-row-id="activeRouteId"
          :show-summary="false"
          :empty-title="$t('platform.publishing.emptyTitle')"
          :empty-description="$t('platform.publishing.emptyDescription')"
          :no-match-title="$t('platform.shared.noMatchesTitle')"
          :no-match-description="$t('platform.shared.noMatchesDescription')"
          @retry="recordsQuery.refresh"
        >
          <template #cell-route="{ row }">
            <span class="whitespace-nowrap font-mono text-xs">{{ recordUrl(row) }}</span>
            <span v-if="row.reserved" class="ml-2 text-xs text-muted-foreground" :title="$t('platform.publishing.reservedHint')">{{ $t('platform.publishing.reserved') }}</span>
          </template>
          <template #cell-origin="{ row }">
            <span class="text-xs">{{ $t(`platform.publishing.origin.${row.origin}`) }}</span>
          </template>
          <template #cell-target="{ row }">
            <span class="whitespace-nowrap font-mono text-xs" :title="originTarget(row)">{{ originTargetLabel(row, shareSlugById) }}</span>
          </template>
          <template #cell-access="{ row }">
            <span :class="cn('whitespace-nowrap text-xs', accessClass(accessMode(row)))" :title="$t(`platform.publishing.accessHint.${accessMode(row)}`)">
              {{ $t(`platform.publishing.access.${accessMode(row)}`) }}
            </span>
          </template>
          <template #cell-state="{ row }">
            <span :class="cn('whitespace-nowrap text-xs', STATE_TONE[recordState(row)])">{{ $t(`platform.publishing.state.${recordState(row)}`) }}</span>
            <span v-if="row.expires_at" class="block text-xs text-muted-foreground">{{ formatDateTime(row.expires_at) }}</span>
          </template>
          <template #cell-actions="{ row }">
            <RowMenu :name="recordUrl(row)" :items="recordMenu(row)" />
          </template>
        </DataTable>
      </template>
    </template>

    <!-- Tokens: every storage token across both kinds. -->
    <DataTable
      v-else-if="layer === 'tokens'"
      state-key="tokens"
      :columns="tokenColumns"
      :rows="tokens"
      :row-key="(token) => `${token.kind}:${token.id}`"
      :loading="tokensQuery.loading.value"
      :error="tokensQuery.error.value"
      :has-data="tokensQuery.data.value !== undefined"
      :searchable="tokens.length > 6"
      :expression-filter="false"
      :show-summary="false"
      :empty-title="$t('platform.storage.noTokens')"
      :empty-description="$t('platform.storage.noTokensDescription')"
      @retry="tokensQuery.refresh"
    >
      <template #empty>
        <div class="space-y-3 rounded-xl border border-dashed border-border p-6 text-center">
          <p class="text-sm font-medium">{{ $t('platform.storage.noTokens') }}</p>
          <p class="mx-auto max-w-prose text-sm text-muted-foreground">{{ $t('platform.storage.noTokensDescription') }}</p>
          <Button size="sm" variant="outline" @click="createMode = 'token'">
            <KeyRound aria-hidden="true" class="size-4" />
            {{ $t('platform.publishingPage.menu.token') }}
          </Button>
        </div>
      </template>
      <template #cell-name="{ row }">
        <p class="font-medium">{{ row.name }}</p>
        <p class="font-mono text-xs text-muted-foreground">{{ row.id }}</p>
      </template>
      <template #cell-access="{ row }">
        <span class="text-xs">{{ row.access }}</span>
        <span v-if="row.revoked_at" class="block text-xs text-muted-foreground">{{ $t('platform.storage.revoked') }}</span>
      </template>
      <template #cell-buckets="{ row }">
        <span class="font-mono text-xs">{{ row.buckets?.join(', ') || '-' }}</span>
      </template>
      <template #cell-last_used="{ row }">
        <span class="whitespace-nowrap text-xs text-muted-foreground" :title="row.last_used_at ? formatDateTime(row.last_used_at) : undefined">
          {{ row.last_used_at ? formatRelativeTime(row.last_used_at) : $t('platform.storage.neverUsed') }}
        </span>
      </template>
      <template #cell-actions="{ row }">
        <RowMenu :name="row.name" :items="tokenMenu(row)" />
      </template>
    </DataTable>

    <!-- Buckets: what holds the bytes; a row's menu opens the bucket in Store. -->
    <DataTable
      v-else
      state-key="buckets"
      :columns="bucketColumns"
      :rows="buckets"
      :row-key="(bucket) => `${bucket.kind}:${bucket.name}`"
      :loading="bucketsQuery.loading.value"
      :error="bucketsQuery.error.value"
      :has-data="bucketsQuery.data.value !== undefined"
      :searchable="buckets.length > 6"
      :expression-filter="false"
      :show-summary="false"
      :empty-title="$t('platform.storage.noBuckets')"
      :empty-description="$t('platform.storage.noBucketsDescription')"
      @retry="bucketsQuery.refresh"
    >
      <template #cell-name="{ row }">
        <p class="font-mono text-xs">{{ row.name }}</p>
        <p v-if="row.display_name" class="text-xs text-muted-foreground">{{ row.display_name }}</p>
      </template>
      <template #cell-description="{ row }">
        <span class="text-xs text-muted-foreground">{{ row.description || '-' }}</span>
      </template>
      <template #cell-routes="{ row }">
        <span class="font-mono text-xs tabular-nums">{{ routesForBucket(row).length }}</span>
      </template>
      <template #cell-updated="{ row }">
        <span class="whitespace-nowrap text-xs text-muted-foreground">{{ formatDateTime(row.updated_at) }}</span>
      </template>
      <template #cell-actions="{ row }">
        <RowMenu :name="row.name" :items="bucketMenu(row)" />
      </template>
    </DataTable>

    <!-- Shares: the table on the share origin; the share sheet and its create form on every layer. -->
    <PublishingSharesPane
      v-if="canSeeShares"
      ref="sharesPane"
      :show-table="layer === 'routes' && lens === 'share'"
      :shares="sharesQuery.data.value"
      :shares-error="sharesQuery.error.value ?? null"
      :shares-loading="sharesQuery.loading.value"
      :routes="recordsQuery.data.value?.records"
      :proxy-users="proxyUsersQuery.error.value ? undefined : proxyUsersQuery.data.value"
      :reload="reloadShares"
    />

    <!-- One storage route: where it answers, what it serves, who may read it. -->
    <ObjectSheet
      :open="routeSheetOpen"
      :title="openRecordRow ? recordUrl(openRecordRow) : (sheet.openId.value ?? '')"
      :subtitle="openRecordRow ? $t(`platform.publishing.origin.${openRecordRow.origin}`) : undefined"
      :mono-title="true"
      :mono-subtitle="false"
      :state="routeSheetState"
      :error="recordsQuery.error.value ? proofReason(recordsQuery.error.value) : null"
      :read-only="!openRecordRow || !canDeleteBinding(openRecordRow)"
      :return-focus="sheet.returnFocus"
      :gone-title="$t('platform.publishingPage.routeGoneTitle')"
      :gone-description="$t('platform.publishingPage.routeGoneDescription')"
      @close="sheet.close"
    >
      <div v-if="openRecordRow" class="space-y-4 text-sm">
        <p :class="accessClass(accessMode(openRecordRow))">
          {{ $t(`platform.publishing.access.${accessMode(openRecordRow)}`) }}:
          <span class="font-normal text-muted-foreground">{{ $t(`platform.publishing.accessHint.${accessMode(openRecordRow)}`) }}</span>
        </p>
        <dl class="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
          <div>
            <dt class="text-xs text-muted-foreground">{{ $t('platform.publishing.columnState') }}</dt>
            <dd :class="STATE_TONE[recordState(openRecordRow)] === 'text-muted-foreground' ? '' : STATE_TONE[recordState(openRecordRow)]">
              {{ $t(`platform.publishing.state.${recordState(openRecordRow)}`) }}
            </dd>
          </div>
          <div class="min-w-0">
            <dt class="text-xs text-muted-foreground">{{ $t('platform.publishing.columnServes') }}</dt>
            <dd>
              <RouterLink
                :to="{ path: '/platform/store', query: { kind: openRecordRow.origin, bucket: openRecordRow.bucket } }"
                class="font-mono text-xs text-primary underline-offset-4 hover:underline"
              >{{ openRecordRow.bucket }}</RouterLink>
            </dd>
          </div>
          <div v-if="openRecordRow.expires_at">
            <dt class="text-xs text-muted-foreground">{{ $t('networking.shares.expires') }}</dt>
            <dd>{{ formatDateTime(openRecordRow.expires_at) }}</dd>
          </div>
          <div v-if="openRecordRow.reserved">
            <dt class="text-xs text-muted-foreground">{{ $t('platform.publishing.reserved') }}</dt>
            <dd class="text-xs text-muted-foreground">{{ $t('platform.publishing.reservedHint') }}</dd>
          </div>
        </dl>
      </div>
      <template v-if="openRecordRow && canDeleteBinding(openRecordRow)" #actions>
        <RowMenu :name="recordUrl(openRecordRow)" :items="recordMenu(openRecordRow).filter((item) => item.key === 'delete')" />
      </template>
    </ObjectSheet>

    <StorageCreateSheet :mode="createMode" :kinds="adminKinds" @close="createMode = null" @created="onCreated" />

    <ConfirmDialog
      :open="!!pendingBinding"
      :title="pendingBinding ? $t('platform.storage.deleteBindingTitle', { url: bindingAddress(pendingBinding) }) : ''"
      :impact="bindingImpact"
      :typed-confirm="pendingBinding ? bindingAddress(pendingBinding) : undefined"
      :confirm-label="$t('platform.storage.deleteBinding')"
      :cancel-label="$t('common.actions.cancel')"
      :pending="deletingBinding"
      @update:open="(open) => { if (!open) pendingBinding = null; }"
      @confirm="confirmDeleteBinding"
    />
    <ConfirmDialog
      :open="!!pendingToken"
      :title="pendingToken ? $t('platform.storage.revokeTokenTitle', { name: pendingToken.name }) : ''"
      :impact="tokenImpact"
      :typed-confirm="pendingToken?.name"
      :confirm-label="$t('platform.storage.revokeToken')"
      :cancel-label="$t('common.actions.cancel')"
      :pending="revokingToken"
      @update:open="(open) => { if (!open) pendingToken = null; }"
      @confirm="confirmRevokeToken"
    />
  </div>
</template>
