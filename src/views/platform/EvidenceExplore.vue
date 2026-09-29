<script setup lang="ts">
/**
 * Evidence Explore (L1): one toolbar, one question.
 *
 * The toolbar holds a time range, a lens switch (connection records or the
 * raw log lines they were assembled from) and one query field. The field
 * speaks in tokens (`node:`, `user:`, `line:`, `dest:`, `reason:`, `kind:`,
 * `session:`, `source:`, `stalled`, `open`) plus free text; the Filters
 * popover offers the enumerable choices and writes them into the field as
 * tokens, so there is one place a filter lives. Every filter is in the
 * address bar under the names the HTTP contract uses (evidenceModel).
 *
 * A connection row opens the side panel at `?conn=`, so a refresh or a pasted
 * link lands on the same connection.
 */
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useRoute, useRouter } from "vue-router";
import { PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from "reka-ui";
import { Search, SlidersHorizontal, X } from "lucide-vue-next";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

import EvidenceConnPanel from "./EvidenceConnPanel.vue";
import EvidenceConnections from "./EvidenceConnections.vue";
import EvidenceRawLog from "./EvidenceRawLog.vue";
import {
  CLOSE_REASONS,
  TRACE_RANGES,
  USER_KINDS,
  readConnTraceFilters,
  writeConnTraceFilters,
  type TraceRange,
} from "./connTraceModel";
import { useEvidenceContext } from "./evidenceContext";
import {
  EMPTY_EVIDENCE_QUERY,
  EVIDENCE_LENSES,
  EVIDENCE_PARAM,
  connectionOnlyTokens,
  formatEvidenceQuery,
  parseEvidenceQuery,
  readEvidenceQuery,
  resolveEvidenceLens,
  writeEvidenceQuery,
  type EvidenceLens,
  type EvidenceQuery,
} from "./evidenceModel";
import type { ConnRecord } from "@/lib/api";

const { t } = useI18n();
const route = useRoute();
const router = useRouter();
const ctx = useEvidenceContext();

/* ------------------------------------------------------------------ */
/* Lens and range                                                      */
/* ------------------------------------------------------------------ */

const lens = computed<EvidenceLens>(() => resolveEvidenceLens(route.query));

function setLens(next: EvidenceLens): void {
  if (next === lens.value) return;
  const query = { ...route.query };
  delete query[EVIDENCE_PARAM.conn];
  if (next === "connections") delete query[EVIDENCE_PARAM.lens];
  else query[EVIDENCE_PARAM.lens] = next;
  router.push({ query }).catch(() => {});
}

const range = computed(() => readConnTraceFilters(route.query));

function setRange(value: string): void {
  const filters = readConnTraceFilters(route.query);
  filters.range = value as TraceRange;
  router.replace({ query: writeConnTraceFilters(route.query, filters) }).catch(() => {});
}

/** datetime-local speaks local wall time; the filter state speaks ISO. */
function toLocalInput(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function setBound(which: "since" | "until", value: string): void {
  const filters = readConnTraceFilters(route.query);
  const ms = value ? Date.parse(value) : Number.NaN;
  filters[which] = Number.isNaN(ms) ? "" : new Date(ms).toISOString();
  router.replace({ query: writeConnTraceFilters(route.query, filters) }).catch(() => {});
}

/* ------------------------------------------------------------------ */
/* The query field                                                     */
/* ------------------------------------------------------------------ */

const applied = computed(() => readEvidenceQuery(route.query));
const appliedText = computed(() => formatEvidenceQuery(applied.value, ctx.resolvers.value));

/** What the field shows. It follows the address bar until the operator edits it. */
const draft = ref(appliedText.value);
const editing = ref(false);
watch(appliedText, (text) => {
  if (!editing.value) draft.value = text;
});

const parsed = computed(() => parseEvidenceQuery(draft.value, ctx.resolvers.value));

function applyQuery(next: EvidenceQuery): void {
  const query = writeEvidenceQuery(route.query, next);
  delete query[EVIDENCE_PARAM.conn];
  editing.value = false;
  draft.value = formatEvidenceQuery(next, ctx.resolvers.value);
  router.replace({ query }).catch(() => {});
}

/**
 * What the last search dropped or could not resolve. Submitting rewrites the
 * field in its canonical spelling, which no longer contains the dropped
 * token, so the note is kept until the operator edits the field again.
 */
const submittedProblems = ref<typeof parsed.value.problems>([]);

function submit(): void {
  const { query, problems } = parsed.value;
  applyQuery(query);
  submittedProblems.value = problems;
}

function clearQuery(): void {
  submittedProblems.value = [];
  applyQuery({ ...EMPTY_EVIDENCE_QUERY, closeReasons: [], userKinds: [] });
}

function searchAnyTime(): void {
  setRange("all");
}

/** Problems with what was typed, named per token. */
const PROBLEM_KEY = {
  "empty-value": "platform.evidence.explore.problemEmpty",
  "unknown-value": "platform.evidence.explore.problemUnknown",
  unresolved: "platform.evidence.explore.problemUnresolved",
} as const;
const problems = computed(() =>
  (editing.value ? parsed.value.problems : submittedProblems.value).map((problem) => t(PROBLEM_KEY[problem.kind], { token: problem.token })),
);

/** Tokens that only mean something for connections, present while reading the raw log. */
const ignoredInLog = computed(() => (lens.value === "log" ? connectionOnlyTokens(applied.value) : []));

/* Filters popover --------------------------------------------------- */

/** The popover edits what the field says right now, typed or applied. */
function editDraft(mutate: (query: EvidenceQuery) => void): void {
  const next = parseEvidenceQuery(draft.value, ctx.resolvers.value).query;
  mutate(next);
  applyQuery(next);
}

function toggleIn(list: string[], value: string, order: readonly string[]): string[] {
  const set = new Set(list);
  if (set.has(value)) set.delete(value);
  else set.add(value);
  return order.filter((entry) => set.has(entry));
}

const filterCount = computed(() => {
  const q = applied.value;
  return (
    q.closeReasons.length +
    q.userKinds.length +
    (q.stalledOnly ? 1 : 0) +
    (q.includeOpen ? 1 : 0) +
    (q.sessionId ? 1 : 0) +
    (q.sourceId ? 1 : 0)
  );
});

const sessionChoices = computed(() => (ctx.sessions.data.value ?? []).slice(0, 8));
const sourceChoices = computed(() => ctx.sources.data.value ?? []);

/* ------------------------------------------------------------------ */
/* Side panel                                                          */
/* ------------------------------------------------------------------ */

const connKey = computed(() => {
  const raw = route.query[EVIDENCE_PARAM.conn];
  return typeof raw === "string" ? raw : "";
});
const loadedRecord = ref<ConnRecord | undefined>();

function openRecord(payload: { key: string; record: ConnRecord }): void {
  loadedRecord.value = payload.record;
  router.push({ query: { ...route.query, [EVIDENCE_PARAM.conn]: payload.key } }).catch(() => {});
}

function closeRecord(): void {
  const query = { ...route.query };
  delete query[EVIDENCE_PARAM.conn];
  router.replace({ query }).catch(() => {});
}

function onRecordsLoaded(lookup: (key: string) => ConnRecord | undefined): void {
  if (connKey.value) loadedRecord.value = lookup(connKey.value) ?? loadedRecord.value;
}
</script>

<template>
  <div class="space-y-4">
    <!-- ── The toolbar ───────────────────────────────────────────────── -->
    <form class="flex flex-wrap items-center gap-2" role="search" @submit.prevent="submit">
      <Select :model-value="range.range" @update:model-value="(v) => setRange(String(v))">
        <SelectTrigger class="w-36 sm:w-40" :aria-label="$t('platform.trace.rangeLabel')">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem v-for="value in TRACE_RANGES" :key="value" :value="value">
            {{ $t(`platform.trace.range.${value}`) }}
          </SelectItem>
        </SelectContent>
      </Select>

      <div
        class="inline-flex h-9 items-center rounded-md border border-border p-0.5"
        role="group"
        :aria-label="$t('platform.evidence.explore.lensLabel')"
      >
        <button
          v-for="name in EVIDENCE_LENSES"
          :key="name"
          type="button"
          :aria-pressed="lens === name"
          :class="cn(
            'h-full rounded-[3px] px-3 text-sm font-medium whitespace-nowrap outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
            lens === name ? 'bg-muted text-foreground' : 'text-muted-foreground hover:text-foreground',
          )"
          @click="setLens(name)"
        >
          {{ name === 'log' ? $t('platform.evidence.lensLog') : $t('platform.evidence.lensConnections') }}
        </button>
      </div>

      <div class="relative min-w-0 flex-1 basis-full sm:basis-72">
        <Search aria-hidden="true" class="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          v-model="draft"
          class="pr-8 pl-8 font-mono text-xs"
          autocomplete="off"
          spellcheck="false"
          :aria-label="$t('platform.evidence.explore.queryLabel')"
          :placeholder="lens === 'log' ? $t('platform.evidence.explore.queryPlaceholderLog') : $t('platform.evidence.explore.queryPlaceholder')"
          data-testid="evidence-query"
          @input="editing = true"
          @keydown.escape="() => { editing = false; draft = appliedText; }"
        />
        <button
          v-if="draft"
          type="button"
          class="absolute top-1/2 right-2 -translate-y-1/2 rounded-sm p-0.5 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          :aria-label="$t('platform.evidence.explore.clearQuery')"
          @click="clearQuery"
        >
          <X aria-hidden="true" class="size-4" />
        </button>
      </div>

      <PopoverRoot>
        <PopoverTrigger as-child>
          <Button type="button" variant="outline" data-testid="evidence-filters">
            <SlidersHorizontal aria-hidden="true" class="size-4" />
            {{ $t('platform.trace.filtersTitle') }}
            <span v-if="filterCount" class="font-mono text-xs tabular text-muted-foreground">{{ filterCount }}</span>
          </Button>
        </PopoverTrigger>
        <PopoverPortal>
          <PopoverContent
            :side-offset="6"
            align="end"
            :collision-padding="12"
            class="z-50 max-h-[min(32rem,var(--reka-popover-content-available-height))] w-[min(22rem,calc(100vw-24px))] overflow-y-auto rounded-md border bg-popover p-3 text-popover-foreground shadow-lg outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
          >
            <p class="mb-3 text-xs text-muted-foreground">{{ $t('platform.evidence.explore.filtersHint') }}</p>
            <template v-if="lens === 'connections'">
              <fieldset class="space-y-1.5">
                <legend class="mb-1 text-xs font-medium text-muted-foreground">{{ $t('platform.trace.closeReasonLabel') }}</legend>
                <label v-for="reason in CLOSE_REASONS" :key="reason" class="flex cursor-pointer items-center gap-2 text-sm">
                  <Checkbox
                    :model-value="applied.closeReasons.includes(reason)"
                    @update:model-value="() => editDraft((q) => { q.closeReasons = toggleIn(q.closeReasons, reason, CLOSE_REASONS); })"
                  />
                  <span>{{ $t(`platform.trace.closeReason.${reason}`) }}</span>
                  <span class="ms-auto font-mono text-xs text-muted-foreground">reason:{{ reason }}</span>
                </label>
              </fieldset>
              <fieldset class="mt-4 space-y-1.5">
                <legend class="mb-1 text-xs font-medium text-muted-foreground">{{ $t('platform.trace.userKindLabel') }}</legend>
                <label v-for="kind in USER_KINDS" :key="kind" class="flex cursor-pointer items-center gap-2 text-sm">
                  <Checkbox
                    :model-value="applied.userKinds.includes(kind)"
                    @update:model-value="() => editDraft((q) => { q.userKinds = toggleIn(q.userKinds, kind, USER_KINDS); })"
                  />
                  <span>{{ $t(`platform.trace.userKind.${kind}`) }}</span>
                  <span class="ms-auto font-mono text-xs text-muted-foreground">kind:{{ kind }}</span>
                </label>
              </fieldset>
              <fieldset class="mt-4 space-y-1.5">
                <legend class="mb-1 text-xs font-medium text-muted-foreground">{{ $t('platform.evidence.explore.stateLabel') }}</legend>
                <label class="flex cursor-pointer items-center gap-2 text-sm">
                  <Checkbox :model-value="applied.stalledOnly" @update:model-value="() => editDraft((q) => { q.stalledOnly = !q.stalledOnly; })" />
                  <span>{{ $t('platform.trace.stalledOnly') }}</span>
                  <span class="ms-auto font-mono text-xs text-muted-foreground">stalled</span>
                </label>
                <label class="flex cursor-pointer items-center gap-2 text-sm">
                  <Checkbox :model-value="applied.includeOpen" @update:model-value="() => editDraft((q) => { q.includeOpen = !q.includeOpen; })" />
                  <span>{{ $t('platform.trace.includeOpen') }}</span>
                  <span class="ms-auto font-mono text-xs text-muted-foreground">open</span>
                </label>
              </fieldset>
              <fieldset v-if="sessionChoices.length" class="mt-4 space-y-1.5">
                <legend class="mb-1 text-xs font-medium text-muted-foreground">{{ $t('platform.trace.sessionLabel') }}</legend>
                <label v-for="session in sessionChoices" :key="session.id" class="flex cursor-pointer items-center gap-2 text-sm">
                  <Checkbox
                    :model-value="applied.sessionId === session.id"
                    @update:model-value="() => editDraft((q) => { q.sessionId = q.sessionId === session.id ? '' : session.id; })"
                  />
                  <span class="min-w-0 truncate" :title="session.name">{{ session.name || session.id }}</span>
                </label>
              </fieldset>
            </template>
            <template v-else>
              <fieldset class="space-y-1.5">
                <legend class="mb-1 text-xs font-medium text-muted-foreground">{{ $t('platform.logs.sourcesTitle') }}</legend>
                <p v-if="sourceChoices.length === 0" class="text-sm text-muted-foreground">{{ $t('platform.logs.sourcesEmptyTitle') }}</p>
                <label v-for="source in sourceChoices" :key="source.id" class="flex cursor-pointer items-center gap-2 text-sm">
                  <Checkbox
                    :model-value="applied.sourceId === source.id"
                    @update:model-value="() => editDraft((q) => { q.sourceId = q.sourceId === source.id ? '' : source.id; })"
                  />
                  <span class="min-w-0 truncate">{{ source.name || source.id }}</span>
                  <span class="ms-auto truncate text-xs text-muted-foreground">{{ ctx.nodeLabel(source.node_id) }}</span>
                </label>
              </fieldset>
            </template>
          </PopoverContent>
        </PopoverPortal>
      </PopoverRoot>

      <Button type="submit" variant="outline" :disabled="draft === appliedText && !editing">
        {{ $t('platform.evidence.explore.apply') }}
      </Button>

      <!-- A custom window needs its two bounds; they sit on their own row. -->
      <div v-if="range.range === 'custom'" class="flex w-full flex-wrap items-center gap-2">
        <label class="flex items-center gap-2 text-sm">
          <span class="text-muted-foreground">{{ $t('platform.trace.sinceLabel') }}</span>
          <Input
            type="datetime-local"
            class="w-auto"
            :model-value="toLocalInput(range.since)"
            @change="(e: Event) => setBound('since', (e.target as HTMLInputElement).value)"
          />
        </label>
        <label class="flex items-center gap-2 text-sm">
          <span class="text-muted-foreground">{{ $t('platform.trace.untilLabel') }}</span>
          <Input
            type="datetime-local"
            class="w-auto"
            :model-value="toLocalInput(range.until)"
            @change="(e: Event) => setBound('until', (e.target as HTMLInputElement).value)"
          />
        </label>
      </div>
    </form>

    <ul v-if="problems.length" class="space-y-0.5 text-xs text-warning-text" aria-live="polite">
      <li v-for="problem in problems" :key="problem">{{ problem }}</li>
    </ul>
    <p v-if="ignoredInLog.length" class="text-xs text-muted-foreground">
      {{ $t('platform.evidence.explore.ignoredInLog', { tokens: ignoredInLog.map((key) => `${key}:`).join(' ') }) }}
    </p>

    <EvidenceConnections
      v-if="lens === 'connections'"
      @open="openRecord"
      @loaded="onRecordsLoaded"
      @clear-query="clearQuery"
      @any-time="searchAnyTime"
    />
    <EvidenceRawLog v-else @clear-query="clearQuery" @any-time="searchAnyTime" />

    <EvidenceConnPanel :conn-key="lens === 'connections' ? connKey : ''" :record="loadedRecord" @close="closeRecord" />
  </div>
</template>
