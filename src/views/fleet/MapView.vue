<script setup lang="ts">
/**
 * The fleet map (design 23, 4.2): where the nodes are, as status clusters
 * with counts, and a click that opens the node.
 *
 *   observed 4s ago · 31 of 34 located · 2 not reporting · 3 unlocated
 *   [Latency from cd-hs-sh]                                   [+] [-] [fit]
 *   [map: clusters coloured by their worst member, a red count of the down;
 *    a pile no zoom can split spread out on leader lines, its members
 *    listed beside it]
 *   Last hour, p50 from cd-hs-sh: up to 50 ms, ... (only with the arcs)
 *   Unlocated: 3 nodes [Set location]
 *
 * A cluster that a zoom can split zooms in; one node opens the node sheet on
 * ?open=; several on one spot spread out around it (FleetMap), and the page
 * lists them beside the spread (under the map on a phone), non-reporting
 * first, a row and its leg lit together under the pointer. A pile the frame
 * cannot hold apart is listed alone, with focus moved to the list.
 *
 * Beside the node list the page reads open incidents and the latency probes
 * (both need monitor:read) for the map's card and its probe arcs; either
 * read failing or forbidden says so in the card and the legend rather than
 * leaving a blank. The arcs are off until asked for, and ?layer=latency
 * keeps them on across a reload or a shared link.
 */
import { computed, nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useElementSize, useNow } from "@vueuse/core";
import { RouterLink } from "vue-router";
import { toast } from "@/lib/toast";
import { RotateCw, Waypoints } from "lucide-vue-next";

import { api, unwrap, type IncidentListResponse, type LatencyProbePlan, type LatencyRollups, type Node, type NodeGeoResolveResult } from "@/lib/api";
import { useAsyncData } from "@/composables/useAsyncData";
import { useProof } from "@/composables/useProof";
import { useOwnedRoute } from "@/composables/useOwnedRoute";
import { bindQueryParam } from "@/composables/useQueryParam";
import { bindRouteOpen } from "@/composables/useRouteOpen";
import { useAuthStore } from "@/stores/auth";
import { countryName } from "@/lib/fleet";
import { formatAge } from "@/lib/format";
import { compareByAttention, describeNodeStatus, isReporting, nodeStatus } from "@/lib/nodeStatus";
import { useMediaQuery } from "@/composables/useMediaQuery";
import { clusterPlace, latencyLayerState } from "./fleetMapModel";
import { isActive as incidentIsOpen } from "./incidentsModel";
import { BAND_STYLE, LOSS_ATTENTION, buildLatencyMatrix } from "./latencyModel";
import { cn } from "@/lib/utils";
import { proofReason } from "@/components/common/proofModel";

import PageHeader from "@/components/common/PageHeader.vue";
import ProofLine, { type ProofSegment } from "@/components/common/ProofLine.vue";
import AttentionList, { type AttentionItem } from "@/components/common/AttentionList.vue";
import StatusDot from "@/components/common/StatusDot.vue";
import EmptyState from "@/components/common/EmptyState.vue";
import DataState from "@/components/common/DataState.vue";
import FleetMap, { type FleetMapSpread } from "@/components/fleet/FleetMap.vue";
import type { FactState, FleetMapFacts, LatencyFact } from "@/components/fleet/fleetMapTypes";
import NodeSheet from "@/components/fleet/NodeSheet.vue";
import { Button } from "@/components/ui/button";

const auth = useAuthStore();
const { t, locale } = useI18n();
const canAdminNodes = computed(() => auth.can("node:admin"));
const canReadMonitors = computed(() => auth.can("monitor:read"));

const nodesQuery = useAsyncData<Node[]>((signal) => api.nodes.list({ signal }).then((r) => unwrap(r, "nodes")), {
  pollInterval: 10_000,
});
const nodes = computed(() => nodesQuery.data.value ?? []);
const proof = useProof(nodesQuery);

const owned = useOwnedRoute();
const sheet = bindRouteOpen(owned);
const arcsOn = bindQueryParam<boolean>(owned, "layer", { parse: (raw) => raw === "latency", format: (on) => (on ? "latency" : undefined) });

function located(node: Node): boolean {
  return typeof node.geo?.lat === "number" && typeof node.geo?.lon === "number";
}
const locatedNodes = computed(() => nodes.value.filter(located));
const unlocated = computed(() => nodes.value.filter((node) => !located(node)));
const down = computed(() => nodes.value.filter((node) => ["offline", "never_reported"].includes(nodeStatus(node))));

