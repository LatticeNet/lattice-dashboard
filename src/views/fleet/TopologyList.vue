<script setup lang="ts">
/**
 * The Topology layer as a list of paths: the phone's presentation (a graph
 * of 34 rows does not fit 375 px) and the keyboard's and screen reader's
 * way to every edge on a desktop. Heartbeats that need a look first, then
 * probes, chains and checks, each worst first. Every line opens what the
 * graph would open.
 */
import { computed, ref } from "vue";
import { useI18n } from "vue-i18n";

import { cn } from "@/lib/utils";

import { CONTROL_PLANE, edgeStyle, pathsWorstFirst, type TopoEdge, type TopoEdgeKind, type TopologyModel } from "./topologyModel";
import { edgeValue, freshnessDot, freshnessText, lastSampleText, quietText, stateLabel } from "./topologyCopy";

const props = defineProps<{
  model: TopologyModel;
  now: number;
}>();

const emit = defineEmits<{
  openNode: [id: string, el: HTMLElement | null];
  openPair: [source: string, target: string];
  openMonitor: [id: string, el: HTMLElement | null];
}>();

const { t, locale } = useI18n();

const CAP = 40;
const showAll = ref<Record<string, boolean>>({});

const nameOf = (id: string) => {
  if (id === CONTROL_PLANE) return t("fleet.monitoring.topology.cp.title");
  return props.model.nodes.get(id)?.name ?? props.model.checks.find((c) => c.id === id)?.name ?? id;
};

const attentionNodes = computed(() =>
  [...props.model.nodes.values()]
    .filter((n) => n.freshness && n.freshness !== "fresh")
    .sort((a, b) => (a.freshness === "quiet" ? 0 : 1) - (b.freshness === "quiet" ? 0 : 1) || a.name.localeCompare(b.name)),
);

const sections = computed(() => {
  const all = pathsWorstFirst(props.model);
  const by = (kind: TopoEdgeKind) => all.filter((e) => e.kind === kind);
  return (
    [
      { kind: "probe" as const, title: t("fleet.monitoring.topology.list.probes"), edges: by("probe") },
      { kind: "chain" as const, title: t("fleet.monitoring.topology.list.chains"), edges: by("chain") },
      { kind: "check" as const, title: t("fleet.monitoring.topology.list.checks"), edges: by("check") },
    ]
  ).filter((s) => s.edges.length > 0);
});

function detail(edge: TopoEdge): string {
  const parts: string[] = [];
  if (edge.kind === "probe") {
    parts.push(t("fleet.monitoring.topology.list.from", { source: nameOf(edge.from) }));
    const country = props.model.nodes.get(edge.to)?.country;
    if (country) parts.push(country);
    if (edge.state === "quiet") parts.push(quietText(t, locale.value, edge, props.now));
    else if (edge.state === "paused" && edge.pausedReason) parts.push(t(`fleet.monitoring.latency.paused.${edge.pausedReason}`));
    else if (edge.last) parts.push(lastSampleText(t, locale.value, edge.last, props.now));
  } else if (edge.kind === "chain") {
    parts.push(t("fleet.monitoring.topology.list.to", { exit: nameOf(edge.to) }));
    if (edge.chain?.error) parts.push(edge.chain.error);
  } else {
    const source = edge.from === CONTROL_PLANE ? t("fleet.monitoring.topology.check.control") : nameOf(edge.from);
    parts.push(t("fleet.monitoring.topology.list.from", { source }));
    parts.push(lastSampleText(t, locale.value, edge.last, props.now));
  }
  return parts.join(" · ");
}

/** A chain reads from its relay ("to <exit>" below it); a probe or a check by where it goes. */
function title(edge: TopoEdge): string {
  return edge.kind === "chain" ? nameOf(edge.from) : nameOf(edge.to);
}

function open(edge: TopoEdge, el: HTMLElement): void {
  if (edge.kind === "probe") emit("openPair", edge.from, edge.to);
  else if (edge.kind === "chain") emit("openNode", edge.from, el);
  else if (edge.monitorId) emit("openMonitor", edge.monitorId, el);
}
</script>

