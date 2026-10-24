<script setup lang="ts">
/**
 * Monitoring's Topology view (design 32 D2): Topology and Paths in one view,
 * on one matrix read, with one query.
 *
 *   graph   the fleet drawn (topologyModel): sources left, targets by region,
 *           chains as arcs, one terminal per address a check dials; a source
 *           picker (?topo.sources=) and a Show filter (?topo=)
 *   list    every path the query keeps, one row each, grouped by the
 *           target's region, worst first, with a column sort
 *
 * The query field (the Paths grammar, at ?paths.q=, since the Incidents layer
 * on this address owns ?q=) filters the list's rows and, in the graph, keeps
 * matching edges and their ends at full strength and fades the rest. Its
 * count is the same in both modes because it counts the same paths: the ones
 * the query keeps, of the matrix's (pathsModel.countPaths is the page's one
 * count rule).
 *
 * An edge, a list row, or a path in the node sheet opens the path sheet in
 * place (?path=); Escape or Close gives focus back to what opened it. A node
 * opens the node sheet (?peek=), led by the node's paths, outbound then
 * inbound, worst first, each one step from its path sheet.
 *
 * ?as= picks the mode: absent, the graph with a mouse from 768 px up and the
 * list on a phone or a touch screen; the other is one tap away.
 */
import { computed, nextTick, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useElementSize, useMediaQuery, useNow } from "@vueuse/core";
import { Network, Route as RouteIcon, Settings2 } from "lucide-vue-next";

import { api, unwrap, type IncidentListResponse, type LineChainView, type MonitorView, type MonitorWindow, type Node } from "@/lib/api";
import { cn } from "@/lib/utils";
import { withoutSorts } from "@/lib/query/syntax";
import { useAsyncData, type AsyncData } from "@/composables/useAsyncData";
import { useListQuery, useQueryText } from "@/composables/useListQuery";
import { bindQueryParam } from "@/composables/useQueryParam";
import { bindRouteOpen } from "@/composables/useRouteOpen";
import type { OwnedRoute } from "@/composables/useOwnedRoute";
import { useAuthStore } from "@/stores/auth";
import { isReporting } from "@/lib/nodeStatus";
import { proofReason } from "@/components/common/proofModel";

import DataState from "@/components/common/DataState.vue";
import EmptyState from "@/components/common/EmptyState.vue";
import ListQueryBar from "@/components/common/ListQueryBar.vue";
import NodeSheet from "@/components/fleet/NodeSheet.vue";
import { Button } from "@/components/ui/button";

import NetworkList from "./NetworkList.vue";
import NodePathList from "./NodePathList.vue";
import PathSheet from "./PathSheet.vue";
import TopologyGraph from "./TopologyGraph.vue";
import TopologySourcePicker from "./TopologySourcePicker.vue";
import { formatPresentation, listOrder, parsePresentation, presentation as presentationFor, roomy, type Presentation } from "./networkModel";
import { NODE_PATHS_SHOWN, monitoringQuery, nodePaths } from "./nodePathsModel";
import { PATHS_QUERY_EXAMPLES, pathsQuerySchema, type PathItem } from "./pathsModel";
import { usePathsCopy } from "./pathsCopy";
import type { PathsData } from "./usePathsData";
import {
  COLLAPSE_AT,
  DEFAULT_DRAWN_SOURCES,
  PATH_TONE,
  TOPOLOGY_LAYERS,
  buildTopology,
  formatDrawnSources,
  parseDrawnSources,
  parseTopologyLayer,
  layerEmpty as emptyKind,
  missingReads,
  readState,
  type TopoRead,
  type TopoReadStatus,
  type TopoReadStatuses,
  type TopologyLayer,
} from "./topologyModel";

