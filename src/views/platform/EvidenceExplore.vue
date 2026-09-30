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
 *
 * The toolbar is the shared QueryBar and the field speaks the shared token
 * grammar (src/lib/queryTokens); this view keeps only what is Evidence's own:
 * the lens switch, the filter choices, and the address bar keys.
 */
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";

import QueryBar, { type QueryFilterGroup } from "@/components/common/QueryBar.vue";
import { QUERY_NAME_WAIT_MS } from "@/components/common/chassisModel";
import { bindRouteOpen } from "@/composables/useRouteOpen";
import { useOwnedRoute } from "@/composables/useOwnedRoute";
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
const owned = useOwnedRoute();
const ctx = useEvidenceContext();

/* ------------------------------------------------------------------ */
/* Lens and range                                                      */
/* ------------------------------------------------------------------ */

const lens = computed<EvidenceLens>(() => resolveEvidenceLens(owned.query()));

function setLens(next: EvidenceLens): void {
  if (next === lens.value) return;
  const query = { ...owned.query() };
  delete query[EVIDENCE_PARAM.conn];
  if (next === "connections") delete query[EVIDENCE_PARAM.lens];
  else query[EVIDENCE_PARAM.lens] = next;
  owned.push(query);
}

const range = computed(() => readConnTraceFilters(owned.query()));

function setRange(value: string): void {
  const filters = readConnTraceFilters(owned.query());
  filters.range = value as TraceRange;
  owned.replace(writeConnTraceFilters(owned.query(), filters));
}

function setBound(which: "since" | "until", iso: string): void {
  const filters = readConnTraceFilters(owned.query());
  filters[which] = iso;
  owned.replace(writeConnTraceFilters(owned.query(), filters));
}

/* ------------------------------------------------------------------ */
/* The query field                                                     */
/* ------------------------------------------------------------------ */

const bar = ref<InstanceType<typeof QueryBar> | null>(null);
const applied = computed(() => readEvidenceQuery(owned.query()));
const appliedText = computed(() => formatEvidenceQuery(applied.value, ctx.resolvers.value));
/** The applied query itself, which does not change when a name list loads and respells an id. */
const appliedKey = computed(() => JSON.stringify(applied.value));

function applyQuery(next: EvidenceQuery): void {
  const query = writeEvidenceQuery(owned.query(), next);
  delete query[EVIDENCE_PARAM.conn];
  owned.replace(query);
}

function submit(text: string): void {
  applyQuery(parseEvidenceQuery(text, ctx.resolvers.value).query);
}

