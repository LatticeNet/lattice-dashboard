<script setup lang="ts">
/**
 * The path sheet (design 29 D7, design 32 D2): one path, opened in place on
 * the Topology view from an edge, a list row or the node sheet's lens, at
 * `?path=`. It carries the path's chart and runs (PathDetail), pausing it,
 * and the way to its check: "Edit check" for an operator check and "Edit
 * path set" for a generated path, which the page opens as a second sheet so
 * cancelling comes back here.
 *
 * When several checks measure the same pair (a path set path and an ICMP
 * check from the same source to the same node), the graph draws one edge and
 * this sheet opens on the one that speaks for it; the others are listed at
 * the top, each one step away, so no check on the pair is hidden.
 */
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink } from "vue-router";
import { ArrowUpRight, Pause, Pencil, Play, Settings2 } from "lucide-vue-next";

import { api, type MonitorView, type MonitorWindow } from "@/lib/api";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import type { OwnedRoute } from "@/composables/useOwnedRoute";
import type { RouteOpen } from "@/composables/useRouteOpen";

import ObjectSheet from "@/components/common/ObjectSheet.vue";
import { Button } from "@/components/ui/button";

import PathDetail from "./PathDetail.vue";
import { buildSourcePause, canEditCheck, sourcePaused } from "./checksModel";
import { draftFromConfig, draftToConfig, formatMs, pairEnabledIn, setPairEnabled } from "./latencyModel";
import { decodePathKey, displayState, targetLabel, type PathItem } from "./pathsModel";
import { usePathsCopy } from "./pathsCopy";
import { pairOrder, pathEnd } from "./topologyModel";
import { verdictFor } from "./triangulationModel";
import type { PathsData } from "./usePathsData";

const props = defineProps<{
  owned: OwnedRoute;
  data: PathsData;
  /** The page's `?path=` (bindRouteOpen), shared with whatever opened the sheet so focus goes back to it. */
  sheet: RouteOpen;
  monitors: MonitorView[];
  canAdmin: boolean;
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
  /** A check changed (a source paused or resumed): the page rereads the monitors with the paths. */
  changed: [];
  window: [window: MonitorWindow];
}>();

const { t } = useI18n();
const { displayLabel, reasonShort, methodName } = usePathsCopy();

const matrix = computed(() => props.data.matrix.value);
const query = props.data.pathsQuery;
const openAddress = computed(() => decodePathKey(props.sheet.openId.value));
const openPath = computed(() => (props.sheet.openId.value ? matrix.value?.paths.find((p) => p.key === props.sheet.openId.value) : undefined));
const openTitle = computed(() => {
  const p = openPath.value;
  if (p) return t("fleet.monitoring.paths.sheet.title", { source: p.sourceName, target: targetLabel(p) });
  return props.sheet.openId.value ?? "";
});
const sheetState = computed(() => {
  if (!props.sheet.openId.value) return "loading" as const;
  if (!matrix.value) return query.error.value && !query.loading.value ? ("failed" as const) : ("loading" as const);
  if (!openPath.value || !openAddress.value) return "gone" as const;
  return query.error.value ? ("stale" as const) : ("ready" as const);
});

/** Every check on the open path's pair, in the order the edge speaks: listed only when there is more than one. */
const pairPaths = computed<PathItem[]>(() => {
  const p = openPath.value;
  if (!p || !matrix.value) return [];
  const end = pathEnd(p);
  const same = matrix.value.paths.filter((q) => q.source === p.source && pathEnd(q) === end);
  return same.length > 1 ? pairOrder(same) : [];
});
const DOT: Record<string, string> = {
  up: "bg-success",
  degraded: "bg-warning",
  down: "bg-destructive",
  unknown: "border border-muted-foreground bg-transparent",
  paused: "bg-muted-foreground/50",
};
const checkLabel = (p: PathItem) => (p.managed ? t("fleet.monitoring.network.pathSet") : p.checkName || p.monitorId);
function pairValue(p: PathItem): string {
  const state = displayState(p);
  if (state === "up" || state === "degraded") return p.p50Ms !== undefined ? formatMs(p.p50Ms) : displayLabel(p);
  if (state === "unknown") return t("fleet.monitoring.paths.state.unknownWhy", { reason: reasonShort(p.reason) });
  return displayLabel(p);
}

/* ---- Actions ---- */

const openMonitor = computed(() => (openPath.value ? props.monitors.find((m) => m.id === openPath.value!.monitorId) : undefined));
const plan = computed(() => props.data.planQuery.data.value);
const serverEdits = computed(() => props.data.source.value === "paths");
const editable = computed(() => !!openMonitor.value && props.canAdmin && canEditCheck(openMonitor.value, serverEdits.value));
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
  if (!p.managed && monitor && canEditCheck(monitor, serverEdits.value) && p.source) return { kind: "check", paused: sourcePaused(monitor, p.source) };
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
    :subtitle="openPath ? `${openPath.method.toUpperCase()} · ${openPath.target || openPath.monitorId}` : undefined"
    :state="sheetState"
    :error="query.error.value?.message ?? null"
    :return-focus="sheet.returnFocus"
    :gone-title="$t('fleet.monitoring.paths.sheet.goneTitle')"
    :gone-description="$t('fleet.monitoring.paths.sheet.goneDescription')"
    @close="sheet.close"
    @retry="data.refresh"
  >
    <section v-if="pairPaths.length" class="mb-4 space-y-1.5" data-testid="path-pair-checks" :aria-label="$t('fleet.monitoring.network.pair.label')">
      <h3 class="text-xs font-medium text-muted-foreground">{{ $t('fleet.monitoring.network.pair.title', { n: pairPaths.length }, pairPaths.length) }}</h3>
      <ul class="divide-y divide-border rounded-md border border-border text-xs">
        <li v-for="p in pairPaths" :key="p.key">
          <button
            type="button"
            :class="cn('grid w-full grid-cols-[0.5rem_minmax(0,1fr)_auto] items-center gap-x-2.5 px-2.5 py-1.5 text-start outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring pointer-coarse:min-h-11', p.key === sheet.openId.value && 'bg-muted/50')"
            :aria-current="p.key === sheet.openId.value ? 'true' : undefined"
            :data-pair-path="p.key"
            @click="sheet.swap(p.key)"
          >
            <span :class="cn('size-2 rounded-full', DOT[displayState(p)])" aria-hidden="true" />
            <span class="min-w-0 truncate">
              <span class="font-mono text-[10px] uppercase text-muted-foreground">{{ methodName(p.method) }}</span>
              {{ checkLabel(p) }}
            </span>
            <span class="font-mono tabular text-muted-foreground">{{ pairValue(p) }}</span>
          </button>
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
      <template v-if="!openPath.managed">
        <Button v-if="editable && openMonitor" variant="outline" size="sm" type="button" data-testid="path-edit-check" @click="emit('editCheck', openMonitor)">
          <Pencil class="size-4" aria-hidden="true" />
          {{ $t('fleet.monitoring.network.editCheck') }}
        </Button>
        <Button v-else variant="outline" size="sm" type="button" @click="emit('openCheck', openPath.monitorId)">
          <Pencil class="size-4" aria-hidden="true" />
          {{ $t('fleet.monitoring.paths.sheet.openCheck') }}
        </Button>
      </template>
      <Button v-else-if="canAdmin" variant="outline" size="sm" type="button" data-testid="path-edit-pathset" @click="emit('pathSet')">
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
</template>