const props = defineProps<{
  owned: OwnedRoute;
  /** The page's path reads: the matrix both modes show, and the path set plan. */
  data: PathsData;
  /** The page's node list read; never sent without node:read. */
  nodesQuery: AsyncData<Node[]>;
  /** The operator's and the generated checks, for the sheet's actions. */
  monitors: MonitorView[];
  incidentsQuery: AsyncData<IncidentListResponse>;
  canAdmin: boolean;
  window: MonitorWindow;
  offered: MonitorWindow[];
  /** A check's newest failure on a source: why a down path is down. */
  failureOf: (monitorId: string, source: string) => string | undefined;
  /** The path set exists with no source. */
  noSources: boolean;
  /** A source's agent version, for a path whose agent is too old. */
  agentOf?: (source: string) => string | undefined;
  /** The page's refreshes: each one rereads the chains too. */
  refreshTick?: number;
}>();

const emit = defineEmits<{
  pathSet: [];
  createCheck: [];
  editCheck: [monitor: MonitorView];
  openCheck: [id: string];
  /** A check changed (a source paused or resumed): the page rereads the monitors with the paths. */
  changed: [];
  window: [window: MonitorWindow];
}>();

const { t } = useI18n();
const { reasonText, windowLong } = usePathsCopy();
const auth = useAuthStore();
const canReadNodes = computed(() => auth.can("node:read"));
const canReadChains = computed(() => auth.can("proxy:read"));
const wide = useMediaQuery("(min-width: 768px)");
const finePointer = useMediaQuery("(pointer: fine)");
const now = useNow({ interval: 5000 });

const matrix = computed(() => props.data.matrix.value);
const pathsQuery = props.data.pathsQuery;
const planQuery = props.data.planQuery;
// A session without proxy:read never sends it.
const chainsQuery = useAsyncData<LineChainView[]>(
  (signal) => api.proxy.lineChains({ signal }).then((r) => unwrap(r as { chains: LineChainView[] }, "chains")),
  { pollInterval: canReadChains.value ? 60000 : 0, immediate: canReadChains.value },
);

watch(
  () => props.refreshTick,
  () => {
    if (canReadChains.value) void chainsQuery.refresh();
  },
);

/* ---- The mode ---- */

/** The view's own width, not the window's: the sidebar and the page's gutters take their share first. */
const root = ref<HTMLElement>();
const { width: viewWidth } = useElementSize(root);
const screen = computed(() => ({ roomy: roomy(viewWidth.value), finePointer: finePointer.value }));
const asParam = bindQueryParam<Presentation | "auto">(props.owned, "as", {
  parse: (raw) => parsePresentation(raw),
  format: (value) => (value === "auto" ? undefined : value),
});
const mode = computed<Presentation>(() => presentationFor(asParam.value, screen.value));
function present(value: Presentation): void {
  asParam.value = formatPresentation(value, screen.value);
}

/* ---- One query for both modes ---- */

const schema = pathsQuerySchema({ reasonText });
const storedQuery = bindQueryParam<string>(props.owned, "paths.q", {
  parse: (raw) => (typeof raw === "string" ? raw : ""),
  format: (value) => (value.trim() ? value : undefined),
});
const queryText = useQueryText(storedQuery);
/** The list's own order, worst first; a `sort:` term or a column replaces it. */
const allPaths = computed(() => listOrder(matrix.value?.paths ?? []));
const listQuery = useListQuery(allPaths, schema, queryText);
// Only a query that leaves paths out reshapes the graph: a sort, or a filter every path passes, keeps the drawing as it is.
const matching = computed(() => (listQuery.filtering.value && listQuery.rows.value.length < allPaths.value.length ? new Set(listQuery.rows.value.map((p) => p.key)) : undefined));
const queryExamples = computed(() => PATHS_QUERY_EXAMPLES.map((e) => ({ query: e.query, note: t(`fleet.monitoring.paths.query.examples.${e.key}`) })));
const isEmpty = computed(() => !!matrix.value && matrix.value.paths.length === 0);