const proofSegments = computed<ProofSegment[]>(() => {
  const out: ProofSegment[] = [{ key: "located", text: t("fleet.map.proof.located", { located: locatedNodes.value.length, total: nodes.value.length }) }];
  if (down.value.length) out.push({ key: "down", text: t("fleet.map.proof.down", { n: down.value.length }), tone: "destructive", to: { name: "nodes", query: { status: "offline" } } });
  if (unlocated.value.length) out.push({ key: "unlocated", text: t("fleet.map.proof.unlocated", { n: unlocated.value.length }), tone: "muted" });
  return out;
});

/* ------------------------- incidents and latency ------------------------- */

// Both need monitor:read; without it nothing is asked for and the card leaves the rows out.
const incidentsQuery = useAsyncData<IncidentListResponse | undefined>(
  (signal) => (canReadMonitors.value ? api.incidents.list(undefined, { signal }) : Promise.resolve(undefined)),
  { pollInterval: 30_000, immediate: canReadMonitors.value },
);
const planQuery = useAsyncData<LatencyProbePlan | undefined>(
  (signal) => (canReadMonitors.value ? api.monitors.latency.plan({ signal }) : Promise.resolve(undefined)),
  { pollInterval: 60_000, immediate: canReadMonitors.value },
);
const rollupsQuery = useAsyncData<LatencyRollups | undefined>(
  (signal) => (canReadMonitors.value ? api.monitors.latency.rollups({ signal }) : Promise.resolve(undefined)),
  { pollInterval: 60_000, immediate: canReadMonitors.value },
);
// Access granted after the page opened (the session's scopes read later): read now rather than at the next poll.
watch(canReadMonitors, (can) => {
  if (!can) return;
  void incidentsQuery.refresh();
  void planQuery.refresh();
  void rollupsQuery.refresh();
});

function stateOf(query: { data: { value: unknown }; error: { value: unknown } }): FactState {
  if (!canReadMonitors.value) return "denied";
  if (query.data.value !== undefined) return "ready";
  return query.error.value ? "failed" : "loading";
}

const openIncidents = computed(() => {
  const counts = new Map<string, number>();
  for (const incident of incidentsQuery.data.value?.incidents ?? []) {
    if (!incident.node_id || !incidentIsOpen(incident)) continue;
    counts.set(incident.node_id, (counts.get(incident.node_id) ?? 0) + 1);
  }
  return counts;
});

/** The probe matrix for the last hour, p50; its first source is the one the map draws from. */
const matrix = computed(() => (planQuery.data.value ? buildLatencyMatrix(planQuery.data.value, rollupsQuery.data.value, "1h", "p50") : undefined));

/**
 * The last hour from the first configured source, one reading per target.
 * Its readings count only once latencyState is ready; before that the
 * source's name still labels the toggle and the card's row.
 */
const latency = computed(() => {
  const source = matrix.value?.sources[0];
  if (!matrix.value || !source) return undefined;
  const readings = new Map<string, LatencyFact>();
  for (const row of matrix.value.rows) {
    const cell = row.cells[0];
    if (!cell) continue;
    readings.set(row.node.node_id, {
      kind: cell.kind,
      band: cell.band,
      p50Ms: cell.p50Ms,
      loss: cell.loss,
      samples: cell.samples,
      expected: cell.expected,
    });
  }
  return { sourceId: source.nodeId, sourceName: source.name, readings, lossAttention: LOSS_ATTENTION, otherSources: matrix.value.sources.length - 1 };
});

// Reading until both the plan and the rollups have answered (fleetMapModel.latencyLayerState).
const latencyState = computed<FleetMapFacts["latencyState"]>(() =>
  latencyLayerState({
    canRead: canReadMonitors.value,
    plan: { hasData: planQuery.data.value !== undefined, failed: !!planQuery.error.value },
    rollups: { hasData: rollupsQuery.data.value !== undefined, failed: !!rollupsQuery.error.value },
    hasSource: !!matrix.value?.sources.length,
  }),
);

const facts = computed<FleetMapFacts>(() => ({
  incidents: openIncidents.value,
  incidentsState: stateOf(incidentsQuery),
  latency: latency.value,
  latencyState: latencyState.value,
}));

