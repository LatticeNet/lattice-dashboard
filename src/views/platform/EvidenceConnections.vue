<script setup lang="ts">
/**
 * The Connections lens of Explore: one row per sing-box connection.
 *
 * Three rules drive the rows: a byte count nobody sampled is never printed as
 * zero, a close reason nobody recorded never reads as a clean close, and a
 * hop path this console inferred says so in words (EvidenceConnPanel).
 *
 * The filters come from the address bar; free text narrows the rows already
 * loaded. An empty result says which of two different problems it is:
 * nothing was collected (the answer is on Overview, where a capture starts)
 * or nothing matched (the answer is a different question).
 */
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute } from "vue-router";
import { toast } from "vue-sonner";
import { RefreshCw } from "lucide-vue-next";

import { api, type ConnRecord } from "@/lib/api";
import { usePluginContributions } from "@/composables/usePluginContributions";
import { formatDateTime, shortId } from "@/lib/format";
import { cn } from "@/lib/utils";
import DataTable, { type DataTableColumn } from "@/components/common/DataTable.vue";
import EmptyState from "@/components/common/EmptyState.vue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

import {
  appendConnPage,
  connCloseCell,
  connEmptyState,
  connRecordKey,
  connTraceFiltersEqual,
  connectionsRequestParams,
  destinationText,
  emptyConnTracePaging,
  identityLinkTarget,
  isStalled,
  lineLinkTarget,
  readConnTraceFilters,
  traceBytesCell,
  traceBytesCoverage,
  traceDurationCell,
  tracePolicyCoverage,
  userCellDisplay,
  vpnCoreRowLinks,
  type ConnEmptyState,
  type ConnTraceFilters,
  type ConnTracePaging,
} from "./connTraceModel";
import { useEvidenceContext } from "./evidenceContext";
import { EVIDENCE_PARAM, connMatchesText, readEvidenceQuery, writeEvidenceLayer } from "./evidenceModel";

const PAGE_LIMIT = 200;
/** Close tones that are routine, rendered as text rather than a badge. */
const QUIET_TONES: ReadonlySet<string> = new Set(["success", "secondary"]);

const props = defineProps<{
  /** The connection open in the side sheet, highlighted in the table. */
  activeKey?: string | null;
}>();

const emit = defineEmits<{
  open: [payload: { key: string; record: ConnRecord; opener: HTMLElement }];
  loaded: [lookup: (key: string) => ConnRecord | undefined];
  "clear-query": [];
  "any-time": [];
}>();

const { t } = useI18n();
const route = useRoute();
const ctx = useEvidenceContext();

const applied = computed(() => readConnTraceFilters(route.query));
/**
 * Names in the applied query that were searched as typed because their list
 * has not loaded. An empty result then may say nothing about the traffic.
 */
const uncheckedNames = computed(() => ctx.uncheckedNames(readEvidenceQuery(route.query)));
const text = computed(() => {
  const raw = route.query[EVIDENCE_PARAM.text];
  return typeof raw === "string" ? raw.trim() : "";
});

/* ------------------------------------------------------------------ */
/* Loading                                                             */
/* ------------------------------------------------------------------ */

const paging = ref<ConnTracePaging>(emptyConnTracePaging());
const loadedOnce = ref(false);
const loading = ref(false);
const loadingOlder = ref(false);
const loadError = ref<Error | null>(null);
let controller: AbortController | undefined;

const records = computed(() => paging.value.records);

/**
 * There is no background poll here on purpose. The list accumulates older
 * keyset pages as the operator walks back through them, and a poll that reset
 * to the newest page would throw that walk away mid-investigation.
 */
async function loadNewest(): Promise<void> {
  if (!ctx.canRead.value) return;
  controller?.abort();
  const mine = new AbortController();
  controller = mine;
  loading.value = true;
  loadError.value = null;
  try {
    const res = await api.trace.connections(
      connectionsRequestParams(applied.value, { limit: PAGE_LIMIT, nowMs: Date.now() }),
      { signal: mine.signal },
    );
    paging.value = appendConnPage(emptyConnTracePaging(), res);
    loadedOnce.value = true;
  } catch (error) {
    if ((error as Error)?.name === "AbortError") return;
    loadError.value = error as Error;
  } finally {
    if (controller === mine) loading.value = false;
  }
}

