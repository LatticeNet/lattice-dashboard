<script setup lang="ts">
/**
 * Monitoring's Topology layer: every path the console knows about, drawn
 * once (topologyModel): the control plane and each node's heartbeat, the
 * latency probes from their sources, relay to exit chains, and the checks
 * an operator made. Filters for the paths shown (?topo=) and the window
 * (?window=, shared with the Latency layer); hover or focus for the numbers
 * and when they were heard; click for the node sheet (?peek=), the pair's
 * series on the Latency layer, or the monitor sheet (?open=, the page's).
 *
 * Under 768 px, and on ?as=list, the same model reads as a list of paths.
 *
 * The page passes what it already polls (nodes, monitors, incidents); this
 * layer reads the probe plan and rollups (every 30 s, like Latency) and the
 * line chains (every 60 s, only with proxy:read).
 */
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { useMediaQuery, useNow } from "@vueuse/core";
import { Network, RefreshCw } from "lucide-vue-next";

import { api, unwrap, type Incident, type LatencyProbePlan, type LatencyWindow, type LineChainView, type MonitorView, type Node } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useAsyncData } from "@/composables/useAsyncData";
import { useProof } from "@/composables/useProof";
import { bindQueryParam } from "@/composables/useQueryParam";
import { bindRouteOpen } from "@/composables/useRouteOpen";
import type { OwnedRoute } from "@/composables/useOwnedRoute";
import { useAuthStore } from "@/stores/auth";
import { isReporting } from "@/lib/nodeStatus";
import { proofReason } from "@/components/common/proofModel";

import DataState from "@/components/common/DataState.vue";
import EmptyState from "@/components/common/EmptyState.vue";
import ProofLine, { type ProofSegment } from "@/components/common/ProofLine.vue";
import NodeSheet from "@/components/fleet/NodeSheet.vue";
import { Button } from "@/components/ui/button";

import TopologyGraph from "./TopologyGraph.vue";
import TopologyList from "./TopologyList.vue";
import { LATENCY_WINDOWS, LOSS_ATTENTION, pairKey } from "./latencyModel";
import { COLLAPSE_AT, TOPOLOGY_LAYERS, buildTopology, type TopologyLayer } from "./topologyModel";

const props = defineProps<{
  owned: OwnedRoute;
  /** The page's node list; undefined until read, or when node:read is missing. */
  nodes: readonly Node[] | undefined;
  nodesError?: Error | null;
  /** Every monitor the page listed, generated ones included. */
  monitors: readonly MonitorView[] | undefined;
  incidents: readonly Incident[] | undefined;
}>();

const emit = defineEmits<{
  layer: [layer: "latency" | "monitors"];
  refreshPage: [];
  /** The page owns the monitor sheet (?open=). */
  openMonitor: [id: string, el: HTMLElement | null];
}>();

const { t } = useI18n();
const auth = useAuthStore();
const canRead = computed(() => auth.can("monitor:read"));
const canReadNodes = computed(() => auth.can("node:read"));
const canReadChains = computed(() => auth.can("proxy:read"));
const wide = useMediaQuery("(min-width: 768px)");
const now = useNow({ interval: 5000 });

const planQuery = useAsyncData(
  (signal) => (canRead.value ? api.monitors.latency.plan({ signal }) : Promise.resolve(undefined as unknown as LatencyProbePlan)),
  { pollInterval: 30000, immediate: canRead.value },
);
const rollupsQuery = useAsyncData(
  (signal) => (canRead.value ? api.monitors.latency.rollups({ signal }) : Promise.resolve(undefined)),
  { pollInterval: 30000, immediate: canRead.value },
);
// A session without proxy:read never sends it.
const chainsQuery = useAsyncData<LineChainView[]>(
  (signal) => api.proxy.lineChains({ signal }).then((r) => unwrap(r as { chains: LineChainView[] }, "chains")),
  { pollInterval: canReadChains.value ? 60000 : 0, immediate: canReadChains.value },
);