const sourceNode = computed(() => (latency.value ? nodes.value.find((node) => node.id === latency.value!.sourceId) : undefined));
const latencyError = computed(() => planQuery.error.value ?? rollupsQuery.error.value);

/** The legend's one line of state while the arcs are asked for, or undefined when the arcs are drawn. */
const layerNotice = computed(() => {
  switch (latencyState.value) {
    case "loading":
      return t("fleet.map.layer.reading");
    case "failed":
      return t("fleet.map.layer.failed", { reason: proofReason(latencyError.value) });
    case "nosource":
      return t("fleet.map.layer.noSource");
    default:
      if (latency.value && (!sourceNode.value || !located(sourceNode.value))) return t("fleet.map.layer.sourceUnlocated", { source: latency.value.sourceName });
      return undefined;
  }
});

/** How old the rollups are, ticking with the proof line's second. */
const now = useNow({ interval: 1000 });
const rollupsAge = computed(() => {
  const at = Date.parse(rollupsQuery.data.value?.generated_at ?? "");
  return Number.isFinite(at) ? formatAge(Math.max(0, now.value.getTime() - at), locale.value) : "";
});

const legendBands = computed(() => [
  { key: "success", swatch: BAND_STYLE.success.swatch, label: t("fleet.monitoring.latency.legend.under", { ms: 50 }) },
  { key: "chart-2", swatch: BAND_STYLE["chart-2"].swatch, label: t("fleet.monitoring.latency.legend.under", { ms: 100 }) },
  { key: "warning", swatch: BAND_STYLE.warning.swatch, label: t("fleet.monitoring.latency.legend.under", { ms: 250 }) },
  { key: "destructive", swatch: BAND_STYLE.destructive.swatch, label: t("fleet.monitoring.latency.legend.over", { ms: 250 }) },
]);

function retryLatency(): void {
  void planQuery.refresh();
  void rollupsQuery.refresh();
}

/* ------------------------------ locate missing ------------------------------ */

const resolving = ref(false);

async function locateMissing(): Promise<void> {
  resolving.value = true;
  try {
    const response = await api.nodes.resolveGeo({ all: true, missing_only: true });
    report(response.results ?? []);
    await nodesQuery.refresh();
  } catch (error) {
    toast.error(error instanceof Error ? error.message : t("fleet.map.toast.resolveFailed"));
  } finally {
    resolving.value = false;
  }
}

function report(results: NodeGeoResolveResult[]): void {
  if (results.some((result) => result.status === "resolver_disabled")) {
    toast.error(t("fleet.map.toast.resolverDisabled"));
    return;
  }
  const updated = results.filter((result) => result.status === "updated").length;
  const unresolved = results.filter((result) => ["lookup_failed", "store_failed", "no_public_ip"].includes(result.status)).length;
  if (updated > 0 && unresolved > 0) toast.warning(t("fleet.map.toast.resolvedWithFailures", { count: updated, failed: unresolved }));
  else if (updated > 0) toast.success(t("fleet.map.toast.resolved", { count: updated }));
  else if (unresolved > 0) toast.error(t("fleet.map.toast.resolveNoPublicIp", { count: unresolved }));
  else toast.info(t("fleet.map.toast.resolveNoop"));
}

const attention = computed<AttentionItem[]>(() => {
  if (!unlocated.value.length) return [];
  const names = unlocated.value.slice(0, 3).map((node) => node.name || node.id).join(", ");
  return [
    {
      key: "unlocated",
      tone: "info",
      claim: t("fleet.map.attention.unlocated", { n: unlocated.value.length }, unlocated.value.length),
      proof: unlocated.value.length > 3 ? `${names} +${unlocated.value.length - 3}` : names,
      action: canAdminNodes.value ? { label: t("fleet.map.actions.resolveMissing"), run: () => void locateMissing() } : undefined,
    },
  ];
});

/* --------------------------- a cluster on one spot --------------------------- */

/**
 * Members of a pile on one spot. Spread on the map, they are listed beside
 * the spread from 768 px, clear of its legs, and under the map on a phone;
 * focus stays with the map's first leg. A pile too big to spread in the
 * frame is listed alone, with focus moved to the list's heading. Escape or
 * Close gives focus back to the cluster either way. Non-reporting members
 * come first: the offline node was eighth of twelve.
 */