async function loadOlder(): Promise<void> {
  if (!paging.value.cursor || loadingOlder.value) return;
  const cursor = paging.value.cursor;
  loadingOlder.value = true;
  try {
    const res = await api.trace.connections(
      connectionsRequestParams(applied.value, { limit: PAGE_LIMIT, cursor, nowMs: Date.now() }),
    );
    // A reload may have landed while this page was in flight; appending to
    // the list it replaced would splice an old window into a new one.
    if (paging.value.cursor !== cursor) return;
    paging.value = appendConnPage(paging.value, res);
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("platform.trace.loadOlderFailed"));
  } finally {
    loadingOlder.value = false;
  }
}

let lastLoaded: ConnTraceFilters | null = null;
watch(
  applied,
  (next) => {
    if (lastLoaded && connTraceFiltersEqual(lastLoaded, next)) return;
    lastLoaded = { ...next, closeReasons: [...next.closeReasons], userKinds: [...next.userKinds] };
    void loadNewest();
  },
  { immediate: true },
);

// The page's Refresh button reloads the list too; nothing else does.
watch(ctx.refreshTick, () => void loadNewest());

onBeforeUnmount(() => controller?.abort());

/* ------------------------------------------------------------------ */
/* Rows                                                                */
/* ------------------------------------------------------------------ */

const { navContributions } = usePluginContributions();
const rowLinks = computed(() => vpnCoreRowLinks(navContributions.value));

interface ConnRowView {
  user: ReturnType<typeof userCellDisplay>;
  close: ReturnType<typeof connCloseCell>;
  upload: ReturnType<typeof traceBytesCell>;
  download: ReturnType<typeof traceBytesCell>;
  duration: ReturnType<typeof traceDurationCell>;
  destination: string;
  node: string;
  stalled: boolean;
  lineTo: string;
  identityTo: string;
}

function buildRowView(row: ConnRecord): ConnRowView {
  const user = userCellDisplay(row, ctx.userNames.value);
  return {
    user,
    close: connCloseCell(row),
    upload: traceBytesCell(row.upload, row.bytes_known),
    download: traceBytesCell(row.download, row.bytes_known),
    duration: traceDurationCell(row.duration_ms),
    destination: destinationText(row),
    node: ctx.nodeLabel(row.node_id),
    stalled: isStalled(row),
    lineTo: lineLinkTarget(row, rowLinks.value),
    identityTo: identityLinkTarget(user, rowLinks.value),
  };
}

/**
 * One derived view per row, rebuilt when the data changes rather than once
 * per cell per render: ten columns each calling the same mappers turns a 200
 * row page into thousands of throwaway objects on every render.
 */
const rowViews = computed(() => {
  const map = new Map<string, ConnRowView>();
  for (const row of records.value) map.set(connRecordKey(row), buildRowView(row));
  return map;
});

function rowView(row: ConnRecord): ConnRowView {
  return rowViews.value.get(connRecordKey(row)) ?? buildRowView(row);
}

/** Free text narrows the rows already loaded, over what each row shows. */
const shownRows = computed(() => {
  if (!text.value) return records.value;
  return records.value.filter((row) => {
    const view = rowView(row);
    return connMatchesText(
      [view.user.primary, view.node, view.destination, row.sniffed_domain ?? "", row.outbound_tag ?? "", row.line_uuid ?? ""],
      text.value,
    );
  });
});

watch(records, () => {
  const byKey = new Map(records.value.map((row) => [connRecordKey(row), row]));
  emit("loaded", (key) => byKey.get(key));
});

const coverage = computed(() => traceBytesCoverage(shownRows.value));

