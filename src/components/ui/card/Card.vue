<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { cn } from "@/lib/utils";

const props = defineProps<{
  class?: HTMLAttributes["class"];
  /** Opt-in hover/press affordance for cards that act as a single control. */
  interactive?: boolean;
}>();
</script>

<template>
  <div
    data-slot="card"
    :class="
      cn(
        'bg-card text-card-foreground flex flex-col gap-6 rounded-xl border py-6 shadow-sm',
        props.interactive && 'surface-interactive',
        props.class,
      )
    "
  >
    <slot />
  </div>
</template>
