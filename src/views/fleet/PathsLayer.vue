<script setup lang="ts">
/**
 * Monitoring's Paths layer (design 29 D7): the source by target matrix for
 * the page's window, targets down the side by region (they are many) and
 * sources across the top (they are few). Each cell is one path: the window's
 * p50 as a number, toned by the path's state, with the loss under it when
 * there was any; an unknown path is hatched and says why on hover and focus.
 * Below 768 px the matrix becomes a list grouped by target, one row per
 * source. A cell opens the path sheet (?path=), which carries the chart.
 *
 * The list query field filters the paths in the console's one grammar
 * (`target:jp state:down source:cd-hs-sh`) and lives at ?paths.q=, because
 * the Incidents layer on this address owns ?q=.
 */
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink } from "vue-router";
import { useMediaQuery } from "@vueuse/core";
import { ArrowUpRight, Pause, Pencil, Play, Route as RouteIcon, Settings2 } from "lucide-vue-next";

import { api, type MonitorView, type MonitorWindow } from "@/lib/api";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { bindQueryParam } from "@/composables/useQueryParam";
import { bindRouteOpen } from "@/composables/useRouteOpen";
import { useListQuery, useQueryText } from "@/composables/useListQuery";
import type { OwnedRoute } from "@/composables/useOwnedRoute";

import DataState from "@/components/common/DataState.vue";
import EmptyState from "@/components/common/EmptyState.vue";
import ListQueryBar from "@/components/common/ListQueryBar.vue";
import ObjectSheet from "@/components/common/ObjectSheet.vue";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

import PathDetail from "./PathDetail.vue";
import { buildSourcePause, canEditCheck, latestCertExpiry, sourcePaused } from "./checksModel";
import { draftFromConfig, draftToConfig, formatLoss, formatMs, pairEnabledIn, setPairEnabled } from "./latencyModel";
import {
  PATHS_QUERY_EXAMPLES,
  cellKey,
  decodePathKey,
  isChosenUnknown,
  matrixSections,
  pathsQuerySchema,
  visibleMatrix,
  type PathItem,
  type PathRow,
} from "./pathsModel";
import { usePathsCopy } from "./pathsCopy";
import type { PathsData } from "./usePathsData";

const props = defineProps<{
  owned: OwnedRoute;
  data: PathsData;
  monitors: MonitorView[];
  canAdmin: boolean;
  window: MonitorWindow;
  /** The windows the page offers, for the sheet's own window control. */
  offered: MonitorWindow[];
  /** A check's newest failure on a source: why a down path is down. */
  failureOf: (monitorId: string, source: string) => string | undefined;
  /** The path set exists with no source. */
  noSources: boolean;
}>();

const emit = defineEmits<{
  pathSet: [];
  createCheck: [];
  openCheck: [id: string];
  /** A check changed (a source paused or resumed): the page rereads the monitors with the paths. */
  changed: [];
  window: [window: MonitorWindow];
}>();

const { t } = useI18n();
const { reasonText, reasonShort, whyText, stateLabel, displayLabel, groupLabel, windowLong } = usePathsCopy();
/** Why a path is not up: its reason, or for a down path the agent's newest error. */
const why = (path: PathItem) => whyText(path, path.state === "down" && !path.reason ? props.failureOf(path.monitorId, path.source) : undefined);
const wide = useMediaQuery("(min-width: 768px)");

const matrix = computed(() => props.data.matrix.value);
const query = props.data.pathsQuery;

/* ---- The query field ---- */

const schema = pathsQuerySchema({ reasonText });
const storedQuery = bindQueryParam<string>(props.owned, "paths.q", {
  parse: (raw) => (typeof raw === "string" ? raw : ""),
  format: (value) => (value.trim() ? value : undefined),
});
const queryText = useQueryText(storedQuery);
const allPaths = computed(() => matrix.value?.paths ?? []);
const listQuery = useListQuery(allPaths, schema, queryText);
const matching = computed(() => (listQuery.filtering.value ? new Set(listQuery.rows.value.map((p) => p.key)) : undefined));
const shown = computed(() => (matrix.value ? visibleMatrix(matrix.value, matching.value) : undefined));
const queryExamples = computed(() => PATHS_QUERY_EXAMPLES.map((e) => ({ query: e.query, note: t(`fleet.monitoring.paths.query.examples.${e.key}`) })));

