<script setup lang="ts">
/**
 * Monitoring's Overview (design 29 D7): what needs a look and how far each
 * source reaches, for the page's window.
 *
 * The attention list is worst first: each target that is down from a source
 * (its sources inside one line), then unknown paths grouped by reason, pauses
 * last and never as a warning. The reach strip is one line per source: how
 * many of its paths are up, down and unknown, each count a link into Paths
 * filtered to it. No degraded state: the server does not compute one yet.
 */
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { Route as RouteIcon, Settings2 } from "lucide-vue-next";

import type { MonitorWindow, PathState } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { OwnedRoute } from "@/composables/useOwnedRoute";

import AttentionList, { type AttentionItem } from "@/components/common/AttentionList.vue";
import DataState from "@/components/common/DataState.vue";
import EmptyState from "@/components/common/EmptyState.vue";
import { Button } from "@/components/ui/button";

import { formatLoss } from "./latencyModel";
import { attentionQuery, pathAttention, reachBySource, reachQuery, type PathAttention, type SourceReach } from "./pathsModel";
import { usePathsCopy } from "./pathsCopy";
import type { PathsData } from "./usePathsData";

const props = defineProps<{
  owned: OwnedRoute;
  data: PathsData;
  window: MonitorWindow;
  canAdmin: boolean;
  /** Operator checks failing on a server whose matrix holds latency paths only. */
  checkAttention: AttentionItem[];
}>();

const emit = defineEmits<{ pathSet: []; createCheck: [] }>();

const { t } = useI18n();
const { reasonText, windowLong } = usePathsCopy();

const matrix = computed(() => props.data.matrix.value);
const query = props.data.pathsQuery;
const isEmpty = computed(() => !!matrix.value && matrix.value.paths.length === 0 && props.checkAttention.length === 0);

function showInPaths(q: string, path?: string): void {
  props.owned.push({ ...props.owned.query(), view: "paths", "paths.q": q, path, open: undefined });
}

const NAMES_SHOWN = 4;

function names(list: string[]): string {
  const unique = [...new Set(list)];
  const shown = unique.slice(0, NAMES_SHOWN).join(", ");
  return unique.length > NAMES_SHOWN ? t("fleet.monitoring.overview.attention.andMore", { names: shown, n: unique.length - NAMES_SHOWN }) : shown;
}

function itemFor(item: PathAttention): AttentionItem {
  if (item.kind === "down") {
    const sources = item.paths.map((p) => p.sourceName);
    const totalSources = matrix.value?.sources.length ?? sources.length;
    const lead = item.paths[0]!;
    const claim =
      sources.length === 1
        ? t("fleet.monitoring.overview.attention.down", { target: item.targetName, source: sources[0] })
        : t("fleet.monitoring.overview.attention.downMany", { target: item.targetName, n: sources.length, total: totalSources });
    const proof = [reasonText(lead.reason), lead.samples > 0 && lead.loss !== undefined ? t("fleet.monitoring.overview.attention.loss", { loss: formatLoss(lead.loss), window: windowLong(props.window) }) : ""]
      .filter(Boolean)
      .join(" · ");
    return {
      key: `down:${item.rowKey}`,
      tone: "danger",
      claim,
      proof,
      action: { label: t("fleet.monitoring.overview.attention.show"), run: () => showInPaths(attentionQuery(item), item.paths.length === 1 ? lead.key : undefined) },
    };
  }
  return {
    key: `unknown:${item.reason}`,
    tone: item.chosen ? "info" : "warning",
    claim: t("fleet.monitoring.overview.attention.unknown", { n: item.paths.length, reason: reasonText(item.reason) }, item.paths.length),
    proof: names(item.paths.map((p) => (matrix.value && matrix.value.sources.length > 1 ? `${p.targetName} (${p.sourceName})` : p.targetName))),
    action: { label: t("fleet.monitoring.overview.attention.show"), run: () => showInPaths(attentionQuery(item)) },
  };
}

const attention = computed<AttentionItem[]>(() => [...(matrix.value ? pathAttention(matrix.value).map(itemFor) : []), ...props.checkAttention]);
const reach = computed(() => (matrix.value ? reachBySource(matrix.value).filter((r) => r.total > 0) : []));

