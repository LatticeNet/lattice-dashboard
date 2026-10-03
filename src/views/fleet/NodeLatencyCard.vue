<script setup lang="ts">
/**
 * The latency section on a node's page: how the probe sources reach this
 * node when it is a target, and how this node reaches its targets when it is
 * a source, over the last hour and the last day. Each pair opens in
 * Monitoring's Latency layer. A node that is neither says why, in the plan's
 * own words, so "no latency here" is never a silent blank.
 *
 * Reads the same plan and rollups as the layer; the node page polls them
 * only while it is open.
 */
import { computed, defineComponent, h, type PropType } from "vue";
import { RouterLink } from "vue-router";
import { useI18n } from "vue-i18n";
import { Gauge } from "lucide-vue-next";

import { api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useAsyncData } from "@/composables/useAsyncData";
import { useAuthStore } from "@/stores/auth";

import DataState from "@/components/common/DataState.vue";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

import {
  BAND_STYLE,
  buildLatencyMatrix,
  formatLoss,
  formatMs,
  pairKey,
  type LatencyCell,
} from "./latencyModel";

const props = defineProps<{ nodeId: string }>();

const { t } = useI18n();
const auth = useAuthStore();
const canRead = computed(() => auth.can("monitor:read"));

const planQuery = useAsyncData((signal) => (canRead.value ? api.monitors.latency.plan({ signal }) : Promise.resolve(undefined)), {
  pollInterval: 60000,
  immediate: canRead.value,
});
const rollupsQuery = useAsyncData((signal) => (canRead.value ? api.monitors.latency.rollups({ signal }) : Promise.resolve(undefined)), {
  pollInterval: 60000,
  immediate: canRead.value,
});

const plan = computed(() => planQuery.data.value);
const self = computed(() => plan.value?.nodes.find((n) => n.node_id === props.nodeId));
const hour = computed(() => (plan.value ? buildLatencyMatrix(plan.value, rollupsQuery.data.value, "1h", "p50") : undefined));
const day = computed(() => (plan.value ? buildLatencyMatrix(plan.value, rollupsQuery.data.value, "24h", "p50") : undefined));

interface PairLine {
  key: string;
  otherId: string;
  otherName: string;
  hour?: LatencyCell;
  day?: LatencyCell;
}

/** As a target: one line per source. */
const asTarget = computed<PairLine[]>(() => {
  const h = hour.value;
  const d = day.value;
  if (!h || !d) return [];
  const row = h.rows.find((r) => r.node.node_id === props.nodeId);
  const dayRow = d.rows.find((r) => r.node.node_id === props.nodeId);
  if (!row) return [];
  return h.sources
    .map((source, index) => ({ key: pairKey(source.nodeId, props.nodeId), otherId: source.nodeId, otherName: source.name, hour: row.cells[index], day: dayRow?.cells[index] }))
    .filter((line) => line.hour?.kind !== "self");
});

/** As a source: one line per target, the slowest and lossiest first. */
const asSource = computed<PairLine[]>(() => {
  const h = hour.value;
  const d = day.value;
  if (!h || !d) return [];
  const col = h.sources.findIndex((s) => s.nodeId === props.nodeId);
  if (col < 0) return [];
  const lines = h.rows
    .map((row, index) => ({ key: pairKey(props.nodeId, row.node.node_id), otherId: row.node.node_id, otherName: row.node.name, hour: row.cells[col], day: d.rows[index]?.cells[col] }))
    .filter((line) => line.hour && line.hour.kind !== "self");
  const weight = (cell?: LatencyCell) => (cell?.kind === "failing" ? 1e9 : cell?.kind === "measured" ? (cell.loss ?? 0) * 1e6 + (cell.valueMs ?? 0) : -1);
  return lines.sort((a, b) => weight(b.hour) - weight(a.hour)).slice(0, 8);
});

const notInvolved = computed(() => !!self.value && !self.value.source && asTarget.value.length === 0);

function cellText(cell?: LatencyCell): string {
  if (!cell) return t("fleet.monitoring.latency.cell.unknown");
  switch (cell.kind) {
    case "measured":
      return (cell.loss ?? 0) > 0 ? `${formatMs(cell.valueMs)} · ${formatLoss(cell.loss)}` : formatMs(cell.valueMs);
    case "failing":
      return t("fleet.monitoring.latency.cell.failing");
    case "unknown":
      return t("fleet.monitoring.latency.cell.unknown");
    case "paused":
      return t("fleet.monitoring.latency.cell.paused");
    case "notProbeable":
      return t("fleet.monitoring.latency.cell.notProbeable");
    default:
      return "";
  }
}

