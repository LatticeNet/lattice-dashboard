<script setup lang="ts">
/**
 * A side panel: one object opened from a list, beside the list rather than
 * over its middle. Full height at the right edge from sm up, the whole screen
 * below it, which is the 375px rule for side panels (design 22, section 2).
 *
 * The same reka Dialog underneath as DialogContent, so focus trapping, Escape
 * and outside click behave the way every other overlay in the console does.
 * The body scrolls inside the panel; the page behind it does not move.
 */
import { computed, type HTMLAttributes } from "vue";
import {
  DialogClose,
  DialogContent,
  type DialogContentEmits,
  type DialogContentProps,
  DialogOverlay,
  DialogPortal,
  useForwardPropsEmits,
} from "reka-ui";
import { X } from "lucide-vue-next";
import { cn } from "@/lib/utils";

defineOptions({
  inheritAttrs: false,
});

const props = defineProps<DialogContentProps & { class?: HTMLAttributes["class"] }>();
const emits = defineEmits<DialogContentEmits>();

const delegatedProps = computed(() => {
  const { class: _class, ...rest } = props;
  return rest;
});

const forwarded = useForwardPropsEmits(delegatedProps, emits);
</script>

<template>
  <DialogPortal>
    <DialogOverlay
      data-slot="sheet-overlay"
      class="data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-black/40"
    />
    <DialogContent
      data-slot="sheet-content"
      v-bind="{ ...forwarded, ...$attrs }"
      :class="
        cn(
          'bg-background data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right fixed inset-y-0 right-0 z-50 flex h-dvh w-full flex-col border-l shadow-lg duration-200 outline-none sm:max-w-xl',
          props.class,
        )
      "
    >
      <slot />

      <DialogClose
        class="ring-offset-background focus-visible:ring-ring absolute top-4 right-4 rounded-xs opacity-70 transition-opacity hover:opacity-100 focus-visible:ring-2 focus-visible:ring-offset-2 focus:outline-none disabled:pointer-events-none [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 [&_svg]:shrink-0"
      >
        <X />
        <span class="sr-only">{{ $t('common.actions.close') }}</span>
      </DialogClose>
    </DialogContent>
  </DialogPortal>
</template>