const windowParam = bindQueryParam<LatencyWindow>(props.owned, "window", {
  parse: (raw) => (LATENCY_WINDOWS.includes(raw as LatencyWindow) ? (raw as LatencyWindow) : "1h"),
  format: (value) => (value === "1h" ? undefined : value),
});
const layerParam = bindQueryParam<TopologyLayer>(props.owned, "topo", {
  parse: (raw) => (TOPOLOGY_LAYERS.includes(raw as TopologyLayer) ? (raw as TopologyLayer) : "all"),
  format: (value) => (value === "all" ? undefined : value),
});
const asParam = bindQueryParam<"graph" | "list">(props.owned, "as", {
  parse: (raw) => (raw === "list" ? "list" : "graph"),
  format: (value) => (value === "graph" ? undefined : value),
});
const presentation = computed(() => (wide.value ? asParam.value : "list"));

/** The last chains read; a failed refresh keeps the last good list, a session without proxy:read has none. */
const chains = computed(() => (canReadChains.value ? chainsQuery.data.value : undefined));

const model = computed(() =>
  buildTopology({
    nodes: canReadNodes.value ? props.nodes : undefined,
    plan: planQuery.data.value,
    rollups: rollupsQuery.data.value,
    chains: chains.value,
    monitors: props.monitors,
    incidents: props.incidents,
    window: windowParam.value,
    layer: layerParam.value,
    now: now.value.getTime(),
  }),
);
const windowLabel = computed(() => t(`fleet.monitoring.latency.window.${windowParam.value}`));

function refreshAll(): void {
  void planQuery.refresh();
  void rollupsQuery.refresh();
  if (canReadChains.value) void chainsQuery.refresh();
  emit("refreshPage");
}

/* ---- Head ---- */

const proof = useProof([planQuery, rollupsQuery], { hasData: () => planQuery.data.value !== undefined });
const proofSegments = computed<ProofSegment[]>(() => {
  const m = model.value;
  if (!planQuery.data.value) return [];
  const c = m.counts;
  const out: ProofSegment[] = [];
  if (m.cp.known) out.push({ key: "nodes", tone: "strong", text: t("fleet.monitoring.topology.proof.nodes", { n: m.cp.total }, m.cp.total) });
  if (m.cp.quiet) out.push({ key: "quietNodes", tone: "destructive", text: t("fleet.monitoring.topology.cp.quiet", { n: m.cp.quiet }) });
  if (layerParam.value === "all" || layerParam.value === "probes") {
    out.push({ key: "paths", text: t("fleet.monitoring.topology.proof.paths", { n: c.paths }, c.paths) });
    if (c.failing) out.push({ key: "failing", tone: "destructive", text: t("fleet.monitoring.topology.proof.failing", { n: c.failing }) });
    if (c.lossy) out.push({ key: "lossy", tone: "warning", text: t("fleet.monitoring.topology.proof.lossy", { n: c.lossy }) });
    if (c.quiet) out.push({ key: "quiet", tone: "warning", text: t("fleet.monitoring.topology.proof.quiet", { n: c.quiet }) });
    if (c.unknown) out.push({ key: "unknown", tone: "muted", text: t("fleet.monitoring.topology.proof.unknown", { n: c.unknown }) });
  }
  if ((layerParam.value === "all" || layerParam.value === "chains") && chains.value) {
    out.push({ key: "chains", text: t("fleet.monitoring.topology.proof.chains", { n: c.chains }, c.chains) });
    if (c.chainsBroken) out.push({ key: "chainsBroken", tone: "warning", text: t("fleet.monitoring.topology.proof.chainsBroken", { n: c.chainsBroken }, c.chainsBroken) });
  }
  if (layerParam.value === "all" || layerParam.value === "checks") {
    if (c.checks || layerParam.value === "checks") out.push({ key: "checks", text: t("fleet.monitoring.topology.proof.checks", { n: c.checks }, c.checks) });
    if (c.checksFailing) out.push({ key: "checksFailing", tone: "destructive", text: t("fleet.monitoring.topology.proof.checksFailing", { n: c.checksFailing }) });
  }
  return out;
});

