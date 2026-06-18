<script setup lang="ts">
import { computed, toRef } from "vue";
import { cn } from "@/lib/utils";
import { useLiveLabel, type LiveState, type UseLiveLabelOptions } from "@/composables/useLiveLabel";

/**
 * Tiny freshness pill for a socket-less, polling dashboard. Drop it into
 * PageHeader's #status slot with the `lastUpdated` timestamp that `useAsyncData`
 * exposes; it ticks once a second (via `useLiveLabel`) and renders localized
 * "Live" / "Updated {n}s ago" / "Stale" copy in the matching status token color.
 *
 * `useLiveLabel` returns STRUCTURED data only ({state, seconds, color}); this
 * component owns the i18n formatting + dot, keeping the composable text-free.
 */
const props = withDefaults(
  defineProps<{
    /** Last successful poll time (ms epoch or Date). `null`/undefined ⇒ idle. */
    lastUpdated: number | Date | null | undefined;
    /** Forwarded to useLiveLabel to tune stale/dead thresholds. */
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

const opts = computed<UseLiveLabelOptions>(() => ({
  staleAfterMs: props.staleAfterMs,
  deadAfterMs: props.deadAfterMs,
}));

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
      return { key: "freshness.stale", params: {} };
    default:
      return { key: "freshness.idle", params: {} };
  }
});
</script>

<template>
  <span
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