/* ---- The graph ---- */

/** The sources the picker drew; absent is the default, the first four in the path set's order. */
const sourcesParam = bindQueryParam<string[] | undefined>(props.owned, "topo.sources", {
  parse: (raw) => parseDrawnSources(raw),
  format: (value) => (value && value.length ? value.join(",") : undefined),
});
const layerParam = bindQueryParam<TopologyLayer>(props.owned, "topo", {
  parse: (raw) => parseTopologyLayer(raw),
  format: (value) => (value === "all" ? undefined : value),
});

const nodes = computed(() => (canReadNodes.value ? props.nodesQuery.data.value : undefined));
const chains = computed(() => (canReadChains.value ? chainsQuery.data.value : undefined));

const model = computed(() =>
  buildTopology({
    nodes: nodes.value,
    plan: planQuery.data.value,
    matrix: matrix.value,
    drawnSources: sourcesParam.value,
    matching: matching.value,
    chains: chains.value,
    incidents: props.incidentsQuery.data.value?.incidents,
    window: props.data.window.value,
    layer: layerParam.value,
  }),
);

/** The picker's choice (in the path set's order): the default written as nothing, so the bare address stays bare. */
function drawSources(ids: string[]): void {
  const defaults = model.value.sourceChoices.slice(0, DEFAULT_DRAWN_SOURCES).map((c) => c.node.id);
  sourcesParam.value = parseDrawnSources(formatDrawnSources(ids, defaults));
}
function drawEverySource(): void {
  drawSources(model.value.sourceChoices.map((c) => c.node.id));
}

type Query = Pick<AsyncData<unknown>, "data" | "error" | "refresh">;
const QUERIES: Record<TopoRead, Query> = {
  plan: planQuery,
  paths: pathsQuery,
  nodes: props.nodesQuery,
  incidents: props.incidentsQuery,
  chains: chainsQuery,
};
const status = (query: Query, allowed: boolean): TopoReadStatus => ({ allowed, hasData: query.data.value !== undefined, failed: !!query.error.value });
const statuses = computed<TopoReadStatuses>(() => ({
  plan: status(planQuery, true),
  paths: status(pathsQuery, true),
  nodes: status(props.nodesQuery, canReadNodes.value),
  incidents: status(props.incidentsQuery, true),
  chains: status(chainsQuery, canReadChains.value),
}));
const readReason = (read: TopoRead) => proofReason(QUERIES[read].error.value);

/** One line for each read the drawing is missing outright, with what that costs it and a retry. */
const missingNotes = computed(() =>
  missingReads(layerParam.value, statuses.value)
    .filter((read) => read !== "paths" && !(read === "chains" && layerParam.value === "chains"))
    .map((read) => ({ read, text: t(`fleet.monitoring.topology.missing.${read}`, { reason: readReason(read) }), retry: () => void QUERIES[read].refresh() })),
);

type LayerEmpty = { title: string; description: string; action?: { label: string; run: () => void } } | null;
const graphEmpty = computed<LayerEmpty>(() => {
  switch (emptyKind(model.value, statuses.value)) {
    case "noSources":
      return { title: t("fleet.monitoring.topology.empty.noSourcesTitle"), description: t("fleet.monitoring.topology.empty.noSourcesDescription") };
    case "chainsDenied":
      return { title: t("fleet.monitoring.topology.empty.noChainAccessTitle"), description: t("fleet.monitoring.topology.empty.noChainAccessDescription") };
    case "chainsFailed":
      // Never read: say why, with a way to try again, instead of a skeleton that never ends.
      return { title: t("fleet.monitoring.topology.empty.chainsFailedTitle"), description: readReason("chains"), action: { label: t("common.actions.retry"), run: () => void chainsQuery.refresh() } };
    case "noChains": {
      const n = model.value.counts.chainsUnplaced;
      const planned = n ? ` ${t("fleet.monitoring.topology.legend.unplaced", { n }, n)}` : "";
      return { title: t("fleet.monitoring.topology.empty.noChainsTitle"), description: t("fleet.monitoring.topology.empty.noChainsDescription") + planned };
    }
    case "noNodes":
      return { title: t("fleet.monitoring.topology.empty.noNodesTitle"), description: t("fleet.monitoring.topology.empty.noNodesDescription") };
    default:
      return null;
  }
});
const graphLoading = computed(() => emptyKind(model.value, statuses.value) === "loading");
const nodesState = computed(() => readState(statuses.value.nodes));
const nodesReason = computed(() => (nodesState.value === "failed" ? readReason("nodes") : null));
const windowLabel = computed(() => windowLong(props.data.window.value));