function pathIn(row: PathRow, source: string): PathItem | undefined {
  return matrix.value?.cells.get(cellKey(row.key, source));
}

/* ---- Cells ---- */

const HATCH = "bg-[repeating-linear-gradient(135deg,var(--border)_0_1.5px,transparent_1.5px_7px)]";

function cellClass(path: PathItem): string {
  if (path.state === "down") return "bg-destructive/6";
  if (path.state === "unknown") return HATCH;
  return "";
}

function railClass(path: PathItem): string {
  if (path.state === "up") return "bg-success";
  if (path.state === "down") return "bg-destructive";
  return "bg-transparent";
}

/** An unknown path never leads with a number, even one its window still holds: it would read as current. */
function cellMain(path: PathItem): string {
  if (path.state === "unknown") return isChosenUnknown(path.reason) ? t("fleet.monitoring.paths.cell.paused") : stateLabel("unknown");
  if (path.p50Ms !== undefined) return formatMs(path.p50Ms);
  return stateLabel("down");
}

const DAY_MS = 86_400_000;
/** Days left on the certificate a tls check last read, from the monitors list's newest results. */
function certLeft(path: PathItem): string | undefined {
  if (path.method !== "tls") return undefined;
  const expires = latestCertExpiry(props.monitors.find((m) => m.id === path.monitorId)?.latest);
  if (expires === undefined) return undefined;
  const days = Math.floor((expires - Date.now()) / DAY_MS);
  return days < 0 ? t("fleet.monitoring.checks.certExpired") : t("fleet.monitoring.checks.certLeft", { n: days });
}

function cellSub(path: PathItem): string {
  if (path.state === "unknown") return reasonShort(path.reason);
  const parts: string[] = [];
  // A certificate check's reason to exist is the expiry: it leads the sub line.
  const cert = certLeft(path);
  if (cert) parts.push(cert);
  if (path.state === "down" && path.p50Ms !== undefined) parts.push(stateLabel("down"));
  if (path.loss !== undefined && path.loss > 0 && path.samples > 0) parts.push(t("fleet.monitoring.paths.cell.loss", { loss: formatLoss(path.loss) }));
  return parts.join(" · ");
}

function mainClass(path: PathItem): string {
  if (path.state === "down") return "text-destructive";
  if (path.state === "unknown") return "text-muted-foreground";
  return "text-foreground";
}

function cellLabel(path: PathItem): string {
  const parts = [displayLabel(path)];
  if (path.p50Ms !== undefined) parts.push(`p50 ${formatMs(path.p50Ms)}`);
  if (path.loss !== undefined && path.samples > 0) parts.push(t("fleet.monitoring.paths.cell.loss", { loss: formatLoss(path.loss) }));
  if (path.state !== "up") parts.push(why(path));
  return t("fleet.monitoring.paths.cell.label", { source: path.sourceName, target: path.targetName, state: parts.join(", ") });
}

function rowDetail(row: PathRow): string {
  const first = matrix.value?.paths.find((p) => p.rowKey === row.key && p.target);
  return [row.kind === "node" ? row.country : undefined, first?.target].filter(Boolean).join(" · ");
}

/**
 * The sections as the template draws them (node targets, then your checks),
 * each with its own columns; each row with its detail line and one cell per
 * source of its section.
 */
const sections = computed(() =>
  matrix.value && shown.value
    ? matrixSections(matrix.value, shown.value).map((section) => ({
        kind: section.kind,
        sources: section.sources,
        groups: section.groups.map((g) => ({
          group: g.group,
          items: g.rows.map((row) => ({
            row,
            detail: rowDetail(row),
            cells: section.sources.map((source) => ({ source, path: pathIn(row, source.nodeId) })),
          })),
        })),
      }))
    : [],
);

/* ---- The sheet ---- */

const sheet = bindRouteOpen(props.owned, "path");
const openAddress = computed(() => decodePathKey(sheet.openId.value));
const openPath = computed(() => (sheet.openId.value ? matrix.value?.paths.find((p) => p.key === sheet.openId.value) : undefined));
const openTitle = computed(() => {
  const p = openPath.value;
  if (p) return t("fleet.monitoring.paths.sheet.title", { source: p.sourceName, target: p.targetName });
  return sheet.openId.value ?? "";
});
const sheetState = computed(() => {
  if (!sheet.openId.value) return "loading" as const;
  if (!matrix.value) return query.error.value && !query.loading.value ? ("failed" as const) : ("loading" as const);
  if (!openPath.value || !openAddress.value) return "gone" as const;
  return query.error.value ? ("stale" as const) : ("ready" as const);
});

