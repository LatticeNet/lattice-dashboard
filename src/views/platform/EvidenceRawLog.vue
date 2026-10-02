<script setup lang="ts">
/**
 * The Raw log lens of Explore: the sing-box and agent lines a node shipped,
 * newest first, for one source.
 *
 * The source is the one `source:` names, else the first on the node `node:`
 * names, else the first source there is. Free text is the server's substring
 * filter and the toolbar's window bounds the query. An empty viewer says
 * which problem it is: no source exists, the source never shipped, or it
 * holds lines and this question selected none (with the newest line's time,
 * so "widen the window" says how far).
 */
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "@/lib/toast";
import { RefreshCw } from "lucide-vue-next";

import { useOwnedRoute } from "@/composables/useOwnedRoute";
import { api, type LogLine } from "@/lib/api";
import { formatDateTime, isZeroTime } from "@/lib/format";
import DataState from "@/components/common/DataState.vue";
import EmptyState from "@/components/common/EmptyState.vue";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

import { readConnTraceFilters, resolveTraceWindow } from "./connTraceModel";
import { useEvidenceContext } from "./evidenceContext";
import {
  RAW_LOG_STALE_MS,
  pickLogSource,
  readEvidenceQuery,
  writeEvidenceLayer,
} from "./evidenceModel";
import { logViewerEmptyState } from "./logsModel";

const QUERY_LIMIT = 200;
const TAIL_POLL_MS = 10000;
/** Rendering thousands of rows janks the page; older lines stay a query away. */
const LOG_RENDER_CAP = 1500;

const emit = defineEmits<{ "clear-query": []; "any-time": [] }>();

const { t } = useI18n();
// Reads go through the owned route: while Evidence is leaving, the router
// already describes the next page, whose query is not this page's filters.
const ownedRoute = useOwnedRoute();
const ctx = useEvidenceContext();

const question = computed(() => readEvidenceQuery(ownedRoute.query()));
const filters = computed(() => readConnTraceFilters(ownedRoute.query()));

const sources = computed(() => ctx.sources.data.value ?? []);
const source = computed(() =>
  pickLogSource(
    sources.value,
    { sourceId: question.value.sourceId, nodeId: question.value.nodeId },
    ctx.logStats.data.value ?? [],
  ),
);
const sourceStats = computed(() =>
  (ctx.logStats.data.value ?? []).find((entry) => entry.source_id === source.value?.id),
);

/* ------------------------------------------------------------------ */
/* Lines                                                               */
/* ------------------------------------------------------------------ */

const lines = ref<LogLine[]>([]);
const truncated = ref(false);
const nextBeforeSeq = ref<number | undefined>();
const loading = ref(false);
const loadingOlder = ref(false);
const loadError = ref<Error | null>(null);
const loadedOnce = ref(false);
let timer: ReturnType<typeof setInterval> | undefined;

const newestFirst = computed(() => lines.value.slice().reverse());
const rendered = computed(() => newestFirst.value.slice(0, LOG_RENDER_CAP));

function requestParams(beforeSeq?: number) {
  const window = resolveTraceWindow(filters.value, Date.now());
  return {
    source_id: source.value?.id ?? "",
    q: question.value.text || undefined,
    since: window.since || undefined,
    until: window.until || undefined,
    limit: QUERY_LIMIT,
    before_seq: beforeSeq,
  };
}

/**
 * Every answer is checked against the question it was asked for. A source or
 * window change while the tail poll or "load older" is in flight would
 * otherwise land source A's lines under source B's name: the old request
 * is aborted, and a late answer whose question no longer matches is dropped.
 */
let newestController: AbortController | undefined;
let olderController: AbortController | undefined;

