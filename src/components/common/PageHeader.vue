<script setup lang="ts">
import { useSlots, type HTMLAttributes } from "vue";
import { cn } from "@/lib/utils";

const props = defineProps<{
  title: string;
  description?: string;
  class?: HTMLAttributes["class"];
}>();

const slots = useSlots();
</script>

<template>
  <div
    :class="
      cn(
        'flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between',
        props.class,
      )
    "
  >
    <div class="space-y-1">
      <h1 class="text-2xl font-semibold tracking-tight text-foreground">
        {{ title }}
      </h1>
      <p v-if="description" class="text-sm text-muted-foreground">
        {{ description }}
      </p>
    </div>
    <div v-if="slots.actions" class="flex shrink-0 items-center gap-2">
      <slot name="actions" />
    </div>
  </div>
</template>
