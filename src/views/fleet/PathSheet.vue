<script setup lang="ts">
/**
 * The path sheet (design 29 D7, design 32 D2): one path, opened in place on
 * the Topology view from an edge, a list row or the node sheet's lens, at
 * `?path=`. A path to a node is the pair, whichever checks measure it
 * (design 32 R1), so the sheet opens with "Checks on this path" (R3): each
 * check's name, method, state, p50 and last run, the name opening that
 * check's sheet, and for a check definition "Stop measuring this pair",
 * which adds the pair to its excluded pairs through the check's normal save
 * after a confirmation. Below it, the chart and runs of one check, the one
 * that speaks for the pair unless another is chosen.
 *
 * A link that named a check to a node by its monitor (`<source>~@<monitor
 * id>`) opens the pair with that check chosen. Pausing a source of a single
 * check stays here; "Edit check" opens the editor as a second sheet, so
 * cancelling comes back here.
 */
import { computed, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink } from "vue-router";
import { ArrowUpRight, LineChart, Pause, Pencil, Play, Settings2 } from "lucide-vue-next";

import { api, ApiError, type MonitorView, type MonitorWindow } from "@/lib/api";
import { formatRelativeTime } from "@/lib/format";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import type { OwnedRoute } from "@/composables/useOwnedRoute";
import type { RouteOpen } from "@/composables/useRouteOpen";

import ConfirmDialog from "@/components/common/ConfirmDialog.vue";
import ObjectSheet from "@/components/common/ObjectSheet.vue";
import { Button } from "@/components/ui/button";

import PathDetail from "./PathDetail.vue";
import { buildSourcePause, canEditCheck, sourcePaused } from "./checksModel";
import { measureAgainSave, stopMeasuringSave } from "./definitionsModel";
import { draftFromConfig, draftToConfig, formatMs, pairEnabledIn, setPairEnabled } from "./latencyModel";
import { currentPathKey, decodePathKey, displayState, everyPath, measuresNow, targetLabel, type PathItem } from "./pathsModel";
import { usePathsCopy } from "./pathsCopy";
import { pairOrder } from "./topologyModel";
import { verdictFor } from "./triangulationModel";
import type { PathsData } from "./usePathsData";

const props = defineProps<{
  owned: OwnedRoute;
  data: PathsData;
  /** The page's `?path=` (bindRouteOpen), shared with whatever opened the sheet so focus goes back to it. */
  sheet: RouteOpen;
  monitors: MonitorView[];
  canAdmin: boolean;
  /** The path set is not migrated into checks (design 32 R1): only then are its pause and editor offered. */
  canEditPathSet: boolean;
  window: MonitorWindow;
  offered: MonitorWindow[];
  compact: boolean;
  failureOf: (monitorId: string, source: string) => string | undefined;
  agentOf?: (source: string) => string | undefined;
}>();

const emit = defineEmits<{
  pathSet: [];
  editCheck: [monitor: MonitorView];
  openCheck: [id: string];
  /** A check changed (a source paused or resumed, a pair no longer measured): the page rereads the monitors with the paths. */
  changed: [];
  window: [window: MonitorWindow];
}>();

const { t } = useI18n();
const { displayLabel, reasonShort, methodName } = usePathsCopy();

const matrix = computed(() => props.data.matrix.value);
const query = props.data.pathsQuery;
const openKey = computed(() => props.sheet.openId.value);
const openAddress = computed(() => decodePathKey(openKey.value));

/**
 * Every check on the open path, in the order they speak for it (the live
 * ones, worst first). The pairs a check skips or the operator paused are read
 * too: a revealed or linked one opens like any other path.
 */
const pairPaths = computed<PathItem[]>(() => {
  const key = openKey.value;
  const m = matrix.value;
  return key && m ? pairOrder(everyPath(m).filter((p) => p.key === key)) : [];
});

/** The check whose chart and runs show: the one chosen, else the one that speaks for the pair. */
const chosen = ref<string>();
let chooseNext: string | undefined;
watch(openKey, () => {
  chosen.value = chooseNext;
  chooseNext = undefined;
});
const openPath = computed(() => pairPaths.value.find((p) => p.checkId === chosen.value) ?? pairPaths.value[0]);

