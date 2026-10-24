<script setup lang="ts">
/**
 * The Network view's list mode (design 32 D2): every path the page's query
 * keeps, one row each, grouped by the target's region (checks to an address
 * last), worst first. A column header sorts inside the groups and a `sort:`
 * term in the query does the same; a header click hands the order back from
 * the query. A row opens the path sheet (?path=), and Escape brings focus
 * back to it.
 *
 * Each row carries what the matrix response has for the path: the state in
 * words (unknown with its reason), p50, p95, jitter, loss, availability, the
 * last run, the method and the check. A figure column no path of the matrix
 * has (a server from before design 29 keeps no jitter) is not shown. In a
 * view narrower than the table needs (networkModel.ROOMY_W) the rows become a
 * list grouped by target, one line per source, the figures in a second line.
 */
import { computed } from "vue";
import { useI18n } from "vue-i18n";

import { formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { RouteOpen } from "@/composables/useRouteOpen";

import DataTable, { type DataTableColumn } from "@/components/common/DataTable.vue";

import { formatLoss, formatMs } from "./latencyModel";
import { LIST_GROUP_ORDER, formatAvailability, listGroup, regionGroups, type ListGroup } from "./networkModel";
import { LOSS_TEXT, availability, displayState, lossTone, measuresNow, targetLabel, type PathItem } from "./pathsModel";
import { usePathsCopy } from "./pathsCopy";

const props = defineProps<{
  /** The paths the query keeps, in the list's order (worst first, or the query's sort). */
  rows: PathItem[];
  /** Every path of the matrix: a figure column shows when any of them has the figure, so typing a query never adds or drops a column. */
  all: readonly PathItem[];
  sheet: RouteOpen;
  /** The query carries `sort:`; the table keeps the order given. */
  querySorted: boolean;
  /** A check's newest failure on a source: why a down path is down. */
  failureOf: (monitorId: string, source: string) => string | undefined;
  /** The rows answer an earlier query: dimmed and inert. */
  stale?: boolean;
  /** The view has the table's width; narrower, the rows are grouped by target. */
  table: boolean;
}>();

const emit = defineEmits<{
  dropQuerySort: [];
  /** A row opens its path sheet: the view's, which closes the node sheet first, so two sheets never stand side by side. */
  open: [key: string, el: HTMLElement];
}>();

const { t } = useI18n();
const { displayLabel, reasonShort, whyText, groupLabel, methodName, evidenceText } = usePathsCopy();

const has = (pick: (p: PathItem) => number | undefined) => props.all.some((p) => pick(p) !== undefined);

/*
 * Every column has its width (its cells truncate inside it), so typing a
 * query never moves a column: the table spreads its spare width the same way
 * whatever the rows hold. The figure columns fit "1.20 s" and "99.9%".
 */
const FIGURE = "w-19";
const columns = computed<DataTableColumn<PathItem>[]>(() => [
  { key: "target", label: t("fleet.monitoring.network.list.target"), class: "w-58", sortable: true, value: (p) => targetLabel(p) },
  { key: "source", label: t("fleet.monitoring.network.list.source"), class: "w-48", sortable: true, value: (p) => p.sourceName },
  { key: "state", label: t("fleet.monitoring.network.list.state"), class: "w-50", sortable: true, value: (p) => STATE_ORDER[displayState(p)] },
  { key: "p50", label: "p50", align: "right", class: FIGURE, sortable: true, value: (p) => (measuresNow(p) ? p.p50Ms : undefined) },
  ...(has((p) => p.p95Ms) ? [{ key: "p95", label: "p95", align: "right" as const, class: FIGURE, sortable: true, value: (p: PathItem) => (measuresNow(p) ? p.p95Ms : undefined) }] : []),
  ...(has((p) => p.jitterMs) ? [{ key: "jitter", label: t("fleet.monitoring.paths.stats.jitter"), align: "right" as const, class: FIGURE, sortable: true, value: (p: PathItem) => (measuresNow(p) ? p.jitterMs : undefined) }] : []),
  { key: "loss", label: t("fleet.monitoring.paths.stats.loss"), align: "right", class: FIGURE, sortable: true, value: (p) => (measuresNow(p) && p.samples > 0 ? p.loss : undefined) },
  ...(has(availability) ? [{ key: "availability", label: t("fleet.monitoring.paths.stats.availability"), align: "right" as const, class: FIGURE, sortable: true, value: (p: PathItem) => availability(p) }] : []),
  { key: "last", label: t("fleet.monitoring.network.list.last"), align: "right", class: "w-26", sortable: true, value: (p) => p.lastAt },
]);

/** Worst first when sorted ascending, as the list's own order is. */
const STATE_ORDER: Record<string, number> = { down: 0, degraded: 1, unknown: 2, paused: 3, up: 4 };
const DOT: Record<string, string> = {
  up: "bg-success",
  degraded: "bg-warning",
  down: "bg-destructive",
  unknown: "border border-muted-foreground bg-transparent",
  paused: "bg-muted-foreground/50",
};
const STATE_INK: Record<string, string> = { up: "text-foreground", degraded: "text-warning-text", down: "text-destructive", unknown: "text-muted-foreground", paused: "text-muted-foreground" };

const checkLabel = (p: PathItem) => (p.managed ? t("fleet.monitoring.network.pathSet") : p.checkName || p.monitorId);

/** The state in words, and the reason beside it: unknown always says why (design 32 D1). */
function stateWords(p: PathItem): { word: string; why: string; title: string } {
  const state = displayState(p);
  if (state === "up") return { word: displayLabel(p), why: "", title: "" };
  if (state === "degraded") return { word: displayLabel(p), why: reasonShort(p.reason), title: evidenceText(p.degraded, p.reason) };
  if (state === "down") {
    const why = whyText(p, !p.reason ? props.failureOf(p.monitorId, p.source) : undefined);
    return { word: displayLabel(p), why: "", title: why };
  }
  if (state === "paused") return { word: displayLabel(p), why: reasonShort(p.reason), title: whyText(p) };
  return { word: displayLabel(p), why: reasonShort(p.reason), title: whyText(p) };
}

function rowLabel(p: PathItem): string {
  const s = stateWords(p);
  const parts = [s.why ? `${s.word}: ${s.why}` : s.word, `${methodName(p.method)} ${checkLabel(p)}`];
  if (measuresNow(p) && p.p50Ms !== undefined) parts.push(`p50 ${formatMs(p.p50Ms)}`);
  if (measuresNow(p) && p.loss !== undefined && p.samples > 0) parts.push(t("fleet.monitoring.paths.cell.loss", { loss: formatLoss(p.loss) }));
  return t("fleet.monitoring.paths.cell.label", { source: p.sourceName, target: p.targetName, state: parts.join(", ") });
}

const lastRun = (p: PathItem) => (p.lastAt !== undefined ? formatRelativeTime(p.lastAt) : t("fleet.monitoring.paths.sheet.noRun"));
const lossClass = (p: PathItem) => ((p.loss ?? 0) > 0 ? LOSS_TEXT[lossTone(displayState(p))] : "text-muted-foreground");

/** The phone's second line: the figures a row has, joined. */
function figures(p: PathItem): string {
  if (!measuresNow(p)) return "";
  const out: string[] = [];
  if (p.p95Ms !== undefined) out.push(`p95 ${formatMs(p.p95Ms)}`);
  if (p.jitterMs !== undefined) out.push(`${t("fleet.monitoring.paths.stats.jitter")} ${formatMs(p.jitterMs)}`);
  const a = availability(p);
  if (a !== undefined) out.push(`${t("fleet.monitoring.paths.stats.availability")} ${formatAvailability(a)}`);
  return out.join(" · ");
}

const groups = computed(() => regionGroups(props.rows));
const groupCounts = computed(() => {
  const out = new Map<string, { n: number; down: number; degraded: number }>();
  for (const p of props.rows) {
    const key = listGroup(p);
    const entry = out.get(key) ?? { n: 0, down: 0, degraded: 0 };
    entry.n += 1;
    if (p.state === "down") entry.down += 1;
    if (p.state === "degraded") entry.degraded += 1;
    out.set(key, entry);
  }
  return out;
});
</script>

<template>
  <div :class="cn(stale && 'opacity-50')" :inert="stale || undefined">
    <DataTable
      v-if="table"
      data-testid="network-list"
      :columns="columns"
      :rows="rows"
      :row-key="(p) => p.key"
      :external-sort="querySorted"
      :has-data="true"
      :searchable="false"
      :expression-filter="false"
      :show-summary="false"
      :row-click="(p, el) => emit('open', p.key, el)"
      :active-row-id="sheet.openId.value"
      :group-key="listGroup"
      :group-order="LIST_GROUP_ORDER"
      state-key="paths.list"
      @sort="emit('dropQuerySort')"
    >
      <template #group="{ group }">
        <span class="font-medium text-foreground">{{ groupLabel(group.key as ListGroup) }}</span>
        <span class="font-mono tabular text-muted-foreground">{{ group.rows.length }}</span>
        <template v-if="groupCounts.get(group.key)?.down"><span class="text-muted-foreground" aria-hidden="true">·</span><span class="font-mono text-destructive tabular">{{ $t('fleet.monitoring.paths.proof.down', { n: groupCounts.get(group.key)!.down }) }}</span></template>
        <template v-if="groupCounts.get(group.key)?.degraded"><span class="text-muted-foreground" aria-hidden="true">·</span><span class="font-mono text-warning-text tabular">{{ $t('fleet.monitoring.paths.proof.degraded', { n: groupCounts.get(group.key)!.degraded }) }}</span></template>
      </template>
      <template #cell-target="{ row }">
        <span class="block max-w-52 truncate font-medium" :title="targetLabel(row)">{{ targetLabel(row) }}</span>
        <span class="block max-w-52 truncate font-mono text-xs text-muted-foreground" :title="row.targetNode ? row.country : row.target">{{ row.targetNode ? row.country : row.target }}</span>
      </template>
      <!-- The source, and what it measures with: the method and the check, the path set's or an operator's. -->
      <template #cell-source="{ row }">
        <span class="block max-w-42 truncate" :title="row.sourceName">{{ row.sourceName }}</span>
        <span class="flex max-w-42 min-w-0 items-center gap-1.5 text-xs text-muted-foreground" :title="`${methodName(row.method)} · ${checkLabel(row)}`">
          <span class="shrink-0 font-mono text-[10px] uppercase">{{ row.method }}</span>
          <span class="truncate">{{ checkLabel(row) }}</span>
        </span>
      </template>
      <template #cell-state="{ row }">
        <span class="flex min-w-0 items-center gap-2" :title="stateWords(row).title || undefined" :data-state="displayState(row)">
          <span :class="cn('size-2 shrink-0 rounded-full', DOT[displayState(row)])" aria-hidden="true" />
          <span :class="cn('whitespace-nowrap', STATE_INK[displayState(row)])">{{ stateWords(row).word }}</span>
        </span>
        <span v-if="stateWords(row).why" :class="cn('block max-w-44 truncate ps-4 text-xs', displayState(row) === 'degraded' ? 'text-warning-text' : 'text-muted-foreground')" :title="stateWords(row).title || undefined">{{ stateWords(row).why }}</span>
      </template>
      <template #cell-p50="{ row }">
        <span :class="cn('whitespace-nowrap font-mono tabular', STATE_INK[displayState(row)])">{{ measuresNow(row) ? formatMs(row.p50Ms) : '' }}</span>
      </template>
      <template #cell-p95="{ row }">
        <span class="whitespace-nowrap font-mono text-muted-foreground tabular">{{ measuresNow(row) ? formatMs(row.p95Ms) : '' }}</span>
      </template>
      <template #cell-jitter="{ row }">
        <span class="whitespace-nowrap font-mono text-muted-foreground tabular">{{ measuresNow(row) ? formatMs(row.jitterMs) : '' }}</span>
      </template>
      <template #cell-loss="{ row }">
        <span :class="cn('whitespace-nowrap font-mono tabular', lossClass(row))">{{ measuresNow(row) && row.loss !== undefined && row.samples > 0 ? formatLoss(row.loss) : '' }}</span>
      </template>
      <template #cell-availability="{ row }">
        <span class="whitespace-nowrap font-mono text-muted-foreground tabular">{{ formatAvailability(availability(row)) }}</span>
      </template>
      <template #cell-last="{ row }">
        <span class="whitespace-nowrap font-mono text-xs text-muted-foreground tabular" :title="row.lastAt ? new Date(row.lastAt).toISOString() : undefined">{{ lastRun(row) }}</span>
      </template>
    </DataTable>

    <!-- Narrower than the table: grouped by target, one line per source, reasons in words (a phone has no hover). -->
    <div v-else class="space-y-4" data-testid="network-list">
      <section v-for="group in groups" :key="group.group" :aria-label="groupLabel(group.group)">
        <h3 class="px-1 pb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {{ groupLabel(group.group) }} · <span class="font-mono tabular">{{ group.count }}</span>
        </h3>
        <ul class="divide-y divide-border rounded-lg border border-border bg-card">
          <li v-for="target in group.targets" :key="target.key" :data-target="target.key">
            <div class="px-3 pt-2">
              <span class="block truncate font-medium">{{ target.name }}</span>
              <span v-if="target.detail" class="block truncate font-mono text-xs text-muted-foreground">{{ target.detail }}</span>
            </div>
            <ul class="pb-1.5">
              <li v-for="p in target.paths" :key="p.key">
                <button
                  type="button"
                  :class="cn('relative grid min-h-11 w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 px-3 py-1.5 text-start outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring', sheet.openId.value === p.key && 'bg-muted/50')"
                  :aria-label="rowLabel(p)"
                  :data-state="displayState(p)"
                  :data-path="p.key"
                  :data-row-key="p.key"
                  @click="(e) => emit('open', p.key, e.currentTarget as HTMLElement)"
                >
                  <span class="min-w-0 ps-1">
                    <span class="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                      <span :class="cn('size-2 shrink-0 rounded-full', DOT[displayState(p)])" aria-hidden="true" />
                      <span class="truncate">{{ $t('fleet.monitoring.paths.list.from', { source: p.sourceName }) }}</span>
                    </span>
                    <!-- The method and the check on their own line, so a long source never cuts them mid-word. -->
                    <span class="block truncate ps-3.5 text-xs text-muted-foreground"><span class="font-mono">{{ p.method.toUpperCase() }}</span><template v-if="!p.managed"> · {{ checkLabel(p) }}</template></span>
                    <span v-if="displayState(p) !== 'up'" :class="cn('block text-xs', STATE_INK[displayState(p)])">
                      {{ stateWords(p).why ? `${stateWords(p).word}: ${stateWords(p).why}` : stateWords(p).title ? `${stateWords(p).word}: ${stateWords(p).title}` : stateWords(p).word }}
                    </span>
                    <span v-if="figures(p)" class="block break-words font-mono text-[11px] text-muted-foreground tabular">{{ figures(p) }}</span>
                  </span>
                  <span class="text-end">
                    <span :class="cn('block font-mono font-medium tabular', STATE_INK[displayState(p)])">{{ measuresNow(p) ? formatMs(p.p50Ms) : '' }}</span>
                    <span v-if="measuresNow(p) && (p.loss ?? 0) > 0" :class="cn('block text-[11px]', lossClass(p))">{{ $t('fleet.monitoring.paths.cell.loss', { loss: formatLoss(p.loss) }) }}</span>
                    <span class="block font-mono text-[10px] text-muted-foreground">{{ lastRun(p) }}</span>
                  </span>
                </button>
              </li>
            </ul>
          </li>
        </ul>
      </section>
    </div>
  </div>
</template>