const columns = computed<DataTableColumn<ConnRecord>[]>(() => [
  { key: "started_at", label: t("platform.trace.colStarted"), sortable: true, class: "md:whitespace-nowrap" },
  { key: "user", label: t("platform.trace.colUser"), sortable: true, value: (row) => rowView(row).user.primary },
  { key: "node_id", label: t("platform.trace.colNode"), sortable: true, value: (row) => rowView(row).node },
  { key: "line_uuid", label: t("platform.trace.colLine"), sortable: true },
  { key: "destination", label: t("platform.trace.colDestination"), sortable: true, value: (row) => destinationText(row) },
  { key: "outbound_tag", label: t("platform.trace.colOutbound"), sortable: true },
  { key: "duration_ms", label: t("platform.trace.colDuration"), align: "right", sortable: true, value: (row) => row.duration_ms ?? -1 },
  // An unsampled counter sorts below a measured zero rather than with it.
  { key: "upload", label: t("platform.trace.colUpload"), align: "right", sortable: true, value: (row) => (row.bytes_known ? (row.upload ?? 0) : -1) },
  { key: "download", label: t("platform.trace.colDownload"), align: "right", sortable: true, value: (row) => (row.bytes_known ? (row.download ?? 0) : -1) },
  { key: "close_reason", label: t("platform.trace.colClose"), sortable: true, value: (row) => connCloseCell(row).id },
]);

function select(row: ConnRecord, opener: HTMLElement): void {
  emit("open", { key: connRecordKey(row), record: row, opener });
}

/* ------------------------------------------------------------------ */
/* Empty result                                                        */
/* ------------------------------------------------------------------ */

const visibleNodes = computed(() => ({
  known: ctx.canReadNodes.value && ctx.nodesQuery.data.value !== undefined && !ctx.nodesQuery.error.value,
  count: ctx.nodes.value.length,
}));
const policyCoverage = computed(() =>
  tracePolicyCoverage(ctx.policies.error.value ? undefined : ctx.policies.data.value),
);

type EmptyKind = ConnEmptyState["kind"] | "text-matched-nothing";

const emptyKind = computed<EmptyKind>(() => {
  if (!loadedOnce.value) return "rows";
  const state = connEmptyState(paging.value, visibleNodes.value, policyCoverage.value);
  if (state.kind === "rows" && shownRows.value.length === 0) return "text-matched-nothing";
  return state.kind;
});
const newestAt = computed(() => paging.value.collectedNewestAt);

/** Nothing in the store for these nodes: no question will find a row. */
const nothingCollected = computed(() =>
  ["no-policy", "policy-no-records", "nothing-collected"].includes(emptyKind.value),
);

/** "Nothing matched" is only true when every name in the question was looked up. */
const notLookedUp = computed(
  () => uncheckedNames.value.length > 0 && ["nothing-matched", "text-matched-nothing"].includes(emptyKind.value),
);

const emptyTitle = computed(() => {
  if (notLookedUp.value) return t("platform.evidence.explore.notLookedUpTitle");
  switch (emptyKind.value) {
    case "no-visible-nodes":
      return t("platform.trace.noVisibleNodesTitle");
    case "no-policy":
      return t("platform.trace.noPolicyTitle");
    case "policy-no-records":
      return t("platform.trace.policyNoRecordsTitle");
    case "nothing-collected":
      return t("platform.trace.nothingCollectedTitle");
    case "nothing-matched":
    case "text-matched-nothing":
      return t("platform.evidence.explore.nothingMatchedTitle");
    default:
      return t("platform.trace.resultsEmptyTitle");
  }
});

const emptyDescription = computed(() => {
  if (notLookedUp.value) {
    return t("platform.evidence.explore.notLookedUp", { tokens: uncheckedNames.value.join(", ") }, uncheckedNames.value.length);
  }
  switch (emptyKind.value) {
    case "no-visible-nodes":
      return t("platform.trace.noVisibleNodesDescription");
    case "no-policy":
    case "policy-no-records":
    case "nothing-collected":
      return t("platform.evidence.explore.nothingCollectedDescription");
    case "nothing-matched":
      return newestAt.value
        ? t("platform.evidence.explore.nothingMatchedNewest", { newest: formatDateTime(newestAt.value) })
        : t("platform.evidence.explore.nothingMatched");
    case "text-matched-nothing":
      return t("platform.evidence.explore.textMatchedNothing", { loaded: records.value.length }, records.value.length);
    default:
      return t("platform.trace.resultsEmptyDescription");
  }
});