// An old link named a check to a node by its monitor: open the pair, with that check chosen (design 32 R1).
watch(
  [openKey, matrix],
  ([key, m]) => {
    if (!key || !m) return;
    const current = currentPathKey(m, key);
    if (current === key) return;
    const monitorId = decodePathKey(key)?.monitorId;
    chooseNext = everyPath(m).find((p) => p.monitorId === monitorId)?.checkId;
    props.sheet.swap(current);
  },
  { immediate: true },
);

const openTitle = computed(() => {
  const p = openPath.value;
  if (p) return t("fleet.monitoring.paths.sheet.title", { source: p.sourceName, target: targetLabel(p) });
  return openKey.value ?? "";
});
const sheetState = computed(() => {
  if (!openKey.value) return "loading" as const;
  if (!matrix.value) return query.error.value && !query.loading.value ? ("failed" as const) : ("loading" as const);
  if (!openPath.value || !openAddress.value) return "gone" as const;
  return query.error.value ? ("stale" as const) : ("ready" as const);
});

const DOT: Record<string, string> = {
  up: "bg-success",
  degraded: "bg-warning",
  down: "bg-destructive",
  unknown: "border border-muted-foreground bg-transparent",
  paused: "bg-muted-foreground/50",
  skipped: "border border-dashed border-muted-foreground bg-transparent",
};
const STATE_INK: Record<string, string> = { up: "text-foreground", degraded: "text-warning-text", down: "text-destructive", unknown: "text-muted-foreground", paused: "text-muted-foreground", skipped: "text-muted-foreground" };
const checkLabel = (p: PathItem) => p.checkName || p.checkId;
function stateText(p: PathItem): string {
  const state = displayState(p);
  if (state === "up") return displayLabel(p);
  return p.reason ? `${displayLabel(p)}: ${reasonShort(p.reason)}` : displayLabel(p);
}
/** A check with a run to chart: one that never ran (skipped from the start) has nothing to show. */
const charted = (p: PathItem) => p.lastAt !== undefined || p.samples > 0;
// "No run yet" promises a run; a skipped or paused pair that never ran gets the plain mark for no value.
const lastRun = (p: PathItem) => (p.lastAt !== undefined ? formatRelativeTime(p.lastAt) : p.measure === "measured" ? t("fleet.monitoring.paths.sheet.noRun") : formatRelativeTime(undefined));

/* ---- Stop measuring this pair (design 32 R3) ---- */

/** A check definition's pair between two nodes: its excluded pairs can hold it. */
const canStop = (p: PathItem) => props.canAdmin && !!p.definitionId && !!p.targetNode && !!p.source;
const stopTarget = ref<PathItem>();
const stopOpen = ref(false);
const stopPending = ref(false);
function askStop(p: PathItem): void {
  stopTarget.value = p;
  stopOpen.value = true;
}
async function stop(): Promise<void> {
  const p = stopTarget.value;
  if (!p?.definitionId || !p.targetNode) return;
  stopPending.value = true;
  try {
    // The definition as stored now, so the save names the version it adds the pair to.
    const current = await api.monitors.definitions.get(p.definitionId);
    const body = stopMeasuringSave(current, p.source, p.targetNode);
    if (body) await api.monitors.definitions.update(body);
    // The pair leaves the matrix with the save, so its way back is here and on the check's sheet.
    toast.success(t("fleet.monitoring.paths.sheet.stop.done", { check: checkLabel(p), source: p.sourceName, target: targetLabel(p) }), {
      action: { label: t("fleet.monitoring.paths.sheet.stop.undo"), onClick: () => void measureAgain(p) },
    });
    stopOpen.value = false;
    chosen.value = undefined;
  } catch (error) {
    if (error instanceof ApiError && error.isVersionConflict) toast.error(t("fleet.monitoring.paths.sheet.stop.conflict", { check: checkLabel(p) }));
    else toast.error(error instanceof Error ? error.message : t("fleet.monitoring.paths.toast.failed"));
  } finally {
    emit("changed");
    stopPending.value = false;
  }
}

