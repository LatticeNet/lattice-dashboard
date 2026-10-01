<script setup lang="ts">
/**
 * The proof line (design 23, section 3.1; design 22's signature element):
 * what the page last read, when, and what it held.
 *
 *   observed 12s ago · 34 nodes · 2 offline
 *
 * Six states, from proofModel. A failed read never prints a count: without a
 * read there is no number, only the reason and a retry. A failed refresh
 * keeps the last good segments, muted, behind "last good 3m ago". A page that
 * does not poll prints no age, because nobody promised the next read.
 *
 * Bind it with useProof: `<ProofLine v-bind="proof" :segments="..." />`.
 */
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { RouterLink, type RouteLocationRaw } from "vue-router";
import { useNow } from "@vueuse/core";
import { RefreshCw } from "lucide-vue-next";

import { formatAge } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { ProofState } from "./proofModel";

export interface ProofSegment {
  key: string;
  text: string;
  /**
   * `default` is the line's own colour; `strong` marks the fact the line is
   * about (Terminal's transport and shell); `muted` is a side note, which
   * the page shows by placing it after the facts, not by greying it further
   * (a lighter grey fell to 2.9:1 in light mode); `warning` and
   * `destructive` carry a state.
   */
  tone?: "default" | "strong" | "muted" | "warning" | "destructive";
  /** A segment with somewhere to go (the audited sessions, the offline nodes). */
  to?: RouteLocationRaw;
}

const props = withDefaults(
  defineProps<{
    state: ProofState;
    observedAt?: number | null;
    segments?: ProofSegment[];
    /** The page's poll interval; carried for completeness, the state already reflects it. */
    pollMs?: number;
    /** Why the last read failed, for `stale` and `failed`. */
    error?: string | null;
    class?: string;
  }>(),
  { observedAt: null, segments: () => [], pollMs: 0, error: null, class: undefined },
);

const emit = defineEmits<{ retry: [] }>();

const { t, locale } = useI18n();
const now = useNow({ interval: 1000 });

const age = computed(() =>
  props.observedAt == null ? "" : formatAge(now.value.getTime() - props.observedAt, locale.value),
);

const TONE: Record<NonNullable<ProofSegment["tone"]>, string> = {
  default: "",
  strong: "text-foreground",
  muted: "text-muted-foreground",
  warning: "text-warning-text",
  destructive: "text-destructive",
};

/**
 * Stale segments are the last good read: shown, but never in a state colour.
 * The "last good" lead in amber already says they are old, so they keep the
 * line's readable grey.
 */
function segmentClass(segment: ProofSegment): string {
  if (props.state === "stale") return "text-muted-foreground";
  return TONE[segment.tone ?? "default"];
}

const showSegments = computed(() => props.state !== "loading" && props.state !== "failed");
const lead = computed(() => {
  switch (props.state) {
    case "observed":
    case "refreshing":
      return age.value ? t("common.proof.observed", { age: age.value }) : "";
    case "stale":
      return age.value ? t("common.proof.lastGood", { age: age.value }) : "";
    default:
      return "";
  }
});
</script>

<template>
  <p
    :class="cn('flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 font-mono text-xs leading-5 tabular text-muted-foreground', props.class)"
    :data-state="state"
    data-testid="proof-line"
  >
    <template v-if="state === 'loading'">
      <span>{{ $t('common.proof.reading') }}</span>
    </template>

    <template v-else-if="state === 'failed'">
      <span class="min-w-0 break-words text-destructive">
        {{ error ? $t('common.proof.notRead', { reason: error }) : $t('common.proof.notReadBare') }}
      </span>
      <button
        type="button"
        class="inline-flex h-6 items-center rounded-sm border border-border px-2 font-sans text-xs text-foreground outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
        @click="emit('retry')"
      >
        {{ $t('common.actions.retry') }}
      </button>
    </template>

    <template v-else>
      <span v-if="lead" :class="state === 'stale' ? 'text-warning-text' : undefined">{{ lead }}</span>
      <template v-if="state === 'stale'">
        <span aria-hidden="true" class="text-muted-foreground/50">·</span>
        <span class="min-w-0 break-words text-warning-text">
          {{ error ? $t('common.proof.refreshFailed', { reason: error }) : $t('common.proof.noAnswer') }}
        </span>
      </template>
      <RefreshCw
        v-if="state === 'refreshing'"
        class="size-3 animate-spin text-muted-foreground/70"
        aria-hidden="true"
      />
      <template v-for="(segment, index) in showSegments ? segments : []" :key="segment.key">
        <span v-if="index > 0 || lead || state === 'stale'" aria-hidden="true" class="text-muted-foreground/50">·</span>
        <RouterLink
          v-if="segment.to"
          :to="segment.to"
          :class="cn('rounded-sm underline decoration-dotted underline-offset-2 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring', segmentClass(segment))"
        >
          {{ segment.text }}
        </RouterLink>
        <span v-else :class="segmentClass(segment)">{{ segment.text }}</span>
      </template>
    </template>
  </p>
</template>
