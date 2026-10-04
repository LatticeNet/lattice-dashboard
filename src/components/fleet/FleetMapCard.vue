<script setup lang="ts">
/**
 * What the map says about the mark under the pointer or the keyboard focus
 * (FleetMap): one node, a pile, or the probe arc into a place. A preview
 * only, so it never takes the pointer; the click opens the node's sheet,
 * which holds everything that can be done with it.
 *
 *   ● [cd]-DMIT-pro-malibu
 *     Degraded for 35m
 *   Place      Los Angeles, US · approximate
 *   Network    DMIT
 *   Agent      0.3.9
 *   Incidents  1 open
 *   cd-hs-sh   168 ms p50 · 2% loss, last hour
 *   Click to open
 *
 * A location from a GeoIP lookup is a city's point at best, so it is
 * labelled approximate; one an operator set is labelled as theirs.
 */
import { computed } from "vue";
import { useI18n } from "vue-i18n";

import { formatAge } from "@/lib/format";
import { describeNodeStatus, nodeStatus, nodeStatusSince } from "@/lib/nodeStatus";
import { cn } from "@/lib/utils";
import { BAND_STYLE, formatLoss, formatMs } from "@/views/fleet/latencyModel";
import type { FleetMapFacts, FleetMapNode, LatencyFact } from "./fleetMapTypes";

import StatusDot from "@/components/common/StatusDot.vue";

const props = defineProps<{
  /** node: one machine; pile: a cluster's members; arc: the members a probe arc ends at. */
  mode: "node" | "pile" | "arc";
  /** Worst first. */
  nodes: readonly FleetMapNode[];
  place: string;
  facts?: FleetMapFacts;
  /** What a click does, said at the foot. */
  hint: string;
}>();

const { t, locale } = useI18n();

const MAX_LISTED = 6;
const STATUS_TEXT: Record<string, string> = {
  success: "text-muted-foreground",
  warning: "text-warning-text",
  destructive: "text-destructive",
  muted: "text-muted-foreground",
};

const first = computed(() => props.nodes[0]);
const listed = computed(() => props.nodes.slice(0, MAX_LISTED));
const more = computed(() => Math.max(0, props.nodes.length - MAX_LISTED));
const down = computed(() => props.nodes.filter((node) => ["offline", "never_reported"].includes(nodeStatus(node))).length);

/** Every member's location came from a lookup, or some came from an operator. */
const operatorSet = computed(() => props.nodes.length > 0 && props.nodes.every((node) => node.geo?.source === "operator"));

function statusLine(node: FleetMapNode): string {
  const info = describeNodeStatus(node);
  const since = nodeStatusSince(node);
  const label = t(info.labelKey);
  if (!since) return label;
  return t("fleet.map.card.statusFor", { status: label, age: formatAge(Date.now() - Date.parse(since), locale.value) });
}

function statusTone(node: FleetMapNode): string {
  return STATUS_TEXT[describeNodeStatus(node).tone] ?? "text-muted-foreground";
}

const network = computed(() => {
  const geo = first.value?.geo;
  if (!geo) return "";
  const org = geo.as_org || geo.provider || "";
  return [geo.asn ? `AS${geo.asn}` : "", org].filter(Boolean).join(" ");
});

const incidents = computed<{ text: string; tone: string } | undefined>(() => {
  const facts = props.facts;
  const node = first.value;
  if (!facts || !node || facts.incidentsState === "denied") return undefined;
  if (facts.incidentsState === "loading") return { text: t("fleet.map.card.reading"), tone: "text-muted-foreground" };
  if (facts.incidentsState === "failed") return { text: t("fleet.map.card.incidentsFailed"), tone: "text-muted-foreground" };
  const open = facts.incidents?.get(node.id) ?? 0;
  return open > 0
    ? { text: t("fleet.map.card.incidentsOpen", { n: open }, open), tone: "text-destructive" }
    : { text: t("fleet.map.card.incidentsNone"), tone: "text-muted-foreground" };
});

const sourceName = computed(() => props.facts?.latency?.sourceName ?? "");

/** One target's latency in words, or undefined where the console has nothing to say. */
function latencyText(fact: LatencyFact | undefined): { text: string; tone: string; swatch?: string } | undefined {
  const facts = props.facts;
  if (!facts || facts.latencyState === "denied" || facts.latencyState === "nosource") return undefined;
  if (facts.latencyState === "loading") return { text: t("fleet.map.card.reading"), tone: "text-muted-foreground" };
  if (facts.latencyState === "failed") return { text: t("fleet.map.card.latencyFailed"), tone: "text-muted-foreground" };
  if (!fact) return { text: t("fleet.map.card.latencyNotProbed"), tone: "text-muted-foreground" };
  switch (fact.kind) {
    case "measured": {
      const parts = [t("fleet.map.card.p50", { ms: formatMs(fact.p50Ms) })];
      if (fact.loss !== undefined) parts.push(t("fleet.map.card.loss", { loss: formatLoss(fact.loss) }));
      return { text: parts.join(" · "), tone: "text-popover-foreground", swatch: fact.band ? BAND_STYLE[fact.band].swatch : undefined };
    }
    case "failing":
      return { text: t("fleet.map.card.latencyFailing"), tone: "text-destructive" };
    case "unknown":
      return { text: t("fleet.map.card.latencyUnknown"), tone: "text-muted-foreground" };
    case "paused":
      return { text: t("fleet.map.card.latencyPaused"), tone: "text-muted-foreground" };
    case "notProbeable":
      return { text: t("fleet.map.card.latencyNotProbeable"), tone: "text-muted-foreground" };
    default:
      return undefined;
  }
}