const listedIds = ref<string[]>([]);
/** spread: the map shows the members as legs; list: the list is all there is. */
const listedFrom = ref<"spread" | "list">("list");
const listed = computed(() =>
  listedIds.value
    .map((id) => nodes.value.find((node) => node.id === id))
    .filter((node): node is Node => !!node)
    .sort((a, b) => compareByAttention(a, b) || (a.name || a.id).localeCompare(b.name || b.id)),
);
const listedPlace = computed(() => {
  const where = clusterPlace(listed.value.map((node) => node.geo));
  switch (where.kind) {
    case "city":
      return [where.city, where.country].filter(Boolean).join(", ");
    case "country":
      return countryName(where.country, locale.value);
    case "places":
      return t("fleet.map.cluster.places", { n: where.count });
    default:
      return "";
  }
});
const wide = useMediaQuery("(min-width: 768px)");
const mapWrap = ref<HTMLElement | null>(null);
const map = ref<InstanceType<typeof FleetMap> | null>(null);
const listHeading = ref<HTMLElement | null>(null);
let listOpener: Element | null = null;
/** What the panel stays clear of, in px inside the map: the spread's box, or the listed cluster's mark. */
const anchor = ref<{ left: number; top: number; right: number; bottom: number; width: number; height: number } | null>(null);
const PANEL_W = 320;
/** The side of the spread or the mark the panel takes: the right when it fits. */
const panelSide = computed<"left" | "right" | null>(() => {
  const at = anchor.value;
  if (!at || !wide.value || !listed.value.length) return null;
  return at.right + 16 + PANEL_W <= at.width - 8 ? "right" : "left";
});
/** Where the panel sits, in px inside the map. */
const panelRect = computed(() => {
  const at = anchor.value;
  if (!at) return null;
  const maxHeight = Math.max(160, Math.min(360, at.height - 16));
  const left = panelSide.value === "right" ? at.right + 16 : Math.max(8, at.left - 16 - PANEL_W);
  const top = Math.min(Math.max(8, at.top), Math.max(8, at.height - maxHeight - 8));
  return { left, top, maxHeight };
});
const panelStyle = computed(() => {
  const rect = panelRect.value;
  if (!rect) return {};
  return { left: `${rect.left}px`, top: `${rect.top}px`, width: `${PANEL_W}px`, maxHeight: `${rect.maxHeight}px` };
});
const panel = ref<HTMLElement | null>(null);
const { height: panelHeight } = useElementSize(panel, undefined, { box: "border-box" });
/** The box the panel covers beside a spread, so a leg's card on the map keeps clear of it. */
const listBox = computed(() => {
  const rect = panelRect.value;
  if (!rect || listedFrom.value !== "spread" || !panelSide.value) return null;
  const height = panelHeight.value > 0 ? panelHeight.value : rect.maxHeight;
  return { left: rect.left, top: rect.top, right: rect.left + PANEL_W, bottom: rect.top + height };
});

/** The member under the pointer, on the map or in the list: both light up. */
const hoverId = ref<string | null>(null);
let hoverFromMap = false;

/** The map's leg under the pointer; its "none" (sent a moment after the pointer leaves) never clears a row hovered since. */
function onMapHover(id: string | null): void {
  if (id) hoverId.value = id;
  else if (hoverFromMap) hoverId.value = null;
  hoverFromMap = !!id;
}

function onRowHover(id: string | null): void {
  hoverFromMap = false;
  hoverId.value = id;
}

function onSelect(ids: string[], opener: Element): void {
  if (ids.length === 1) {
    if (listedFrom.value === "list") closeList(false);
    sheet.open(ids[0]!, opener as HTMLElement);
    return;
  }
  // Too many to spread in this frame: list them, focus on the list.
  listOpener = opener;
  listedFrom.value = "list";
  const wrap = mapWrap.value?.getBoundingClientRect();
  const mark = opener.getBoundingClientRect();
  anchor.value = wrap
    ? {
        left: mark.left - wrap.left,
        top: mark.top - wrap.top - 28,
        right: mark.right - wrap.left,
        bottom: mark.bottom - wrap.top,
        width: wrap.width,
        height: wrap.height,
      }
    : null;
  listedIds.value = ids;
  void nextTick(() => {
    const heading = listHeading.value;
    if (!heading) return;
    heading.focus({ preventScroll: wide.value });
    if (!wide.value) heading.scrollIntoView({ block: "nearest" });
  });
}

