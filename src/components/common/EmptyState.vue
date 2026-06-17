<script setup lang="ts">
import { computed, useSlots, type Component, type HTMLAttributes } from "vue";
import { useI18n } from "vue-i18n";
import { cn } from "@/lib/utils";

const props = defineProps<{
  icon?: Component;
  title?: string;
  description?: string;
  class?: HTMLAttributes["class"];
}>();

const slots = useSlots();
const { t } = useI18n();

/** Caller-provided title, falling back to the shared default. */
const resolvedTitle = computed(() => props.title ?? t("common.state.nothingHere"));
</script>

<template>
  <div
    :class="
      cn(
        'flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border p-10 text-center',
        props.class,
      )
    "
  >
    <div
      v-if="icon"
      class="flex items-center justify-center rounded-full bg-muted p-3 text-muted-foreground"
    >
      <component :is="icon" class="size-5" />
    </div>
    <div class="space-y-1">
      <p class="text-sm font-medium text-foreground">{{ resolvedTitle }}</p>
      <p v-if="description" class="text-sm text-muted-foreground">
        {{ description }}
      </p>
    </div>
    <div v-if="slots.default" class="mt-1 flex items-center gap-2">
      <slot />
    </div>
  </div>
</template>
