<script setup lang="ts">
/**
 * MetricStrip: the page's headline numbers as one band, not as a row of cards.
 *
 * Four StatCards across the top of a page cost ~160px of vertical space to
 * carry four integers, and they only reach that height because CSS grid
 * stretches every card to match the tallest one - so three cards of dead space
 * pay for the one that has a second line. On a console where the answer is
 * usually in the table underneath, that is the most expensive real estate on
 * the page being spent on the least information.
 *
 * The strip says the same things in ~64px: a label, a value, an optional hint,
 * separated by hairlines. Segments are individually linkable, so a count that
 * has a list behind it still drills through.
 *
 * The dividers are the container's background showing through a 1px grid gap.
 * That is what makes them survive wrapping: at any column count every seam is
 * exactly one hairline, with no first-child / last-child arithmetic to get
 * wrong when the strip reflows from four columns to two.
 */
import { computed, type Component } from "vue";
import { RouterLink, type RouteLocationRaw } from "vue-router";
import { cn } from "@/lib/utils";

export type MetricTone = "default" | "success" | "warning" | "destructive";

export interface Metric {
  /** Stable key for the v-for. */
  key: string;
  label: string;
  value: string | number;
  /** Secondary text beside the value: a denominator, a delta, a qualifier. */
  hint?: string;
  tone?: MetricTone;
  icon?: Component;
  /** When set, this segment becomes a drill-through link. */
  to?: RouteLocationRaw;
}

const props = withDefaults(
  defineProps<{
    metrics: Metric[];
    /** Columns at the widest breakpoint. Below it the strip halves, then stacks. */
    columns?: 2 | 3 | 4 | 5;
  }>(),
  { columns: 4 },
);

const toneClass: Record<MetricTone, string> = {
  default: "text-foreground",
  success: "text-success",
  warning: "text-warning",
  destructive: "text-destructive",
};

/**
 * A segment needs roughly 200px before its value starts truncating (a rate like
 * "115.1 MiB/s" beside a cumulative total is the widest thing these carry), so
 * the full column count only applies once the page is actually wide enough for
 * it. Wrapping to two rows of legible numbers beats one row of ellipses.
 */
const gridClass = computed(
  () =>
    ({
      2: "grid-cols-1 sm:grid-cols-2",
      3: "grid-cols-2 lg:grid-cols-3",
      4: "grid-cols-2 lg:grid-cols-4",
      5: "grid-cols-2 md:grid-cols-3 xl:grid-cols-5",
    })[props.columns],
);
</script>

<template>
  <div
    :class="cn('grid gap-px overflow-hidden rounded-lg border border-border bg-border', gridClass)"
  >
    <component
      :is="metric.to ? RouterLink : 'div'"
      v-for="metric in metrics"
      :key="metric.key"
      :to="metric.to"
      :class="cn(
        'flex min-w-0 items-center gap-2.5 bg-card px-3.5 py-3',
        metric.to && 'transition-colors hover:bg-foreground/3 focus-visible:outline-none focus-visible:bg-foreground/5',
      )"
      :title="metric.hint ? `${metric.label}: ${metric.value} (${metric.hint})` : undefined"
    >
      <component
        :is="metric.icon"
        v-if="metric.icon"
        class="size-4 shrink-0 text-muted-foreground"
        aria-hidden="true"
      />
      <div class="min-w-0">
        <p class="truncate text-xs text-muted-foreground">{{ metric.label }}</p>
        <p class="flex min-w-0 items-baseline gap-1.5">
          <span
            :class="cn('truncate text-xl font-semibold leading-tight tabular', toneClass[metric.tone ?? 'default'])"
          >{{ metric.value }}</span>
          <span v-if="metric.hint" class="truncate text-xs text-muted-foreground">{{ metric.hint }}</span>
        </p>
      </div>
    </component>
  </div>
</template>