function onSpread(spread: FleetMapSpread | null): void {
  if (!spread) {
    if (listedFrom.value === "spread") {
      listedIds.value = [];
      anchor.value = null;
    }
    return;
  }
  listOpener = null;
  listedFrom.value = "spread";
  const wrap = mapWrap.value?.getBoundingClientRect();
  anchor.value = wrap ? { ...spread.box, width: wrap.width, height: wrap.height } : null;
  listedIds.value = spread.ids;
}

function closeList(returnFocus = true): void {
  if (listedFrom.value === "spread") {
    // The map folds the spread and gives focus back to its pile.
    map.value?.collapse(returnFocus);
    return;
  }
  listedIds.value = [];
  anchor.value = null;
  const opener = listOpener;
  listOpener = null;
  if (returnFocus && (opener instanceof HTMLElement || opener instanceof SVGElement)) opener.focus();
}

/** The ring on the map: the open sheet's node, or every member of a pile listed without a spread. */
const activeIds = computed(() => (sheet.openId.value ? [sheet.openId.value] : listedFrom.value === "list" ? listedIds.value : []));

/** Why the node read failed, for the sheet; null while a first read retries, so the sheet shows it loading. */
const sheetError = computed(() => (nodesQuery.error.value && !nodesQuery.loading.value ? proofReason(nodesQuery.error.value) : null));

function openTerminal(node: Node): void {
  if (!auth.can("terminal:open") || !isReporting(node)) return;
  window.open(`/terminal?node_id=${encodeURIComponent(node.id)}&connect=1`, "_blank", "noopener");
}

const STATUS_TEXT: Record<string, string> = {
  success: "text-muted-foreground",
  warning: "text-warning-text",
  destructive: "text-destructive",
  muted: "text-muted-foreground",
};
</script>