const layerTabs = computed(() =>
  TOPOLOGY_LAYERS.map((value) => ({ value, label: t(`fleet.monitoring.topology.layer.${value}`) })),
);

/* ---- States ---- */

const chainsNote = computed(() => {
  if (layerParam.value !== "all") return "";
  if (!canReadChains.value) return t("fleet.monitoring.topology.legend.noChains");
  if (chainsQuery.error.value && chainsQuery.data.value === undefined) return t("fleet.monitoring.topology.legend.chainsFailed", { reason: proofReason(chainsQuery.error.value) });
  return "";
});

type LayerEmpty = { title: string; description: string; action?: { label: string; run: () => void } } | null;
const layerEmpty = computed<LayerEmpty>(() => {
  const m = model.value;
  switch (layerParam.value) {
    case "probes":
      if (m.sources.length === 0) {
        return { title: t("fleet.monitoring.topology.empty.noSourcesTitle"), description: t("fleet.monitoring.topology.empty.noSourcesDescription"), action: { label: t("fleet.monitoring.topology.empty.openLatency"), run: () => emit("layer", "latency") } };
      }
      return null;
    case "chains":
      if (!canReadChains.value) return { title: t("fleet.monitoring.topology.empty.noChainAccessTitle"), description: t("fleet.monitoring.topology.empty.noChainAccessDescription") };
      if (chainsQuery.data.value === undefined) {
        // Never read: say why, with a way to try again, instead of a skeleton that never ends.
        if (chainsQuery.error.value) {
          return {
            title: t("fleet.monitoring.topology.empty.chainsFailedTitle"),
            description: proofReason(chainsQuery.error.value),
            action: { label: t("common.actions.retry"), run: () => void chainsQuery.refresh() },
          };
        }
        return null;
      }
      if (m.counts.chains === 0) {
        const planned = m.counts.chainsUnplaced ? ` ${t("fleet.monitoring.topology.legend.unplaced", { n: m.counts.chainsUnplaced }, m.counts.chainsUnplaced)}` : "";
        return { title: t("fleet.monitoring.topology.empty.noChainsTitle"), description: t("fleet.monitoring.topology.empty.noChainsDescription") + planned };
      }
      return null;
    case "checks":
      if (m.checks.length === 0) {
        return { title: t("fleet.monitoring.topology.empty.noChecksTitle"), description: t("fleet.monitoring.topology.empty.noChecksDescription"), action: { label: t("fleet.monitoring.topology.empty.openMonitors"), run: () => emit("layer", "monitors") } };
      }
      return null;
    default:
      if (m.members.length === 0 && m.sources.length === 0) return { title: t("fleet.monitoring.topology.empty.noNodesTitle"), description: t("fleet.monitoring.topology.empty.noNodesDescription") };
      return null;
  }
});
const chainsLoading = computed(
  () => layerParam.value === "chains" && canReadChains.value && chainsQuery.data.value === undefined && !chainsQuery.error.value,
);

/* ---- Legend ---- */

