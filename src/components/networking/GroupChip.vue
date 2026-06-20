<script setup lang="ts">
import { computed, type HTMLAttributes } from "vue";
import { cn } from "@/lib/utils";
import { groupColor } from "@/lib/groupColors";

/**
 * GroupChip — a compact, CSP-safe group identity badge (color dot + name).
 * Reused by the reachability matrix axes, the cell editor, and group lists.
 */
const props = withDefaults(
  defineProps<{
    name: string;
    color?: string;
    /** Render a softly-tinted pill rather than a bare dot + label. */
    pill?: boolean;
    class?: HTMLAttributes["class"];
  }>(),
  { color: "slate", pill: false },
);

const classes = computed(() => groupColor(props.color));
</script>

<template>
  <span
    :class="
      cn(
        'inline-flex max-w-full items-center gap-1.5 text-sm',
        pill && 'rounded-full border px-2 py-0.5 text-xs font-medium',
        pill && classes.soft,
        pill && classes.border,
        props.class,
      )
    "
  >
    <span :class="cn('size-2 shrink-0 rounded-full', classes.dot)" aria-hidden="true" />
    <span class="truncate">{{ name }}</span>
  </span>
</template>