async function loadNewest(): Promise<void> {
  const key = requestKey.value;
  newestController?.abort();
  olderController?.abort();
  if (!source.value) {
    lines.value = [];
    nextBeforeSeq.value = undefined;
    truncated.value = false;
    loadedOnce.value = true;
    loading.value = false;
    return;
  }
  const mine = new AbortController();
  newestController = mine;
  loading.value = true;
  loadError.value = null;
  try {
    const res = await api.logs.query(requestParams(), { signal: mine.signal });
    if (newestController !== mine || key !== requestKey.value) return;
    lines.value = [...res.lines].sort((a, b) => a.seq - b.seq);
    truncated.value = res.truncated;
    nextBeforeSeq.value = res.next_before_seq;
    loadedOnce.value = true;
  } catch (error) {
    if ((error as Error)?.name === "AbortError" || newestController !== mine) return;
    loadError.value = error instanceof Error ? error : new Error(t("platform.logs.queryFailed"));
  } finally {
    if (newestController === mine) loading.value = false;
  }
}

async function loadOlder(): Promise<void> {
  const before = nextBeforeSeq.value;
  if (!source.value || before === undefined || loadingOlder.value) return;
  const key = requestKey.value;
  const mine = new AbortController();
  olderController = mine;
  loadingOlder.value = true;
  try {
    const res = await api.logs.query(requestParams(before), { signal: mine.signal });
    // The page belongs to the walk it continued; a newer question or a
    // reload since then owns the list now.
    if (olderController !== mine || key !== requestKey.value || nextBeforeSeq.value !== before) return;
    const seen = new Set(lines.value.map((line) => line.seq));
    lines.value = [...res.lines.filter((line) => !seen.has(line.seq)), ...lines.value].sort((a, b) => a.seq - b.seq);
    nextBeforeSeq.value = res.next_before_seq;
  } catch (error) {
    if ((error as Error)?.name === "AbortError" || olderController !== mine) return;
    toast.error(error instanceof Error ? error.message : t("platform.logs.loadOlderFailed"));
  } finally {
    if (olderController === mine) loadingOlder.value = false;
  }
}

function stopTail(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}

/** A relative window keeps moving, so the newest page is re-read on a slow poll. */
function startTail(): void {
  stopTail();
  if (!source.value || filters.value.range === "custom") return;
  timer = setInterval(() => {
    if (loading.value || loadingOlder.value || nextBeforeSeq.value !== undefined && lines.value.length > QUERY_LIMIT) return;
    void loadNewest();
  }, TAIL_POLL_MS);
}

const requestKey = computed(() =>
  JSON.stringify([source.value?.id ?? "", question.value.text, filters.value.range, filters.value.since, filters.value.until]),
);
watch(
  requestKey,
  () => {
    // A new question starts from nothing, so a failed load never leaves the
    // previous source's or window's lines on screen under the new one.
    lines.value = [];
    nextBeforeSeq.value = undefined;
    truncated.value = false;
    loadedOnce.value = false;
    loadError.value = null;
    void loadNewest();
    startTail();
  },
  { immediate: true },
);
watch(ctx.refreshTick, () => void loadNewest());
onBeforeUnmount(() => {
  stopTail();
  newestController?.abort();
  olderController?.abort();
});

/* ------------------------------------------------------------------ */
/* What the source is, and why the viewer is empty                     */
/* ------------------------------------------------------------------ */

const lastIngest = computed(() => sourceStats.value?.last_ingest_at ?? "");
const stale = computed(() => {
  const at = lastIngest.value;
  if (!at || isZeroTime(at)) return true;
  return Date.now() - Date.parse(at) > RAW_LOG_STALE_MS;
});

/** A node was asked for and has no source: say so rather than show another node's lines. */
const noSourceOnNode = computed(() => !source.value && question.value.nodeId !== "" && sources.value.length > 0);

const empty = computed(() =>
  logViewerEmptyState({
    sourcesKnown: ctx.sources.data.value !== undefined && !ctx.sources.error.value,
    sourceCount: sources.value.length,
    selected: source.value,
    heldLines: ctx.logStats.error.value ? undefined : sourceStats.value?.lines,
    filterActive: question.value.text !== "" || filters.value.range !== "all",
  }),
);

const collectLink = computed(() => ({ query: writeEvidenceLayer(ownedRoute.query(), "collection") }));
const overviewLink = computed(() => ({ query: writeEvidenceLayer(ownedRoute.query(), "overview") }));

