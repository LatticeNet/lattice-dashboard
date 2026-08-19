<script setup lang="ts">
import type { HTMLAttributes } from "vue";
import { cn } from "@/lib/utils";

/**
 * The multi-line sibling of Input.
 *
 * Sixteen call sites were repeating a hand-written class string, which is how
 * half of them ended up with no focus ring: there was nothing to copy it from.
 * Border, focus and invalid treatments are the same tokens Input uses, so a
 * textarea and a text field in the same form look like the same control.
 */
const props = defineProps<{ class?: HTMLAttributes["class"] }>();

const modelValue = defineModel<string>();
</script>

<template>
  <textarea
    v-model="modelValue"
    data-slot="textarea"
    :class="
      cn(
        'placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground border-input flex min-h-24 w-full rounded-md border bg-transparent px-3 py-2 text-base shadow-xs transition-[color,box-shadow] outline-none disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm',
        'focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]',
        'aria-invalid:ring-destructive/20 aria-invalid:border-destructive',
        props.class,
      )
    "
  />
</template>