const HATCH = "bg-[repeating-linear-gradient(135deg,var(--border)_0_1.5px,transparent_1.5px_7px)]";
const SEGMENTS: { state: PathState; bar: string }[] = [
  { state: "up", bar: "bg-success" },
  { state: "down", bar: "bg-destructive" },
  { state: "unknown", bar: cn(HATCH, "border border-muted-foreground/40") },
];

function share(r: SourceReach, state: PathState): string {
  return `${(r[state] / Math.max(1, r.total)) * 100}%`;
}
</script>

<template>
  <div class="space-y-4">
    <DataState :loading="query.loading.value" :error="query.error.value ?? null" :has-data="!!matrix" :skeleton-rows="4" @retry="data.refresh">
      <template v-if="matrix">
        <EmptyState
          v-if="isEmpty"
          :icon="RouteIcon"
          :title="$t('fleet.monitoring.paths.empty.title')"
          :description="canAdmin ? $t('fleet.monitoring.paths.empty.description') : $t('fleet.monitoring.paths.empty.readOnly')"
        >
          <div v-if="canAdmin" class="flex flex-wrap justify-center gap-2">
            <Button size="sm" type="button" @click="emit('pathSet')">
              <Settings2 class="size-4" aria-hidden="true" />
              {{ $t('fleet.monitoring.paths.empty.pathSet') }}
            </Button>
            <Button size="sm" variant="outline" type="button" @click="emit('createCheck')">{{ $t('fleet.monitoring.paths.empty.check') }}</Button>
          </div>
        </EmptyState>
        <template v-else>
          <AttentionList :items="attention" />
          <p v-if="attention.length === 0" class="rounded-lg border border-border bg-card px-3.5 py-3 text-sm text-muted-foreground" data-testid="overview-clear">
            {{ $t('fleet.monitoring.overview.clear', { n: matrix.counts.paths, window: windowLong(window) }, matrix.counts.paths) }}
          </p>

          <section v-if="reach.length" class="overflow-hidden rounded-lg border border-border bg-card" :aria-labelledby="'overview-reach'" data-testid="overview-reach">
            <h2 id="overview-reach" class="border-b border-border px-3.5 py-2 text-xs font-medium text-muted-foreground">{{ $t('fleet.monitoring.overview.reach.title') }}</h2>
            <ul class="divide-y divide-border">
              <li v-for="r in reach" :key="r.source" class="grid gap-x-4 gap-y-1.5 px-3.5 py-2.5 sm:grid-cols-[minmax(8rem,14rem)_minmax(0,1fr)_auto] sm:items-center" :data-source="r.source">
                <button
                  type="button"
                  class="min-w-0 truncate text-start text-sm font-medium hover:underline pointer-coarse:min-h-11"
                  :title="r.name"
                  @click="showInPaths(reachQuery(r))"
                >{{ r.name }}</button>
                <!-- The bar shows the shares; the counts beside it are the controls. -->
                <div class="flex h-2.5 gap-0.5" aria-hidden="true">
                  <template v-for="seg in SEGMENTS" :key="seg.state">
                    <span v-if="r[seg.state] > 0" :class="cn('h-full rounded-[2px]', seg.bar)" :style="{ width: share(r, seg.state) }" />
                  </template>
                </div>
                <p class="flex flex-wrap items-center gap-x-3 text-xs">
                  <span class="text-muted-foreground">{{ $t('fleet.monitoring.overview.reach.reaches', { up: r.up, total: r.total }) }}</span>
                  <button
                    v-for="state in (['down', 'unknown'] as const)"
                    v-show="r[state] > 0"
                    :key="state"
                    type="button"
                    :class="cn('font-medium underline decoration-dotted underline-offset-2 pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:items-center', state === 'down' ? 'text-destructive' : 'text-warning-text')"
                    @click="showInPaths(reachQuery(r, state))"
                  >{{ $t(`fleet.monitoring.overview.reach.${state}`, { n: r[state] }) }}</button>
                </p>
              </li>
            </ul>
          </section>
        </template>
      </template>
    </DataState>
  </div>
</template>