/** The dependency, counted, under a store that holds nothing. */
const policyCoverageText = computed(() => {
  const c = policyCoverage.value;
  if (!c.known) return "";
  return t("platform.trace.policyCoverage", { enabled: c.enabled, total: c.total }, c.total);
});

const overviewLink = computed(() => ({ query: writeEvidenceLayer(route.query, "overview") }));
</script>

<template>
  <div class="space-y-3">
    <p v-if="loadedOnce && records.length > 0" class="font-mono text-xs tabular text-muted-foreground">
      {{ $t('platform.evidence.explore.shown', { shown: shownRows.length, loaded: records.length }, records.length) }}
      <template v-if="shownRows.length">
        · {{ $t('platform.trace.bytesCoverage', { measured: coverage.measured, total: coverage.total }) }}
      </template>
    </p>

    <DataTable
      state-key="conn"
      :columns="columns"
      :rows="shownRows"
      :row-key="(row) => connRecordKey(row)"
      :loading="loading && !loadedOnce"
      :error="loadError"
      :has-data="loadedOnce"
      :page-size="0"
      :expression-filter="false"
      :show-summary="false"
      narrow-layout="scroll"
      :skeleton-rows="8"
      :row-click="select"
      :active-row-id="props.activeKey"
      @retry="loadNewest"
    >
      <template #empty>
        <EmptyState :title="emptyTitle" :description="emptyDescription" data-testid="evidence-empty">
          <template v-if="nothingCollected && policyCoverageText" #notice>
            <p class="tabular">{{ policyCoverageText }}</p>
          </template>
          <template v-if="nothingCollected" #default>
            <Button as-child size="sm" variant="outline">
              <RouterLink :to="overviewLink">{{ $t('platform.evidence.explore.goOverview') }}</RouterLink>
            </Button>
          </template>
          <template v-else-if="emptyKind === 'nothing-matched' || emptyKind === 'text-matched-nothing'" #default>
            <Button size="sm" variant="outline" @click="emit('clear-query')">
              {{ $t('platform.evidence.explore.clearQuery') }}
            </Button>
            <Button v-if="applied.range !== 'all' && emptyKind === 'nothing-matched'" size="sm" variant="ghost" @click="emit('any-time')">
              {{ $t('platform.evidence.explore.searchAnyTime') }}
            </Button>
          </template>
        </EmptyState>
      </template>

      <template #cell-started_at="{ row }">
        <span class="font-mono text-xs tabular md:whitespace-nowrap">{{ formatDateTime(row.started_at) }}</span>
      </template>

      <template #cell-user="{ row }">
        <div class="flex min-w-0 flex-col gap-0.5">
          <!-- A managed identity is a vpn-core object; the cell links to that
               plugin's Users page when it is installed and readable. DataTable
               ignores clicks inside an anchor, so the link does not also open
               the row. -->
          <RouterLink
            v-if="rowView(row).user.primary && rowView(row).identityTo"
            :to="rowView(row).identityTo"
            :title="$t('platform.trace.openVpnCoreUsers')"
            :class="cn(
              'truncate rounded-sm text-primary outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50',
              rowView(row).user.monospace && 'font-mono text-xs',
            )"
          >
            {{ rowView(row).user.primary }}
          </RouterLink>
          <span v-else-if="rowView(row).user.primary" :class="cn('truncate', rowView(row).user.monospace && 'font-mono text-xs')">
            {{ rowView(row).user.primary }}
          </span>
          <span v-else class="text-xs text-muted-foreground">{{ $t('platform.trace.userNoneLogged') }}</span>
          <Badge v-if="rowView(row).user.marker" variant="outline" class="w-fit" :title="$t('platform.trace.userUnresolvedHint')">
            {{ $t(`platform.trace.userKind.${rowView(row).user.kind}`) }}
          </Badge>
        </div>
      </template>

      <template #cell-node_id="{ row }">
        <span class="truncate text-xs">{{ rowView(row).node }}</span>
      </template>

      <template #cell-line_uuid="{ row }">
        <RouterLink
          v-if="rowView(row).lineTo"
          :to="rowView(row).lineTo"
          :title="$t('platform.trace.openVpnCoreLines')"
          class="rounded-sm font-mono text-xs text-primary outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          {{ shortId(row.line_uuid ?? '', 10) }}
        </RouterLink>
        <span v-else-if="row.line_uuid" class="font-mono text-xs text-muted-foreground">{{ shortId(row.line_uuid, 10) }}</span>
        <span v-else class="text-xs text-muted-foreground">{{ $t('common.misc.none') }}</span>
      </template>

      <template #cell-destination="{ row }">
        <div class="flex min-w-0 flex-col">
          <span class="truncate font-mono text-xs">{{ rowView(row).destination || $t('common.misc.none') }}</span>
          <span v-if="row.sniffed_domain && row.sniffed_domain !== row.dst_host" class="truncate text-xs text-muted-foreground">
            {{ $t('platform.trace.sniffedAs', { domain: row.sniffed_domain }) }}
          </span>
        </div>
      </template>

      <template #cell-outbound_tag="{ row }">
        <span v-if="row.outbound_tag" class="font-mono text-xs">{{ row.outbound_tag }}</span>
        <span v-else class="text-xs text-muted-foreground">{{ $t('common.misc.none') }}</span>
      </template>

      <template #cell-duration_ms="{ row }">
        <span v-if="rowView(row).duration.known" class="font-mono text-xs tabular">{{ rowView(row).duration.text }}</span>
        <span v-else class="text-xs text-muted-foreground">{{ $t('common.misc.none') }}</span>
      </template>

      <!-- bytes_known false means nobody measured, so the cell says so in
           words. A zero here would be read as "carried nothing". -->
      <template #cell-upload="{ row }">
        <span v-if="rowView(row).upload.known" class="font-mono text-xs tabular">{{ rowView(row).upload.text }}</span>
        <span v-else class="text-xs italic text-muted-foreground" :title="$t('platform.trace.bytesNotSampledHint')">
          {{ $t('platform.trace.bytesNotSampled') }}
        </span>
      </template>

      <template #cell-download="{ row }">
        <span v-if="rowView(row).download.known" class="font-mono text-xs tabular">{{ rowView(row).download.text }}</span>
        <span v-else class="text-xs italic text-muted-foreground" :title="$t('platform.trace.bytesNotSampledHint')">
          {{ $t('platform.trace.bytesNotSampled') }}
        </span>
      </template>

      <template #cell-close_reason="{ row }">
        <div class="flex flex-wrap items-center gap-1">
          <!-- A clean or routine end is the common case and reads as plain
               text; colour is kept for the ends that mean something went
               wrong, and "unknown" keeps its outline so a gap never reads as
               a clean close. -->
          <span v-if="QUIET_TONES.has(rowView(row).close.tone)" class="text-xs text-muted-foreground">
            {{ $t(`platform.trace.closeReason.${rowView(row).close.id}`) }}
          </span>
          <Badge v-else :variant="rowView(row).close.tone" :title="rowView(row).close.certain ? undefined : $t('platform.trace.closeUnknownHint')">
            {{ $t(`platform.trace.closeReason.${rowView(row).close.id}`) }}
          </Badge>
          <Badge v-if="rowView(row).stalled" variant="warning" :title="$t('platform.trace.stalledAt', { at: formatDateTime(row.stalled_at) })">
            {{ $t('platform.trace.stalled') }}
          </Badge>
        </div>
      </template>
    </DataTable>

    <div v-if="loadedOnce && records.length > 0" class="flex flex-wrap items-center justify-end gap-2">
      <Button v-if="!paging.exhausted" variant="outline" size="sm" :disabled="loadingOlder" @click="loadOlder">
        <RefreshCw v-if="loadingOlder" aria-hidden="true" class="size-4 animate-spin" />
        {{ $t('platform.trace.loadOlder') }}
      </Button>
      <p v-else class="text-xs text-muted-foreground">{{ $t('platform.trace.allLoaded') }}</p>
    </div>
  </div>
</template>
