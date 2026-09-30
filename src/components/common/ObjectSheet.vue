<script setup lang="ts">
/**
 * One object, opened from its collection (design 23, section 3.5; design 22,
 * section 2, rules 4, 5 and 7). Lifted from Evidence's connection panel.
 *
 * From 768 px up the sheet sits beside the collection (36 to 44 rem) and is
 * not modal: no overlay, the page keeps scrolling, and the rows stay live, so
 * a click on another row swaps the object (the page's row click writes a new
 * ?open=) instead of only closing the sheet. Below 768 px it is modal and
 * takes the whole screen, so a tapped row on a phone opens something on
 * screen instead of selecting an object rendered 5,000 px below. In both, a
 * click elsewhere never closes it; Escape and the close button do, and return
 * focus to the row that opened it (useRouteOpen). Opening focuses the title,
 * not the first control: Enter from a keyboard-opened sheet must not follow
 * "Open page", which appears when the object has a route of its own.
 *
 * States: `loading` before the object is known, `gone` when it no longer
 * exists (it offers the collection back; the page may name what is gone with
 * `goneTitle` and `goneDescription`), `stale` when the page shows the last
 * good read after a failed refresh, `ready` otherwise. `readOnly` hides the
 * action footer and says why there is none.
 */
import { computed, ref } from "vue";
import { RouterLink, type RouteLocationRaw } from "vue-router";
import { ArrowUpRight, SearchX } from "lucide-vue-next";

import { Button } from "@/components/ui/button";
import { Dialog, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { SheetContent } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { useMediaQuery } from "@/composables/useMediaQuery";
import { cn } from "@/lib/utils";

const props = withDefaults(
  defineProps<{
    open: boolean;
    title: string;
    subtitle?: string;
    /** The object's own page, when it has one. */
    pageTo?: RouteLocationRaw;
    state?: "ready" | "loading" | "gone" | "stale";
    readOnly?: boolean;
    /** Why the last refresh failed, for the stale note. */
    error?: string | null;
    /** Where focus goes on close; from useRouteOpen. */
    returnFocus?: () => HTMLElement | null;
    /** Monospace title, for an address or an id. */
    monoTitle?: boolean;
    /** Monospace subtitle; the default, since a subtitle is usually an id. */
    monoSubtitle?: boolean;
    /** What the gone state says, when the page can name what is gone. */
    goneTitle?: string;
    goneDescription?: string;
  }>(),
  {
    subtitle: undefined,
    pageTo: undefined,
    state: "ready",
    readOnly: false,
    error: null,
    returnFocus: undefined,
    monoTitle: false,
    monoSubtitle: true,
    goneTitle: undefined,
    goneDescription: undefined,
  },
);

/** Beside the collection, not over it: from 768 px up the rows stay live. */
const beside = useMediaQuery("(min-width: 768px)");
const header = ref<HTMLElement | null>(null);

const emit = defineEmits<{ close: [] }>();

function onOpenChange(value: boolean): void {
  if (!value) emit("close");
}

/**
 * A click outside never closes the sheet. Beside the collection it is a row
 * being opened in its place; on a phone the sheet covers the screen anyway.
 */
function onInteractOutside(event: Event): void {
  event.preventDefault();
}

/** Land on the title, so Enter does not follow the first link in the header. */
function onOpenAutoFocus(event: Event): void {
  const title = header.value?.querySelector<HTMLElement>("[data-slot='dialog-title']");
  if (!title) return;
  event.preventDefault();
  title.focus();
}

function onCloseAutoFocus(event: Event): void {
  const target = props.returnFocus?.();
  if (!target) return;
  event.preventDefault();
  target.focus();
}

const showBody = computed(() => props.state === "ready" || props.state === "stale");
</script>

<template>
  <Dialog :open="open" :modal="!beside" @update:open="onOpenChange">
    <SheetContent
      :aria-describedby="undefined"
      class="sm:max-w-none md:w-[clamp(36rem,40vw,44rem)]"
      data-testid="object-sheet"
      :data-sheet-state="state"
      :data-sheet-modal="beside ? undefined : ''"
      @open-auto-focus="onOpenAutoFocus"
      @interact-outside="onInteractOutside"
      @close-auto-focus="onCloseAutoFocus"
    >
      <header ref="header" class="flex items-start gap-3 border-b border-border px-5 pt-5 pb-4 pr-12">
        <div class="min-w-0 flex-1 space-y-1">
          <DialogTitle
            :class="
              cn(
                'truncate rounded-xs text-base font-semibold tracking-[-0.01em] outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                monoTitle && 'font-mono',
              )
            "
            :title="title"
            tabindex="-1"
          >
            {{ title }}
          </DialogTitle>
          <DialogDescription
            v-if="subtitle"
            :class="cn('text-xs break-all text-muted-foreground', monoSubtitle && 'font-mono')"
          >
            {{ subtitle }}
          </DialogDescription>
          <p v-if="readOnly" class="text-xs text-muted-foreground">{{ $t('common.sheet.readOnly') }}</p>
        </div>
        <Button v-if="pageTo && state !== 'gone'" variant="outline" size="sm" as-child class="shrink-0">
          <RouterLink :to="pageTo">
            {{ $t('common.sheet.openPage') }}
            <ArrowUpRight aria-hidden="true" />
          </RouterLink>
        </Button>
      </header>

      <p
        v-if="state === 'stale'"
        class="border-b border-border bg-warning/10 px-5 py-2 text-xs text-warning-text"
        role="status"
      >
        {{ error ? $t('common.sheet.staleReason', { reason: error }) : $t('common.sheet.stale') }}
      </p>

      <div class="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        <div v-if="state === 'loading'" class="space-y-3" aria-busy="true">
          <Skeleton class="h-4 w-2/3" />
          <Skeleton class="h-4 w-1/2" />
          <Skeleton class="h-24 w-full" />
          <Skeleton class="h-4 w-3/5" />
        </div>
        <div v-else-if="state === 'gone'" class="flex flex-col items-start gap-3 py-6" role="status">
          <SearchX class="size-5 text-muted-foreground" aria-hidden="true" />
          <p class="text-sm font-medium">{{ goneTitle ?? $t('common.sheet.goneTitle') }}</p>
          <p class="text-sm text-muted-foreground">{{ goneDescription ?? $t('common.sheet.goneDescription') }}</p>
          <Button variant="outline" size="sm" type="button" @click="emit('close')">{{ $t('common.sheet.backToList') }}</Button>
        </div>
        <slot v-if="showBody" />
      </div>

      <footer
        v-if="$slots.actions && showBody && !readOnly"
        class="flex flex-wrap items-center justify-end gap-2 border-t border-border px-5 py-3"
      >
        <slot name="actions" />
      </footer>
    </SheetContent>
  </Dialog>
</template>
