<script setup lang="ts">
import { useSlots, type HTMLAttributes } from "vue";
import { cn } from "@/lib/utils";

/**
 * The page's heading. It never repeats the section (design 23, section
 * 3.10): the header's breadcrumb already says where the page sits, and
 * "Fleet / [cd]-DMIT-2" as an H1 read the section twice.
 */
const props = defineProps<{
  title: string;
  description?: string;
  /**
   * "page" is the view's own heading. "section" is the same header inside a
   * page that already has one, as when Logs renders as a lens of Evidence:
   * an h2 at section size, the actions kept, nothing else changed.
   */
  level?: "page" | "section";
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
    <div class="min-w-0 space-y-1">
      <component
        :is="level === 'section' ? 'h2' : 'h1'"
        :class="level === 'section' ? 'text-lg font-semibold tracking-tight text-foreground' : 'text-2xl font-semibold tracking-tight text-foreground'"
      >
        {{ title }}
      </component>
      <!-- A view whose line under the title is structured (Terminal's proof
           line) renders it through the slot; the string prop stays the
           common case. -->
      <slot name="description">
        <p v-if="description" class="text-sm text-muted-foreground">
          {{ description }}
        </p>
      </slot>
    </div>
    <div
      v-if="slots.status || slots.actions"
      class="flex w-full flex-wrap items-center gap-2 sm:w-auto sm:shrink-0 sm:justify-end"
    >
      <slot name="status" />
      <slot name="actions" />
    </div>
  </div>
</template>