function openCell(path: PathItem, el: HTMLElement | null): void {
  sheet.open(path.key, el);
}

/* ---- Actions: pause a path ---- */

const openMonitor = computed(() => (openPath.value ? props.monitors.find((m) => m.id === openPath.value!.monitorId) : undefined));
const plan = computed(() => props.data.planQuery.data.value);
const pending = ref(false);

/** Pause through the path set (generated paths) or the check (operator paths), and whether it is paused now. */
const pauseAction = computed<{ kind: "pathset" | "check"; paused: boolean } | undefined>(() => {
  const p = openPath.value;
  if (!p || !props.canAdmin) return undefined;
  if (p.managed && p.targetNode && plan.value) {
    const draft = draftFromConfig(plan.value.config);
    return { kind: "pathset", paused: !pairEnabledIn(draft, p.source, p.targetNode) };
  }
  const monitor = openMonitor.value;
  if (!p.managed && monitor && canEditCheck(monitor, props.data.source.value === "paths") && p.source) return { kind: "check", paused: sourcePaused(monitor, p.source) };
  return undefined;
});

async function togglePause(): Promise<void> {
  const p = openPath.value;
  const action = pauseAction.value;
  if (!p || !action) return;
  pending.value = true;
  const pause = !action.paused;
  try {
    if (action.kind === "pathset" && plan.value && p.targetNode) {
      const draft = setPairEnabled(draftFromConfig(plan.value.config), p.source, p.targetNode, !pause);
      props.data.planQuery.data.value = await api.monitors.latency.save(draftToConfig(draft));
    } else if (openMonitor.value) {
      await api.monitors.update(buildSourcePause(openMonitor.value, p.source, pause));
    }
    toast.success(pause ? t("fleet.monitoring.paths.toast.paused") : t("fleet.monitoring.paths.toast.resumed"));
  } catch (error) {
    const status = (error as { status?: number }).status;
    toast.error(status === 409 ? t("fleet.monitoring.paths.toast.conflict") : error instanceof Error ? error.message : t("fleet.monitoring.paths.toast.failed"));
  } finally {
    // The pause state and the version the next click sends come from the monitors list: reread it with the paths.
    emit("changed");
    pending.value = false;
  }
}

const isEmpty = computed(() => !!matrix.value && (matrix.value.sources.length === 0 || matrix.value.paths.length === 0));
</script>

