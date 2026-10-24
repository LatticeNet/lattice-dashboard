<script setup lang="ts">
/**
 * One of a node's two path lists ("reached by", "reaches"): one line per
 * path with the other end, the method and the value. The state is the dot
 * and, when the path is not up, the words in the value column; the whole
 * line is labelled for a screen reader. Shared by the node page's Paths card,
 * whose lines link to the path on Monitoring, and by the node sheet's lens on
 * the Network view (design 32 D2), whose lines open the path sheet in place.
 */
import { useI18n } from "vue-i18n";
import { RouterLink, type RouteLocationRaw } from "vue-router";

import { cn } from "@/lib/utils";

import { formatLoss, formatMs } from "./latencyModel";
import { NODE_PATHS_SHOWN, degradedFigures, otherEnd } from "./nodePathsModel";
import { displayState, type PathItem } from "./pathsModel";
import { usePathsCopy } from "./pathsCopy";

const props = withDefaults(
  defineProps<{
    paths: PathItem[];
    side: "reachedBy" | "reaches";
    /** A line links here; without it a line is a button that emits `open`. */
    linkTo?: (path: PathItem) => RouteLocationRaw;
    /** Lines shown before the list hands over. */
    shown?: number;
  }>(),
  { linkTo: undefined, shown: NODE_PATHS_SHOWN },
);

const emit = defineEmits<{ open: [path: PathItem, el: HTMLElement] }>();

const { t } = useI18n();
const { reasonShort, displayLabel, methodName, evidenceText } = usePathsCopy();

/**
 * The value a line shows: the p50 (and loss) when up, the state and loss when
 * down, unknown with its reason, and for a degraded line the evidence its
 * reason rests on (the 15-minute median, the hour's loss) with the full
 * sentence on hover, never the window's p50.
 */
function valueOf(path: PathItem): { text: string; tone: string; title?: string } {
  const state = displayState(path);
  if (state === "up") {
    const loss = (path.loss ?? 0) > 0 ? ` · ${formatLoss(path.loss)}` : "";
    return { text: path.p50Ms !== undefined ? `${formatMs(path.p50Ms)}${loss}` : t("fleet.monitoring.paths.reasonShort.no_data"), tone: "text-foreground" };
  }
  if (state === "down") return { text: (path.loss ?? 0) > 0 ? `${displayLabel(path)} · ${formatLoss(path.loss)}` : displayLabel(path), tone: "text-destructive" };
  // Degraded (design 29 D13): the evidence and the reason, in the warning tone.
  if (state === "degraded") {
    const f = degradedFigures(path);
    const figures = [f.latencyMs !== undefined ? formatMs(f.latencyMs) : "", f.loss !== undefined ? formatLoss(f.loss) : ""];
    return { text: [...figures, reasonShort(path.reason)].filter(Boolean).join(" · "), tone: "text-warning-text", title: evidenceText(path.degraded, path.reason) || undefined };
  }
  if (state === "paused") return { text: displayLabel(path), tone: "text-muted-foreground" };
  return { text: t("fleet.monitoring.paths.state.unknownWhy", { reason: reasonShort(path.reason) }), tone: "text-muted-foreground" };
}

const DOT: Record<string, string> = {
  up: "bg-success",
  degraded: "bg-warning",
  down: "bg-destructive",
  unknown: "border border-muted-foreground bg-transparent",
  paused: "bg-muted-foreground/50",
};

function lineOf(path: PathItem) {
  const end = otherEnd(path, props.side);
  const value = valueOf(path);
  const name = end.check ? `${end.name}, ${t("fleet.monitoring.nodePaths.viaCheck", { name: end.check })}` : end.name;
  return { path, end, value, state: displayState(path), label: t("fleet.monitoring.nodePaths.rowLabel", { name, method: methodName(path.method), value: value.text, state: displayLabel(path) }) };
}

const LINE = "grid w-full min-w-0 grid-cols-[0.5rem_minmax(0,1fr)_auto_minmax(4.5rem,auto)] items-center gap-x-2.5 py-1.5 text-start outline-none hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11";
</script>

<template>
  <ul class="divide-y divide-border border-y border-border text-xs">
    <li v-for="line in paths.slice(0, shown).map(lineOf)" :key="line.path.key" :data-node-path="line.path.key" :data-state="line.state">
      <component
        :is="linkTo ? RouterLink : 'button'"
        v-bind="linkTo ? { to: linkTo(line.path) } : { type: 'button' }"
        :aria-label="line.label"
        :class="LINE"
        @click="(e: MouseEvent) => !linkTo && emit('open', line.path, e.currentTarget as HTMLElement)"
      >
        <span :class="cn('size-2 rounded-full', DOT[line.state])" aria-hidden="true" />
        <span class="min-w-0">
          <span class="block truncate" :title="line.end.name">{{ line.end.name }}</span>
          <span v-if="line.end.check" class="block truncate text-[11px] text-muted-foreground" :title="line.end.check">{{ $t('fleet.monitoring.nodePaths.viaCheck', { name: line.end.check }) }}</span>
        </span>
        <span class="font-mono text-[10px] uppercase text-muted-foreground" aria-hidden="true">{{ line.path.method }}</span>
        <span :class="cn('text-end font-mono tabular', line.value.tone)" aria-hidden="true" :title="line.value.title">{{ line.value.text }}</span>
      </component>
    </li>
  </ul>
</template>
