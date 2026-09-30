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
 *
 * Capped at four (design 23, section 3.3): a page head shows at most four
 * numbers, and only numbers that move. Totals that only grow and static
 * configuration belong in the proof line or in Settings. A strip over the
 * cap still renders, and warns once in development so the page gets fixed.
 */
import { computed, watch, type Component } from "vue";
import { RouterLink, type RouteLocationRaw } from "vue-router";
import { cn } from "@/lib/utils";
import { metricCapWarning } from "./chassisModel";

/**
 * `muted` is not a weaker `default`. It marks a value that is not an assertion:
 * a check that has not run, a state the server declined to report. Rendering
 * those at full contrast alongside verified numbers is how a console tells an
 * operator something it does not actually know.
 */
export type MetricTone = "default" | "muted" | "success" | "warning" | "destructive";

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
  /**
   * Phrases that each carry their own tone, printed in place of `value` and
   * joined by a middle dot ("1 overdue · 3 within 7 days"). `value` stays the
   * plain-text reading for the title and for anything that cannot style.
   */
  parts?: { text: string; tone?: MetricTone }[];
  /** Extra classes for this segment, such as a column span. */
  class?: string;
}

const props = withDefaults(
  defineProps<{
    metrics: Metric[];
    /** Columns at the widest breakpoint. Below it the strip halves, then stacks. */
    columns?: 2 | 3 | 4 | 5 | 6;
  }>(),
  { columns: 4 },
);

if (import.meta.env.DEV) {
  let warned = false;
  watch(
    () => props.metrics.length,
    (count) => {
      const warning = metricCapWarning(count);
      if (warning && !warned) {
        warned = true;
        console.warn(warning, props.metrics.map((metric) => metric.key));
      }
    },
    { immediate: true },
  );
}

const toneClass: Record<MetricTone, string> = {
  default: "text-foreground",
  muted: "text-muted-foreground",
  success: "text-success",
  // The darker text step: the fill-strength amber is under 3:1 on a light card.
  warning: "text-warning-text",
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
      // Six is the fleet status band: three pairs on a phone, one row on a desktop.
      6: "grid-cols-2 md:grid-cols-3 xl:grid-cols-6",
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
        metric.to && 'transition-colors outline-none hover:bg-foreground/3 focus-visible:bg-foreground/5 focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset',
        metric.class,
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
        <!-- Value and hint sit side by side once there is room for both. At
             375 there is not: a two-column strip leaves each segment ~115px of
             text, and a throughput beside its cumulative total clipped to
             "70.7 ... 98....". Below `sm` the hint drops to its own line and
             the rate gets the whole width. -->
        <p class="flex min-w-0 flex-col items-start gap-x-1.5 sm:flex-row sm:items-baseline">
          <span
            v-if="metric.parts?.length"
            class="max-w-full truncate text-lg font-semibold leading-tight tabular sm:text-xl"
          >
            <template v-for="(part, index) in metric.parts" :key="index">
              <span v-if="index > 0" class="font-normal text-muted-foreground" aria-hidden="true"> · </span>
              <span :class="toneClass[part.tone ?? 'default']">{{ part.text }}</span>
            </template>
          </span>
          <span
            v-else
            :class="cn('max-w-full truncate text-lg font-semibold leading-tight tabular sm:text-xl', toneClass[metric.tone ?? 'default'])"
          >{{ metric.value }}</span>
          <span v-if="metric.hint" class="max-w-full truncate text-xs text-muted-foreground">{{ metric.hint }}</span>
        </p>
      </div>
    </component>
  </div>
</template>