/** Undo of a stop: the pair taken out of the definition's excluded pairs again. */
async function measureAgain(p: PathItem): Promise<void> {
  if (!p.definitionId || !p.targetNode) return;
  try {
    const current = await api.monitors.definitions.get(p.definitionId);
    const body = measureAgainSave(current, p.source, p.targetNode);
    if (body) await api.monitors.definitions.update(body);
    toast.success(t("fleet.monitoring.paths.sheet.stop.undone", { check: checkLabel(p), source: p.sourceName, target: targetLabel(p) }));
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("fleet.monitoring.paths.toast.failed"));
  } finally {
    emit("changed");
  }
}

/* ---- Actions ---- */

const openMonitor = computed(() => (openPath.value ? props.monitors.find((m) => m.id === openPath.value!.monitorId) : undefined));
const plan = computed(() => props.data.planQuery.data.value);
const serverEdits = computed(() => props.data.source.value === "paths");
/** A single check this session may edit; a definition's path is edited through its definition's sheet. */
const editable = computed(() => !!openMonitor.value && !openPath.value?.definitionId && props.canAdmin && canEditCheck(openMonitor.value, serverEdits.value));
/** A path of the unmigrated path set (design 32 R1 leaves it only on a server that could not migrate it). */
const pathSetPath = computed(() => !!openPath.value?.managed && !openPath.value.definitionId && props.canEditPathSet);
const pending = ref(false);

