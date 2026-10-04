<script setup lang="ts">
import { computed, useSlots, type HTMLAttributes } from "vue";
import { cn } from "@/lib/utils";

/**
 * The page's heading. It never repeats the section (design 23, section
 * 3.10): the header's breadcrumb already says where the page sits, and
 * "Fleet / [cd]-DMIT-2" as an H1 read the section twice.
 *
 * The actions share the title's line whenever they fit beside it, at every
 * width. Below 640 px they used to take a full-width row of their own under
 * the description, so on a phone a lone Refresh cost a whole row on 28 pages.
 * A header whose actions do not fit beside the title (three buttons at 375)
 * wraps them onto the next line, still above the description.
 *
 * On a coarse pointer the page title's line is as tall as a 44 px touch
 * button, whether or not the page has one, so the title sits at the same
 * height on every page. Centred against taller buttons it moved 6 px between
 * pages with actions and pages without.
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
const hasDescription = computed(() => !!slots.description || !!props.description);
</script>

<template>
  <div :class="cn('flex flex-wrap items-center gap-x-4 gap-y-1', props.class)">
    <component
      :is="level === 'section' ? 'h2' : 'h1'"
      :class="cn(
        'min-w-0 grow basis-auto break-words',
        level === 'section' ? 'text-lg font-semibold tracking-tight text-foreground' : 'text-2xl font-semibold tracking-tight text-foreground pointer-coarse:py-1.5',
      )"
    >
      {{ title }}
    </component>
    <div
      v-if="slots.status || slots.actions"
      class="flex flex-wrap items-center gap-2 sm:justify-end"
    >
      <slot name="status" />
      <slot name="actions" />
    </div>
    <!-- A view whose line under the title is structured (Terminal's proof
         line) renders it through the slot; the string prop stays the
         common case. -->
    <div v-if="hasDescription" class="min-w-0 basis-full space-y-1">
      <slot name="description">
        <p v-if="description" class="text-sm text-muted-foreground">
          {{ description }}
        </p>
      </slot>
    </div>
  </div>
</template>