const latency = computed(() => (first.value ? latencyText(props.facts?.latency?.readings.get(first.value.id)) : undefined));

/** The listed members, each with its latency on an arc's card. */
const rows = computed(() =>
  listed.value.map((node) => ({ node, latency: props.mode === "arc" ? latencyText(props.facts?.latency?.readings.get(node.id)) : undefined })),
);
</script>

<template>
  <div
    class="pointer-events-none w-64 rounded-md border border-border bg-popover text-xs text-popover-foreground shadow-lg"
    role="tooltip"
    data-testid="fleet-map-card"
  >
    <!-- One node. -->
    <template v-if="mode === 'node' && first">
      <div class="flex items-start gap-2 border-b border-border px-3 py-2">
        <StatusDot class="mt-1.5" :status="describeNodeStatus(first).health" :pulse="false" />
        <div class="min-w-0">
          <p class="truncate font-mono text-[13px] font-medium" :title="first.name || first.id">{{ first.name || first.id }}</p>
          <p :class="cn('mt-0.5', statusTone(first))">{{ statusLine(first) }}</p>
        </div>
      </div>
      <dl class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 px-3 py-2">
        <dt class="text-muted-foreground">{{ $t('fleet.map.card.place') }}</dt>
        <dd class="min-w-0">
          <span class="block truncate">{{ place || $t('fleet.map.cluster.somewhere') }}</span>
          <span class="block truncate text-muted-foreground">{{ operatorSet ? $t('fleet.map.card.operatorSet') : $t('fleet.map.card.approximate') }}</span>
        </dd>
        <template v-if="network">
          <dt class="text-muted-foreground">{{ $t('fleet.map.card.network') }}</dt>
          <dd class="min-w-0 truncate">{{ network }}</dd>
        </template>
        <dt class="text-muted-foreground">{{ $t('fleet.map.card.agent') }}</dt>
        <dd class="min-w-0 truncate font-mono">{{ first.agent_version || $t('fleet.map.card.noAgent') }}</dd>
        <template v-if="incidents">
          <dt class="text-muted-foreground">{{ $t('fleet.map.card.incidents') }}</dt>
          <dd :class="cn('min-w-0 truncate', incidents.tone)">{{ incidents.text }}</dd>
        </template>
        <template v-if="latency">
          <dt class="max-w-24 truncate font-mono text-muted-foreground" :title="sourceName">{{ sourceName || $t('fleet.map.card.latency') }}</dt>
          <dd :class="cn('flex min-w-0 items-center gap-1.5', latency.tone)">
            <span v-if="latency.swatch" :class="cn('size-2 shrink-0 rounded-full', latency.swatch)" aria-hidden="true" />
            <span>{{ latency.text }}</span>
          </dd>
        </template>
      </dl>
    </template>

    <!-- A pile, or the members an arc ends at. -->
    <template v-else>
      <div class="border-b border-border px-3 py-2">
        <p class="truncate text-[13px] font-medium">
          <template v-if="mode === 'arc'"><span class="font-mono">{{ sourceName }}</span> → </template>{{
            mode === 'arc' ? place || $t('fleet.map.cluster.somewhere') : $t('fleet.map.cluster.many', { n: nodes.length, place: place || $t('fleet.map.cluster.somewhere') })
          }}
        </p>
        <p class="mt-0.5 text-muted-foreground">
          {{ operatorSet ? $t('fleet.map.card.operatorSet') : $t('fleet.map.card.approximate') }}<template v-if="down"> · <span class="text-destructive">{{ $t('fleet.map.cluster.down', { n: down }) }}</span></template>
        </p>
      </div>
      <ul class="space-y-1 px-3 py-2">
        <li v-for="row in rows" :key="row.node.id" class="flex min-w-0 items-center gap-2">
          <StatusDot :status="describeNodeStatus(row.node).health" :pulse="false" />
          <span class="min-w-0 flex-1 truncate font-mono">{{ row.node.name || row.node.id }}</span>
          <span v-if="row.latency" :class="cn('flex shrink-0 items-center gap-1', row.latency.tone)">
            <span v-if="row.latency.swatch" :class="cn('size-1.5 rounded-full', row.latency.swatch)" aria-hidden="true" />
            {{ row.latency.text }}
          </span>
          <span v-else-if="mode !== 'arc' && nodeStatus(row.node) !== 'online'" :class="cn('shrink-0', statusTone(row.node))">{{ $t(describeNodeStatus(row.node).labelKey) }}</span>
        </li>
        <li v-if="more" class="text-muted-foreground">{{ $t('fleet.map.card.more', { n: more }) }}</li>
      </ul>
    </template>

    <p class="border-t border-border px-3 py-1.5 text-muted-foreground">{{ hint }}</p>
  </div>
</template>