/** Pause through the unmigrated path set, or a single check's source, and whether it is paused now. */
const pauseAction = computed<{ kind: "pathset" | "check"; paused: boolean } | undefined>(() => {
  const p = openPath.value;
  if (!p || !props.canAdmin) return undefined;
  if (pathSetPath.value && p.targetNode && plan.value) {
    const draft = draftFromConfig(plan.value.config);
    return { kind: "pathset", paused: !pairEnabledIn(draft, p.source, p.targetNode) };
  }
  const monitor = openMonitor.value;
  if (!p.managed && !p.definitionId && monitor && canEditCheck(monitor, serverEdits.value) && p.source) return { kind: "check", paused: sourcePaused(monitor, p.source) };
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
</script>

<template>
  <ObjectSheet
    :open="!!sheet.openId.value"
    :title="openTitle"
    wrap-title
    :subtitle="openPath ? `${openPath.method.toUpperCase()} · ${openPath.target || openPath.monitorId}` : undefined"
    :state="sheetState"
    :error="query.error.value?.message ?? null"
    :return-focus="sheet.returnFocus"
    :gone-title="$t('fleet.monitoring.paths.sheet.goneTitle')"
    :gone-description="$t('fleet.monitoring.paths.sheet.goneDescription')"
    @close="sheet.close"
    @retry="data.refresh"
  >
    <!-- Checks on this path (design 32 R3): every check on the pair, the name opening its sheet. -->
    <section v-if="pairPaths.length" class="mb-4 space-y-1.5" data-testid="path-checks" :aria-labelledby="'path-checks-title'">
      <h3 id="path-checks-title" class="text-xs font-medium text-muted-foreground">{{ $t('fleet.monitoring.paths.sheet.checks.title') }}</h3>
      <ul class="divide-y divide-border rounded-md border border-border text-xs">
        <li
          v-for="p in pairPaths"
          :key="p.id"
          :class="cn('space-y-1 px-2.5 py-2', pairPaths.length > 1 && p.id === openPath?.id && 'bg-muted/40')"
          :data-check="p.checkId"
          :data-state="displayState(p)"
        >
          <div class="grid grid-cols-[0.5rem_minmax(0,1fr)_auto] items-center gap-x-2.5">
            <span :class="cn('size-2 rounded-full', DOT[displayState(p)])" aria-hidden="true" />
            <button
              type="button"
              class="min-w-0 truncate rounded-sm text-start font-medium text-foreground underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11"
              :title="$t('fleet.monitoring.paths.sheet.checks.open', { check: checkLabel(p) })"
              data-testid="path-check-name"
              @click="emit('openCheck', p.checkId)"
            >
              {{ checkLabel(p) }}
            </button>
            <span :class="cn('font-mono tabular', STATE_INK[displayState(p)])">{{ measuresNow(p) && p.p50Ms !== undefined ? formatMs(p.p50Ms) : '' }}</span>
          </div>
          <p class="flex flex-wrap items-baseline gap-x-1.5 ps-4.5 text-muted-foreground">
            <span class="font-mono text-[10px] uppercase">{{ methodName(p.method) }}</span>
            <span aria-hidden="true">·</span>
            <span :class="cn('min-w-0 break-words', STATE_INK[displayState(p)])">{{ stateText(p) }}</span>
            <span aria-hidden="true">·</span>
            <span class="font-mono tabular" :title="p.lastAt ? new Date(p.lastAt).toISOString() : undefined">{{ lastRun(p) }}</span>
          </p>
          <div v-if="(pairPaths.length > 1 && charted(p)) || canStop(p)" class="flex flex-wrap gap-x-3 gap-y-1 ps-4.5">
            <button
              v-if="pairPaths.length > 1 && charted(p)"
              type="button"
              class="inline-flex items-center gap-1 rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-pressed:font-medium aria-pressed:text-foreground pointer-coarse:min-h-11"
              :aria-pressed="p.id === openPath?.id"
              data-testid="path-check-chart"
              @click="chosen = p.checkId"
            >
              <LineChart class="size-3.5" aria-hidden="true" />
              {{ p.id === openPath?.id ? $t('fleet.monitoring.paths.sheet.checks.charted') : $t('fleet.monitoring.paths.sheet.checks.chart') }}
            </button>
            <button
              v-if="canStop(p)"
              type="button"
              class="rounded-sm text-muted-foreground underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11"
              :aria-label="$t('fleet.monitoring.paths.sheet.stop.actionFor', { check: checkLabel(p) })"
              data-testid="path-check-stop"
              @click="askStop(p)"
            >
              {{ $t('fleet.monitoring.paths.sheet.stop.action') }}
            </button>
          </div>
        </li>
      </ul>
    </section>
    <PathDetail
      v-if="openAddress && openPath"
      :address="openAddress"
      :path="openPath"
      :window="window"
      :source="data.source.value"
      :compact="compact"
      :title="openTitle"
      :offered="offered"
      :failure="openPath.state === 'down' && !openPath.reason ? failureOf(openPath.monitorId, openPath.source) : undefined"
      :agent-version="agentOf?.(openPath.source)"
      :paths-failed="!!data.pathsQuery.error.value && data.source.value === 'unknown'"
      :owned="owned"
      :judges-degraded="!!matrix?.judgesDegraded"
      :verdict="data.triangulation.value ? verdictFor(data.triangulation.value, openPath) : undefined"
      @window="(w) => emit('window', w)"
    />
    <template v-if="openPath" #actions>
      <Button v-if="pauseAction" variant="outline" size="sm" type="button" :disabled="pending" data-testid="path-pause" @click="togglePause">
        <component :is="pauseAction.paused ? Play : Pause" class="size-4" aria-hidden="true" />
        {{ pauseAction.paused ? $t('fleet.monitoring.paths.sheet.resume') : $t('fleet.monitoring.paths.sheet.pause') }}
      </Button>
      <Button v-if="editable && openMonitor" variant="outline" size="sm" type="button" data-testid="path-edit-check" @click="emit('editCheck', openMonitor)">
        <Pencil class="size-4" aria-hidden="true" />
        {{ $t('fleet.monitoring.network.editCheck') }}
      </Button>
      <Button v-else-if="pathSetPath && canAdmin" variant="outline" size="sm" type="button" data-testid="path-edit-pathset" @click="emit('pathSet')">
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

  <ConfirmDialog
    v-model:open="stopOpen"
    :title="$t('fleet.monitoring.paths.sheet.stop.title')"
    :description="stopTarget ? $t('fleet.monitoring.paths.sheet.stop.description', { check: checkLabel(stopTarget), source: stopTarget.sourceName, target: targetLabel(stopTarget) }) : ''"
    :confirm-label="$t('fleet.monitoring.paths.sheet.stop.confirm')"
    :cancel-label="$t('common.actions.cancel')"
    :pending="stopPending"
    @confirm="stop"
  />
</template>