/**
 * Names in the question searched as typed because their list has not loaded.
 * "No source on this node" and "nothing matched" are then unproven: the
 * node or source name may simply not have been looked up.
 */
const uncheckedNames = computed(() => ctx.uncheckedNames(question.value));
const notLookedUp = computed(
  () => uncheckedNames.value.length > 0 && (noSourceOnNode.value || empty.value.kind === "nothing-matched"),
);

const emptyTitle = computed(() => {
  if (notLookedUp.value) return t("platform.evidence.explore.notLookedUpTitle");
  if (noSourceOnNode.value) return t("platform.evidence.explore.noSourceOnNodeTitle");
  switch (empty.value.kind) {
    case "no-sources":
      return t("platform.logs.viewerNoSourcesTitle");
    case "source-disabled":
      return t("platform.logs.sourceDisabledTitle");
    case "source-empty":
      return t("platform.logs.sourceEmptyTitle");
    case "nothing-matched":
      return t("platform.evidence.explore.nothingMatchedTitle");
    default:
      return t("platform.logs.viewerUnknownEmptyTitle");
  }
});

const emptyDescription = computed(() => {
  const name = source.value?.name || source.value?.id || "";
  const node = source.value ? ctx.nodeLabel(source.value.node_id) : "";
  if (notLookedUp.value) {
    return t("platform.evidence.explore.notLookedUp", { tokens: uncheckedNames.value.join(", ") }, uncheckedNames.value.length);
  }
  if (noSourceOnNode.value) {
    return t("platform.evidence.explore.noSourceOnNode", { node: ctx.nodeLabel(question.value.nodeId) });
  }
  switch (empty.value.kind) {
    case "no-sources":
      return t("platform.logs.viewerNoSourcesDescription");
    case "source-disabled":
      return t("platform.logs.sourceDisabledDescriptionNodeNamed", { name, node });
    case "source-empty":
      return t("platform.logs.sourceEmptyDescriptionNodeNamed", { name, node });
    case "nothing-matched": {
      const newest = sourceStats.value?.last_at;
      return newest && !isZeroTime(newest)
        ? t("platform.evidence.explore.logNothingMatchedNewest", { newest: formatDateTime(newest) })
        : t("platform.evidence.explore.nothingMatched");
    }
    default:
      return t("platform.logs.viewerUnknownEmptyDescriptionNodeNamed", { name, node });
  }
});

const nothingCollected = computed(
  () => !noSourceOnNode.value && ["no-sources", "source-disabled", "source-empty"].includes(empty.value.kind),
);
</script>