const showsPaths = computed(() => layerParam.value === "all" || layerParam.value === "paths");
type LegendItem = { key: string; color: string; dash?: string; width: number; double?: boolean; label: string };
// A path's colour is its state's tone and nothing else (design 29 D13): the legend is the states.
const legend = computed<LegendItem[]>(() => [
  ...(showsPaths.value
    ? [
        { key: "up", color: PATH_TONE.up, width: 2, label: t("fleet.monitoring.paths.state.up") },
        ...(matrix.value?.judgesDegraded ? [{ key: "degraded", color: PATH_TONE.degraded, width: 2, label: t("fleet.monitoring.paths.state.degraded") }] : []),
        { key: "down", color: PATH_TONE.down, width: 2.5, label: t("fleet.monitoring.paths.state.down") },
        { key: "unknown", color: PATH_TONE.unknown, dash: "5 4", width: 1.5, label: t("fleet.monitoring.paths.state.unknown") },
        { key: "paused", color: PATH_TONE.paused, dash: "1.5 3.5", width: 1.5, label: t("fleet.monitoring.paths.state.paused") },
      ]
    : []),
  ...((layerParam.value === "all" || layerParam.value === "chains") && model.value.counts.chains > 0
    ? [
        { key: "chain", color: "--primary", width: 4.5, double: true, label: t("fleet.monitoring.topology.legend.chain") },
        { key: "chainBroken", color: "--warning", width: 4.5, double: true, label: t("fleet.monitoring.topology.legend.chainBroken") },
      ]
    : []),
]);
const folds = computed(() => model.value.members.length > COLLAPSE_AT);

/* ---- Sheets ---- */

const pathSheet = bindRouteOpen(props.owned, "path");
const peek = bindRouteOpen(props.owned, "peek");
const nodeSheetError = computed(() => (props.nodesQuery.error.value ? proofReason(props.nodesQuery.error.value) : null));

/** One sheet at a time: a node opens with the path sheet closed, and the other way round. */
function openNode(id: string, el: HTMLElement | null): void {
  peek.open(id, el, { path: undefined });
}
function openPath(key: string, el: HTMLElement | null): void {
  pathSheet.open(key, el, { peek: undefined });
}

/** The node sheet's lens: the node's paths, outbound then inbound, worst first. */
const lens = computed(() => (peek.openId.value ? nodePaths(matrix.value, peek.openId.value) : undefined));
const lensName = (id: string) => nodes.value?.find((n) => n.id === id)?.name || model.value.nodes.get(id)?.name || id;
/**
 * A node's outbound paths in the list, the node sheet closed: `source:=` finds
 * exactly them. Inbound paths are all listed in the lens (one per source and
 * check, so few), since `target:` reads a check's own name and would miss a
 * check to the node named otherwise.
 */
function showOutboundInList(id: string): void {
  const as = formatPresentation("list", screen.value);
  props.owned.replace({ ...props.owned.query(), peek: undefined, path: undefined, as: as === "auto" ? undefined : as, "paths.q": monitoringQuery("reaches", lensName(id)) });
}

