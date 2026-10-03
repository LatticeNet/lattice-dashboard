<script setup lang="ts">
/**
 * Identity links on Publishing's share lens: one read-only row per issued
 * link, beside the shares, because each is a public URL this server serves
 * on the same /sub/ mount and Publishing is where every such URL is listed.
 *
 * Read only on purpose. A link belongs to its identity and is issued,
 * paused, rotated, revoked and revealed on vpn-core's Users page, where the
 * identity's lines and credentials are; a row opens it there. No token is
 * ever here: the routes and the status carry none. Rows are in address
 * order, the order an operator looks a person up in.
 *
 * What a row says comes from what was read (useIdentityLinks): the owner's
 * address from vpn-core's users list, the state and last fetch from the
 * link's status. Without the status (no vpncore:admin, a restricted
 * allowlist, a failed read) the row shows the route's own state and says why
 * it shows no more.
 */
import { computed } from "vue";
import { useI18n } from "vue-i18n";

import type { PublishingRecord } from "@/lib/api";
import type { PaletteIdentity } from "@/components/common/commandPaletteModel";
import { formatDateTime, formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { publishingState } from "./publishingModel";
import {
  clientFamily,
  fetchFreshness,
  identityLinkSlug,
  identityLinkState,
  maskedSharePath,
  placeholderReason,
} from "./publishedModel";
import type { IdentityLinkRead } from "./useIdentityLinks";

import DataTable, { type DataTableColumn } from "@/components/common/DataTable.vue";

const props = defineProps<{
  /** The page's routes that are identity links. */
  records: PublishingRecord[];
  recordsLoading: boolean;
  recordsError: Error | null;
  /** The routes read has landed. */
  hasData: boolean;
  statuses: ReadonlyMap<string, IdentityLinkRead>;
  identities: ReadonlyMap<string, PaletteIdentity> | undefined;
  loading: boolean;
  canReadStatus: boolean;
  /** vpn-core's Users page, when this principal may open it. */
  usersPath?: string;
  retry: () => unknown;
}>();

const { t } = useI18n();

type RowState =
  | "active"
  | "never"
  | "placeholder"
  | "empty"
  | "paused"
  | "expired"
  | "none"
  | "unreadable"
  | "routeServing"
  | "routePaused"
  | "routeExpired";

interface Row {
  id: string;
  identityId: string;
  slug: string;
  email: string;
  name: string;
  read?: IdentityLinkRead;
  state: RowState;
}

const ROUTE_STATE: Record<ReturnType<typeof publishingState>, RowState> = {
  serving: "routeServing",
  disabled: "routePaused",
  expired: "routeExpired",
};

const reads = computed(() => [...props.statuses.values()]);

/** Link status is not this session's to read: no vpncore:admin, or the server refused it (a restricted allowlist). */
const statusDenied = computed(
  () => !props.canReadStatus || reads.value.some((read) => "error" in read && read.httpStatus === 403),
);

/**
 * Every status read failed for another reason (the server or the network):
 * one sentence with a retry above the rows, instead of the same error on
 * each of them. A failure on some rows only is said on those rows.
 */
const allFailed = computed(() => {
  const list = reads.value;
  return list.length > 0 && list.every((read) => "error" in read && read.httpStatus !== 403);
});
const failedReason = computed(() => {
  const first = reads.value[0];
  return first && "error" in first ? first.error : "";
});

const rows = computed<Row[]>(() =>
  props.records
    .map((record): Row => {
    const identityId = record.identity_id ?? record.bucket;
    // A refusal (403) is this session's access, not the link's state, and a
    // read that failed everywhere is the server's; either way the row shows
    // the route, and the note above says why, once.
    const raw = props.statuses.get(identityId);
    const read = raw && "error" in raw && (raw.httpStatus === 403 || allFailed.value) ? undefined : raw;
    const status = read && "status" in read ? read.status : undefined;
    const identity = props.identities?.get(identityId);
    let state: RowState;
    if (status) state = identityLinkState(status);
    else if (read) state = "unreadable";
    else state = ROUTE_STATE[publishingState(record)];
    return {
      id: record.id,
      identityId,
      slug: identityLinkSlug(record, status),
      email: identity?.email ?? "",
      name: identity?.name ?? "",
      read,
      state,
    };
    })
    .sort((a, b) => (a.email || a.identityId).localeCompare(b.email || b.identityId)),
);

/**
 * The first status read is still out: the rows wait for it rather than show
 * the route's state and then change their mind a moment later.
 */
const firstRead = computed(() => props.loading && props.canReadStatus && props.statuses.size === 0 && props.records.length > 0);

const TONE: Record<RowState, string> = {
  active: "text-muted-foreground",
  never: "text-muted-foreground",
  placeholder: "text-warning-text",
  empty: "text-destructive",
  paused: "text-muted-foreground",
  expired: "text-destructive",
  none: "text-muted-foreground",
  unreadable: "text-warning-text",
  routeServing: "text-muted-foreground",
  routePaused: "text-muted-foreground",
  routeExpired: "text-destructive",
};

function statusOf(row: Row) {
  return row.read && "status" in row.read ? row.read.status : undefined;
}

/** The second line under the state word: what decides it. */
function stateDetail(row: Row): string {
  const status = statusOf(row);
  if (row.state === "unreadable" && row.read && "error" in row.read) return row.read.error;
  if (!status) return "";
  if (row.state === "placeholder") return t(`platform.publishingPage.identityLinks.reason.${placeholderReason(status.answer_reason)}`);
  if (row.state === "empty") return t("platform.publishingPage.identityLinks.detail.allLeftOut", { n: status.excluded.length });
  if (row.state === "active" || row.state === "never") {
    const served = status.included.length;
    const left = status.excluded.length;
    return left
      ? t("platform.publishingPage.identityLinks.detail.servesWithLeftOut", { n: served, left })
      : t("platform.publishingPage.identityLinks.detail.serves", { n: served }, served);
  }
  return "";
}

function fetchAt(row: Row): string {
  return statusOf(row)?.last_fetch?.at ?? "";
}

/** A stale fetch is worth a colour only while the link serves; a paused link is expected to go quiet. */
function fetchTone(row: Row): string {
  const status = statusOf(row);
  if (!status) return "text-muted-foreground";
  const serving = row.state === "active" || row.state === "never";
  return serving && fetchFreshness(status) === "stale" ? "text-warning-text" : "";
}

function family(row: Row): string {
  const fetch = statusOf(row)?.last_fetch;
  if (!fetch) return "";
  return clientFamily(fetch.ua_class) || t("platform.publishingPage.identityLinks.fetch.unknownClient");
}

const columns = computed<DataTableColumn<Row>[]>(() => [
  {
    key: "identity",
    label: t("platform.publishingPage.identityLinks.columns.identity"),
    sortable: true,
    searchable: true,
    value: (row) => row.email || row.identityId,
  },
  {
    key: "state",
    label: t("platform.publishingPage.identityLinks.columns.state"),
    sortable: true,
    class: "w-[13rem]",
    value: (row) => t(`platform.publishingPage.identityLinks.state.${row.state}`),
  },
  {
    key: "fetch",
    label: t("platform.publishingPage.identityLinks.columns.fetch"),
    sortable: true,
    class: "w-[11rem]",
    value: (row) => fetchAt(row),
  },
  // Last: on a phone the table scrolls sideways, and the state is what is scanned for.
  { key: "link", label: t("platform.publishingPage.identityLinks.columns.link"), searchable: true, value: (row) => row.slug },
]);

/** The identity on vpn-core's Users page (`open` is its page-state key for the open object). */
function openTo(row: Row) {
  return { path: props.usersPath!, query: { open: row.identityId } };
}
</script>

<template>
  <section class="space-y-3" aria-labelledby="publishing-identity-links-heading" data-testid="identity-links">
    <div class="space-y-1">
      <h2 id="publishing-identity-links-heading" class="flex items-baseline gap-2 text-sm font-medium">
        {{ $t('platform.publishingPage.identityLinks.title') }}
        <span v-if="hasData" class="font-mono text-xs tabular-nums text-muted-foreground">{{ records.length }}</span>
      </h2>
      <p class="max-w-prose text-xs text-muted-foreground">
        {{ usersPath ? $t('platform.publishingPage.identityLinks.description') : $t('platform.publishingPage.identityLinks.descriptionNoPage') }}
      </p>
      <!-- Permission denied, said once above the rows instead of on each of them. -->
      <p v-if="statusDenied && records.length" class="text-xs text-warning-text" data-testid="identity-links-denied">
        {{ $t('platform.publishingPage.identityLinks.statusDenied') }}
      </p>
      <p v-else-if="allFailed && records.length" class="flex flex-wrap items-baseline gap-x-2 text-xs text-warning-text" data-testid="identity-links-failed">
        <span>{{ $t('platform.publishingPage.identityLinks.statusFailed', { reason: failedReason }) }}</span>
        <button
          type="button"
          class="rounded-sm text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
          :disabled="loading"
          @click="props.retry()"
        >{{ $t('common.actions.retry') }}</button>
      </p>
    </div>

    <DataTable
      state-key="identity-links"
      :columns="columns"
      :rows="rows"
      :row-key="(row) => row.id"
      :loading="recordsLoading || firstRead"
      :error="recordsError"
      :has-data="hasData && !firstRead"
      :page-size="25"
      :searchable="rows.length > 6"
      :expression-filter="false"
      :row-to="usersPath ? openTo : undefined"
      :show-summary="false"
      :empty-title="$t('platform.publishingPage.identityLinks.emptyTitle')"
      :empty-description="$t('platform.publishingPage.identityLinks.emptyDescription')"
      @retry="props.retry"
    >
      <template #cell-identity="{ row }">
        <div class="min-w-0">
          <p v-if="row.email" class="truncate font-medium" :title="row.email">{{ row.email }}</p>
          <p :class="cn('truncate font-mono text-xs', row.email ? 'text-muted-foreground' : 'text-foreground')" :title="row.identityId">
            {{ row.name ? `${row.name} · ${row.identityId}` : row.identityId }}
          </p>
        </div>
      </template>
      <template #cell-link="{ row }">
        <span class="whitespace-nowrap font-mono text-xs text-muted-foreground">{{ maskedSharePath(row) }}</span>
      </template>
      <template #cell-state="{ row }">
        <span :class="cn('block text-xs', TONE[row.state as RowState])" data-testid="identity-link-state">
          {{ $t(`platform.publishingPage.identityLinks.state.${row.state}`) }}
        </span>
        <span v-if="stateDetail(row)" class="block max-w-[13rem] truncate text-xs text-muted-foreground" :title="stateDetail(row)">
          {{ stateDetail(row) }}
        </span>
      </template>
      <template #cell-fetch="{ row }">
        <template v-if="fetchAt(row)">
          <span :class="cn('block whitespace-nowrap text-xs tabular', fetchTone(row))" :title="formatDateTime(fetchAt(row))">
            {{ formatRelativeTime(fetchAt(row)) }}
          </span>
          <span class="block truncate text-xs text-muted-foreground">{{ family(row) }}</span>
        </template>
        <span v-else-if="row.state === 'none'" class="block text-xs text-muted-foreground">-</span>
        <span
          v-else-if="statusOf(row)"
          class="block text-xs text-muted-foreground"
          :title="$t('platform.publishingPage.identityLinks.fetch.memoryOnly')"
        >{{ $t('platform.publishingPage.identityLinks.fetch.never') }}</span>
        <span v-else class="block text-xs text-muted-foreground">{{ $t('platform.publishingPage.identityLinks.fetch.unread') }}</span>
      </template>
    </DataTable>
  </section>
</template>
