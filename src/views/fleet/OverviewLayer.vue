<script setup lang="ts">
/**
 * Monitoring's Overview (design 29 D7): what needs a look and how far each
 * source reaches, for the page's window.
 *
 * The attention list is worst first (design 29 D13): each target that is
 * down (its sources inside one line), the down paths triangulation places on
 * a source's network, the same two for degraded paths, offline sources,
 * unknown paths grouped by reason, pauses last and never as a warning. Each
 * down and degraded line carries its verdict and what it rests on. The reach
 * strip is one line per source: how many of its paths are up, degraded, down
 * and unknown, each count a link into Paths filtered to it. Degraded shows
 * only from a server that judges it.
 */
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { Route as RouteIcon, Settings2 } from "lucide-vue-next";

import type { MonitorWindow } from "@/lib/api";
import { formatRelativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { OwnedRoute } from "@/composables/useOwnedRoute";

import AttentionList, { type AttentionItem } from "@/components/common/AttentionList.vue";
import DataState from "@/components/common/DataState.vue";
import EmptyState from "@/components/common/EmptyState.vue";
import { Button } from "@/components/ui/button";

import { formatLoss } from "./latencyModel";
import { attentionQuery, pathAttention, reachBySource, reachQuery, type PathAttention, type PathDisplay, type PathItem, type SourceReach } from "./pathsModel";
import { soleReporter, type Verdict } from "./triangulationModel";
import { usePathsCopy } from "./pathsCopy";
import type { PathsData } from "./usePathsData";

const props = defineProps<{
  owned: OwnedRoute;
  data: PathsData;
  window: MonitorWindow;
  canAdmin: boolean;
  /** Operator checks failing on a server whose matrix holds latency paths only. */
  checkAttention: AttentionItem[];
  /** A check's newest failure on a source: the reason a down path carries in its runs. */
  failureOf: (monitorId: string, source: string) => string | undefined;
  /** When a node last reported. */
  nodeSeen: (nodeId: string) => string | undefined;
  /** The path set exists with no source. */
  noSources: boolean;
}>();

const emit = defineEmits<{ pathSet: []; createCheck: [] }>();

const { t } = useI18n();
const { reasonText, windowLong, evidenceText, verdictLabel, verdictEvidence } = usePathsCopy();

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

const show = (q: string, path?: string) => ({ label: t("fleet.monitoring.overview.attention.show"), run: () => showInPaths(q, path) });

const items = computed(() => (matrix.value ? pathAttention(matrix.value, props.data.triangulation.value) : []));
/**
 * The source every verdict on the list leans on when none can be placed (one
 * source in the path set, as production runs today): the list says so once
 * under its heading, and the lines leave out a verdict that would repeat it.
 */
const sole = computed(() => soleReporter(items.value.map((i) => ("verdict" in i ? i.verdict : undefined))));

/**
 * The verdict line. A target verdict counts the sources that report on the
 * target; when more sources probe it (`measuredBy`), the rest report nothing
 * and the line says how many, so its count and the claim's agree.
 */
function verdictLine(v: Verdict | undefined, measuredBy?: number): AttentionItem["verdict"] {
  if (!v || (sole.value !== undefined && v.evidence.kind === "alone")) return undefined;
  let evidence = verdictEvidence(v);
  const silent = v.evidence.kind === "target" && measuredBy !== undefined ? measuredBy - v.evidence.sources.length : 0;
  if (silent > 0) evidence = `${evidence}; ${t("fleet.monitoring.paths.verdict.silent", { n: silent }, silent)}`;
  return { label: verdictLabel(v), evidence };
}

/** Why a down path is down: its reason, else the agent's newest error, and its loss over the window. */
function downProof(lead: PathItem): string {
  // The server sends a down path without a reason; the agent's error is in the newest result.
  const failure = lead.reason ? reasonText(lead.reason) : props.failureOf(lead.monitorId, lead.source);
  const loss = lead.samples > 0 && lead.loss !== undefined ? t("fleet.monitoring.overview.attention.loss", { loss: formatLoss(lead.loss), window: windowLong(props.window) }) : "";
  return [failure, loss].filter(Boolean).join(" · ");
}

function itemFor(item: PathAttention): AttentionItem {
  switch (item.kind) {
    case "down": {
      const sources = item.paths.map((p) => p.sourceName);
      const lead = item.paths[0]!;
      const claim =
        sources.length === 1 && item.measuredBy === 1
          ? t("fleet.monitoring.overview.attention.down", { target: item.targetName, source: sources[0] })
          : t("fleet.monitoring.overview.attention.downMany", { target: item.targetName, n: sources.length, total: item.measuredBy });
      return { key: `down:${item.rowKey}`, tone: "danger", claim, proof: downProof(lead), verdict: verdictLine(item.verdict, item.measuredBy), action: show(attentionQuery(item), item.paths.length === 1 ? lead.key : undefined) };
    }
    case "downSource":
      return {
        key: `downSource:${item.source}`,
        tone: "danger",
        claim: t("fleet.monitoring.overview.attention.downSource", { source: item.sourceName, n: item.paths.length }, item.paths.length),
        proof: names(item.paths.map((p) => p.targetName)),
        verdict: verdictLine(item.verdict),
        action: show(attentionQuery(item)),
      };
    case "degraded": {
      const sources = item.paths.map((p) => p.sourceName);
      const lead = item.paths[0]!;
      const claim =
        sources.length === 1 && item.measuredBy === 1
          ? t("fleet.monitoring.overview.attention.degraded", { target: item.targetName, source: sources[0] })
          : t("fleet.monitoring.overview.attention.degradedMany", { target: item.targetName, n: sources.length, total: item.measuredBy });
      // A degraded item's proof is its evidence sentence (D13), the lead path's; over several paths it names whose.
      const evidence = evidenceText(lead.degraded, lead.reason);
      const proof = item.paths.length > 1 ? t("fleet.monitoring.overview.attention.fromSource", { source: lead.sourceName, evidence }) : evidence;
      return { key: `degraded:${item.rowKey}`, tone: "warning", claim, proof, verdict: verdictLine(item.verdict, item.measuredBy), action: show(attentionQuery(item), item.paths.length === 1 ? lead.key : undefined) };
    }
    case "degradedSource":
      return {
        key: `degradedSource:${item.source}`,
        tone: "warning",
        claim: t("fleet.monitoring.overview.attention.degradedSource", { source: item.sourceName, n: item.paths.length }, item.paths.length),
        proof: names(item.paths.map((p) => p.targetName)),
        verdict: verdictLine(item.verdict),
        action: show(attentionQuery(item)),
      };
    case "offline": {
      const seen = props.nodeSeen(item.source);
      return {
        key: `offline:${item.source}`,
        tone: "warning",
        claim: t("fleet.monitoring.overview.attention.offline", { source: item.sourceName, n: item.paths.length }, item.paths.length),
        proof: [seen ? t("fleet.monitoring.overview.attention.lastSeen", { age: formatRelativeTime(seen) }) : "", names(item.paths.map((p) => p.targetName))].filter(Boolean).join(" · "),
        action: show(attentionQuery(item)),
      };
    }
    case "unknown":
      return {
        key: `unknown:${item.reason}`,
        tone: "warning",
        claim: t("fleet.monitoring.overview.attention.unknown", { n: item.paths.length, reason: reasonText(item.reason) }, item.paths.length),
        proof: names(item.paths.map((p) => (matrix.value && matrix.value.sources.length > 1 ? `${p.targetName} (${p.sourceName})` : p.targetName))),
        action: show(attentionQuery(item)),
      };
    case "paused":
      return {
        key: "paused",
        tone: "info",
        claim: t("fleet.monitoring.overview.attention.paused", { n: item.paths.length }, item.paths.length),
        proof: names(item.paths.map((p) => `${p.targetName} (${p.sourceName})`)),
        action: show(attentionQuery(item)),
      };
  }
}

const attention = computed<AttentionItem[]>(() => [...items.value.map(itemFor), ...props.checkAttention]);
const reach = computed(() => (matrix.value ? reachBySource(matrix.value).filter((r) => r.total > 0) : []));
/** The counts the strip links, worst first; degraded only from a server that judges it. */
const reachLinks = computed<PathDisplay[]>(() => (matrix.value?.judgesDegraded ? ["degraded", "down", "unknown", "paused"] : ["down", "unknown", "paused"]));
/** Amber means degraded wherever a path state is shown (D13): unknown keeps its hatch and muted ink. */
const LINK_TONE: Record<PathDisplay, string> = { up: "text-foreground", degraded: "text-warning-text", down: "text-destructive", unknown: "text-muted-foreground", paused: "text-muted-foreground" };

const HATCH = "bg-[repeating-linear-gradient(135deg,var(--border)_0_1.5px,transparent_1.5px_7px)]";
const SEGMENTS: { state: PathDisplay; bar: string }[] = [
  { state: "up", bar: "bg-success" },
  { state: "degraded", bar: "bg-warning" },
  { state: "down", bar: "bg-destructive" },
  { state: "unknown", bar: cn(HATCH, "border border-muted-foreground/40") },
  { state: "paused", bar: "bg-muted-foreground/25" },
];

function share(r: SourceReach, state: PathDisplay): string {
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
        <template v-else>
          <AttentionList :items="attention" :note="sole !== undefined ? $t('fleet.monitoring.paths.verdict.sole', { source: sole }) : undefined" />
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
                    v-for="state in reachLinks"
                    v-show="r[state] > 0"
                    :key="state"
                    type="button"
                    :class="cn('font-medium underline decoration-dotted underline-offset-2 pointer-coarse:inline-flex pointer-coarse:min-h-11 pointer-coarse:items-center', LINK_TONE[state])"
                    :data-reach="state"
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