const showsProbes = computed(() => layerParam.value === "all" || layerParam.value === "probes");
const showsChains = computed(() => (layerParam.value === "all" || layerParam.value === "chains") && model.value.counts.chains > 0);
const showsChecks = computed(() => (layerParam.value === "all" || layerParam.value === "checks") && model.value.checks.length > 0);
type LegendItem = { key: string; color: string; dash?: string; width: number; double?: boolean; label: string };
const LEGEND_PROBES = computed<LegendItem[]>(() => [
  { key: "success", color: "--success", width: 2, label: t("fleet.monitoring.topology.legend.under", { ms: 50 }) },
  { key: "chart-2", color: "--chart-2", width: 2, label: t("fleet.monitoring.topology.legend.under", { ms: 100 }) },
  { key: "warning", color: "--warning", width: 2, label: t("fleet.monitoring.topology.legend.under", { ms: 250 }) },
  { key: "destructive", color: "--destructive", width: 2, label: t("fleet.monitoring.topology.legend.over", { ms: 250 }) },
  { key: "lossy", color: "--warning", width: 3.5, label: t("fleet.monitoring.topology.legend.lossy", { pct: Math.round(LOSS_ATTENTION * 100) }) },
  { key: "failing", color: "--destructive", dash: "5 4", width: 2, label: t("fleet.monitoring.topology.legend.failing") },
  { key: "quiet", color: "--muted-foreground", dash: "5 4", width: 1.5, label: t("fleet.monitoring.topology.legend.quiet") },
  { key: "unknown", color: "--muted-foreground", dash: "1.5 3.5", width: 1.5, label: t("fleet.monitoring.topology.legend.unknown") },
]);
const LEGEND_CHAINS = computed<LegendItem[]>(() => [
  { key: "chain", color: "--primary", width: 4.5, double: true, label: t("fleet.monitoring.topology.legend.chain") },
  { key: "chainBroken", color: "--warning", width: 4.5, double: true, label: t("fleet.monitoring.topology.legend.chainBroken") },
]);
const LEGEND_CHECKS = computed<LegendItem[]>(() => [{ key: "check", color: "--success", width: 1.5, label: t("fleet.monitoring.topology.legend.check") }]);
const legend = computed(() => [...(showsProbes.value ? LEGEND_PROBES.value : []), ...(showsChains.value ? LEGEND_CHAINS.value : []), ...(showsChecks.value ? LEGEND_CHECKS.value : [])]);
const folds = computed(() => model.value.members.length > COLLAPSE_AT);

/* ---- Opening things ---- */

const peek = bindRouteOpen(props.owned, "peek");
const nodeSheetError = computed(() => (props.nodesError ? proofReason(props.nodesError) : null));

function openPair(source: string, target: string): void {
  props.owned.push({ ...props.owned.query(), view: "latency", pair: pairKey(source, target), peek: undefined, topo: undefined, as: undefined });
}

function openMonitor(id: string, el: HTMLElement | null): void {
  emit("openMonitor", id, el);
}

function openTerminal(node: Node): void {
  if (!auth.can("terminal:open") || !isReporting(node)) return;
  window.open(`/terminal?node_id=${encodeURIComponent(node.id)}&connect=1`, "_blank", "noopener");
}

const SEGMENT = "rounded px-2.5 py-1 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11 pointer-coarse:min-w-11";
</script>

