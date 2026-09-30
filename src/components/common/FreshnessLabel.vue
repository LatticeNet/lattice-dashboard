<script setup lang="ts">
import { computed, toRef } from "vue";
import { cn } from "@/lib/utils";
import { useLiveLabel, type LiveState, type UseLiveLabelOptions } from "@/composables/useLiveLabel";
import { freshnessVisible, staleAfterMs } from "./proofModel";

/**
 * Tiny freshness pill for a socket-less, polling dashboard. Drop it into
 * PageHeader's #status slot with the `lastUpdated` timestamp that `useAsyncData`
 * exposes; it ticks once a second (via `useLiveLabel`) and renders localized
 * "Live" / "Updated {n}s ago" / "Stale" copy in the matching status token color.
 *
 * `useLiveLabel` returns STRUCTURED data only ({state, seconds, color}); this
 * component owns the i18n formatting + dot, keeping the composable text-free.
 *
 * The threshold comes from the page's own poll interval (stale at 1.5 times,
 * design 23 section 3.1), passed as `poll-ms` from the query:
 * `:poll-ms="nodesQuery.pollMs"`. One fixed 8 s threshold made a 12 s poll
 * flash amber every cycle and a page that never polls turn red. A page that
 * does not poll gets no pill at all: there is no refresh to be late. The
 * ProofLine replaces this pill page by page in wave 2.
 */
const props = withDefaults(
  defineProps<{
    /** Last successful poll time (ms epoch or Date). `null`/undefined means idle. */
    lastUpdated: number | Date | null | undefined;
    /** The query's poll interval (`query.pollMs`). 0 or absent hides the pill. */
    pollMs?: number;
    /** Overrides the threshold derived from `pollMs`. */
    staleAfterMs?: number;
    deadAfterMs?: number;
    /** Hide the leading status dot when false. */
    showDot?: boolean;
    class?: string;
  }>(),
  {
    showDot: true,
  },
);

const visible = computed(() => freshnessVisible(props.pollMs));

const opts = computed<UseLiveLabelOptions>(() => {
  const staleAfter = props.staleAfterMs ?? staleAfterMs(props.pollMs);
  return {
    staleAfterMs: staleAfter,
    deadAfterMs: props.deadAfterMs ?? (staleAfter === undefined ? undefined : staleAfter * 3),
  };
});

const { state, seconds, color } = useLiveLabel(toRef(props, "lastUpdated"), opts.value);

/** Background tint for the dot, mirroring the text token in `color`. */
const DOT_BY_STATE: Record<LiveState, string> = {
  live: "bg-success",
  stale: "bg-warning",
  dead: "bg-destructive",
  idle: "bg-muted-foreground",
};

const text = computed(() => {
  switch (state.value) {
    case "live":
      return { key: "freshness.live", params: {} };
    case "stale":
      return { key: "freshness.updatedAgo", params: { n: seconds.value } };
    case "dead":
      // Says how long the console has gone without a successful poll rather
      // than the bare word "stale", which told the operator nothing.
      return { key: "freshness.stale", params: { n: seconds.value } };
    default:
      return { key: "freshness.idle", params: {} };
  }
});
</script>

<template>
  <span
    v-if="visible"
    :class="cn('inline-flex items-center gap-1.5 text-xs font-medium', color, props.class)"
    role="status"
    aria-live="polite"
  >
    <span
      v-if="showDot"
      :class="
        cn(
          'inline-block size-1.5 shrink-0 rounded-full',
          DOT_BY_STATE[state],
          state === 'live' && 'animate-pulse-dot',
        )
      "
      aria-hidden="true"
    />
    {{ $t(text.key, text.params) }}
  </span>
</template>