<template>
  <div class="space-y-5 p-4 sm:p-6">
    <PageHeader :title="$t('fleet.map.title')">
      <template #description>
        <p class="text-sm text-muted-foreground">{{ $t('fleet.map.description') }}</p>
        <ProofLine v-bind="proof" :segments="proofSegments" @retry="nodesQuery.refresh" />
      </template>
      <template #actions>
        <Button variant="outline" size="sm" type="button" :disabled="nodesQuery.refreshing.value" @click="nodesQuery.refresh">
          <RotateCw :class="cn('size-4', nodesQuery.refreshing.value && 'animate-spin')" aria-hidden="true" />
          {{ $t('common.actions.refresh') }}
        </Button>
      </template>
    </PageHeader>

    <AttentionList :items="attention" />

    <EmptyState
      v-if="nodesQuery.data.value !== undefined && nodes.length === 0"
      :title="$t('fleet.map.emptyTitle')"
      :description="$t('fleet.map.emptyDescription')"
    />
    <template v-else-if="nodesQuery.data.value !== undefined">
      <div class="min-w-0 space-y-2">
        <div ref="mapWrap" class="relative">
          <FleetMap
            ref="map"
            :nodes="nodes"
            :active-ids="activeIds"
            :facts="facts"
            :arcs="arcsOn"
            :highlight-id="hoverId"
            :list-box="listBox"
            @select="onSelect"
            @spread="onSpread"
            @hover="onMapHover"
          >
            <template #controls>
              <button
                type="button"
                :class="
                  cn(
                    'inline-flex h-8 max-w-full items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-white disabled:cursor-not-allowed disabled:opacity-50 pointer-coarse:h-11',
                    arcsOn ? 'border-white/40 bg-white/15 text-white hover:bg-white/20' : 'border-white/15 bg-black/50 text-white/85 hover:bg-black/70',
                  )
                "
                :aria-pressed="arcsOn"
                :disabled="!canReadMonitors"
                :title="canReadMonitors ? undefined : $t('fleet.map.layer.denied')"
                data-testid="map-latency-toggle"
                @click="arcsOn = !arcsOn"
              >
                <Waypoints class="size-3.5 shrink-0" aria-hidden="true" />
                <span class="truncate">{{ latency ? $t('fleet.map.layer.latency', { source: latency.sourceName }) : $t('fleet.map.layer.latencyPlain') }}</span>
              </button>
            </template>
          </FleetMap>
          <!-- From 768 px: the members beside the spread or the cluster they came from. -->
          <section
            v-if="listed.length && wide"
            ref="panel"
            class="absolute z-20 flex flex-col overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-lg"
            :style="panelStyle"
            aria-labelledby="map-listed"
            data-testid="map-listed-panel"
            :data-from="listedFrom"
            @keydown.esc.stop.prevent="closeList()"
          >
            <header class="flex items-center gap-2 border-b border-border px-3 py-2">
              <h2 id="map-listed" ref="listHeading" tabindex="-1" class="min-w-0 truncate rounded-sm text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">
                {{ $t('fleet.map.listed.title', { n: listed.length, place: listedPlace || $t('fleet.map.cluster.somewhere') }) }}
              </h2>
              <Button variant="ghost" size="sm" class="ms-auto shrink-0" type="button" @click="closeList()">{{ $t('common.actions.close') }}</Button>
            </header>
            <ul class="min-h-0 divide-y divide-border overflow-y-auto">
              <li v-for="node in listed" :key="node.id">
                <button
                  type="button"
                  :class="cn('flex h-8 w-full items-center gap-2 px-3 text-left text-sm outline-none transition-colors hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring pointer-coarse:h-11', hoverId === node.id && 'bg-muted/40')"
                  :data-node="node.id"
                  @click="sheet.open(node.id, $event.currentTarget as HTMLElement)"
                  @pointerenter="onRowHover(node.id)"
                  @pointerleave="onRowHover(null)"
                  @focus="onRowHover(node.id)"
                  @blur="onRowHover(null)"
                >
                  <StatusDot :status="describeNodeStatus(node).health" :pulse="false" />
                  <span class="min-w-0 truncate font-mono text-[13px]">{{ node.name || node.id }}</span>
                  <span
                    v-if="nodeStatus(node) !== 'online'"
                    :class="cn('ms-auto shrink-0 text-xs', STATUS_TEXT[describeNodeStatus(node).tone])"
                  >{{ $t(describeNodeStatus(node).labelKey) }}</span>
                </button>
              </li>
            </ul>
          </section>
        </div>

        <!-- The arcs' legend, with what the layer last heard; or why there are no arcs. -->
        <div v-if="arcsOn" class="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground" data-testid="map-latency-legend">
          <template v-if="layerNotice">
            <span :class="latencyState === 'failed' ? 'text-destructive' : undefined">{{ layerNotice }}</span>
            <button
              v-if="latencyState === 'failed'"
              type="button"
              class="underline decoration-dotted underline-offset-2 hover:text-foreground pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:min-w-11 pointer-coarse:items-center pointer-coarse:justify-center pointer-coarse:px-2"
              @click="retryLatency"
            >
              {{ $t('common.actions.retry') }}
            </button>
          </template>
          <template v-else-if="latency">
            <span class="text-foreground">{{ $t('fleet.map.layer.legend', { source: latency.sourceName }) }}</span>
            <span v-for="band in legendBands" :key="band.key" class="inline-flex items-center gap-1.5">
              <span :class="cn('h-0.5 w-4 rounded-full', band.swatch)" aria-hidden="true" />{{ band.label }}
            </span>
            <span>{{ $t('fleet.map.layer.lossy', { pct: Math.round(LOSS_ATTENTION * 100) }) }}</span>
            <span>{{ $t('fleet.map.layer.worst') }}</span>
            <span class="inline-flex items-center gap-1.5">
              <span class="w-4 border-t-2 border-dotted border-destructive" aria-hidden="true" />{{ $t('fleet.map.layer.failing') }}
            </span>
            <span class="inline-flex items-center gap-1.5">
              <span class="w-4 border-t-2 border-dotted border-muted-foreground" aria-hidden="true" />{{ $t('fleet.map.layer.unknown') }}
            </span>
            <span v-if="rollupsAge" class="font-mono">{{ $t('fleet.map.layer.heard', { age: rollupsAge }) }}</span>
          </template>
          <span v-if="latency && latency.otherSources > 0">{{ $t('fleet.map.layer.otherSources', { n: latency.otherSources }, latency.otherSources) }}</span>
          <RouterLink
            :to="{ name: 'monitoring', query: { view: 'latency' } }"
            class="underline decoration-dotted underline-offset-2 hover:text-foreground pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:items-center"
          >
            {{ $t('fleet.map.layer.open') }}
          </RouterLink>
        </div>
        <p class="hidden text-xs text-muted-foreground pointer-fine:block">{{ $t('fleet.map.canvasHint') }}</p>
        <p class="hidden text-xs text-muted-foreground pointer-coarse:block">{{ $t('fleet.map.touchHint') }}</p>
        <p id="fleet-map-keys" class="hidden text-xs text-muted-foreground pointer-fine:block">{{ $t('fleet.map.keysHint') }}</p>
      </div>

      <div class="grid min-w-0 grid-cols-1 items-start gap-5 lg:grid-cols-2">
        <!-- On a phone: the members under the map. -->
        <section
          v-if="listed.length && !wide"
          class="overflow-hidden rounded-lg border border-border bg-card"
          aria-labelledby="map-listed"
          data-testid="map-listed-panel"
          :data-from="listedFrom"
          @keydown.esc.stop.prevent="closeList()"
        >
          <header class="flex items-center gap-2 border-b border-border px-4 py-2.5">
            <h2 id="map-listed" ref="listHeading" tabindex="-1" class="min-w-0 truncate rounded-sm text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">
              {{ $t('fleet.map.listed.title', { n: listed.length, place: listedPlace || $t('fleet.map.cluster.somewhere') }) }}
            </h2>
            <Button variant="ghost" size="sm" class="ms-auto pointer-coarse:h-11" type="button" @click="closeList()">{{ $t('common.actions.close') }}</Button>
          </header>
          <ul class="divide-y divide-border">
            <li v-for="node in listed" :key="node.id">
              <button
                type="button"
                class="flex w-full items-center gap-2 px-4 py-2 text-left text-sm outline-none transition-colors hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring pointer-coarse:min-h-11"
                :data-node="node.id"
                @click="sheet.open(node.id, $event.currentTarget as HTMLElement)"
              >
                <StatusDot :status="describeNodeStatus(node).health" />
                <span class="min-w-0 truncate font-mono text-[13px]">{{ node.name || node.id }}</span>
                <span
                  v-if="nodeStatus(node) !== 'online'"
                  :class="cn('ms-auto shrink-0 text-xs', STATUS_TEXT[describeNodeStatus(node).tone])"
                >{{ $t(describeNodeStatus(node).labelKey) }}</span>
              </button>
            </li>
          </ul>
        </section>

        <!-- Nodes without coordinates: where to set them. -->
        <section v-if="unlocated.length" class="overflow-hidden rounded-lg border border-border bg-card" aria-labelledby="map-unlocated">
          <header class="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
            <h2 id="map-unlocated" class="text-sm font-medium">{{ $t('fleet.map.unlocated.title') }}</h2>
            <span v-if="canAdminNodes" class="text-xs text-muted-foreground">{{ $t('fleet.map.unlocated.hint') }}</span>
          </header>
          <ul class="divide-y divide-border">
            <li v-for="node in unlocated" :key="node.id" class="flex items-center gap-2 px-4 py-2 text-sm">
              <StatusDot :status="describeNodeStatus(node).health" />
              <button
                type="button"
                class="min-w-0 truncate rounded-sm text-left font-medium outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11"
                @click="sheet.open(node.id, $event.currentTarget as HTMLElement)"
              >
                {{ node.name || node.id }}
              </button>
              <span class="shrink-0 font-mono text-xs text-muted-foreground">{{ node.public_ip || $t('fleet.map.unlocated.noIp') }}</span>
              <RouterLink
                v-if="canAdminNodes"
                :to="{ name: 'node-detail', params: { id: node.id }, query: { view: 'settings' }, hash: '#node-geo' }"
                class="ms-auto shrink-0 text-xs text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:items-center"
              >
                {{ $t('fleet.map.unlocated.set') }}
              </RouterLink>
            </li>
          </ul>
        </section>
      </div>
    </template>
    <div v-else-if="nodesQuery.loading.value" class="grid aspect-[2/1] place-items-center rounded-lg border border-dashed border-border text-sm text-muted-foreground">
      {{ $t('common.proof.reading') }}
    </div>
    <!-- The first read failed: no map is drawn from nothing. -->
    <DataState v-else :loading="false" :error="nodesQuery.error.value ?? null" @retry="nodesQuery.refresh" />

    <NodeSheet
      :node-id="sheet.openId.value"
      :nodes="nodesQuery.data.value"
      :error="sheetError"
      :return-focus="sheet.returnFocus"
      @close="sheet.close"
      @terminal="openTerminal"
      @retry="nodesQuery.refresh"
    />
  </div>
</template>