<template>
  <div class="space-y-5" data-testid="topology-list">
    <section v-if="model.cp.known" :aria-label="$t('fleet.monitoring.topology.list.heartbeats')" class="space-y-1.5">
      <h3 class="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {{ $t('fleet.monitoring.topology.list.heartbeats') }}
        <span class="ms-1 font-mono normal-case tracking-normal tabular">{{ $t('fleet.monitoring.topology.cp.beating', { fresh: model.cp.fresh, total: model.cp.total }) }}</span>
      </h3>
      <p v-if="attentionNodes.length === 0" class="text-sm text-muted-foreground">{{ $t('fleet.monitoring.topology.list.allBeating') }}</p>
      <ul v-else class="divide-y divide-border rounded-lg border border-border bg-card">
        <li v-for="node in attentionNodes" :key="node.id">
          <button
            type="button"
            class="flex w-full items-center gap-2.5 px-3 py-2 text-start outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring pointer-coarse:min-h-11"
            @click="(e) => emit('openNode', node.id, e.currentTarget as HTMLElement)"
          >
            <span :class="cn('size-2 shrink-0 rounded-full', freshnessDot(node))" aria-hidden="true" />
            <span class="min-w-0 flex-1 truncate text-sm">{{ node.name }}</span>
            <span :class="cn('shrink-0 text-xs', node.freshness === 'quiet' ? 'text-destructive' : 'text-muted-foreground')">{{ freshnessText(t, locale, node, now) }}</span>
          </button>
        </li>
      </ul>
    </section>

    <section v-for="section in sections" :key="section.kind" :aria-label="section.title" class="space-y-1.5">
      <h3 class="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {{ section.title }} <span class="ms-1 font-mono tabular">{{ section.edges.length }}</span>
      </h3>
      <ul class="divide-y divide-border rounded-lg border border-border bg-card">
        <li v-for="edge in showAll[section.kind] ? section.edges : section.edges.slice(0, CAP)" :key="edge.id" :data-edge="edge.id" :data-state="edge.state">
          <button
            type="button"
            class="relative flex w-full items-center gap-3 py-2 ps-4 pe-3 text-start outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring pointer-coarse:min-h-11"
            :aria-label="$t('fleet.monitoring.topology.list.label', { from: nameOf(edge.from), to: nameOf(edge.to), state: `${stateLabel(t, edge)}, ${edgeValue(t, edge).text}` })"
            @click="(e) => open(edge, e.currentTarget as HTMLElement)"
          >
            <!-- The edge's own stroke, so the list and the graph read alike. -->
            <svg class="absolute inset-y-2 start-1.5 w-1" viewBox="0 0 4 40" preserveAspectRatio="none" aria-hidden="true">
              <line
                x1="2" y1="2" x2="2" y2="38"
                stroke-linecap="round"
                :stroke-width="edgeStyle(edge).width + 1"
                :stroke-dasharray="edgeStyle(edge).stroke === 'dashed' ? '5 4' : edgeStyle(edge).stroke === 'dotted' ? '1.5 3.5' : undefined"
                :style="{ stroke: `var(${edgeStyle(edge).color})` }"
              />
            </svg>
            <span class="min-w-0 flex-1">
              <span class="block truncate text-sm font-medium">{{ title(edge) }}</span>
              <span class="block truncate text-xs text-muted-foreground">{{ detail(edge) }}</span>
            </span>
            <span class="shrink-0 text-end font-mono text-xs tabular">
              <span :class="cn('block', edgeValue(t, edge).tone)">{{ edgeValue(t, edge).text }}</span>
              <span v-if="edgeValue(t, edge).loss" class="block text-[11px] text-destructive">{{ $t('fleet.monitoring.latency.cell.loss', { loss: edgeValue(t, edge).loss }) }}</span>
            </span>
          </button>
        </li>
      </ul>
      <button
        v-if="!showAll[section.kind] && section.edges.length > CAP"
        type="button"
        class="text-xs font-medium text-foreground underline decoration-dotted underline-offset-2 pointer-coarse:min-h-11"
        @click="showAll = { ...showAll, [section.kind]: true }"
      >
        {{ $t('fleet.monitoring.topology.list.showAll', { n: section.edges.length }) }}
      </button>
    </section>
  </div>
</template>