<template>
  <div class="space-y-4">
    <EmptyState
      v-if="!canRead"
      :icon="Network"
      :title="$t('fleet.monitoring.noAccessTitle')"
      :description="$t('fleet.monitoring.noAccessDescription')"
    />
    <template v-else>
      <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
        <ProofLine v-bind="proof" :segments="proofSegments" class="me-auto" @retry="refreshAll" />
        <Button variant="outline" size="sm" type="button" :disabled="planQuery.refreshing.value || rollupsQuery.refreshing.value" @click="refreshAll">
          <RefreshCw :class="cn('size-4', (planQuery.refreshing.value || rollupsQuery.refreshing.value) && 'animate-spin')" aria-hidden="true" />
          {{ $t('common.actions.refresh') }}
        </Button>
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <div class="flex rounded-md border border-border p-0.5 text-xs" role="group" :aria-label="$t('fleet.monitoring.topology.layerLabel')" data-testid="topology-layers">
          <button
            v-for="tab in layerTabs"
            :key="tab.value"
            type="button"
            :class="cn(SEGMENT, layerParam === tab.value ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:text-foreground')"
            :aria-pressed="layerParam === tab.value"
            @click="layerParam = tab.value"
          >
            {{ tab.label }}
          </button>
        </div>
        <div class="flex rounded-md border border-border p-0.5 text-xs" role="group" :aria-label="$t('fleet.monitoring.latency.windowLabel')" data-testid="topology-window">
          <button
            v-for="w in LATENCY_WINDOWS"
            :key="w"
            type="button"
            :class="cn(SEGMENT, 'font-mono', windowParam === w ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:text-foreground')"
            :aria-pressed="windowParam === w"
            @click="windowParam = w"
          >
            {{ $t(`fleet.monitoring.latency.window.${w}`) }}
          </button>
        </div>
        <div v-if="wide" class="flex rounded-md border border-border p-0.5 text-xs md:ms-auto" role="group" :aria-label="$t('fleet.monitoring.topology.viewLabel')">
          <button
            v-for="v in (['graph', 'list'] as const)"
            :key="v"
            type="button"
            :class="cn(SEGMENT, asParam === v ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:text-foreground')"
            :aria-pressed="asParam === v"
            @click="asParam = v"
          >
            {{ $t(`fleet.monitoring.topology.view.${v}`) }}
          </button>
        </div>
      </div>

      <DataState
        :loading="planQuery.loading.value || chainsLoading"
        :error="planQuery.error.value ?? null"
        :has-data="!!planQuery.data.value"
        :skeleton-rows="8"
        @retry="refreshAll"
      >
        <template v-if="planQuery.data.value">
          <EmptyState v-if="layerEmpty" :icon="Network" :title="layerEmpty.title" :description="layerEmpty.description">
            <Button v-if="layerEmpty.action" size="sm" variant="outline" type="button" @click="layerEmpty.action.run">{{ layerEmpty.action.label }}</Button>
          </EmptyState>
          <div v-else class="space-y-3">
            <!-- The key, in one row above the drawing; every state is also written on the rows and the card. -->
            <div
              v-if="presentation === 'graph' && legend.length"
              class="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground"
              data-testid="topology-legend"
              role="group"
              :aria-label="$t('fleet.monitoring.topology.legend.label')"
            >
              <span v-for="item in legend" :key="item.key" class="inline-flex items-center gap-1.5">
                <svg width="22" height="8" aria-hidden="true">
                  <line x1="1" y1="4" x2="21" y2="4" :stroke-linecap="item.double ? 'butt' : 'round'" :stroke-width="item.width" :stroke-dasharray="item.dash" :style="{ stroke: `var(${item.color})` }" />
                  <line v-if="item.double" x1="0" y1="4" x2="22" y2="4" stroke-width="1.5" style="stroke: var(--background)" />
                </svg>
                {{ item.label }}
              </span>
            </div>
            <p v-if="!canReadNodes" class="text-xs text-muted-foreground">{{ $t('fleet.monitoring.topology.nodesUnread') }}</p>
            <p v-if="chainsNote" class="text-xs text-muted-foreground" data-testid="topology-chains-note">{{ chainsNote }}</p>
            <p v-if="model.counts.chainsUnplaced && (layerParam === 'all' || layerParam === 'chains')" class="text-xs text-muted-foreground">
              {{ $t('fleet.monitoring.topology.legend.unplaced', { n: model.counts.chainsUnplaced }, model.counts.chainsUnplaced) }}
            </p>
            <p v-if="folds && presentation === 'graph'" class="text-xs text-muted-foreground">{{ $t('fleet.monitoring.topology.legend.folded', { n: COLLAPSE_AT }) }}</p>

            <TopologyGraph
              v-if="presentation === 'graph'"
              :model="model"
              :now="now.getTime()"
              :window-label="windowLabel"
              @open-node="(id, el) => peek.open(id, el)"
              @open-pair="openPair"
              @open-monitor="openMonitor"
            />
            <TopologyList
              v-else
              :model="model"
              :now="now.getTime()"
              @open-node="(id, el) => peek.open(id, el)"
              @open-pair="openPair"
              @open-monitor="openMonitor"
            />
          </div>
        </template>
      </DataState>
    </template>

    <NodeSheet
      :node-id="peek.openId.value"
      :nodes="canReadNodes ? nodes : undefined"
      :error="nodeSheetError"
      :return-focus="peek.returnFocus"
      @close="peek.close"
      @terminal="openTerminal"
      @retry="emit('refreshPage')"
    />
  </div>
</template>