function openTerminal(node: Node): void {
  if (!auth.can("terminal:open") || !isReporting(node)) return;
  window.open(`/terminal?node_id=${encodeURIComponent(node.id)}&connect=1`, "_blank", "noopener");
}

/** The graph's skip link: the list reaches every path with one tab stop each, worst first. */
const listRef = ref<InstanceType<typeof NetworkList> | null>(null);
async function skipToList(): Promise<void> {
  present("list");
  await nextTick();
  (listRef.value?.$el as HTMLElement | undefined)?.querySelector<HTMLElement>("[data-row-key]")?.focus();
}

const SEGMENT = "rounded px-2.5 py-1 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11 pointer-coarse:min-w-11";
const STEP = "text-xs font-medium text-muted-foreground";
</script>

<template>
  <div ref="root" class="space-y-4">
    <p v-if="data.source.value === 'legacy'" class="text-xs text-muted-foreground" data-testid="paths-legacy">
      {{ $t('fleet.monitoring.paths.legacy') }}
    </p>

    <ListQueryBar
      v-if="matrix && !isEmpty"
      v-model="queryText"
      class="max-w-3xl"
      storage-key="paths"
      testid="network-query"
      :query="listQuery"
      :count="listQuery.filtering.value ? { shown: listQuery.rows.value.length, total: allPaths.length } : undefined"
      :label="$t('fleet.monitoring.paths.query.label')"
      :placeholder="$t('fleet.monitoring.paths.query.placeholder')"
      :examples="queryExamples"
    />

    <div v-if="matrix && !isEmpty" class="flex flex-wrap items-center gap-2">
      <div class="flex rounded-md border border-border p-0.5 text-xs" role="group" :aria-label="$t('fleet.monitoring.topology.viewLabel')" data-testid="network-mode">
        <button
          v-for="v in (['graph', 'list'] as const)"
          :key="v"
          type="button"
          :class="cn(SEGMENT, mode === v ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:text-foreground')"
          :aria-pressed="mode === v"
          @click="present(v)"
        >
          {{ $t(`fleet.monitoring.topology.view.${v}`) }}
        </button>
      </div>
      <template v-if="mode === 'graph'">
        <div class="flex items-center gap-1.5 text-xs" role="group" :aria-label="$t('fleet.monitoring.topology.layerLabel')" data-testid="topology-layers">
          <span class="text-muted-foreground">{{ $t('fleet.monitoring.topology.layerLabel') }}</span>
          <div class="flex rounded-md border border-border p-0.5">
            <button
              v-for="value in TOPOLOGY_LAYERS"
              :key="value"
              type="button"
              :class="cn(SEGMENT, layerParam === value ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:text-foreground')"
              :aria-pressed="layerParam === value"
              @click="layerParam = value"
            >
              {{ $t(`fleet.monitoring.topology.layer.${value}`) }}
            </button>
          </div>
        </div>
        <!-- Which sources draw their fan: every source with its reach (D13). -->
        <TopologySourcePicker v-if="showsPaths && model.sourceChoices.length > 1" :choices="model.sourceChoices" @update="drawSources" />
      </template>
    </div>

    <DataState :loading="pathsQuery.loading.value" :error="pathsQuery.error.value ?? null" :has-data="!!matrix" :skeleton-rows="8" @retry="data.refresh">
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
          v-else-if="listQuery.filtering.value && listQuery.rows.value.length === 0"
          :title="$t('fleet.monitoring.paths.empty.noMatchTitle')"
          :description="$t('fleet.monitoring.paths.empty.noMatchDescription')"
        >
          <Button size="sm" variant="outline" type="button" @click="queryText = ''">{{ $t('fleet.monitoring.paths.empty.clear') }}</Button>
        </EmptyState>

        <NetworkList
          v-else-if="mode === 'list'"
          ref="listRef"
          :rows="[...listQuery.rows.value]"
          :all="allPaths"
          :sheet="pathSheet"
          :query-sorted="listQuery.sorted.value"
          :failure-of="failureOf"
          :stale="listQuery.staleRows.value"
          :table="screen.roomy"
          @drop-query-sort="queryText = withoutSorts(queryText)"
          @open="openPath"
        />

        <template v-else>
          <div v-if="graphLoading" class="h-64 animate-pulse rounded-lg border border-border bg-muted/30" aria-hidden="true" />
          <EmptyState v-else-if="graphEmpty" :icon="Network" :title="graphEmpty.title" :description="graphEmpty.description">
            <Button v-if="graphEmpty.action" size="sm" variant="outline" type="button" @click="graphEmpty.action.run">{{ graphEmpty.action.label }}</Button>
          </EmptyState>
          <div v-else :class="cn('space-y-3', listQuery.staleRows.value && 'opacity-50')" :inert="listQuery.staleRows.value || undefined">
            <!-- The key, in one row above the drawing; every state is also written on the rows and the card. -->
            <div v-if="legend.length" class="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground" data-testid="topology-legend" role="group" :aria-label="$t('fleet.monitoring.topology.legend.label')">
              <span v-for="item in legend" :key="item.key" class="inline-flex items-center gap-1.5">
                <svg width="22" height="8" aria-hidden="true">
                  <line x1="1" y1="4" x2="21" y2="4" :stroke-linecap="item.double ? 'butt' : 'round'" :stroke-width="item.width" :stroke-dasharray="item.dash" :style="{ stroke: `var(${item.color})` }" />
                  <line v-if="item.double" x1="0" y1="4" x2="22" y2="4" stroke-width="1.5" style="stroke: var(--background)" />
                </svg>
                {{ item.label }}
              </span>
            </div>
            <p v-if="showsPaths && model.counts.undrawn" class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground" data-testid="network-undrawn">
              <span>{{ $t('fleet.monitoring.network.graph.undrawn', { n: model.counts.undrawn }, model.counts.undrawn) }}</span>
              <button
                type="button"
                class="inline-flex h-6 items-center rounded-sm border border-border px-2 text-xs text-foreground outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:h-11 pointer-coarse:px-3"
                @click="drawEverySource"
              >
                {{ $t('fleet.monitoring.network.graph.drawAll', { n: model.sourceChoices.length }) }}
              </button>
            </p>
            <p v-if="listQuery.sorted.value" class="text-xs text-muted-foreground" data-testid="network-sort-list">{{ $t('fleet.monitoring.network.graph.sortList') }}</p>
            <p v-if="!canReadNodes" class="text-xs text-muted-foreground">{{ $t('fleet.monitoring.topology.nodesUnread') }}</p>
            <!-- A read the drawing is missing outright: what it costs, and a retry. -->
            <p v-for="note in missingNotes" :key="note.read" class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-destructive" :data-testid="`topology-missing-${note.read}`">
              <span class="min-w-0 break-words">{{ note.text }}</span>
              <button
                type="button"
                class="inline-flex h-6 items-center rounded-sm border border-border px-2 text-xs text-foreground outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:h-11 pointer-coarse:px-3"
                @click="note.retry"
              >
                {{ $t('common.actions.retry') }}
              </button>
            </p>
            <p v-if="!canReadChains && layerParam === 'all'" class="text-xs text-muted-foreground" data-testid="topology-chains-note">{{ $t('fleet.monitoring.topology.legend.noChains') }}</p>
            <p v-if="model.counts.chainsUnplaced && layerParam !== 'paths'" class="text-xs text-muted-foreground">
              {{ $t('fleet.monitoring.topology.legend.unplaced', { n: model.counts.chainsUnplaced }, model.counts.chainsUnplaced) }}
            </p>
            <p v-if="folds" class="text-xs text-muted-foreground">{{ $t('fleet.monitoring.topology.legend.folded', { n: COLLAPSE_AT }) }}</p>

            <div class="relative">
              <!-- Past the drawing in one step: the list reaches every path with one tab stop each. Shown over the drawing's corner while focused, so nothing moves. -->
              <button
                type="button"
                class="sr-only rounded-md border border-border bg-card text-xs font-medium shadow-(--shadow-overlay) outline-none focus:not-sr-only focus:absolute focus:start-2 focus:top-2 focus:z-40 focus:px-3 focus:py-1.5 focus-visible:ring-2 focus-visible:ring-ring"
                data-testid="topology-skip"
                @click="skipToList"
              >
                {{ $t('fleet.monitoring.topology.skipToList') }}
              </button>
              <TopologyGraph
                :model="model"
                :now="now.getTime()"
                :window-label="windowLabel"
                :nodes-state="nodesState"
                :nodes-reason="nodesReason"
                :open-path="pathSheet.openId.value"
                @open-node="openNode"
                @open-path="openPath"
                @retry-nodes="() => void props.nodesQuery.refresh()"
              />
            </div>
          </div>
        </template>
      </template>
    </DataState>

    <PathSheet
      :owned="owned"
      :data="data"
      :sheet="pathSheet"
      :monitors="monitors"
      :can-admin="canAdmin"
      :window="window"
      :offered="offered"
      :compact="!wide"
      :failure-of="failureOf"
      :agent-of="agentOf"
      @path-set="emit('pathSet')"
      @edit-check="(m) => emit('editCheck', m)"
      @open-check="(id) => emit('openCheck', id)"
      @changed="emit('changed')"
      @window="(w) => emit('window', w)"
    />

    <NodeSheet
      :node-id="peek.openId.value"
      :nodes="nodes"
      :error="nodeSheetError"
      :return-focus="peek.returnFocus"
      @close="peek.close"
      @terminal="openTerminal"
      @retry="nodesQuery.refresh()"
    >
      <template #lead="{ node }">
        <section v-if="lens" class="space-y-3" data-testid="node-sheet-paths" :aria-label="$t('fleet.monitoring.network.lens.label')">
          <p class="text-xs text-muted-foreground">{{ $t('fleet.monitoring.network.lens.description', { window: windowLabel }) }}</p>
          <p v-if="!lens.reaches.length && !lens.reachedBy.length" class="text-xs text-muted-foreground" data-testid="node-sheet-paths-none">{{ $t('fleet.monitoring.nodePaths.notInvolved') }}</p>
          <template v-else>
            <div v-for="side in (['reaches', 'reachedBy'] as const)" :key="side" class="space-y-1.5" :data-testid="`node-sheet-${side}`">
              <h3 :class="STEP">
                {{ $t(`fleet.monitoring.network.lens.${side}`) }} <span class="font-normal tabular">{{ lens[side].length }}</span>
              </h3>
              <NodePathList v-if="lens[side].length" :paths="lens[side]" :side="side" :shown="side === 'reaches' ? NODE_PATHS_SHOWN : lens[side].length" @open="(p: PathItem, el: HTMLElement) => openPath(p.key, el)" />
              <p v-else class="text-xs text-muted-foreground">{{ side === 'reaches' ? $t('fleet.monitoring.nodePaths.noneReaches') : $t('fleet.monitoring.nodePaths.noneReachedBy') }}</p>
              <p v-if="side === 'reaches' && lens[side].length > NODE_PATHS_SHOWN" class="text-xs text-muted-foreground">
                {{ $t('fleet.monitoring.nodePaths.more', { n: lens[side].length - NODE_PATHS_SHOWN }) }}
                <button type="button" class="font-medium text-foreground underline underline-offset-2 pointer-coarse:min-h-11" @click="showOutboundInList(node.id)">{{ $t('fleet.monitoring.network.lens.showAll') }}</button>
              </p>
            </div>
          </template>
        </section>
      </template>
    </NodeSheet>
  </div>
</template>