function cellTone(cell?: LatencyCell): string {
  if (cell?.kind === "measured") return cn("font-mono tabular", BAND_STYLE[cell.band ?? "destructive"].text);
  if (cell?.kind === "failing") return "text-destructive";
  return "text-muted-foreground";
}

/*
 * One line per pair. From 420 px up: name, 1 h and 24 h in three columns
 * under a header; below it the name takes its own line and each value
 * carries its own window label, so a long node name is never cut to "[Metix]-".
 */
const PairList = defineComponent({
  name: "NodeLatencyPairList",
  props: { lines: { type: Array as PropType<PairLine[]>, required: true }, head: { type: String, required: true } },
  setup(listProps) {
    const label1h = () => t("fleet.monitoring.latency.window.1h");
    const label24h = () => t("fleet.monitoring.latency.window.24h");
    const row = "grid grid-cols-[minmax(0,1fr)_6.5rem_6.5rem] items-center gap-x-3 max-[420px]:grid-cols-2";
    return () =>
      h("div", { class: "text-xs" }, [
        h("div", { class: cn(row, "py-1 text-muted-foreground max-[420px]:hidden"), "aria-hidden": "true" }, [
          h("span", listProps.head),
          h("span", { class: "text-end" }, label1h()),
          h("span", { class: "text-end" }, label24h()),
        ]),
        h(
          "ul",
          { class: "divide-y divide-border border-t border-border" },
          listProps.lines.map((line) =>
            h("li", { key: line.key, class: cn(row, "py-1.5") }, [
              h(
                RouterLink,
                { to: { name: "monitoring", query: { view: "latency", pair: line.key } }, class: "flex min-w-0 items-center hover:underline max-[420px]:col-span-2 pointer-coarse:min-h-11", title: line.otherName },
                () => h("span", { class: "truncate" }, line.otherName),
              ),
              h("span", { class: cn("text-end max-[420px]:text-start", cellTone(line.hour)) }, [
                h("span", { class: "me-1 font-sans text-muted-foreground min-[421px]:sr-only" }, label1h()),
                cellText(line.hour),
              ]),
              h("span", { class: cn("text-end", cellTone(line.day)) }, [
                h("span", { class: "me-1 font-sans text-muted-foreground min-[421px]:sr-only" }, label24h()),
                cellText(line.day),
              ]),
            ]),
          ),
        ),
      ]);
  },
});

const reasonText = computed(() => {
  const node = self.value;
  if (!node) return "";
  if (node.target === "not_probeable") return t(`fleet.monitoring.latency.endpointNote.${node.endpoint_note || "no_tcp_line"}`);
  return t(`fleet.monitoring.latency.reason.${node.target_reason || "auto_off"}`);
});
</script>

<template>
  <Card v-if="canRead" data-testid="node-latency">
    <CardHeader>
      <CardTitle class="flex items-center gap-2">
        <Gauge class="size-4 text-muted-foreground" aria-hidden="true" />
        {{ $t('fleet.monitoring.latency.node.title') }}
      </CardTitle>
      <CardDescription>{{ $t('fleet.monitoring.latency.node.description') }}</CardDescription>
    </CardHeader>
    <CardContent class="space-y-4 text-sm">
      <DataState
        :loading="planQuery.loading.value"
        :error="planQuery.error.value ?? null"
        :has-data="!!plan"
        :skeleton-rows="2"
        @retry="planQuery.refresh"
      >
        <p v-if="notInvolved" class="text-muted-foreground">{{ $t('fleet.monitoring.latency.node.notInvolved', { reason: reasonText }) }}</p>
        <template v-else>
          <section v-if="self && self.target !== 'none'" class="space-y-1.5">
            <h3 class="text-xs font-medium text-muted-foreground">
              {{ $t('fleet.monitoring.latency.node.asTarget') }}
              <span v-if="self.endpoint" class="font-mono font-normal"> · {{ self.endpoint }}</span>
            </h3>
            <p v-if="self.target === 'not_probeable'" class="text-xs text-muted-foreground">{{ reasonText }}</p>
            <PairList v-else :lines="asTarget" :head="$t('fleet.monitoring.latency.fromLabel')" />
          </section>
          <section v-if="asSource.length" class="space-y-1.5">
            <h3 class="text-xs font-medium text-muted-foreground">{{ $t('fleet.monitoring.latency.node.asSource') }}</h3>
            <PairList :lines="asSource" :head="$t('fleet.monitoring.latency.targetColumn')" />
          </section>
        </template>
        <RouterLink
          :to="{ name: 'monitoring', query: { view: 'latency' } }"
          class="inline-block text-xs text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:items-center"
        >{{ $t('fleet.monitoring.latency.node.open') }}</RouterLink>
      </DataState>
    </CardContent>
  </Card>
</template>
