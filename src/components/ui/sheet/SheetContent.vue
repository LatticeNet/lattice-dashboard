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

      <!-- The 16 px glyph sits in a 32 px box (it was a 16 px target from
           768 up), centred where the glyph always was: 8 + 16/2 = 24 px from
           the top and the right edge. On a phone the sheet covers the screen
           and this is the only way out, so on a coarse pointer the box is a
           visible 44 px, the glyph still in place. Below 768 px (the sheet
           is full screen there) a fine pointer gets an invisible pad to
           44 px: an inset, not a translate, so on a coarse pointer the
           .touch-target pad in app.css (which sets every edge itself) wins
           alone instead of stacking a second translate on its own. -->
      <DialogClose
        class="ring-offset-background focus-visible:ring-ring touch-target absolute top-2 right-2 inline-flex size-8 items-center justify-center rounded-md opacity-70 pointer-coarse:top-0.5 pointer-coarse:right-0.5 pointer-coarse:size-11 max-md:after:absolute max-md:after:-inset-1.5 max-md:after:content-[''] transition-[opacity,background-color] hover:bg-accent hover:opacity-100 focus-visible:ring-2 focus-visible:ring-offset-2 focus:outline-none disabled:pointer-events-none [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 [&_svg]:shrink-0"
      >
        <X />
        <span class="sr-only">{{ $t('common.actions.close') }}</span>
      </DialogClose>
    </DialogContent>
  </DialogPortal>
</template>
