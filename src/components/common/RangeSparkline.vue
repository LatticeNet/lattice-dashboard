<script setup lang="ts">
/**
 * A table row's sparkline over the page's range: one slot per bucket so a
 * quiet stretch keeps its width, the line broken where nothing was heard,
 * and a tick under every bucket that had a failure. Decorative beside the
 * row's own numbers, so it is hidden from assistive tech.
 */
import { computed } from "vue";

import type { SystemSpark } from "@/lib/api/systemTypes";
import { sparkPath } from "@/views/platform/systemModel";

const props = withDefaults(
  defineProps<{
    spark?: SystemSpark;
    /** Which column of the spark to draw. */
    field?: "p95" | "avg" | "n";
    from: number;
    to: number;
    tone?: "default" | "warning" | "destructive";
  }>(),
  { spark: undefined, field: "p95", tone: "default" },
);

const W = 96;
const H = 24;

const values = computed<(number | undefined)[]>(() => {
  const s = props.spark;
  if (!s) return [];
  const col = props.field === "n" ? s.n : s[props.field];
  return s.t.map((_, i) => col?.[i]);
});
// A size (avg) is drawn against its own range, a latency against zero.
const d = computed(() => sparkPath(props.spark, values.value, { from: props.from, to: props.to, w: W, h: H, relative: props.field === "avg" }));
const failures = computed(() => {
  const s = props.spark;
  if (!s?.e) return [];
  const step = Math.max(s.step_seconds, 1);
  const span = Math.max(props.to - props.from, step);
  return s.t.flatMap((t, i) => ((s.e?.[i] ?? 0) > 0 ? [((t + step / 2 - props.from) / span) * W] : []));
});
const stroke = computed(() => (props.tone === "destructive" ? "var(--destructive)" : props.tone === "warning" ? "var(--warning)" : "var(--primary)"));
</script>

<template>
  <svg :viewBox="`0 0 ${W} ${H}`" class="block h-6 w-24 shrink-0" preserveAspectRatio="none" aria-hidden="true">
    <path v-if="d" :d="d" fill="none" :stroke="stroke" stroke-width="1.25" stroke-linejoin="round" vector-effect="non-scaling-stroke" />
    <line v-else x1="0" :x2="W" :y1="H - 1" :y2="H - 1" stroke="var(--border)" stroke-dasharray="2 3" vector-effect="non-scaling-stroke" />
    <line
      v-for="(x, i) in failures"
      :key="i"
      :x1="x"
      :x2="x"
      :y1="H - 4"
      :y2="H"
      stroke="var(--destructive)"
      stroke-width="1.5"
      vector-effect="non-scaling-stroke"
    />
  </svg>
</template>