function clearQuery(): void {
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

function problemsFor(text: string): string[] {
  // "does not name a known item" is only true when the list was read; with a
  // list that failed or never answered, the name was not checked at all.
  const unchecked = ctx.namesUnchecked.value;
  return parseEvidenceQuery(text, ctx.resolvers.value).problems.map((problem) =>
    t(unchecked && problem.kind === "unresolved" ? "platform.evidence.explore.problemUnchecked" : PROBLEM_KEY[problem.kind], {
      token: problem.token,
    }),
  );
}

/** Tokens that only mean something for connections, present while reading the raw log. */
const ignoredInLog = computed(() => (lens.value === "log" ? connectionOnlyTokens(applied.value) : []));

/* Filters popover --------------------------------------------------- */

/** The popover edits what the field says right now, typed or applied. */
function editDraft(mutate: (query: EvidenceQuery) => void): void {
  const next = parseEvidenceQuery(bar.value?.draft ?? appliedText.value, ctx.resolvers.value).query;
  mutate(next);
  applyQuery(next);
  bar.value?.settle(formatEvidenceQuery(next, ctx.resolvers.value));
}

/** The field's canonical spelling, written back the moment a search is applied. */
function canonicalText(text: string): string {
  return formatEvidenceQuery(parseEvidenceQuery(text, ctx.resolvers.value).query, ctx.resolvers.value);
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

/** The popover's checkboxes, each writing the token it shows. */
const filterGroups = computed<QueryFilterGroup[]>(() => {
  const q = applied.value;
  if (lens.value === "log") {
    return [
      {
        key: "source",
        legend: t("platform.logs.sourcesTitle"),
        empty: t("platform.logs.sourcesEmptyTitle"),
        options: sourceChoices.value.map((source) => ({
          key: source.id,
          label: source.name || source.id,
          hint: ctx.nodeLabel(source.node_id),
          checked: q.sourceId === source.id,
          toggle: () => editDraft((next) => { next.sourceId = next.sourceId === source.id ? "" : source.id; }),
        })),
      },
    ];
  }
  const groups: QueryFilterGroup[] = [
    {
      key: "reason",
      legend: t("platform.trace.closeReasonLabel"),
      options: CLOSE_REASONS.map((reason) => ({
        key: reason,
        label: t(`platform.trace.closeReason.${reason}`),
        token: `reason:${reason}`,
        checked: q.closeReasons.includes(reason),
        toggle: () => editDraft((next) => { next.closeReasons = toggleIn(next.closeReasons, reason, CLOSE_REASONS); }),
      })),
    },
    {
      key: "kind",
      legend: t("platform.trace.userKindLabel"),
      options: USER_KINDS.map((kind) => ({
        key: kind,
        label: t(`platform.trace.userKind.${kind}`),
        token: `kind:${kind}`,
        checked: q.userKinds.includes(kind),
        toggle: () => editDraft((next) => { next.userKinds = toggleIn(next.userKinds, kind, USER_KINDS); }),
      })),
    },
    {
      key: "state",
      legend: t("platform.evidence.explore.stateLabel"),
      options: [
        {
          key: "stalled",
          label: t("platform.trace.stalledOnly"),
          token: "stalled",
          checked: q.stalledOnly,
          toggle: () => editDraft((next) => { next.stalledOnly = !next.stalledOnly; }),
        },
        {
          key: "open",
          label: t("platform.trace.includeOpen"),
          token: "open",
          checked: q.includeOpen,
          toggle: () => editDraft((next) => { next.includeOpen = !next.includeOpen; }),
        },
      ],
    },
  ];
  if (sessionChoices.value.length) {
    groups.push({
      key: "session",
      legend: t("platform.trace.sessionLabel"),
      options: sessionChoices.value.map((session) => ({
        key: session.id,
        label: session.name || session.id,
        checked: q.sessionId === session.id,
        toggle: () => editDraft((next) => { next.sessionId = next.sessionId === session.id ? "" : session.id; }),
      })),
    });
  }
  return groups;
});

/* ------------------------------------------------------------------ */
/* Side panel                                                          */
/* ------------------------------------------------------------------ */

const sheet = bindRouteOpen(owned, EVIDENCE_PARAM.conn);
const connKey = computed(() => sheet.openId.value ?? "");
const loadedRecord = ref<ConnRecord | undefined>();

function openRecord(payload: { key: string; record: ConnRecord; opener: HTMLElement }): void {
  loadedRecord.value = payload.record;
  sheet.open(payload.key, payload.opener);
}

function onRecordsLoaded(lookup: (key: string) => ConnRecord | undefined): void {
  if (connKey.value) loadedRecord.value = lookup(connKey.value) ?? loadedRecord.value;
}
</script>

<template>
  <div class="space-y-4">
    <!-- The toolbar: range, lens, the one field, Filters, Apply. -->
    <QueryBar
      ref="bar"
      testid="evidence-query-bar"
      :applied-text="appliedText"
      :applied-key="appliedKey"
      :label="$t('platform.evidence.explore.queryLabel')"
      :placeholder="lens === 'log' ? $t('platform.evidence.explore.queryPlaceholderLog') : $t('platform.evidence.explore.queryPlaceholder')"
      :ready="ctx.namesReady.value"
      :problems="problemsFor"
      :canonical="canonicalText"
      :ranges="TRACE_RANGES"
      :range="range.range"
      :range-label="(value) => $t(`platform.trace.range.${value}`)"
      :range-aria-label="$t('platform.trace.rangeLabel')"
      :since="range.since"
      :until="range.until"
      :filter-count="filterCount"
      :filter-groups="filterGroups"
      :filters-hint="$t('platform.evidence.explore.filtersHint')"
      :resolving-text="$t('platform.evidence.explore.resolvingNames', { seconds: QUERY_NAME_WAIT_MS / 1000 })"
      @submit="submit"
      @clear="clearQuery"
      @update:range="setRange"
      @update:since="(iso) => setBound('since', iso)"
      @update:until="(iso) => setBound('until', iso)"
    >
      <template #leading>
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
      </template>
    </QueryBar>

    <p v-if="ignoredInLog.length" class="text-xs text-muted-foreground">
      {{ $t('platform.evidence.explore.ignoredInLog', { tokens: ignoredInLog.map((key) => `${key}:`).join(' ') }) }}
    </p>

    <EvidenceConnections
      v-if="lens === 'connections'"
      :active-key="connKey || null"
      @open="openRecord"
      @loaded="onRecordsLoaded"
      @clear-query="clearQuery"
      @any-time="searchAnyTime"
    />
    <EvidenceRawLog v-else @clear-query="clearQuery" @any-time="searchAnyTime" />

    <EvidenceConnPanel
      :conn-key="lens === 'connections' ? connKey : ''"
      :record="loadedRecord"
      :return-focus="sheet.returnFocus"
      @close="sheet.close"
    />
  </div>
</template>