<template>
  <div class="space-y-3">
    <!-- Which source this is, where it comes from and how fresh it is. -->
    <p v-if="source" class="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-xs tabular text-muted-foreground">
      <span class="text-foreground">{{ source.name || source.id }}</span>
      <span>· {{ ctx.nodeLabel(source.node_id) }}</span>
      <span v-if="sourceStats">· {{ $t('platform.logs.feedHeld', { count: sourceStats.lines }) }}</span>
      <span>
        · {{ lastIngest && !isZeroTime(lastIngest)
          ? $t('platform.evidence.overview.lastIngest', { at: formatDateTime(lastIngest) })
          : $t('platform.evidence.overview.neverShipped') }}
      </span>
      <Badge v-if="stale && lastIngest && !isZeroTime(lastIngest)" variant="warning" :title="$t('platform.evidence.overview.staleHint')">
        {{ $t('platform.evidence.overview.stale') }}
      </Badge>
      <span v-if="!source.enabled">· {{ $t('common.status.disabled') }}</span>
    </p>

    <DataState
      :loading="(loading && !loadedOnce) || (ctx.sources.loading.value && !source)"
      :error="loadError || (ctx.sources.error.value && !source ? ctx.sources.error.value : null)"
      :has-data="lines.length > 0"
      :is-empty="lines.length === 0"
      :skeleton-rows="6"
      @retry="() => { ctx.sources.refresh(); void loadNewest(); }"
    >
      <template #empty>
        <EmptyState :title="emptyTitle" :description="emptyDescription" data-testid="evidence-empty">
          <template v-if="nothingCollected" #default>
            <Button v-if="empty.kind === 'no-sources' && ctx.canAdmin.value" as-child size="sm" variant="outline">
              <RouterLink :to="collectLink">{{ $t('platform.evidence.explore.goCollection') }}</RouterLink>
            </Button>
            <Button v-else as-child size="sm" variant="outline">
              <RouterLink :to="overviewLink">{{ $t('platform.evidence.explore.goOverview') }}</RouterLink>
            </Button>
          </template>
          <template v-else-if="noSourceOnNode || empty.kind === 'nothing-matched'" #default>
            <Button size="sm" variant="outline" @click="emit('clear-query')">
              {{ $t('platform.evidence.explore.clearQuery') }}
            </Button>
            <Button v-if="filters.range !== 'all' && !noSourceOnNode" size="sm" variant="ghost" @click="emit('any-time')">
              {{ $t('platform.evidence.explore.searchAnyTime') }}
            </Button>
          </template>
        </EmptyState>
      </template>

      <div class="space-y-3">
        <!-- Phone width: each line gets the full width under its time and
             sequence; a table column there left the line about 100px. -->
        <ol class="divide-y divide-border rounded-md border border-border sm:hidden">
          <li v-for="line in rendered" :key="line.seq" class="space-y-1 px-3 py-2">
            <p class="font-mono text-[11px] tabular text-muted-foreground">{{ formatDateTime(line.at) }} · {{ line.seq }}</p>
            <p class="font-mono text-xs break-all whitespace-pre-wrap">{{ line.line }}</p>
            <Badge v-if="line.truncated" variant="warning">{{ $t('platform.logs.lineTruncated') }}</Badge>
          </li>
        </ol>
        <div class="relative hidden overflow-x-auto rounded-md border border-border sm:block">
          <table class="w-full min-w-[560px] text-xs">
            <thead>
              <tr class="border-b border-border text-left text-muted-foreground">
                <th scope="col" class="pin-start px-3 py-2 font-medium">{{ $t('platform.logs.colTime') }}</th>
                <th scope="col" class="px-3 py-2 text-right font-medium">{{ $t('platform.logs.colSeq') }}</th>
                <th scope="col" class="px-3 py-2 font-medium">{{ $t('platform.logs.colLine') }}</th>
              </tr>
            </thead>
            <tbody class="font-mono">
              <tr v-for="line in rendered" :key="line.seq" class="border-b border-border align-top last:border-b-0 hover:bg-muted/40">
                <td class="pin-start px-3 py-1.5 whitespace-nowrap text-muted-foreground tabular">{{ formatDateTime(line.at) }}</td>
                <td class="px-3 py-1.5 text-right whitespace-nowrap text-muted-foreground tabular">{{ line.seq }}</td>
                <td class="px-3 py-1.5">
                  <span class="break-all whitespace-pre-wrap">{{ line.line }}</span>
                  <Badge v-if="line.truncated" variant="warning" class="ml-2">{{ $t('platform.logs.lineTruncated') }}</Badge>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="flex flex-wrap items-center justify-between gap-2">
          <p class="text-xs text-muted-foreground">
            <template v-if="newestFirst.length > LOG_RENDER_CAP">
              {{ $t('platform.logs.renderCapped', { shown: LOG_RENDER_CAP, loaded: newestFirst.length }) }}
            </template>
            <span v-if="truncated" class="text-warning-text">{{ $t('platform.logs.resultTruncated') }}</span>
          </p>
          <Button v-if="nextBeforeSeq !== undefined" variant="outline" size="sm" :disabled="loadingOlder" @click="loadOlder">
            <RefreshCw v-if="loadingOlder" aria-hidden="true" class="size-4 animate-spin" />
            {{ $t('common.actions.loadOlder') }}
          </Button>
        </div>
      </div>
    </DataState>
  </div>
</template>
