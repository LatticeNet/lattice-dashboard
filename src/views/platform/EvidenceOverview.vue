<script setup lang="ts">
/**
 * Evidence Overview (L0): coverage first, because nothing else on the page
 * means anything without it.
 *
 * The one primary action is a time-boxed capture on chosen nodes, since that
 * is what turns "nothing collected" into an answer and it stops by itself.
 * When the last hour holds records, three facts follow (how many connections,
 * how many failed and why, where they went), each a link into Explore with
 * the question already asked. The node table closes the page: trace on or
 * off, raw log sources and how fresh they are, what is held.
 */
import { computed, nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { toast } from "@/lib/toast";
import { PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from "reka-ui";
import { useNow } from "@vueuse/core";
import { CircleStop, Play, Plus, RefreshCw, X } from "lucide-vue-next";

import { useOwnedRoute } from "@/composables/useOwnedRoute";
import { api } from "@/lib/api";
import { formatDateTime, formatRelativeTime } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import { closeReasonDisplay } from "./connTraceModel";
import { useEvidenceContext } from "./evidenceContext";
import {
  CAPTURE_DURATIONS,
  DEFAULT_CAPTURE_SECONDS,
  EMPTY_EVIDENCE_QUERY,
  captureBlock,
  captureRequest,
  captureSessionName,
  isActiveSession,
  readEvidenceQuery,
  seedCaptureNodes,
  writeEvidenceLayer,
  writeEvidenceQuery,
  type EvidenceQuery,
} from "./evidenceModel";
import type { TraceRange } from "./connTraceModel";
import type { TraceSession } from "@/lib/api";

const { t } = useI18n();
// Reads go through the owned route: while Evidence is leaving, the router
// already describes the next page, whose query is not this page's filters.
const ownedRoute = useOwnedRoute();
const ctx = useEvidenceContext();

/* ------------------------------------------------------------------ */
/* Drill-through into Explore                                          */
/* ------------------------------------------------------------------ */

function exploreTo(partial: Partial<EvidenceQuery>, range: TraceRange = "1h") {
  const base = writeEvidenceLayer(ownedRoute.query(), "explore");
  return {
    query: writeEvidenceQuery(base, { ...EMPTY_EVIDENCE_QUERY, ...partial }, { range, since: "", until: "" }),
  };
}

/* ------------------------------------------------------------------ */
/* Capture                                                             */
/* ------------------------------------------------------------------ */

const sessionsKnown = computed(() => ctx.sessions.data.value !== undefined && !ctx.sessions.error.value);
/** Ticks so a capture that passes its deadline between polls stops counting. */
const now = useNow({ interval: 15000 });
const running = computed(() => (ctx.sessions.data.value ?? []).filter((session) => isActiveSession(session, now.value.getTime())));
const collecting = computed(() => ctx.storeProof.value.collecting);

/** Nodes offered to the capture, named, in the coverage table's order. */
const nodeChoices = computed(() => ctx.coverageRows.value.map((row) => ({ id: row.nodeId, name: row.name })));

// A question already asked in Explore names the node it is about; start
// from there rather than from nothing, but only with nodes that can be
// chosen, once the list of them has loaded.
const chosen = ref<string[]>([]);
const seedParam = readEvidenceQuery(ownedRoute.query()).nodeId;
let seeded = seedParam === "";
watch(
  nodeChoices,
  (choices) => {
    if (seeded || choices.length === 0) return;
    seeded = true;
    chosen.value = seedCaptureNodes(seedParam, choices);
  },
  { immediate: true },
);
const duration = ref(String(DEFAULT_CAPTURE_SECONDS));
const pickerOpen = ref(false);
const pickerFilter = ref("");
const starting = ref(false);
const startError = ref("");
const stoppingId = ref("");

const pickerMatches = computed(() => {
  const needle = pickerFilter.value.trim().toLowerCase();
  return nodeChoices.value.filter((node) => !needle || node.name.toLowerCase().includes(needle) || node.id.includes(needle));
});

function toggleNode(id: string): void {
  chosen.value = chosen.value.includes(id) ? chosen.value.filter((value) => value !== id) : [...chosen.value, id];
  startError.value = "";
}

watch(pickerOpen, (open) => {
  if (!open) pickerFilter.value = "";
});

/**
 * The picker is a combobox: focus stays in the filter field, the arrows move
 * a highlight through the matches (the first by default), Enter picks or
 * unpicks the highlighted node and keeps the list open for the next one, and
 * Escape closes it. The options are not in the tab order.
 */
const PICKER_LIST_ID = "evidence-node-picker";
const pickerActive = ref(0);
const pickerList = ref<HTMLElement | null>(null);
watch([pickerOpen, pickerFilter], () => {
  pickerActive.value = 0;
});
watch(pickerActive, async (index) => {
  await nextTick();
  pickerList.value?.querySelector(`#${PICKER_LIST_ID}-${index}`)?.scrollIntoView({ block: "nearest" });
});

function onPickerKeydown(event: KeyboardEvent): void {
  const last = pickerMatches.value.length - 1;
  if (event.key === "ArrowDown") {
    event.preventDefault();
    pickerActive.value = Math.min(pickerActive.value + 1, Math.max(last, 0));
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    pickerActive.value = Math.max(pickerActive.value - 1, 0);
  } else if (event.key === "Enter") {
    event.preventDefault();
    const node = pickerMatches.value[pickerActive.value];
    if (node) toggleNode(node.id);
  } else if (event.key === "Escape") {
    pickerOpen.value = false;
  }
}

const block = computed(() =>
  captureBlock({
    canAdmin: ctx.canAdmin.value,
    storeReady: ctx.storeReady.value,
    nodeIds: chosen.value,
    sessions: ctx.sessions.data.value ?? [],
    sessionsKnown: sessionsKnown.value,
    nowMs: now.value.getTime(),
  }),
);

const blockReason = computed(() => {
  switch (block.value) {
    case "needs-admin":
      return t("platform.evidence.capture.blockAdmin", { scope: "log:admin" });
    case "store-off":
      return t("platform.evidence.capture.blockStoreOff");
    case "sessions-unread":
      return ctx.sessions.error.value
        ? t("platform.evidence.capture.blockSessionsFailed")
        : t("platform.evidence.capture.blockSessionsLoading");
    case "no-nodes":
      return t("platform.evidence.capture.blockNoNodes");
    case "limit-total":
      return t("platform.evidence.capture.blockLimitTotal");
    case "limit-node":
      return t("platform.evidence.capture.blockLimitNode");
    default:
      return "";
  }
});

const durationLabel = (seconds: number) => t(`platform.evidence.capture.durations.s${seconds}`);

/**
 * What pressing the button does, said before it is pressed: which nodes, for
 * how long, and the method and audit entry it goes through, so an agent
 * reading the screen can make the same call.
 */
const consequence = computed(() =>
  t(
    "platform.evidence.capture.consequence",
    { count: chosen.value.length, duration: durationLabel(Number(duration.value)) },
    chosen.value.length,
  ),
);

async function startCapture(): Promise<void> {
  if (block.value || starting.value) return;
  starting.value = true;
  startError.value = "";
  const names = chosen.value.map((id) => ctx.nodeLabel(id));
  try {
    const created = await api.trace.startSession(
      captureRequest(chosen.value, Number(duration.value), captureSessionName(names, new Date())),
    );
    toast.success(t("platform.evidence.capture.started", { count: names.length }, names.length));
    chosen.value = [];
    await ctx.sessions.refresh();
    void ctx.lastHour.refresh();
    await focusCaptureRow(created.id);
  } catch (error) {
    startError.value = error instanceof Error ? error.message : t("platform.trace.sessionStartFailed");
  } finally {
    starting.value = false;
  }
}

/**
 * After a start, focus lands on the capture it made, not on the page body
 * (the Start button disables itself once the chosen nodes clear). If the list
 * has not caught up, the section heading takes it instead.
 */
const runningList = ref<HTMLElement | null>(null);
const captureTitle = ref<HTMLElement | null>(null);
async function focusCaptureRow(id: string): Promise<void> {
  await nextTick();
  const row = runningList.value?.querySelector<HTMLElement>(`[data-session-id="${CSS.escape(id)}"]`);
  (row ?? captureTitle.value)?.focus();
}

async function stopCapture(session: TraceSession): Promise<void> {
  if (!ctx.canAdmin.value || stoppingId.value) return;
  stoppingId.value = session.id;
  try {
    await api.trace.stopSession(session.id);
    toast.success(t("platform.trace.sessionStopped", { name: session.name || session.id }));
    await ctx.sessions.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("platform.trace.sessionStopFailed"));
  } finally {
    stoppingId.value = "";
  }
}

function sessionNodes(session: TraceSession): string {
  const ids = session.filter?.node_ids ?? [];
  if (ids.length === 0) return t("platform.evidence.capture.allNodes");
  return ids.map((id) => ctx.nodeLabel(id)).join(", ");
}

/* ------------------------------------------------------------------ */
/* The headline                                                        */
/* ------------------------------------------------------------------ */

type Headline = "storeoff" | "loading" | "unread" | "capturing" | "policy" | "idle";

const headline = computed<Headline>(() => {
  // A known server state, not a failure: say it once instead of three errors.
  if (!ctx.storeReady.value) return "storeoff";
  if (running.value.length > 0) return "capturing";
  if (ctx.policies.error.value || ctx.sessions.error.value) return "unread";
  if (!ctx.coverageKnown.value || !sessionsKnown.value) return "loading";
  return collecting.value > 0 ? "policy" : "idle";
});

/* ------------------------------------------------------------------ */
/* The last hour                                                       */
/* ------------------------------------------------------------------ */

const summary = computed(() => ctx.lastHourSummary.value);
const sample = computed(() => ctx.lastHour.data.value);
/** The store holds records but none started in the last hour. */
const quietHour = computed(
  () => !!sample.value && sample.value.records.length === 0 && (sample.value.collectedTotal ?? 0) > 0,
);
const connectionsFigure = computed(() => {
  const s = summary.value;
  if (!s) return "";
  return s.capped ? t("platform.evidence.overview.atLeast", { count: s.total }) : String(s.total);
});
const failureMax = computed(() => Math.max(1, ...(summary.value?.failures ?? []).map((entry) => entry.count)));
const destinationMax = computed(() => Math.max(1, ...(summary.value?.destinations ?? []).map((entry) => entry.count)));

function barWidth(count: number, max: number): number {
  return Math.max(2, Math.round((count / max) * 100));
}

function reasonFill(reason: string): string {
  return closeReasonDisplay(reason).tone === "destructive" ? "fill-destructive" : "fill-warning";
}

/* ------------------------------------------------------------------ */
/* Coverage                                                            */
/* ------------------------------------------------------------------ */

const showQuiet = ref(false);
const activeRows = computed(() => ctx.coverageRows.value.filter((row) => !row.quiet));
const quietRows = computed(() => ctx.coverageRows.value.filter((row) => row.quiet));
const visibleRows = computed(() => (showQuiet.value ? ctx.coverageRows.value : activeRows.value));
// Only when the hour holds records; a column of zeros says nothing the
// headline above it has not.
const showLastHour = computed(() => !!summary.value);
/** The policy list and the source list both failed: nothing about coverage is known. */
const coverageUnread = computed(() => !!ctx.policies.error.value && !!ctx.sources.error.value && ctx.storeReady.value);
const coverageLoading = computed(
  () => ctx.policies.data.value === undefined && !ctx.policies.error.value && ctx.coverageRows.value.length === 0,
);
</script>

<template>
  <div class="space-y-6">
    <!-- ── Collection and the one action ─────────────────────────────── -->
    <section class="rounded-lg border border-border bg-card" aria-labelledby="evidence-capture-title">
      <div class="space-y-1 border-b border-border px-4 py-4 sm:px-5">
        <h2 id="evidence-capture-title" ref="captureTitle" tabindex="-1" class="text-base font-semibold tracking-[-0.01em] outline-none">
          <template v-if="headline === 'capturing'">
            {{ $t('platform.evidence.overview.capturingTitle', { count: running.length }, running.length) }}
          </template>
          <template v-else-if="headline === 'policy'">
            {{ $t('platform.evidence.overview.policyTitle', { count: collecting }, collecting) }}
          </template>
          <template v-else-if="headline === 'unread'">{{ $t('platform.evidence.overview.unreadTitle') }}</template>
          <template v-else-if="headline === 'storeoff'">{{ $t('platform.evidence.overview.storeOffTitle') }}</template>
          <template v-else-if="headline === 'loading'">{{ $t('platform.evidence.overview.loadingTitle') }}</template>
          <template v-else>{{ $t('platform.evidence.overview.idleTitle') }}</template>
        </h2>
        <p class="max-w-3xl text-sm text-muted-foreground">
          <template v-if="headline === 'unread'">{{ $t('platform.evidence.overview.unreadBody') }}</template>
          <template v-else-if="headline === 'storeoff'">{{ $t('platform.evidence.overview.storeOffBody') }}</template>
          <template v-else-if="headline === 'policy'">{{ $t('platform.evidence.overview.policyBody') }}</template>
          <template v-else-if="headline === 'capturing'">{{ $t('platform.evidence.overview.capturingBody') }}</template>
          <template v-else>{{ $t('platform.evidence.overview.idleBody') }}</template>
        </p>
        <Button
          v-if="headline === 'unread'"
          variant="outline"
          size="sm"
          class="mt-2"
          @click="() => { ctx.policies.refresh(); ctx.sessions.refresh(); }"
        >
          <RefreshCw aria-hidden="true" class="size-4" />
          {{ $t('common.actions.retry') }}
        </Button>
      </div>

      <!-- Running captures: what is collecting now, until when, and what it
           has kept so far. Dropped lines stay visible; a capture that lost
           lines under budget must not read as a quiet network. -->
      <ul v-if="running.length" ref="runningList" class="divide-y divide-border border-b border-border">
        <!-- Focusable only by script (after a start), so the ring shows on
             any focus: it is the "here is your capture" cue. -->
        <li
          v-for="session in running"
          :key="session.id"
          :data-session-id="session.id"
          tabindex="-1"
          class="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 outline-none focus:outline-2 focus:-outline-offset-2 focus:outline-ring sm:px-5"
        >
          <div class="min-w-0 flex-1 basis-56">
            <p class="truncate text-sm font-medium" :title="session.name">{{ sessionNodes(session) }}</p>
            <p class="font-mono text-xs tabular text-muted-foreground">
              {{ $t('platform.evidence.capture.endsAt', { at: formatDateTime(session.expires_at), rel: formatRelativeTime(session.expires_at) }) }}
              · {{ $t('platform.evidence.capture.kept', { records: session.records, lines: session.lines }) }}
              <span v-if="session.dropped > 0" class="text-warning-text" :title="$t('platform.trace.droppedHint')">
                · {{ $t('platform.evidence.capture.dropped', { count: session.dropped }) }}
              </span>
            </p>
          </div>
          <div class="flex shrink-0 items-center gap-2">
            <Button as-child variant="outline" size="sm">
              <RouterLink :to="exploreTo({ sessionId: session.id }, 'all')">
                {{ $t('platform.evidence.capture.explore') }}
              </RouterLink>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              :disabled="!ctx.canAdmin.value || stoppingId === session.id"
              :title="ctx.canAdmin.value ? undefined : $t('platform.trace.needsAdmin', { scope: 'log:admin' })"
              @click="stopCapture(session)"
            >
              <CircleStop aria-hidden="true" class="size-4" />
              {{ $t('platform.trace.sessionStop') }}
            </Button>
          </div>
        </li>
      </ul>

      <!-- The capture form: nodes, a duration, and the one solid button. -->
      <form class="space-y-3 px-4 py-4 sm:px-5" @submit.prevent="startCapture">
        <div class="flex flex-wrap items-center gap-x-4 gap-y-3">
          <div class="flex min-w-0 flex-wrap items-center gap-2">
            <span class="text-sm text-muted-foreground">{{ $t('platform.evidence.capture.nodesLabel') }}</span>
            <span
              v-for="id in chosen"
              :key="id"
              class="inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-muted/40 py-0.5 pr-1 pl-2.5 text-xs"
            >
              <span class="truncate">{{ ctx.nodeLabel(id) }}</span>
              <button
                type="button"
                class="rounded-full p-0.5 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                :aria-label="$t('platform.evidence.capture.removeNode', { name: ctx.nodeLabel(id) })"
                @click="toggleNode(id)"
              >
                <X aria-hidden="true" class="size-3" />
              </button>
            </span>
            <PopoverRoot v-model:open="pickerOpen">
              <PopoverTrigger as-child>
                <Button type="button" variant="outline" size="sm" :disabled="nodeChoices.length === 0">
                  <Plus aria-hidden="true" class="size-4" />
                  {{ chosen.length ? $t('platform.evidence.capture.addMore') : $t('platform.evidence.capture.addNode') }}
                </Button>
              </PopoverTrigger>
              <PopoverPortal>
                <PopoverContent
                  :side-offset="6"
                  align="start"
                  class="z-50 w-72 rounded-md border bg-popover p-2 text-popover-foreground shadow-lg outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
                >
                  <Input
                    v-model="pickerFilter"
                    class="h-8 text-sm"
                    role="combobox"
                    aria-autocomplete="list"
                    aria-expanded="true"
                    :aria-controls="PICKER_LIST_ID"
                    :aria-activedescendant="pickerMatches.length ? `${PICKER_LIST_ID}-${pickerActive}` : undefined"
                    :aria-label="$t('platform.evidence.capture.filterNodes')"
                    :placeholder="$t('platform.evidence.capture.filterNodes')"
                    @keydown="onPickerKeydown"
                  />
                  <ul
                    :id="PICKER_LIST_ID"
                    ref="pickerList"
                    class="mt-2 max-h-64 overflow-y-auto"
                    role="listbox"
                    aria-multiselectable="true"
                    :aria-label="$t('platform.evidence.capture.nodesLabel')"
                  >
                    <!-- mousedown is held so a click keeps focus in the field
                         and the arrows keep working after it. -->
                    <li
                      v-for="(node, index) in pickerMatches"
                      :id="`${PICKER_LIST_ID}-${index}`"
                      :key="node.id"
                      role="option"
                      :aria-selected="chosen.includes(node.id)"
                      :data-active="index === pickerActive || undefined"
                      class="flex cursor-pointer items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-sm data-[active]:bg-muted"
                      @mousedown.prevent
                      @pointermove="pickerActive = index"
                      @click="toggleNode(node.id)"
                    >
                      <span class="truncate">{{ node.name }}</span>
                      <span v-if="chosen.includes(node.id)" class="text-xs text-primary">{{ $t('platform.evidence.capture.chosen') }}</span>
                    </li>
                    <li v-if="pickerMatches.length === 0" class="px-2 py-1.5 text-xs text-muted-foreground">
                      {{ $t('platform.evidence.capture.noNodeMatches') }}
                    </li>
                  </ul>
                </PopoverContent>
              </PopoverPortal>
            </PopoverRoot>
          </div>

          <div class="flex items-center gap-2">
            <span class="text-sm text-muted-foreground">{{ $t('platform.evidence.capture.forLabel') }}</span>
            <Select v-model="duration">
              <SelectTrigger class="w-36" :aria-label="$t('platform.evidence.capture.forLabel')">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem v-for="seconds in CAPTURE_DURATIONS" :key="seconds" :value="String(seconds)">
                  {{ durationLabel(seconds) }}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button
            type="submit"
            class="ms-auto"
            :disabled="!!block || starting"
            :title="blockReason || undefined"
            data-testid="start-capture"
          >
            <RefreshCw v-if="starting" aria-hidden="true" class="size-4 animate-spin" />
            <Play v-else aria-hidden="true" class="size-4" />
            {{ $t('platform.evidence.capture.start') }}
          </Button>
        </div>

        <p v-if="blockReason" class="text-xs text-muted-foreground" data-testid="capture-block">{{ blockReason }}</p>
        <p v-else class="font-mono text-xs tabular text-muted-foreground">{{ consequence }}</p>
        <p v-if="startError" class="text-xs text-destructive" role="alert">
          {{ $t('platform.evidence.capture.failed', { reason: startError }) }}
        </p>
      </form>
    </section>

    <!-- ── Coverage per node ──────────────────────────────────────────── -->
    <section class="space-y-2" aria-labelledby="evidence-nodes-title">
      <div class="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="evidence-nodes-title" class="text-sm font-semibold tracking-[-0.01em]">
          {{ $t('platform.evidence.overview.nodesTitle') }}
        </h2>
        <p v-if="ctx.policies.error.value && ctx.storeReady.value && !coverageUnread" class="text-xs text-destructive">
          {{ $t('platform.evidence.overview.policiesFailed') }}
        </p>
      </div>

      <div v-if="coverageLoading" class="space-y-2">
        <Skeleton v-for="n in 4" :key="n" class="h-9 w-full" />
      </div>
      <!-- Neither list loaded: one honest block, not a table of guesses. -->
      <div
        v-else-if="coverageUnread"
        class="flex flex-wrap items-center justify-between gap-3 rounded-md border border-destructive/40 bg-destructive/5 p-4"
        role="alert"
      >
        <p class="text-sm">{{ $t('platform.evidence.overview.nodesUnread') }}</p>
        <Button variant="outline" size="sm" @click="() => { ctx.policies.refresh(); ctx.sources.refresh(); ctx.logStats.refresh(); }">
          <RefreshCw aria-hidden="true" class="size-4" />
          {{ $t('common.actions.retry') }}
        </Button>
      </div>
      <p v-else-if="ctx.coverageRows.value.length === 0" class="rounded-md border border-dashed border-border p-4 text-sm text-muted-foreground">
        {{ $t('platform.trace.noVisibleNodesDescription') }}
      </p>
      <div v-else-if="visibleRows.length" class="relative overflow-x-auto rounded-md border border-border">
        <table class="w-full min-w-[680px] text-sm">
          <thead>
            <tr class="border-b border-border text-left text-xs text-muted-foreground">
              <th scope="col" class="pin-start px-3 py-2 font-medium">{{ $t('platform.evidence.overview.colNode') }}</th>
              <th scope="col" class="px-3 py-2 font-medium">{{ $t('platform.evidence.overview.colTrace') }}</th>
              <th scope="col" class="px-3 py-2 font-medium">{{ $t('platform.evidence.overview.colRawLog') }}</th>
              <th scope="col" class="px-3 py-2 text-right font-medium">{{ $t('platform.evidence.overview.colHeld') }}</th>
              <th v-if="showLastHour" scope="col" class="px-3 py-2 text-right font-medium">{{ $t('platform.evidence.overview.colLastHour') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in visibleRows" :key="row.nodeId" class="border-b border-border last:border-b-0">
              <th scope="row" class="pin-start px-3 py-2 text-left font-medium">
                <span class="block truncate" :title="row.nodeId">{{ row.name }}</span>
              </th>
              <td class="px-3 py-2 whitespace-nowrap">
                <Badge v-if="row.capturing > 0" variant="info" :title="$t('platform.evidence.overview.capturingUntil', { at: formatDateTime(row.captureEndsAt) })">
                  {{ $t('platform.evidence.overview.traceCapturing') }}
                </Badge>
                <span v-else-if="row.trace?.enabled" class="text-sm">
                  {{ $t('platform.evidence.overview.traceOn') }}
                  <span class="font-mono text-xs text-muted-foreground">{{ row.trace.level }}</span>
                </span>
                <span v-else-if="!ctx.storeReady.value" class="text-xs text-muted-foreground">{{ $t('platform.evidence.overview.traceServerOff') }}</span>
                <span v-else-if="row.trace" class="text-sm text-muted-foreground">{{ $t('platform.evidence.overview.traceOff') }}</span>
                <span v-else class="text-xs text-muted-foreground">{{ $t('platform.evidence.overview.unread') }}</span>
              </td>
              <td class="px-3 py-2">
                <span v-if="!row.sourcesKnown" class="text-xs text-muted-foreground">{{ $t('platform.evidence.overview.unread') }}</span>
                <span v-else-if="row.sources.length === 0" class="text-sm text-muted-foreground">{{ $t('platform.evidence.overview.noSource') }}</span>
                <ul v-else class="space-y-0.5">
                  <li v-for="source in row.sources" :key="source.id" class="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    <RouterLink
                      :to="exploreTo({ sourceId: source.id, nodeId: row.nodeId }, 'all')"
                      class="text-sm hover:underline"
                      :class="!source.enabled && 'text-muted-foreground'"
                    >
                      {{ source.name }}
                    </RouterLink>
                    <span class="font-mono text-xs tabular text-muted-foreground">
                      {{ source.lastIngestAt
                        ? $t('platform.evidence.overview.lastIngest', { at: formatDateTime(source.lastIngestAt) })
                        : $t('platform.evidence.overview.neverShipped') }}
                    </span>
                    <Badge
                      v-if="source.stale && source.lastIngestAt"
                      variant="warning"
                      :title="$t('platform.evidence.overview.staleHint')"
                    >
                      {{ $t('platform.evidence.overview.stale') }}
                    </Badge>
                    <span v-if="!source.enabled" class="text-xs text-muted-foreground">{{ $t('common.status.disabled') }}</span>
                  </li>
                </ul>
              </td>
              <td class="px-3 py-2 text-right font-mono text-xs tabular whitespace-nowrap">
                <span v-if="row.heldLines === undefined" class="text-muted-foreground">{{ $t('platform.evidence.overview.unread') }}</span>
                <span v-else :class="row.heldLines === 0 && 'text-muted-foreground'">
                  {{ $t('platform.evidence.overview.heldLines', { count: row.heldLines }, row.heldLines) }}
                </span>
              </td>
              <td v-if="showLastHour" class="px-3 py-2 text-right font-mono text-xs tabular">
                <span :class="!row.lastHour && 'text-muted-foreground'">{{ row.lastHour ?? 0 }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <!-- Rows that would all read "off, none, 0" collapse into one line
           that says so, instead of a screen of identical rows. It sits under
           the table, outside its scroller, so the toggle is reachable at
           phone width. -->
      <div v-if="quietRows.length && !coverageUnread" class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-1">
        <p class="text-sm text-muted-foreground">
          {{ showQuiet
            ? $t('platform.evidence.overview.quietShown', { count: quietRows.length }, quietRows.length)
            : activeRows.length
              ? $t('platform.evidence.overview.quietRows', { count: quietRows.length }, quietRows.length)
              : $t('platform.evidence.overview.quietAll', { count: quietRows.length }, quietRows.length) }}
        </p>
        <Button variant="ghost" size="sm" :aria-expanded="showQuiet" @click="showQuiet = !showQuiet">
          {{ showQuiet ? $t('platform.evidence.overview.hideQuiet') : $t('platform.evidence.overview.showQuiet', { count: quietRows.length }, quietRows.length) }}
        </Button>
      </div>
    </section>

    <!-- ── The last hour ─────────────────────────────────────────────── -->
    <section v-if="summary" class="space-y-4" aria-labelledby="evidence-hour-title">
      <h2 id="evidence-hour-title" class="text-sm font-semibold tracking-[-0.01em]">
        {{ $t('platform.evidence.overview.hourTitle') }}
      </h2>
      <dl class="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
        <div>
          <dt class="text-xs text-muted-foreground">{{ $t('platform.evidence.overview.connections') }}</dt>
          <dd class="font-mono text-2xl font-semibold tabular">
            <RouterLink :to="exploreTo({})" class="rounded-sm outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:items-center">
              {{ connectionsFigure }}
            </RouterLink>
          </dd>
        </div>
        <div>
          <dt class="text-xs text-muted-foreground">{{ $t('platform.evidence.overview.failures') }}</dt>
          <dd class="font-mono text-2xl font-semibold tabular">
            <RouterLink
              :to="exploreTo({ closeReasons: summary.failures.map((entry) => entry.value) })"
              class="rounded-sm outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:items-center"
            >
              {{ summary.failureTotal }}
            </RouterLink>
          </dd>
        </div>
        <div>
          <dt class="text-xs text-muted-foreground">{{ $t('platform.evidence.overview.nodesReporting') }}</dt>
          <dd class="font-mono text-2xl font-semibold tabular">{{ summary.byNode.size }}</dd>
        </div>
      </dl>

      <div class="grid grid-cols-1 min-w-0 gap-6 lg:grid-cols-2">
        <div class="space-y-2">
          <h3 class="text-xs font-medium text-muted-foreground">{{ $t('platform.evidence.overview.failuresByReason') }}</h3>
          <p v-if="summary.failures.length === 0" class="text-sm text-muted-foreground">
            {{ $t('platform.evidence.overview.noFailures') }}
          </p>
          <ul v-else class="space-y-1">
            <li v-for="entry in summary.failures" :key="entry.value">
              <RouterLink
                :to="exploreTo({ closeReasons: [entry.value] })"
                class="grid grid-cols-[9rem_minmax(0,1fr)_3.5rem] items-center gap-3 rounded-sm px-1 py-1 text-sm outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11"
              >
                <span class="truncate">{{ $t(`platform.trace.closeReason.${entry.value}`) }}</span>
                <svg
                  class="h-3 w-full"
                  viewBox="0 0 100 12"
                  preserveAspectRatio="none"
                  role="img"
                  :aria-label="$t('platform.evidence.overview.barLabel', { label: $t(`platform.trace.closeReason.${entry.value}`), count: entry.count })"
                >
                  <rect x="0" y="0" width="100" height="12" class="fill-muted" />
                  <rect x="0" y="0" :width="barWidth(entry.count, failureMax)" height="12" :class="reasonFill(entry.value)" />
                </svg>
                <span class="text-right font-mono text-xs tabular">{{ entry.count }}</span>
              </RouterLink>
            </li>
          </ul>
        </div>
        <div class="space-y-2">
          <h3 class="text-xs font-medium text-muted-foreground">{{ $t('platform.evidence.overview.topDestinations') }}</h3>
          <ul class="space-y-1">
            <li v-for="entry in summary.destinations" :key="entry.value">
              <RouterLink
                :to="exploreTo({ dst: entry.value })"
                class="grid grid-cols-[minmax(0,12rem)_minmax(0,1fr)_3.5rem] items-center gap-3 rounded-sm px-1 py-1 text-sm outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11"
              >
                <span class="truncate font-mono text-xs" :title="entry.value">{{ entry.value }}</span>
                <svg
                  class="h-3 w-full"
                  viewBox="0 0 100 12"
                  preserveAspectRatio="none"
                  role="img"
                  :aria-label="$t('platform.evidence.overview.barLabel', { label: entry.value, count: entry.count })"
                >
                  <rect x="0" y="0" width="100" height="12" class="fill-muted" />
                  <rect x="0" y="0" :width="barWidth(entry.count, destinationMax)" height="12" class="fill-muted-foreground/60" />
                </svg>
                <span class="text-right font-mono text-xs tabular">{{ entry.count }}</span>
              </RouterLink>
            </li>
          </ul>
        </div>
      </div>
      <p v-if="summary.capped" class="text-xs text-muted-foreground">
        {{ $t('platform.evidence.overview.cappedNote', { count: summary.total }) }}
      </p>
    </section>

    <!-- Records exist, just not recently: say when the newest one is, and
         open all of them rather than an empty hour. -->
    <p v-else-if="quietHour" class="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
      <span>
        {{ sample?.collectedNewestAt
          ? $t('platform.evidence.overview.quietHourNewest', { newest: formatDateTime(sample.collectedNewestAt) })
          : $t('platform.evidence.overview.quietHour') }}
      </span>
      <RouterLink :to="exploreTo({}, 'all')" class="text-primary hover:underline">
        {{ $t('platform.evidence.overview.exploreAll') }}
      </RouterLink>
    </p>
    <p v-else-if="ctx.lastHour.error.value && ctx.storeReady.value" class="text-sm text-destructive" role="alert">
      {{ $t('platform.evidence.overview.hourFailed', { reason: ctx.lastHour.error.value.message }) }}
    </p>
  </div>
</template>