<template>
  <div class="space-y-4">
    <p v-if="data.source.value === 'legacy'" class="text-xs text-muted-foreground" data-testid="paths-legacy">
      {{ $t('fleet.monitoring.paths.legacy') }}
    </p>

    <ListQueryBar
      v-if="matrix && !isEmpty"
      v-model="queryText"
      class="max-w-3xl"
      storage-key="paths"
      testid="paths-query"
      :query="listQuery"
      :count="listQuery.filtering.value ? { shown: listQuery.rows.value.length, total: allPaths.length } : undefined"
      :label="$t('fleet.monitoring.paths.query.label')"
      :placeholder="$t('fleet.monitoring.paths.query.placeholder')"
      :examples="queryExamples"
    />

    <DataState :loading="query.loading.value" :error="query.error.value ?? null" :has-data="!!matrix" :skeleton-rows="8" @retry="data.refresh">
      <template v-if="matrix">
        <EmptyState
          v-if="isEmpty"
          :icon="RouteIcon"
          :title="noSources ? $t('fleet.monitoring.paths.empty.noSourceTitle') : $t('fleet.monitoring.paths.empty.title')"
          :description="!canAdmin ? $t('fleet.monitoring.paths.empty.readOnly') : noSources ? $t('fleet.monitoring.paths.empty.noSourceDescription') : $t('fleet.monitoring.paths.empty.description')"
        >
          <div v-if="canAdmin" class="flex flex-wrap justify-center gap-2">
            <Button size="sm" type="button" @click="emit('pathSet')">
              <Settings2 class="size-4" aria-hidden="true" />
              {{ noSources ? $t('fleet.monitoring.paths.empty.noSourceAction') : $t('fleet.monitoring.paths.empty.pathSet') }}
            </Button>
            <Button size="sm" variant="outline" type="button" @click="emit('createCheck')">{{ $t('fleet.monitoring.paths.empty.check') }}</Button>
          </div>
        </EmptyState>

        <EmptyState
          v-else-if="shown && shown.rows.length === 0"
          :title="$t('fleet.monitoring.paths.empty.noMatchTitle')"
          :description="$t('fleet.monitoring.paths.empty.noMatchDescription')"
        >
          <Button size="sm" variant="outline" type="button" @click="queryText = ''">{{ $t('fleet.monitoring.paths.empty.clear') }}</Button>
        </EmptyState>

        <div v-else-if="shown" :class="cn('space-y-3', listQuery.staleRows.value && 'opacity-50')" :inert="listQuery.staleRows.value || undefined">
          <aside class="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground" data-testid="paths-legend" :aria-label="$t('fleet.monitoring.paths.legend.label')">
            <span class="inline-flex items-center gap-1.5"><span class="h-3 w-[3px] rounded-full bg-success" aria-hidden="true" />{{ $t('fleet.monitoring.paths.state.up') }}</span>
            <span class="inline-flex items-center gap-1.5"><span class="h-3 w-[3px] rounded-full bg-destructive" aria-hidden="true" />{{ $t('fleet.monitoring.paths.state.down') }}</span>
            <span class="inline-flex items-center gap-1.5"><span :class="cn('size-3 rounded-[2px] border border-muted-foreground/50', HATCH)" aria-hidden="true" />{{ $t('fleet.monitoring.paths.legend.unknown') }}</span>
            <span>{{ $t('fleet.monitoring.paths.legend.number', { window: windowLong(window) }) }}</span>
          </aside>

          <!-- 768 px and up: the matrix, shrink-wrapped so one source does not stretch into a bar;
               your checks in a table of their own, so their sources do not widen it. -->
          <template v-if="wide">
          <section v-for="section in sections" :key="section.kind" class="space-y-1.5" :aria-label="section.kind === 'checks' ? $t('fleet.monitoring.paths.matrix.checksGroup') : undefined">
          <h3 v-if="section.kind === 'checks'" class="pt-2 text-xs font-medium text-muted-foreground">{{ $t('fleet.monitoring.paths.matrix.checksGroup') }}</h3>
          <div
            class="w-fit max-w-full overflow-x-auto rounded-lg border border-border bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            role="region"
            tabindex="0"
            :aria-label="section.kind === 'checks' ? $t('fleet.monitoring.paths.matrix.checksLabel') : $t('fleet.monitoring.paths.matrix.label')"
            :data-testid="section.kind === 'checks' ? 'paths-checks' : 'paths-matrix'"
          >
            <table class="border-collapse text-sm">
              <caption class="sr-only">{{ $t('fleet.monitoring.paths.matrix.caption', { window: windowLong(window) }) }}</caption>
              <thead>
                <tr class="border-b border-border bg-muted/40 text-xs text-muted-foreground">
                  <th scope="col" class="sticky start-0 z-10 w-80 min-w-48 bg-muted px-3 py-2 text-start font-medium">
                    {{ section.kind === 'checks' ? $t('fleet.monitoring.paths.matrix.check') : $t('fleet.monitoring.paths.matrix.target') }}
                  </th>
                  <th v-for="source in section.sources" :key="source.nodeId" scope="col" class="w-36 min-w-28 px-2 py-2 text-start align-bottom font-medium">
                    <span class="block text-[10px] uppercase tracking-wide">{{ $t('fleet.monitoring.paths.matrix.from') }}</span>
                    <span class="block truncate text-foreground" :title="source.name">{{ source.name }}</span>
                  </th>
                </tr>
              </thead>
              <template v-for="group in section.groups" :key="group.group">
                <tbody v-if="section.kind === 'nodes'" class="border-b border-border">
                  <tr>
                    <th
                      :colspan="section.sources.length + 1"
                      scope="rowgroup"
                      class="bg-muted/30 px-3 pb-1 pt-2.5 text-start text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
                      :data-region="group.group"
                    >
                      {{ groupLabel(group.group) }} · <span class="font-mono tabular">{{ group.items.length }}</span>
                    </th>
                  </tr>
                </tbody>
                <tbody class="border-b border-border last:border-b-0">
                  <tr v-for="{ row, detail, cells } in group.items" :key="row.key" class="border-b border-border/60 last:border-b-0" :data-target="row.key">
                    <th scope="row" class="sticky start-0 z-10 bg-card px-3 py-1.5 text-start align-middle font-normal">
                      <RouterLink
                        v-if="row.kind === 'node' && row.nodeId"
                        :to="{ name: 'node-detail', params: { id: row.nodeId } }"
                        class="flex max-w-72 items-center font-medium hover:underline pointer-coarse:min-h-11"
                        :title="row.name"
                      ><span class="truncate">{{ row.name }}</span></RouterLink>
                      <button
                        v-else
                        type="button"
                        class="flex max-w-72 items-center text-start font-medium hover:underline pointer-coarse:min-h-11"
                        :title="row.name"
                        @click="row.monitorId && emit('openCheck', row.monitorId)"
                      ><span class="truncate">{{ row.name }}</span></button>
                      <span class="block max-w-72 truncate font-mono text-xs text-muted-foreground" :title="detail">{{ detail }}</span>
                    </th>
                    <td v-for="cell in cells" :key="cell.source.nodeId" class="p-1 align-middle">
                      <template v-if="cell.path">
                        <Tooltip :disabled="cell.path.state === 'up'">
                          <TooltipTrigger as-child>
                            <button
                              type="button"
                              :class="
                                cn(
                                  'relative flex h-12 w-full min-w-28 items-center overflow-hidden rounded-md border border-transparent ps-3 pe-2 text-start outline-none transition-colors hover:border-border focus-visible:ring-2 focus-visible:ring-ring',
                                  cellClass(cell.path),
                                  sheet.openId.value === cell.path.key && 'border-ring',
                                  !shown.matches(cell.path) && 'opacity-35',
                                )
                              "
                              :aria-label="cellLabel(cell.path)"
                              :data-cell="cell.path.state"
                              :data-path="cell.path.key"
                              :data-row-key="cell.path.key"
                              @click="(e) => openCell(cell.path!, e.currentTarget as HTMLElement)"
                            >
                              <span :class="cn('absolute inset-y-1.5 start-1 w-[3px] rounded-full', railClass(cell.path))" aria-hidden="true" />
                              <span class="min-w-0">
                                <span :class="cn('block truncate font-mono font-medium leading-tight tabular', mainClass(cell.path))">{{ cellMain(cell.path) }}</span>
                                <span v-if="cellSub(cell.path)" class="block max-w-32 truncate text-[11px] leading-tight text-muted-foreground">{{ cellSub(cell.path) }}</span>
                              </span>
                            </button>
                          </TooltipTrigger>
                          <TooltipContent class="max-w-72">
                            <p class="font-medium">{{ displayLabel(cell.path) }}</p>
                            <p class="text-xs">{{ why(cell.path) }}</p>
                          </TooltipContent>
                        </Tooltip>
                      </template>
                      <span v-else class="flex h-12 min-w-28 items-center px-3 text-xs text-muted-foreground">{{ $t('fleet.monitoring.paths.cell.noPath') }}</span>
                    </td>
                  </tr>
                </tbody>
              </template>
            </table>
          </div>
          </section>
          </template>

          <!-- Under 768 px: a list grouped by target, one row per source, reasons in words (a phone has no hover). -->
          <div v-else class="space-y-4" data-testid="paths-list">
            <section v-for="group in sections.flatMap((s) => s.groups)" :key="group.group" :aria-label="groupLabel(group.group)">
              <h3 class="px-1 pb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                {{ groupLabel(group.group) }} · <span class="font-mono tabular">{{ group.items.length }}</span>
              </h3>
              <ul class="divide-y divide-border rounded-lg border border-border bg-card">
                <li v-for="{ row, detail, cells } in group.items" :key="row.key" :data-target="row.key">
                  <div class="px-3 pt-2">
                    <RouterLink
                      v-if="row.kind === 'node' && row.nodeId"
                      :to="{ name: 'node-detail', params: { id: row.nodeId } }"
                      class="inline-flex max-w-full items-center font-medium hover:underline pointer-coarse:min-h-11"
                    ><span class="truncate">{{ row.name }}</span></RouterLink>
                    <span v-else class="block truncate font-medium">{{ row.name }}</span>
                    <span class="block truncate font-mono text-xs text-muted-foreground">{{ detail }}</span>
                  </div>
                  <ul class="pb-1.5">
                    <template v-for="cell in cells" :key="cell.source.nodeId">
                      <li v-if="cell.path" :class="!shown.matches(cell.path) && 'opacity-35'">
                        <button
                          type="button"
                          :class="cn('relative grid min-h-11 w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 px-3 py-1.5 text-start outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring', cellClass(cell.path))"
                          :aria-label="cellLabel(cell.path)"
                          :data-cell="cell.path.state"
                          :data-path="cell.path.key"
                              :data-row-key="cell.path.key"
                          @click="(e) => openCell(cell.path!, e.currentTarget as HTMLElement)"
                        >
                          <span :class="cn('absolute inset-y-2 start-1 w-[3px] rounded-full', railClass(cell.path))" aria-hidden="true" />
                          <span class="min-w-0 ps-1">
                            <span class="block truncate text-xs text-muted-foreground">{{ $t('fleet.monitoring.paths.list.from', { source: cell.source.name }) }}</span>
                            <span v-if="cell.path.state !== 'up'" :class="cn('block text-xs', cell.path.state === 'down' ? 'text-destructive' : 'text-muted-foreground')">
                              {{ displayLabel(cell.path) }}: {{ why(cell.path) }}
                            </span>
                          </span>
                          <span class="text-end">
                            <span :class="cn('block font-mono font-medium tabular', mainClass(cell.path))">{{ cell.path.p50Ms !== undefined ? formatMs(cell.path.p50Ms) : '' }}</span>
                            <span v-if="(cell.path.loss ?? 0) > 0" class="block text-[11px] text-muted-foreground">{{ $t('fleet.monitoring.paths.cell.loss', { loss: formatLoss(cell.path.loss) }) }}</span>
                          </span>
                        </button>
                      </li>
                    </template>
                  </ul>
                </li>
              </ul>
            </section>
          </div>
        </div>
      </template>
    </DataState>

    <ObjectSheet
      :open="!!sheet.openId.value"
      :title="openTitle"
      :subtitle="openPath ? `${openPath.method.toUpperCase()} · ${openPath.target || openPath.monitorId}` : undefined"
      :state="sheetState"
      :error="query.error.value?.message ?? null"
      :return-focus="sheet.returnFocus"
      :gone-title="$t('fleet.monitoring.paths.sheet.goneTitle')"
      :gone-description="$t('fleet.monitoring.paths.sheet.goneDescription')"
      @close="sheet.close"
      @retry="data.refresh"
    >
      <PathDetail
        v-if="openAddress && openPath"
        :address="openAddress"
        :path="openPath"
        :window="window"
        :source="data.source.value"
        :compact="!wide"
        :title="openTitle"
        :offered="offered"
        :failure="openPath.state === 'down' && !openPath.reason ? failureOf(openPath.monitorId, openPath.source) : undefined"
        @window="(w) => emit('window', w)"
      />
      <template v-if="openPath" #actions>
        <Button v-if="pauseAction" variant="outline" size="sm" type="button" :disabled="pending" data-testid="path-pause" @click="togglePause">
          <component :is="pauseAction.paused ? Play : Pause" class="size-4" aria-hidden="true" />
          {{ pauseAction.paused ? $t('fleet.monitoring.paths.sheet.resume') : $t('fleet.monitoring.paths.sheet.pause') }}
        </Button>
        <Button v-if="!openPath.managed" variant="outline" size="sm" type="button" @click="emit('openCheck', openPath.monitorId)">
          <Pencil class="size-4" aria-hidden="true" />
          {{ $t('fleet.monitoring.paths.sheet.openCheck') }}
        </Button>
        <Button v-else-if="canAdmin" variant="outline" size="sm" type="button" @click="emit('pathSet')">
          <Settings2 class="size-4" aria-hidden="true" />
          {{ $t('fleet.monitoring.paths.sheet.editPathSet') }}
        </Button>
        <Button v-if="openPath.source" variant="outline" size="sm" as-child>
          <RouterLink :to="{ name: 'node-detail', params: { id: openPath.source } }">
            {{ $t('fleet.monitoring.paths.sheet.openSource') }}
            <ArrowUpRight class="size-4" aria-hidden="true" />
          </RouterLink>
        </Button>
        <Button v-if="openPath.targetNode" variant="outline" size="sm" as-child>
          <RouterLink :to="{ name: 'node-detail', params: { id: openPath.targetNode } }">
            {{ $t('fleet.monitoring.paths.sheet.openTarget') }}
            <ArrowUpRight class="size-4" aria-hidden="true" />
          </RouterLink>
        </Button>
      </template>
    </ObjectSheet>
  </div>
</template>
